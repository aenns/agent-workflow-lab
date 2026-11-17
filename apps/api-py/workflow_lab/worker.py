"""Run the Python Temporal worker and its local MCP child."""

import asyncio
import os
import signal

from temporalio import activity
from temporalio.worker import Worker

from .agent import open_agent
from .telemetry import log
from .temporal_jobs import QUEUE, get_client
from .workflows import InventoryPython

SERVICE = "temporal-worker-python"


async def main():
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, stop.set)

    async with open_agent(SERVICE, "mcp-worker-python") as agent:
        @activity.defn(name="python_ask")
        async def ask(turn: dict, correlation_id: str) -> dict:
            return await agent.ask(turn, correlation_id)

        @activity.defn(name="python_call_tool")
        async def call_tool(turn: dict, correlation_id: str) -> dict:
            return await agent.call_next(turn, correlation_id)

        async with Worker(await get_client(), task_queue=QUEUE, workflows=[InventoryPython],
                          activities=[ask, call_tool], identity=os.getenv("LAB_WORKER_IDENTITY")):
            log(SERVICE, "", "worker", "worker.started", task_queue=QUEUE)
            await stop.wait()


if __name__ == "__main__":
    asyncio.run(main())
