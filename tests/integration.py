"""Cross-language integration tests using isolated real PostgreSQL and Temporal."""

from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
from threading import Thread
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
PROMPT = "Check stock and pickup hours for LAMP-42."
TOOLS = ["lookup_inventory", "warehouse_hours"]


def eventually(check, seconds=25):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.25)
    raise AssertionError(f"Condition did not become true within {seconds} seconds.")


def request(base, path, body=None, correlation=None):
    headers = {"Content-Type": "application/json"}
    if correlation:
        headers["X-Correlation-ID"] = correlation
    req = Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    try:
        response = urlopen(req, timeout=25)
    except HTTPError as error:
        response = error
    with response:
        return response.status, response.headers, json.load(response)


@contextmanager
def ollama_stub():
    calls = []
    fail_after_inventory = set()

    class OllamaHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.respond(200, {"models": [{"name": "test-model:latest", "capabilities": ["tools"]}]})

        def do_POST(self):
            self.assert_path()
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            correlation = self.headers.get("X-Correlation-ID")
            results = [message for message in payload["messages"] if message["role"] == "tool"]
            calls.append((correlation, [message.get("tool_name") for message in results]))
            if correlation in fail_after_inventory and len(results) == 1:
                fail_after_inventory.remove(correlation)
                return self.respond(500, {"error": "Simulated Ollama failure after inventory"})
            if results:
                # The warehouse argument comes from the actual MCP inventory result.
                warehouse = json.loads(results[0]["content"])["warehouse"]
            if len(results) == 0:
                message = self.tool(TOOLS[0], {"sku": "LAMP-42"})
            elif len(results) == 1:
                message = self.tool(TOOLS[1], {"warehouse": warehouse})
            else:
                hours = json.loads(results[1]["content"])["pickupHours"]
                message = {"role": "assistant", "content": f"7 lamps at {warehouse}. {hours}"}
            if payload.get("stream"):
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.end_headers()
                # Send separate records, including a UTF-8 character, to exercise
                # adapters instead of disguising a complete JSON reply as a stream.
                chunks = [{"message": message, "done": False}]
                if not message.get("tool_calls"):
                    content = message["content"] + " Café"
                    chunks = [{"message": {"role": "assistant", "content": part}, "done": False}
                              for part in [content[:7], content[7:]]]
                chunks.append({"message": {"role": "assistant", "content": ""}, "done": True,
                               "prompt_eval_count": 12, "eval_count": 4})
                if correlation.startswith("temporal-stream-") and not message.get("tool_calls"):
                    content = message["content"] + " Café — a streamed Temporal response."
                    chunks = [{"message": {"role": "assistant", "content": character}, "done": False}
                              for character in content]
                    chunks.append({"message": {"role": "assistant", "content": ""}, "done": True,
                                   "prompt_eval_count": 12, "eval_count": 4})
                try:
                    for chunk in chunks:
                        self.wfile.write((json.dumps(chunk, ensure_ascii=False) + "\n").encode())
                        self.wfile.flush()
                        if correlation.startswith("temporal-stream-"):
                            time.sleep(0.08)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # A worker killed during the restart test closes Ollama.
            else:
                self.respond(200, {"message": message, "prompt_eval_count": 12, "eval_count": 4})

        def assert_path(self):
            if self.path != "/api/chat":
                raise AssertionError(f"Unexpected Ollama request: {self.path}")

        @staticmethod
        def tool(name, arguments):
            return {"role": "assistant", "content": "", "tool_calls": [
                {"function": {"name": name, "arguments": arguments}},
            ]}

        def respond(self, status, payload):
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode())

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), OllamaHandler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}", calls, fail_after_inventory
        finally:
            server.shutdown()
            thread.join()


@contextmanager
def services(directory):
    # Docker chooses host ports and the unique project owns its volumes.
    override = directory / "ports.yaml"
    override.write_text('''services:
  postgres:
    ports: !override ["127.0.0.1::5432"]
  temporal:
    ports: !override ["127.0.0.1::7233"]
''')
    compose = ["docker", "compose", "-p", "workflow-lab-test-" + uuid4().hex[:10],
               "-f", str(ROOT / "compose.yaml"), "-f", str(override)]

    def port(service, target):
        return subprocess.check_output([*compose, "port", service, str(target)], text=True, timeout=10).strip()

    try:
        subprocess.run([*compose, "up", "-d", "--wait", "--wait-timeout", "90", "postgres", "temporal"], check=True, timeout=180)
        yield f"postgres://lab:lab@{port('postgres', 5432)}/lab?sslmode=disable", port("temporal", 7233)
    finally:
        subprocess.run([*compose, "down", "-v"], check=True, timeout=60)


@contextmanager
def process(arguments, cwd, env, logfile):
    with logfile.open("ab") as output:
        child = subprocess.Popen(arguments, cwd=cwd, env=env, stdout=output, stderr=output,
                                 start_new_session=True)
        try:
            yield child
        finally:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class BackendIntegration(unittest.TestCase):
    def test_each_backend(self):
        with tempfile.TemporaryDirectory(prefix="workflow-lab-integration-") as temp:
            directory = Path(temp)
            binary = directory / "lab-go"
            subprocess.run(["go", "build", "-o", binary, "./apps/api/cmd/api"], cwd=ROOT, check=True, timeout=120)
            with services(directory) as (database, temporal), ollama_stub() as (ollama, calls, failure):
                backends = [
                    ("go", ROOT, [binary], [binary, "temporal-worker"], "lab-job-"),
                    ("typescript", ROOT / "apps/api-ts", ["node", "src/server.ts"], ["node", "src/worker.ts"], "lab-ts-job-"),
                    ("python", ROOT / "apps/api-py", [".venv/bin/python", "-m", "workflow_lab.server"],
                     [".venv/bin/python", "-m", "workflow_lab.worker"], "lab-py-job-"),
                ]
                java_dir = ROOT / "apps/api-java"
                if (java_dir / "target/classes/lab/Main.class").is_file():
                    java = ["java", "-cp", "target/classes:target/dependency/*", "lab.Main"]
                    backends.append(("java", java_dir, [*java, "api"], [*java, "temporal-worker"], "lab-java-job-"))
                for name, cwd, api, worker, prefix in backends:
                    with self.subTest(backend=name):
                        print(f"Testing {name} checkpoint recovery and queued jobs", flush=True)
                        port = free_port()
                        env = {**os.environ, "DATABASE_URL": database, "TEMPORAL_ADDR": temporal,
                               "OLLAMA_URL": ollama, "OLLAMA_MODEL": "test-model:latest",
                               "API_ADDR": f"127.0.0.1:{port}", "TS_API_PORT": str(port), "PY_API_PORT": str(port), "JAVA_API_PORT": str(port),
                               "LAB_LOG_DIR": str(directory / name)}
                        log = directory / f"{name}.log"
                        try:
                            self.exercise(f"http://127.0.0.1:{port}", cwd, api, worker, prefix,
                                          env, log, calls, failure)
                        except Exception as error:
                            raise AssertionError(f"{name} failed: {error}\n{log.read_text()[-6000:]}") from error

    def exercise(self, base, cwd, api, worker, prefix, env, log, calls, failure):
        correlation = str(uuid4())
        job_key = str(uuid4())
        job_id = prefix + job_key
        chat = {"engine": "state-machine", "runId": correlation,
                "messages": [{"role": "user", "content": PROMPT}]}

        def ready(child):
            if child.poll() is not None:
                raise AssertionError(f"API exited with {child.returncode}")
            try:
                return request(base, "/api/ready")[0] == 200
            except URLError:
                return False

        # Fail after a completed MCP call, then restart the whole API process.
        failure.add(correlation)
        with process(api, cwd, env, log) as child:
            eventually(lambda: ready(child))
            status, headers, payload = request(base, "/api/chat", chat, correlation)
            self.assertEqual(status, 502, payload)
            self.assertEqual(headers["X-Correlation-ID"], correlation)

        with process(api, cwd, env, log) as child:
            eventually(lambda: ready(child))
            status, _, recovered = request(base, "/api/chat", chat, correlation)
            self.assertEqual(status, 200, recovered)
            self.assert_reply(recovered)
            self.assertEqual(recovered["runId"], correlation)
            # The resumed attempt starts with the saved inventory result.
            self.assertEqual([len(results) for cid, results in calls if cid == correlation], [0, 1, 1, 2])
            self.assertEqual(request(base, "/api/chat", chat, correlation)[2], recovered)
            self.assertEqual(request(base, "/api/chat", {**chat, "messages": [
                {"role": "user", "content": "Different input"},
            ]}, correlation)[0], 409)
            status, _, inspected = request(base, "/api/database/query", {"queryId": "token-usage", "runId": correlation})
            self.assertEqual(status, 200, inspected)
            self.assertEqual(len(inspected["rows"]), 3)

            self.exercise_streams(base, calls, failure)
            self.exercise_temporal_stream(base, cwd, worker, env, log, calls)

            submission = {"prompt": PROMPT, "key": job_key}
            status, headers, queued = request(base, "/api/jobs", submission, job_id)
            self.assertEqual(status, 202, queued)
            self.assertEqual(headers["X-Correlation-ID"], job_id)
            self.assertEqual(queued["id"], job_id)
            self.assertEqual(request(base, "/api/jobs", submission, job_id)[2]["id"], job_id)
            self.assertEqual(request(base, "/api/jobs", {**submission, "prompt": "Different audit"}, job_id)[0], 409)
            _, _, waiting = request(base, f"/api/jobs/{job_id}")
            self.assertEqual(waiting["status"], "running")
            self.assertIsNone(waiting.get("report"))
            self.assertFalse(any(cid == job_id for cid, _ in calls))
            self.assertEqual(request(base, "/api/health")[0], 200)

            def completed():
                status, _, report = request(base, f"/api/jobs/{job_id}")
                self.assertEqual(status, 200, report)
                self.assertNotEqual(report["status"], "failed", report)
                return report if report["status"] == "completed" else None

            with process(worker, cwd, env, log) as worker_child:
                def worker_completion():
                    if worker_child.poll() is not None:
                        raise AssertionError(f"Worker exited with {worker_child.returncode}")
                    return completed()

                finished = eventually(worker_completion, seconds=45)
                self.assertEqual(finished["id"], job_id)
                self.assert_reply(finished["report"])
                entries = request(base, "/api/logs")[2]
                scoped = [entry for entry in entries if entry.get("correlation_id") == job_id]
                self.assertTrue(any(entry["service"].startswith("api") for entry in scoped), scoped)
                self.assertTrue(any(entry["service"].startswith("temporal-worker") for entry in scoped), scoped)
                self.assertTrue(any(entry["service"].startswith("mcp") for entry in scoped), scoped)

    def stream(self, base, body, correlation, notify=None):
        req = Request(base + "/api/chat", data=json.dumps(body).encode(), headers={
            "Content-Type": "application/json", "X-Correlation-ID": correlation,
        })
        with urlopen(req, timeout=25) as response:
            self.assertEqual(response.status, 200)
            self.assertIn("application/x-ndjson", response.headers["Content-Type"])
            self.assertEqual(response.headers["X-Correlation-ID"], correlation)
            events = []
            for line in response:
                if not line.strip():
                    continue
                event = json.loads(line)
                events.append(event)
                if notify:
                    notify(event)
            return events

    def exercise_streams(self, base, calls, failure):
        for engine in ["loop", "state-machine"]:
            correlation = str(uuid4())
            body = {"stream": True, "engine": engine, "runId": correlation,
                    "messages": [{"role": "user", "content": PROMPT}]}
            events = self.stream(base, body, correlation)
            self.assertEqual(events[-1]["type"], "complete", events)
            reply = events[-1]["reply"]
            self.assert_reply(reply)
            self.assertEqual([event["name"] for event in events if event["type"] == "tool-start"], TOOLS)
            self.assertEqual([event["name"] for event in events if event["type"] == "tool-complete"], TOOLS)
            self.assertEqual(sum(event["type"] == "model-start" for event in events), 3)
            self.assertEqual("".join(event["text"] for event in events if event["type"] == "text"),
                             reply["message"]["content"])
            self.assertIn("Café", reply["message"]["content"])
            self.assertEqual([len(results) for cid, results in calls if cid == correlation], [0, 1, 2])
            if engine == "state-machine":
                cached = self.stream(base, body, correlation)
                self.assertEqual([event["type"] for event in cached], ["complete"])
                self.assertEqual(cached[0]["reply"], reply)
                # Failure after inventory checkpoints must send a terminal error,
                # then resume without executing the completed inventory tool again.
                correlation = str(uuid4())
                body["runId"] = correlation
                failure.add(correlation)
                failed = self.stream(base, body, correlation)
                self.assertEqual(failed[-1]["type"], "error", failed)
                self.assertFalse(any(event["type"] == "complete" for event in failed))
                recovered = self.stream(base, body, correlation)
                self.assertEqual(recovered[-1]["type"], "complete", recovered)
                self.assert_reply(recovered[-1]["reply"])
                self.assertEqual([event["name"] for event in recovered if event["type"] == "tool-start"], [TOOLS[1]])
                self.assertEqual([len(results) for cid, results in calls if cid == correlation], [0, 1, 1, 2])
        status, _, _ = request(base, "/api/chat", {
            "engine": "temporal", "stream": "true", "messages": [{"role": "user", "content": PROMPT}],
        })
        self.assertEqual(status, 400)

    def exercise_temporal_stream(self, base, cwd, worker, env, log, calls):
        correlation = "temporal-stream-" + str(uuid4())
        body = {"stream": True, "engine": "temporal", "runId": correlation,
                "messages": [{"role": "user", "content": PROMPT}]}
        # Closing the first browser connection must leave the accepted workflow
        # queued. A second connection with the same ID attaches to that run.
        req = Request(base + "/api/chat", data=json.dumps(body).encode(), headers={
            "Content-Type": "application/json", "X-Correlation-ID": correlation,
        })
        with urlopen(req, timeout=25) as response:
            self.assertEqual(json.loads(response.readline())["type"], "status")
        observed = []
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(self.stream, base, body, correlation, observed.append)
            eventually(lambda: bool(observed))
            self.assertFalse(future.done())
            self.assertFalse(any(cid == correlation for cid, _ in calls))
            with process(worker, cwd, env, log) as worker_child:
                eventually(lambda: any(event["type"] == "model-snapshot" and event["text"] for event in observed), 30)
                # Hard failure after visible text forces retry of just the
                # unfinished model activity, using its existing activity ID.
                os.killpg(worker_child.pid, signal.SIGKILL)
            self.assertFalse(future.done(), "workflow finished before the worker interruption")
            with process(worker, cwd, env, log):
                events = future.result(timeout=45)
        self.assertEqual(events[-1]["type"], "complete", events)
        self.assert_reply(events[-1]["reply"])
        previews = [event for event in events if event["type"] == "model-snapshot" and event["text"]]
        self.assertTrue(any(event["attempt"] == 1 for event in previews), previews)
        self.assertTrue(any(event["attempt"] > 1 for event in previews), previews)
        # Completed inventory/hours activities do not repeat after model retry.
        self.assertEqual([len(results) for cid, results in calls if cid == correlation], [0, 1, 2, 2])
        cached = self.stream(base, body, correlation)
        self.assertEqual(cached[-1]["type"], "complete")
        self.assertEqual(cached[-1]["reply"], events[-1]["reply"])
        self.assertFalse(any(event["type"] == "model-snapshot" for event in cached))

    def assert_reply(self, reply):
        self.assertEqual([tool["name"] for tool in reply["tools"]], TOOLS)
        self.assertTrue(all(not tool["isError"] for tool in reply["tools"]))
        self.assertEqual(reply["usage"], [{"inputTokens": 12, "outputTokens": 4}] * 3)
        self.assertIn("09:00", reply["message"]["content"])


if __name__ == "__main__":
    unittest.main()
