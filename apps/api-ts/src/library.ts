import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import { ollama } from './agent.ts';
import { HttpError } from './errors.ts';
import { log, type Trace } from './logging.ts';

const validTag = /^[a-z0-9][a-z0-9._-]{0,63}(?::[a-z0-9][a-z0-9._-]{0,63})?$/i;

// The library also lists tags without local weights. Check the manifest before offering a download.
async function hasManifest(tag: string, signal: AbortSignal) {
  const [family, variant = 'latest'] = tag.split(':');
  const response = await fetch(`https://registry.ollama.ai/v2/library/${family}/manifests/${variant}`, { signal });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error('Could not verify the Ollama registry manifest.');
  const manifest = await response.json() as { layers?: { mediaType: string }[] };
  return manifest.layers?.some((layer) => layer.mediaType === 'application/vnd.ollama.image.model') ?? false;
}

export async function searchLibrary(query: string, signal: AbortSignal) {
  if (!query || Buffer.byteLength(query) > 80) throw new HttpError(400, 'Enter a search query of up to 80 bytes.');
  async function find(path: string) {
    const response = await fetch('https://ollama.com' + path, { signal });
    if (!response.ok) return [];
    return [...(await response.text()).matchAll(/href=["']\/library\/([^"'/?#\s]+)["']/g)]
      .map((entry) => entry[1]).filter((tag) => validTag.test(tag));
  }
  const [families, variants] = await Promise.all([
    find('/search?q=' + encodeURIComponent(query) + '&c=tools'),
    /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(query) ? find('/library/' + query + '/tags') : [],
  ]);
  const candidates = [...new Set([...families.slice(0, 12), ...variants.slice(0, 12)])];
  const results = await Promise.all(candidates.map(async (tag) => (await hasManifest(tag, signal))
    ? { tag, url: 'https://ollama.com/library/' + tag } : null));
  return results.filter((entry) => entry !== null);
}

let pulling = false;
export async function installModel(tag: string, trace: Trace, signal: AbortSignal, output: ServerResponse) {
  if (!validTag.test(tag)) throw new HttpError(400, 'Enter a local Ollama Library tag such as qwen3:14b.');
  if (pulling) throw new HttpError(409, 'A model download is already in progress.');
  pulling = true;
  try {
    if (!await hasManifest(tag, AbortSignal.any([signal, AbortSignal.timeout(8000)]))) {
      throw new HttpError(400, 'That tag has no downloadable local model. Check the Ollama Library.');
    }
    log(trace, 'ollama-client', 'ollama.pull.started', { model: tag });
    const response = await ollama('/api/pull', trace, signal, { model: tag, stream: true }, tag);
    if (!response.ok || !response.body) throw new HttpError(503, 'Could not start the model download.');
    output.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    // Stream newline-delimited progress with backpressure and cancel on disconnect.
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), output, { signal });
    log(trace, 'ollama-client', 'ollama.pull.ended', { model: tag });
  } finally {
    pulling = false;
  }
}
