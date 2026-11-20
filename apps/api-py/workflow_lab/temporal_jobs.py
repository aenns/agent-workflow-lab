"""Temporal submissions and visibility for the Python task queue."""

import asyncio
from datetime import timedelta
from contextlib import suppress
import json
import os
from uuid import uuid4

from temporalio.client import Client, WorkflowExecutionStatus, WorkflowFailureError
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from .agent import APIError, fingerprint, new_turn
from .temporal_progress import progress_event

ADDRESS = os.getenv("TEMPORAL_ADDR") or "127.0.0.1:7233"
QUEUE = "workflow-lab-python"
JOB_PREFIX = "lab-py-job-"
client_lock = asyncio.Lock()
connection = None


async def get_client():
    global connection
    async with client_lock:
        if connection is None:
            async with asyncio.timeout(3):
                connection = await Client.connect(ADDRESS)
    return connection


async def start(model, messages, workflow_id, correlation_id, prompt=None):
    client = await get_client()
    key = fingerprint(model, messages)
    memo = {"fingerprint": key, "model": model, "correlationId": correlation_id}
    if prompt is not None:
        memo["prompt"] = prompt
    try:
        return await client.start_workflow(
            "InventoryPython", {"turn": new_turn(model, messages), "runId": workflow_id,
                                "correlationId": correlation_id},
            id=workflow_id, task_queue=QUEUE, id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
            execution_timeout=timedelta(hours=24) if prompt else timedelta(minutes=20),
            memo=memo,
        )
    except WorkflowAlreadyStartedError:
        # Retried submissions reuse the workflow only if the original request matches.
        handle = client.get_workflow_handle(workflow_id)
        existing = await (await handle.describe()).memo()
        if existing.get("fingerprint") != key:
            raise APIError(409, "This ID belongs to a different request.")
        return handle


async def temporal_chat(model, messages, correlation_id, run_id, emit=None):
    if run_id.startswith(JOB_PREFIX):
        raise APIError(400, "Choose a chat run ID.")
    handle = await start(model, messages, run_id, correlation_id)
    try:
        # Cancelling this wait leaves the workflow itself running.
        if emit is None:
            return await handle.result()
        client = await get_client()
        result = asyncio.create_task(handle.result())
        last = None
        try:
            await emit({"type": "status", "message": "Waiting for a Temporal worker…"})
            while not result.done():
                info = await handle.describe()
                for pending in info.raw_description.pending_activities:
                    if not pending.heartbeat_details.payloads:
                        continue
                    values = await client.data_converter.decode(pending.heartbeat_details.payloads)
                    event = progress_event(values[0]) if values else None
                    key = json.dumps(event)
                    if event and key != last:
                        await emit(event)
                        last = key
                await asyncio.wait({result}, timeout=0.5)
            return await result
        finally:
            result.cancel()
            with suppress(asyncio.CancelledError):
                await result
    except WorkflowFailureError as error:
        raise APIError(502, "The Temporal workflow could not complete this chat.") from error


async def summary(execution):
    memo = await execution.memo()
    status = execution.status
    return {
        "id": execution.id, "model": memo["model"], "prompt": memo["prompt"],
        "correlationId": memo["correlationId"], "startedAt": execution.start_time.isoformat(),
        **({"finishedAt": execution.close_time.isoformat()} if execution.close_time else {}),
        "status": "completed" if status == WorkflowExecutionStatus.COMPLETED else
                  "running" if status == WorkflowExecutionStatus.RUNNING else "failed",
    }


async def submit_job(model, prompt, key):
    job_id = JOB_PREFIX + (key or str(uuid4()))
    handle = await start(model, [{"role": "user", "content": prompt}], job_id, job_id, prompt)
    return await summary(await handle.describe())


async def jobs():
    result = []
    async for record in (await get_client()).list_workflows(
        "WorkflowType = 'InventoryPython' AND WorkflowId STARTS_WITH 'lab-py-job-'", limit=50,
    ):
        result.append(await summary(record))
    return result


async def get_job(job_id):
    if not job_id.startswith(JOB_PREFIX):
        raise APIError(404, "Job not found.")
    handle = (await get_client()).get_workflow_handle(job_id)
    try:
        result = await summary(await handle.describe())
        if result["status"] == "completed":
            result["report"] = await handle.result()
        return result
    except RPCError as error:
        if error.status == RPCStatusCode.NOT_FOUND:
            raise APIError(404, "Job not found.") from error
        raise
