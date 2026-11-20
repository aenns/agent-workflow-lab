"""LangGraph execution and read-only inspection of Python checkpoints."""

import asyncio
from contextlib import asynccontextmanager
import os
from typing import TypedDict
from uuid import uuid4

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, START, StateGraph
from psycopg import AsyncConnection
from psycopg.rows import dict_row

from .agent import APIError, fingerprint, new_turn, reply

DATABASE = os.getenv("DATABASE_URL") or "postgres://lab:lab@127.0.0.1:54329/lab?sslmode=disable"
# Give the Python saver its own tables and migration history.
SCHEMA = "workflow_lab_python"
setup_lock = asyncio.Lock()
setup_done = False
running = set()


class State(TypedDict):
    turn: dict
    fingerprint: str
    states: list[str]


@asynccontextmanager
async def open_checkpoints():
    global setup_done
    async with await AsyncConnection.connect(
        DATABASE, autocommit=True, prepare_threshold=0, row_factory=dict_row,
        connect_timeout=3, options=f"-c search_path={SCHEMA} -c statement_timeout=5000",
    ) as connection:
        saver = AsyncPostgresSaver(connection)
        async with setup_lock:
            if not setup_done:
                await connection.execute(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}")
                await saver.setup()
                setup_done = True
        yield connection, saver


async def run_graph(agent, model, messages, correlation_id, run_id=None, emit=None):
    run_id = run_id or str(uuid4())
    if run_id in running:
        raise APIError(409, "This run is already in progress.")
    running.add(run_id)
    try:
        async with open_checkpoints() as (_, saver):
            async def ask(state):
                return {"turn": await agent.ask(state["turn"], correlation_id, emit),
                        "states": [*state["states"], "Ask model"]}

            async def tool(state):
                return {"turn": await agent.call_next(state["turn"], correlation_id, emit),
                        "states": [*state["states"], "Run tools"]}

            def next_tool_or(state, fallback):
                return "tool" if state["turn"]["pending"] else fallback

            builder = StateGraph(State)
            builder.add_node("ask", ask)
            builder.add_node("tool", tool)
            builder.add_edge(START, "ask")
            builder.add_conditional_edges("ask", lambda state: next_tool_or(state, END), ["tool", END])
            builder.add_conditional_edges("tool", lambda state: next_tool_or(state, "ask"), ["tool", "ask"])
            graph = builder.compile(checkpointer=saver)
            config = {"configurable": {"thread_id": run_id}, "recursion_limit": 24}
            existing = await graph.aget_state(config)
            key = fingerprint(model, messages)
            previous = existing.values.get("fingerprint")
            if previous and previous != key:
                raise APIError(409, "This run ID belongs to a different chat request.")
            if previous and not existing.next:
                state = existing.values
            else:
                # None resumes the work scheduled by the last committed checkpoint.
                initial = None if previous else {
                    "turn": new_turn(model, messages), "fingerprint": key, "states": [],
                }
                state = await graph.ainvoke(initial, config)
            return reply(state["turn"], "state-machine", run_id, [*state["states"], "Complete"])
    finally:
        running.remove(run_id)


select_checkpoints = (
    f"SELECT thread_id AS run_id, checkpoint_id, checkpoint->>'ts' AS saved_at "
    f"FROM {SCHEMA}.checkpoints WHERE checkpoint_ns = ''"
)
queries = [
    {"id": "recent-runs", "title": "Recent runs", "description": "Latest Python checkpoint per run.",
     "requiresRunId": False, "sql": (
         f"SELECT * FROM ({select_checkpoints.replace('SELECT ', 'SELECT DISTINCT ON (thread_id) ', 1)} "
         "ORDER BY thread_id, checkpoint_id DESC) latest ORDER BY checkpoint_id DESC LIMIT 50"
     )},
    {"id": "run-history", "title": "Checkpoint history", "description": "Saved checkpoints for one Python run.",
     "requiresRunId": True, "sql": select_checkpoints + " AND thread_id = %s ORDER BY checkpoint_id DESC LIMIT 50"},
    {"id": "latest-state", "title": "Latest state", "description": "Most recent state decoded by LangGraph.",
     "requiresRunId": True, "sql": ""},
    {"id": "tool-results", "title": "Tool results", "description": "Tool calls in the latest checkpoint.",
     "requiresRunId": True, "sql": ""},
    {"id": "token-usage", "title": "Token usage", "description": "Token counts in the latest checkpoint.",
     "requiresRunId": True, "sql": ""},
]


async def inspect_checkpoints(query_id, run_id):
    query = next((item for item in queries if item["id"] == query_id), None)
    if not query or (query["requiresRunId"] and not run_id):
        raise APIError(400, "Choose a saved query and supply its run ID.")
    async with open_checkpoints() as (connection, saver):
        if query["sql"]:
            cursor = await connection.execute(query["sql"], (run_id,) if query["requiresRunId"] else ())
            return {"columns": [field.name for field in cursor.description],
                    "rows": [list(row.values()) for row in await cursor.fetchall()]}
        # Let the saver decode checkpoint values stored in its binary format.
        saved = await saver.aget_tuple({"configurable": {"thread_id": run_id}})
        state = saved.checkpoint["channel_values"] if saved else {}
        turn = state.get("turn", {})
        if query_id == "tool-results":
            columns = ["name", "arguments", "result", "isError", "durationMs"]
            return {"columns": columns, "rows": [[item.get(key) for key in columns] for item in turn.get("tools", [])]}
        if query_id == "token-usage":
            return {"columns": ["model", "call", "input_tokens", "output_tokens"], "rows": [
                [turn["model"], index, item.get("inputTokens"), item.get("outputTokens")]
                for index, item in enumerate(turn.get("usage", []), 1)
            ]}
        return {"columns": ["run_id", "state"], "rows": [[run_id, state]] if saved else []}
