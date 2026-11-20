"""Bridge async engine callbacks to a bounded, cancellable NDJSON response."""

import asyncio
from contextlib import suppress
import json

from fastapi.responses import StreamingResponse

from .agent import APIError
from .telemetry import log


def chat_stream(run, headers, correlation_id):
    async def records():
        # Bounded buffering applies backpressure if the browser reads slowly.
        queue = asyncio.Queue(maxsize=16)

        async def produce():
            try:
                result = await run(queue.put)
                log("api-python", correlation_id, "chat", "chat.completed", stream=True,
                    engine=result["engine"], model=result["model"], tool_count=len(result["tools"]))
                await queue.put({"type": "complete", "reply": result})
            except Exception as error:
                log("api-python", correlation_id, "chat", "chat.failed", level="warn",
                    error_type=type(error).__name__, stream=True)
                message = str(error) if isinstance(error, APIError) else (
                    "The chat request timed out." if isinstance(error, TimeoutError)
                    else "The streaming request failed. Try again or resume the saved run."
                )
                await queue.put({"type": "error", "error": message})

        task = asyncio.create_task(produce())
        try:
            while True:
                event = await queue.get()
                yield json.dumps(event, ensure_ascii=False) + "\n"
                if event["type"] in ("complete", "error"):
                    break
        finally:
            # StreamingResponse cancels the iterator on a client disconnect.
            # Also cancel model I/O and release any graph run lock immediately.
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    return StreamingResponse(records(), media_type="application/x-ndjson",
                             headers={**headers, "Cache-Control": "no-store", "X-Accel-Buffering": "no"})
