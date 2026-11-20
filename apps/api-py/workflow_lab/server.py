"""Python implementation of the lab's shared HTTP API."""

import asyncio
from contextlib import asynccontextmanager
import json
import os
import re
from time import monotonic
from typing import Literal
from uuid import uuid4

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError

from .agent import APIError, MODEL, open_agent
from .streaming import chat_stream
from .graph import inspect_checkpoints, queries, run_graph
from .library import install, search
from .telemetry import ROOT, log, recent_logs
from .temporal_jobs import get_job, jobs, submit_job, temporal_chat

SERVICE = "api-python"
ID = r"^[a-zA-Z0-9_-]{16,64}$"
CONTRACT = ROOT / "apps/api/internal/httpapi/contract/openapi.yaml"
CHAT_TIMEOUT = float(os.getenv("PY_CHAT_TIMEOUT_SECONDS", "180"))
if not 0 < CHAT_TIMEOUT <= 3600:
    raise ValueError("PY_CHAT_TIMEOUT_SECONDS must be positive and no greater than 3600.")


@asynccontextmanager
async def lifespan(app):
    async with open_agent(SERVICE, "mcp-python") as agent:
        app.state.agent = agent
        log(SERVICE, "", "http", "api.started", model=MODEL)
        yield


# All four backends serve the same contract, including labeled Java-only extensions.
app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def request_trace(request: Request, call_next):
    supplied = request.headers.get("X-Correlation-ID", "")
    request.state.correlation_id = supplied if re.fullmatch(ID, supplied) else str(uuid4())
    started = monotonic()
    response = await call_next(request)
    response.headers["X-Correlation-ID"] = request.state.correlation_id
    response.headers["X-Lab-Backend"] = "python"
    if request.url.path != "/api/logs":
        route = request.scope.get("route")
        log(SERVICE, request.state.correlation_id, "http", "http.request.completed",
            method=request.method, route=getattr(route, "path", "<unmatched>"),
            status=response.status_code, duration_ms=int((monotonic() - started) * 1000))
    return response


@app.exception_handler(APIError)
async def api_error(_request, error):
    return JSONResponse({"error": str(error)}, status_code=error.status)


@app.exception_handler(Exception)
async def unexpected_error(request, error):
    correlation_id = request.state.correlation_id
    log(SERVICE, correlation_id, "http", "request.failed", level="warn", error_type=type(error).__name__)
    return JSONResponse(
        {"error": "The Python backend could not complete this request. Check Ollama, PostgreSQL, or Temporal and retry."},
        status_code=503, headers={"X-Correlation-ID": correlation_id, "X-Lab-Backend": "python"},
    )


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class Chat(BaseModel):
    messages: list[Message] = Field(min_length=1, max_length=41)
    engine: Literal["loop", "state-machine", "temporal"] = "loop"
    stream: bool = Field(default=False, strict=True)
    runId: str | None = Field(default=None, pattern=ID)
    model: str | None = Field(default=None, max_length=255)


class Job(BaseModel):
    prompt: str
    key: str | None = Field(default=None, pattern=ID)
    model: str | None = Field(default=None, max_length=255)


class Query(BaseModel, extra="forbid"):
    queryId: str
    runId: str | None = Field(default=None, pattern=ID)


class Install(BaseModel):
    model: str


# Bound the request before decoding it. Pydantic validates the parsed JSON body.
async def parse_body(request, schema, limit):
    if request.headers.get("content-type", "").partition(";")[0].strip().lower() != "application/json":
        raise APIError(415, "Send an application/json request.")
    buffer = bytearray()
    async for chunk in request.stream():
        if len(buffer) + len(chunk) > limit:
            raise APIError(413, "Request is too large.")
        buffer.extend(chunk)
    try:
        return schema.model_validate(json.loads(buffer))
    except (ValueError, ValidationError) as error:
        raise APIError(400, "The request does not match the API contract. Check the body and field limits.") from error


async def choose_model(request, name):
    name = name.strip() if name else ""
    if name and name not in await request.app.state.agent.models(request.state.correlation_id):
        raise APIError(400, "Choose an installed Ollama model that supports tools.")
    return name or MODEL


@app.get("/api/openapi.yaml")
async def openapi():
    return Response(CONTRACT.read_bytes(), media_type="application/yaml")


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/ready")
async def ready(request: Request):
    agent, correlation = request.app.state.agent, request.state.correlation_id
    try:
        if MODEL not in await agent.models(correlation):
            raise ValueError("default model unavailable")
        async with asyncio.timeout(2):
            await agent.list_tools(correlation)
    except Exception:
        return JSONResponse({"status": "unavailable", "model": MODEL,
                             "error": "Check Ollama, the default model, and the Python MCP server."}, status_code=503)
    return {"status": "ready", "model": MODEL}


@app.get("/api/models")
async def models(request: Request):
    return {"defaultModel": MODEL, "models": await request.app.state.agent.models(request.state.correlation_id)}


@app.get("/api/models/search")
async def search_models(request: Request):
    query = request.query_params.get("q", "").strip()
    if not query or len(query.encode()) > 80:
        raise APIError(400, "Enter a search query of up to 80 bytes.")
    async with asyncio.timeout(12):
        return await search(request.app.state.agent.http, query)


@app.post("/api/models/install")
async def install_model(request: Request):
    body = await parse_body(request, Install, 4096)
    return await install(request.app.state.agent, body.model.strip(), request.state.correlation_id)


@app.get("/api/tools")
async def tools(request: Request):
    async with asyncio.timeout(2):
        result = await request.app.state.agent.list_tools(request.state.correlation_id)
    return [tool.model_dump(by_alias=True, exclude_none=True) for tool in result]


@app.get("/api/logs")
async def logs():
    return await asyncio.to_thread(recent_logs)


@app.get("/api/database/queries")
async def database_queries():
    return queries


@app.post("/api/database/query")
async def database_query(request: Request):
    body = await parse_body(request, Query, 4096)
    return await inspect_checkpoints(body.queryId, body.runId)


@app.post("/api/chat")
async def chat(request: Request):
    body = await parse_body(request, Chat, 512 * 1024)
    for index, message in enumerate(body.messages):
        expected = "assistant" if index % 2 else "user"
        if message.role != expected or not message.content.strip() or (
            message.role == "user" and len(message.content.encode()) > 8000
        ):
            raise APIError(400, "Use alternating nonblank user and assistant messages.")
    if body.messages[-1].role != "user":
        raise APIError(400, "The final message must be from the user.")
    agent, correlation = request.app.state.agent, request.state.correlation_id
    messages = [message.model_dump() for message in body.messages]
    run_id = (body.runId or str(uuid4())) if body.engine != "loop" else None
    headers = {"X-Run-ID": run_id} if run_id else {}
    model = await choose_model(request, body.model)
    log(SERVICE, correlation, "chat", "chat.started", engine=body.engine, model=model)
    async def run(emit=None):
        async with asyncio.timeout(CHAT_TIMEOUT):
            if body.engine == "state-machine":
                return await run_graph(agent, model, messages, correlation, run_id, emit)
            if body.engine == "temporal":
                return await temporal_chat(model, messages, correlation, run_id, emit)
            return await agent.loop(model, messages, correlation, emit)

    if body.stream:
        return chat_stream(run, headers, correlation)
    try:
        result = await run()
    except TimeoutError:
        return JSONResponse({"error": "The chat request timed out."}, status_code=504, headers=headers)
    except APIError as error:
        return JSONResponse({"error": str(error)}, status_code=error.status, headers=headers)
    return JSONResponse(result, headers=headers)


@app.get("/api/jobs")
async def list_jobs():
    async with asyncio.timeout(5):
        return await jobs()


@app.post("/api/jobs")
async def start_job(request: Request):
    body = await parse_body(request, Job, 16 * 1024)
    prompt = body.prompt.strip()
    if not prompt or len(prompt.encode()) > 8000:
        raise APIError(400, "Enter a prompt of up to 8,000 bytes.")
    model = await choose_model(request, body.model)
    async with asyncio.timeout(5):
        job = await submit_job(model, prompt, body.key)
    request.state.correlation_id = job["id"]
    log(SERVICE, job["id"], "temporal", "workflow.submitted", model=model, workflow_id=job["id"])
    return JSONResponse(job, status_code=202, headers={"Location": "jobs/" + job["id"]})


@app.get("/api/jobs/{job_id}")
async def job_report(job_id: str):
    async with asyncio.timeout(5):
        return await get_job(job_id)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PY_API_PORT") or "8082"), access_log=False)
