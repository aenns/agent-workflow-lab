"""Exercise the Python HTTP API with simulated Ollama and a real MCP child."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
from threading import Thread
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from workflow_lab.server import CONTRACT, app

CORRELATION_ID = "test-python-correlated-turn"


@contextmanager
def mock_ollama():
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            response = json.dumps({"models": [{"name": "qwen3:14b"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append((self.headers.get("X-Correlation-ID"), body))
            if self.path == "/api/pull":
                response = b'{"status":"downloading","completed":1,"total":1}\n{"status":"success"}\n'
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)
                return
            steps = [
                ("lookup_inventory", {"sku": "LAMP-42"}),
                ("warehouse_hours", {"warehouse": "north"}),
            ]
            message = {"role": "assistant", "content": "Seven lamps at the north warehouse."}
            index = sum(message["role"] == "tool" for message in body["messages"])
            if index < len(steps):
                name, arguments = steps[index]
                message = {"role": "assistant", "content": "",
                           "tool_calls": [{"function": {"name": name, "arguments": arguments}}]}
            if body.get("stream"):
                chunks = [{"message": message, "done": False}]
                if not any(message["content"] == "broken-stream" for message in body["messages"]):
                    chunks.append({"message": {"role": "assistant", "content": ""}, "done": True,
                                   "prompt_eval_count": 10, "eval_count": 2})
                response = "".join(json.dumps(chunk) + "\n" for chunk in chunks).encode()
            else:
                response = json.dumps({"message": message, "prompt_eval_count": 10, "eval_count": 2}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}", calls
        finally:
            server.shutdown()
            thread.join()


class PythonBackendTest(unittest.TestCase):
    def test_contract_and_correlated_tool_chain(self):
        with mock_ollama() as (url, calls), tempfile.TemporaryDirectory() as directory:
            with patch("workflow_lab.agent.OLLAMA", url), patch("workflow_lab.telemetry.DIRECTORY", Path(directory)):
                with patch.dict("os.environ", {"LAB_LOG_DIR": directory}), TestClient(app) as client:
                    self.assertEqual(client.get("/api/openapi.yaml").content, CONTRACT.read_bytes())
                    self.assertEqual(client.get("/api/ready").status_code, 200)
                    response = client.post("/api/chat", headers={"X-Correlation-ID": CORRELATION_ID},
                                           json={"messages": [{"role": "user", "content": "Stock and pickup hours?"}]})
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.headers["X-Lab-Backend"], "python")
                    self.assertEqual(response.headers["X-Correlation-ID"], CORRELATION_ID)
                    result = response.json()
                    self.assertEqual([event["name"] for event in result["tools"]], [
                        "lookup_inventory", "warehouse_hours",
                    ])
                    self.assertTrue(all(not event["isError"] for event in result["tools"]))
                    self.assertEqual(result["usage"], [{"inputTokens": 10, "outputTokens": 2}] * 3)
                    self.assertTrue(all(correlation == CORRELATION_ID for correlation, _ in calls))
                    self.assertEqual(json.loads(calls[1][1]["messages"][-1]["content"])["stock"], 7)
                    self.assertIn("09:00", calls[2][1]["messages"][-1]["content"])
                    logs = [event for event in client.get("/api/logs").json()
                            if event.get("correlation_id") == CORRELATION_ID]
                    self.assertTrue(all(event["backend"] == "python" for event in logs))
                    self.assertEqual({event["service"] for event in logs}, {"api-python", "mcp-python"})
                    invalid = client.post("/api/chat", json={
                        "messages": [{"role": "assistant", "content": "Invalid first role"}],
                    })
                    self.assertEqual(invalid.status_code, 400)


    def test_model_install_stream(self):
        with mock_ollama() as (url, calls), tempfile.TemporaryDirectory() as directory:
            with patch("workflow_lab.library.OLLAMA", url), patch("workflow_lab.library.has_manifest", return_value=True):
                with patch("workflow_lab.telemetry.DIRECTORY", Path(directory)):
                    with patch.dict("os.environ", {"LAB_LOG_DIR": directory}), TestClient(app) as client:
                        with client.stream("POST", "/api/models/install", json={"model": "qwen3:14b"},
                                           headers={"X-Correlation-ID": CORRELATION_ID}) as response:
                            self.assertEqual(response.status_code, 200)
                            self.assertIn("application/x-ndjson", response.headers["Content-Type"])
                            self.assertEqual([json.loads(line)["status"] for line in response.iter_lines()],
                                             ["downloading", "success"])
                    self.assertEqual(calls, [(CORRELATION_ID, {"model": "qwen3:14b", "stream": True})])


    def test_chat_stream_and_incomplete_response(self):
        with mock_ollama() as (url, calls), tempfile.TemporaryDirectory() as directory:
            with patch("workflow_lab.agent.OLLAMA", url), patch("workflow_lab.telemetry.DIRECTORY", Path(directory)):
                with patch.dict("os.environ", {"LAB_LOG_DIR": directory}), TestClient(app) as client:
                    response = client.post("/api/chat", headers={"X-Correlation-ID": CORRELATION_ID}, json={
                        "stream": True, "messages": [{"role": "user", "content": "Stock and hours?"}],
                    })
                    self.assertEqual(response.status_code, 200)
                    self.assertIn("application/x-ndjson", response.headers["Content-Type"])
                    self.assertEqual(response.headers["X-Correlation-ID"], CORRELATION_ID)
                    events = [json.loads(line) for line in response.iter_lines()]
                    self.assertEqual(events[-1]["type"], "complete")
                    self.assertEqual([event["name"] for event in events if event["type"] == "tool-start"],
                                     ["lookup_inventory", "warehouse_hours"])
                    self.assertEqual(sum(event["type"] == "tool-complete" for event in events), 2)
                    self.assertEqual(events[-1]["reply"]["usage"], [{"inputTokens": 10, "outputTokens": 2}] * 3)
                    self.assertEqual("".join(event["text"] for event in events if event["type"] == "text"),
                                     events[-1]["reply"]["message"]["content"])
                    response = client.post("/api/chat", json={
                        "stream": True, "messages": [{"role": "user", "content": "broken-stream"}],
                    })
                    events = [json.loads(line) for line in response.iter_lines()]
                    self.assertEqual(events[-1]["type"], "error")
                    self.assertFalse(any(event["type"] == "complete" for event in events))
                    response = client.post("/api/chat", json={
                        "stream": "true", "engine": "temporal", "messages": [{"role": "user", "content": "Hello"}],
                    })
                    self.assertEqual(response.status_code, 400)
