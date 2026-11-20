"""Structured records shared by the API, worker, and MCP subprocesses."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
DIRECTORY = ROOT / (os.getenv("LAB_LOG_DIR") or ".lab/logs")
LIMIT = 512 * 1024
SOURCES = (
    "api", "api-mcp", "temporal-worker", "worker-mcp",
    "api-typescript", "mcp-typescript", "mcp-worker-typescript", "temporal-worker-typescript",
    "api-python", "mcp-python", "mcp-worker-python", "temporal-worker-python",
    "api-java", "mcp-java", "temporal-worker-java", "mcp-worker-java", "restate-java", "mcp-restate-java",
)


def log(service, correlation_id, component, message, **fields):
    record = {
        "time": datetime.now(timezone.utc).isoformat(), "level": "info", "msg": message,
        "service": service, "backend": "python", "component": component,
        "correlation_id": correlation_id, **fields,
    }
    line = (json.dumps(record, ensure_ascii=False) + "\n").encode()
    print(line.decode().rstrip("\n"), file=sys.stderr, flush=True)
    try:
        DIRECTORY.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = DIRECTORY / f"{service}.jsonl"
        if path.exists() and path.stat().st_size + len(line) > LIMIT:
            path.replace(path.with_suffix(".jsonl.previous"))
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, "ab") as output:
            output.write(line)
    except OSError:
        # Stderr stays available if the optional local copy fails.
        pass


def recent_logs():
    entries = []
    for source in SOURCES:
        for suffix in (".jsonl", ".jsonl.previous"):
            try:
                with (DIRECTORY / (source + suffix)).open("rb") as source_file:
                    size = os.fstat(source_file.fileno()).st_size
                    source_file.seek(max(0, size - LIMIT))
                    if size > LIMIT:
                        source_file.readline()
                    lines = source_file.read(LIMIT).splitlines()
            except FileNotFoundError:
                continue
            for line in lines:
                try:
                    entry = json.loads(line)
                    if not isinstance(entry["msg"], str):
                        continue
                    timestamp = datetime.fromisoformat(entry["time"]).timestamp()
                    entries.append((timestamp, entry))
                except (ValueError, TypeError, KeyError):
                    continue
    entries.sort(key=lambda item: item[0], reverse=True)
    return [entry for _, entry in entries[:500]]
