"""Streaming lifecycle tests that do not require Ollama or a database."""

import asyncio
import json
import unittest

from workflow_lab.streaming import chat_stream


class StreamingLifecycleTest(unittest.IsolatedAsyncioTestCase):
    async def test_closing_response_iterator_cancels_model_work(self):
        stopped = asyncio.Event()

        async def run(emit):
            try:
                await emit({"type": "model-start"})
                await asyncio.Event().wait()
            finally:
                stopped.set()

        response = chat_stream(run, {}, "stream-cancel-test")
        iterator = response.body_iterator
        self.assertEqual(json.loads(await anext(iterator)), {"type": "model-start"})
        await iterator.aclose()
        self.assertTrue(stopped.is_set(), "disconnected response left model work running")

    async def test_unexpected_failure_is_terminal_and_does_not_expose_internals(self):
        async def run(emit):
            await emit({"type": "text", "text": "draft"})
            raise ValueError("private internal detail")

        response = chat_stream(run, {}, "stream-failure-test")
        events = [json.loads(record) async for record in response.body_iterator]
        self.assertEqual([event["type"] for event in events], ["text", "error"])
        self.assertNotIn("private internal detail", events[-1]["error"])

    async def test_heartbeat_preview_caps_text_and_resets_drafts(self):
        from temporalio.testing import ActivityEnvironment
        from workflow_lab.temporal_progress import activity_progress, progress_event
        from unittest.mock import patch

        environment = ActivityEnvironment()
        heartbeats = []
        environment.on_heartbeat = lambda snapshot: heartbeats.append(snapshot)

        async def run():
            async with activity_progress() as emit:
                await emit({"type": "model-start"})
                await emit({"type": "text", "text": "x" * 17000})
                await emit({"type": "model-start"})

        # Advance time at each call without sleeping through the throttle window.
        with patch("workflow_lab.temporal_progress.monotonic", side_effect=[1, 2, 3, 4]):
            await environment.run(run)
        preview = progress_event(heartbeats[1])
        self.assertEqual(len(preview["text"]), 16000)
        self.assertTrue(preview["truncated"])
        self.assertEqual(progress_event(heartbeats[-1])["text"], "")
        self.assertFalse(progress_event(heartbeats[-1])["truncated"])
