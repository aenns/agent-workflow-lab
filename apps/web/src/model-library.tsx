import { apiPath, type Backend } from './backend';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { correlatedFetch } from './telemetry';

type LibraryModel = { tag: string; url: string };
type Progress = { status?: string; total?: number; completed?: number; error?: string };

async function readError(response: Response, fallback: string) {
  const body = await response.json().catch(() => null);
  return new Error(body?.error || fallback);
}

async function download(backend: Backend, tag: string, signal: AbortSignal, onProgress: (value: Progress) => void) {
  const response = await correlatedFetch(apiPath(backend, '/api/models/install'), {
    method: 'POST',
    body: JSON.stringify({ model: tag }),
    headers: { 'Content-Type': 'application/json' },
    signal,
  }, undefined, { model: tag });
  if (!response.ok) throw await readError(response, 'Could not start the model download.');
  if (!response.body) throw new Error('Ollama did not return download progress.');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  let succeeded = false;
  function record(line: string) {
    if (!line.trim()) return;
    const value = JSON.parse(line) as Progress;
    if (value.error) throw new Error(value.error);
    onProgress(value);
    if (value.status === 'success') succeeded = true;
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += value;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) record(line);
    }
    record(pending);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!succeeded) throw new Error('The download ended before Ollama confirmed success.');
}

export function ModelLibrary({ backend, installed, onInstalled, onUse }: {
  backend: Backend;
  installed: string[];
  onInstalled: () => Promise<string[] | undefined>;
  onUse: (tag: string, openChat?: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [results, setResults] = useState<LibraryModel[]>();
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [active, setActive] = useState('');
  const [progress, setProgress] = useState<Progress>();
  const [installError, setInstallError] = useState('');
  const [notice, setNotice] = useState('');
  const searchRequest = useRef<AbortController>(null);
  const pullRequest = useRef<AbortController>(null);

  useEffect(() => () => {
    searchRequest.current?.abort();
    pullRequest.current?.abort();
  }, []);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    searchRequest.current?.abort();
    const controller = new AbortController();
    searchRequest.current = controller;
    setSearching(true);
    setSearchError('');
    setResults(undefined);
    try {
      const response = await correlatedFetch(apiPath(backend, `/api/models/search?q=${encodeURIComponent(query.trim())}`), { signal: controller.signal });
      if (!response.ok) throw await readError(response, 'Could not search the Ollama Library.');
      const models = await response.json() as LibraryModel[];
      if (!controller.signal.aborted) setResults(models);
    } catch (error) {
      if (!controller.signal.aborted) setSearchError(error instanceof Error ? error.message : 'Search failed.');
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }

  async function install(candidate: string) {
    const name = candidate.trim();
    if (!name || pullRequest.current) return;
    const controller = new AbortController();
    pullRequest.current = controller;
    setActive(name);
    setProgress(undefined);
    setInstallError('');
    setNotice('');
    try {
      await download(backend, name, controller.signal, setProgress);
      const updated = await onInstalled();
      const normalized = name.includes(':') ? name : `${name}:latest`;
      const selectable = updated?.find((item) => item === normalized || item === name);
      if (selectable) {
        onUse(selectable, false);
        setNotice(`${selectable} is installed and selected for your next message.`);
      } else {
        setNotice(`${name} downloaded. Check the installed model list for tool compatibility.`);
      }
    } catch (error) {
      if (controller.signal.aborted) setNotice('Download canceled.');
      else setInstallError(error instanceof Error ? error.message : 'Download failed.');
    } finally {
      pullRequest.current = null;
      setActive('');
    }
  }

  const percent = progress?.total && progress.completed !== undefined
    ? Math.min(100, Math.round(100 * progress.completed / progress.total))
    : undefined;
  return <section className="panel" aria-labelledby="models-title">
    <div className="panel-heading">
      <div><h2 id="models-title">Model library</h2><p>Search Ollama and download models to this machine.</p></div>
      <a className="action" href="https://ollama.com/search" target="_blank" rel="noreferrer">Open Ollama Library ↗</a>
    </div>
    <form className="model-form" onSubmit={(event) => void search(event)}>
      <label>Search models<input value={query} maxLength={80} placeholder="e.g. qwen3.5" onChange={(event) => setQuery(event.target.value)} /></label>
      <button disabled={!query.trim()}>{searching ? 'Searching…' : 'Search'}</button>
    </form>
    {searchError && <p className="panel-status error" role="alert">{searchError}</p>}
    {results?.length === 0 && <p className="panel-status">No matching library tags found. You can enter a known tag below.</p>}
    {!!results?.length && <ul className="model-list">
      {results.map((entry) => <li key={entry.tag}>
        <a href={entry.url} target="_blank" rel="noreferrer"><code>{entry.tag}</code></a>
        {installed.includes(entry.tag)
          ? <button type="button" onClick={() => onUse(entry.tag)}>Use model</button>
          : <button type="button" disabled={!!active} onClick={() => void install(entry.tag)}>Install</button>}
      </li>)}
    </ul>}
    <form className="model-form model-install" onSubmit={(event) => { event.preventDefault(); void install(tag); }}>
      <label>Install by tag<input value={tag} placeholder="qwen3.5:9b" maxLength={161} onChange={(event) => setTag(event.target.value)} /></label>
      <button disabled={!!active || !tag.trim()}>Install model</button>
    </form>
    {active && <div className="model-progress">
      <div><p role="status"><strong>{active}</strong> · {progress?.status ?? 'Connecting to Ollama…'}{percent !== undefined && ` · ${percent}% of current layer`}</p>
        <progress max={100} value={percent} aria-label="Current download layer" /></div>
      <button type="button" onClick={() => pullRequest.current?.abort()}>Cancel download</button>
    </div>}
    {notice && <p className="panel-status" role="status">{notice}</p>}
    {installError && <p className="panel-status error" role="alert">{installError}</p>}
  </section>;
}
