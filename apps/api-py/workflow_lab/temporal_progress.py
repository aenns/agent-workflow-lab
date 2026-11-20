"""Latest-value Temporal previews, independent of durable activity results."""

import asyncio
from contextlib import asynccontextmanager, suppress
from time import monotonic

from temporalio import activity


@asynccontextmanager
async def activity_progress():
    info = activity.info()
    snapshot = {"version": 1, "type": "model", "text": "", "name": "",
                "activityId": info.activity_id, "attempt": info.attempt, "truncated": False}
    sent = 0.0

    def beat():
        nonlocal sent
        activity.heartbeat(dict(snapshot))
        sent = monotonic()

    async def emit(event):
        if event["type"] == "model-start":
            snapshot.update(type="model", text="", truncated=False)
        elif event["type"] == "text":
            text = snapshot["text"] + event["text"]
            snapshot.update(text=text[:16000], truncated=snapshot["truncated"] or len(text) > 16000)
            if monotonic() - sent < 0.4:
                return
        elif event["type"] in ("tool-start", "tool-complete"):
            snapshot.update(type=event["type"], name=event["name"], text="")
        else:
            return
        beat()

    async def keep_alive():
        while True:
            await asyncio.sleep(2)
            beat()

    timer = asyncio.create_task(keep_alive())
    try:
        yield emit
    finally:
        timer.cancel()
        with suppress(asyncio.CancelledError):
            await timer


def progress_event(snapshot):
    if not isinstance(snapshot, dict) or snapshot.get("version") != 1:
        return None
    if snapshot.get("type") == "model":
        return {"type": "model-snapshot", **{key: snapshot[key] for key in (
            "text", "activityId", "attempt", "truncated",
        )}}
    if snapshot.get("type") in ("tool-start", "tool-complete"):
        return {"type": snapshot["type"], "name": snapshot["name"]}
