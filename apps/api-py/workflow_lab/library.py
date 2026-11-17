"""Public Ollama tag discovery and local NDJSON download progress."""

import asyncio
from html.parser import HTMLParser
import json
import re

from anyio import CancelScope
from fastapi.responses import StreamingResponse
import httpx

from .agent import APIError, OLLAMA
from .telemetry import log

TAG = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}(?::[a-z0-9][a-z0-9._-]{0,63})?", re.IGNORECASE)
download = asyncio.Lock()


class LibraryLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = []

    def handle_starttag(self, tag, attrs):
        path = dict(attrs).get("href") if tag == "a" else None
        if path and path.startswith("/library/") and TAG.fullmatch(path[9:]):
            self.tags.append(path[9:])


async def has_manifest(http, tag):
    family, _, variant = tag.partition(":")
    response = await http.get(f"https://registry.ollama.ai/v2/library/{family}/manifests/{variant or 'latest'}", timeout=8)
    if response.status_code == 404:
        return False
    response.raise_for_status()
    return any(layer["mediaType"] == "application/vnd.ollama.image.model"
               for layer in response.json().get("layers", []))


async def search(http, query):
    async def find(path, **options):
        response = await http.get("https://ollama.com" + path, **options)
        if not response.is_success:
            return []
        links = LibraryLinks()
        links.feed(response.text)
        return list(dict.fromkeys(links.tags))[:12]

    families = await find("/search", params={"q": query, "c": "tools"})
    variants = await find(f"/library/{query}/tags") if TAG.fullmatch(query) and ":" not in query else []
    tags = list(dict.fromkeys(families + variants))

    async def verify(tag):
        try:
            return await has_manifest(http, tag)
        except httpx.HTTPError:
            return False

    available = await asyncio.gather(*(verify(tag) for tag in tags))
    return [{"tag": tag, "url": "https://ollama.com/library/" + tag}
            for tag, valid in zip(tags, available) if valid]


async def install(agent, tag, correlation_id):
    if not TAG.fullmatch(tag):
        raise APIError(400, "Enter a local Ollama Library tag such as qwen3:14b.")
    if download.locked():
        raise APIError(409, "A model download is already in progress.")
    await download.acquire()
    try:
        if not await has_manifest(agent.http, tag):
            raise APIError(400, "That tag has no downloadable local model. Check the Ollama Library.")
        request = agent.http.build_request(
            "POST", OLLAMA + "/api/pull", json={"model": tag, "stream": True},
            headers={"X-Correlation-ID": correlation_id},
            timeout=httpx.Timeout(None, connect=10, pool=10),
        )
        upstream = await agent.http.send(request, stream=True)
        if not upstream.is_success:
            await upstream.aclose()
            raise APIError(503, "Could not start the model download.")
    except BaseException:
        download.release()
        raise

    # Keep the download lock until streaming ends, including on browser disconnect.
    async def progress():
        log(agent.service, correlation_id, "ollama-client", "ollama.pull.started", model=tag)
        try:
            async with asyncio.timeout(7200):
                async for line in upstream.aiter_lines():
                    if line:
                        yield line + "\n"
        except (httpx.HTTPError, TimeoutError):
            yield json.dumps({"error": "The model download was interrupted."}) + "\n"
        finally:
            download.release()
            with CancelScope(shield=True):
                await upstream.aclose()
            log(agent.service, correlation_id, "ollama-client", "ollama.pull.ended", model=tag)

    return StreamingResponse(progress(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})
