"""The model and MCP operations shared by all three Python engines."""

from contextlib import asynccontextmanager
import hashlib
import json
import os
import sys
from time import monotonic

import httpx
from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client

from .telemetry import log

MODEL = os.getenv("OLLAMA_MODEL", "qwen3:14b").strip() or "qwen3:14b"
OLLAMA = (os.getenv("OLLAMA_URL") or "http://127.0.0.1:11434").rstrip("/")
INSTRUCTIONS = (
    "Use the provided tools for facts about demo inventory and warehouse pickup hours. "
    "If a required SKU or warehouse ID is missing, ask for it unless it can be obtained "
    "from the conversation or a tool result. Do not invent inventory facts. Answer other questions normally."
)


class APIError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def fingerprint(model, messages):
    return hashlib.sha256(json.dumps([model, messages], sort_keys=True).encode()).hexdigest()


def new_turn(model, messages):
    # Checkpoints and Temporal activities both need JSON-serializable state.
    return {"model": model, "transcript": [{"role": "system", "content": INSTRUCTIONS}, *messages],
            "tools": [], "usage": [], "rounds": 0, "pending": []}


def reply(turn, engine, run_id=None, states=None):
    response = {
        "engine": engine, "model": turn["model"], "usage": turn["usage"], "tools": turn["tools"],
        "message": {"role": "assistant", "content": turn["transcript"][-1]["content"]},
    }
    if run_id:
        response["runId"] = run_id
    if states:
        response["states"] = states
    return response


class Agent:
    def __init__(self, http, mcp, service):
        self.http = http
        self.mcp = mcp
        self.service = service

    async def list_tools(self, correlation_id):
        params = types.PaginatedRequestParams(_meta=types.RequestParams.Meta(correlation_id=correlation_id))
        result = await self.mcp.send_request(
            types.ClientRequest(types.ListToolsRequest(params=params)), types.ListToolsResult,
        )
        log(self.service, correlation_id, "mcp-client", "mcp.tools.discovered", tool_count=len(result.tools))
        return result.tools

    async def ollama(self, method, path, correlation_id, **options):
        started = monotonic()
        response = await self.http.request(method, OLLAMA + path,
                                           headers={"X-Correlation-ID": correlation_id}, **options)
        log(self.service, correlation_id, "ollama-client", "ollama.request.completed",
            route=path, status=response.status_code, model=(options.get("json") or {}).get("model"),
            duration_ms=int((monotonic() - started) * 1000))
        return response

    async def models(self, correlation_id):
        response = await self.ollama("GET", "/api/tags", correlation_id, timeout=3)
        response.raise_for_status()
        return sorted({
            item["name"] for item in response.json()["models"]
            if item.get("name") and (not item.get("capabilities") or "tools" in item["capabilities"])
        })

    async def ask(self, turn, correlation_id, emit=None):
        final = turn["rounds"] >= 4 or len(turn["tools"]) >= 8
        tools = [] if final else await self.list_tools(correlation_id)
        try:
            body = {
                "model": turn["model"], "messages": turn["transcript"],
                "tools": [{"type": "function", "function": {
                    "name": tool.name, "description": tool.description, "parameters": tool.inputSchema,
                }} for tool in tools],
                "stream": emit is not None, "think": False,
            }
            if emit:
                await emit({"type": "model-start"})
                payload = await self.stream_model(body, correlation_id, emit)
            else:
                response = await self.ollama("POST", "/api/chat", correlation_id, json=body)
                response.raise_for_status()
                payload = response.json()
            message = payload["message"]
            if message.get("role") != "assistant" or not isinstance(message.get("content"), str):
                raise ValueError("invalid assistant response")
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as error:
            raise APIError(502, "Ollama could not complete the chat request.") from error
        calls = message.get("tool_calls") or []
        if calls and (final or len(turn["tools"]) + len(calls) > 8):
            raise APIError(502, "The model exceeded the tool call limit.")
        counts = {key: payload[source] for key, source in (
            ("inputTokens", "prompt_eval_count"), ("outputTokens", "eval_count"),
        ) if isinstance(payload.get(source), int)}
        assistant = {key: message[key] for key in ("role", "content", "tool_calls") if key in message}
        return {**turn, "transcript": [*turn["transcript"], assistant], "pending": calls,
                "usage": [*turn["usage"], counts], "rounds": turn["rounds"] + bool(calls)}

    async def stream_model(self, body, correlation_id, emit):
        # Keep HTTP resources scoped to this request so cancellation closes Ollama.
        started = monotonic()
        message = {"role": "assistant", "content": "", "tool_calls": []}
        async with self.http.stream("POST", OLLAMA + "/api/chat", json=body,
                                    headers={"X-Correlation-ID": correlation_id}) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.strip():
                    continue
                if len(line) > 2 * 1024 * 1024:
                    raise ValueError("Streaming record exceeded the size limit.")
                chunk = json.loads(line)
                if chunk.get("error"):
                    raise ValueError("Ollama stream failed.")
                part = chunk.get("message") or {}
                if part.get("content"):
                    message["content"] += part["content"]
                    await emit({"type": "text", "text": part["content"]})
                message["tool_calls"].extend(part.get("tool_calls") or [])
                if chunk.get("done"):
                    log(self.service, correlation_id, "ollama-client", "ollama.request.completed",
                        route="/api/chat", model=body["model"], status=response.status_code, stream=True,
                        duration_ms=int((monotonic() - started) * 1000))
                    return {**chunk, "message": message}
        raise ValueError("Ollama stream ended before completion.")

    async def call_next(self, turn, correlation_id, emit=None):
        # Execute one call per durable step, including when Ollama requests a batch.
        call, *pending = turn["pending"]
        function = call.get("function") or {}
        name, args = function.get("name", ""), function.get("arguments")
        if emit:
            await emit({"type": "tool-start", "name": name})
        started = monotonic()
        try:
            if not isinstance(args, dict):
                raise ValueError("tool arguments must be an object")
            params = types.CallToolRequestParams(
                name=name, arguments=args, _meta=types.RequestParams.Meta(correlation_id=correlation_id),
            )
            result = await self.mcp.send_request(
                types.ClientRequest(types.CallToolRequest(params=params)), types.CallToolResult,
            )
            output = "\n".join(part.text for part in result.content if part.type == "text")
            failed = result.isError
        except Exception:
            output, failed = "MCP tool call failed. Check the tool name and arguments.", True
        duration = int((monotonic() - started) * 1000)
        log(self.service, correlation_id, "mcp-client", "mcp.call.completed", tool=name,
            tool_error=failed, duration_ms=duration)
        if emit:
            await emit({"type": "tool-complete", "name": name})
        event = {"name": name, "arguments": args, "result": output, "isError": failed, "durationMs": duration}
        return {**turn, "pending": pending, "tools": [*turn["tools"], event],
                "transcript": [*turn["transcript"], {"role": "tool", "tool_name": name, "content": output}]}

    async def loop(self, model, messages, correlation_id, emit=None):
        turn = new_turn(model, messages)
        while True:
            turn = await self.ask(turn, correlation_id, emit)
            if not turn["pending"]:
                return reply(turn, "loop")
            while turn["pending"]:
                turn = await self.call_next(turn, correlation_id, emit)


@asynccontextmanager
async def open_agent(service, mcp_service):
    params = StdioServerParameters(
        command=sys.executable, args=["-m", "workflow_lab.mcp_server"],
        env={**os.environ, "LAB_MCP_LOG_SOURCE": mcp_service},
    )
    async with httpx.AsyncClient(timeout=180) as http:
        async with stdio_client(params) as (reader, writer):
            async with ClientSession(reader, writer) as mcp:
                await mcp.initialize()
                yield Agent(http, mcp, service)
