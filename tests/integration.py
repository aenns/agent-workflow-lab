"""Cross-language integration tests using isolated real PostgreSQL and Temporal."""

from contextlib import contextmanager
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
        subprocess.run([*compose, "up", "-d", "--wait", "--wait-timeout", "90"], check=True, timeout=180)
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
                for name, cwd, api, worker, prefix in backends:
                    with self.subTest(backend=name):
                        print(f"Testing {name} checkpoint recovery and queued jobs", flush=True)
                        port = free_port()
                        env = {**os.environ, "DATABASE_URL": database, "TEMPORAL_ADDR": temporal,
                               "OLLAMA_URL": ollama, "OLLAMA_MODEL": "test-model:latest",
                               "API_ADDR": f"127.0.0.1:{port}", "TS_API_PORT": str(port), "PY_API_PORT": str(port),
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

    def assert_reply(self, reply):
        self.assertEqual([tool["name"] for tool in reply["tools"]], TOOLS)
        self.assertTrue(all(not tool["isError"] for tool in reply["tools"]))
        self.assertEqual(reply["usage"], [{"inputTokens": 12, "outputTokens": 4}] * 3)
        self.assertIn("09:00", reply["message"]["content"])


if __name__ == "__main__":
    unittest.main()
