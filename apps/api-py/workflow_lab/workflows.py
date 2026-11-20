"""Replay-safe Temporal orchestration. Network calls live in activities."""

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

ACTIVITY_TIMEOUT = timedelta(minutes=3)
RETRY = RetryPolicy(maximum_attempts=3)


@workflow.defn(name="InventoryPython")
class InventoryPython:
    @workflow.run
    async def run(self, request: dict) -> dict:
        turn = request["turn"]
        correlation_id = request["correlationId"]
        while True:
            turn = await workflow.execute_activity(
                "python_ask", args=[turn, correlation_id], start_to_close_timeout=ACTIVITY_TIMEOUT, heartbeat_timeout=timedelta(seconds=10),
                retry_policy=RETRY,
            )
            if not turn["pending"]:
                return {"engine": "temporal", "model": turn["model"], "runId": request["runId"],
                        "usage": turn["usage"], "tools": turn["tools"],
                        "message": {"role": "assistant", "content": turn["transcript"][-1]["content"]}}
            while turn["pending"]:
                turn = await workflow.execute_activity(
                    "python_call_tool", args=[turn, correlation_id], start_to_close_timeout=ACTIVITY_TIMEOUT, heartbeat_timeout=timedelta(seconds=10),
                    retry_policy=RETRY,
                )
