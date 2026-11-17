import { apiPath, type Backend } from './backend';
import { useEffect, useState } from 'react';
import { parse } from 'yaml';
import { correlatedFetch, correlationHeader, readBrowserLogs, type LogEntry } from './telemetry';

type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };
type Operation = {
  method: string;
  path: string;
  summary: string;
  description?: string;
  responses: Record<string, { description?: string }>;
  parameters?: { name?: string; in?: string; required?: boolean }[];
  requestBody?: { content: { 'application/json'?: { example?: unknown } } };
};

async function get<T>(url: string, signal: AbortSignal, decode: (response: Response) => Promise<T>): Promise<T> {
  const response = await correlatedFetch(url, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `Request returned HTTP ${response.status}.`);
  }
  return decode(response);
}

function useResource<T>(url: string, decode: (response: Response) => Promise<T>) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [revision, refresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void get(url, controller.signal, decode).then(setData).catch((cause: Error) => {
      if (!controller.signal.aborted) setError(cause.message);
    });
    return () => controller.abort();
  }, [url, decode, revision]);
  return { data, error, refresh: () => refresh((value) => value + 1) };
}

const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

async function openAPI(response: Response): Promise<Operation[]> {
  const document = parse(await response.text()) as {
    paths: Record<string, Record<string, Omit<Operation, 'method' | 'path'>>>;
  };
  return Object.entries(document.paths).flatMap(([path, operations]) =>
    Object.entries(operations)
      .filter(([method]) => methods.has(method))
      .map(([method, operation]) => ({ ...operation, path, method: method.toUpperCase() })),
  ).sort((a, b) => {
    const order = ['/api/chat', '/api/health', '/api/ready', '/api/models', '/api/models/search', '/api/models/install', '/api/tools', '/api/database/queries', '/api/database/query', '/api/jobs', '/api/jobs/{jobId}', '/api/logs', '/api/openapi.yaml'];
    return order.indexOf(a.path) - order.indexOf(b.path);
  });
}

function Endpoint({ backend, operation }: { backend: Backend; operation: Operation }) {
  const { path, method, summary, description, responses, requestBody } = operation;
  const example = requestBody?.content['application/json']?.example;
  const [body, setBody] = useState(() => example ? JSON.stringify(example, null, 2) : '{}');
  const [result, setResult] = useState<{ status: number; text: string; id: string | null }>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const hasBody = !!requestBody;
  const pathFields = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  const [pathValues, setPathValues] = useState<Record<string, string>>({});
  const queryFields = (operation.parameters ?? []).filter((field) => field.in === 'query' && field.name);
  const allFields = [...pathFields, ...queryFields.map((field) => field.name!)];
  const canSend = [...pathFields, ...queryFields.filter((field) => field.required).map((field) => field.name!)]
    .every((field) => pathValues[field]?.trim());
  async function tryRequest() {
    setError('');
    setResult(undefined);
    setPending(true);
    try {
      const payload = hasBody ? JSON.stringify(JSON.parse(body)) : undefined;
      const query = new URLSearchParams();
      for (const field of queryFields) {
        if (field.name && pathValues[field.name]?.trim()) query.set(field.name, pathValues[field.name].trim());
      }
      const target = path.replace(/\{([^}]+)\}/g, (_, field: string) => encodeURIComponent(pathValues[field].trim()));
      const response = await correlatedFetch(apiPath(backend, query.size ? `${target}?${query}` : target), {
        method, body: payload, headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
      });
      const text = response.headers.get('Content-Type')?.includes('application/json')
        ? JSON.stringify(await response.json(), null, 2) : await response.text();
      setResult({ status: response.status, text, id: response.headers.get(correlationHeader) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <details className="endpoint">
      <summary><span className={`method ${method.toLowerCase()}`}>{method}</span><code>{path}</code><span>{summary}</span></summary>
      <div className="endpoint-body">
        {description && <p>{description}</p>}
        <ul className="responses">
          {Object.entries(responses).map(([code, response]) => (
            <li key={code}><code>{code}</code> {response.description ?? 'See OpenAPI schema'}</li>
          ))}
        </ul>
        {allFields.map((field) => <label className="editor" key={field}>
          {field}<input value={pathValues[field] ?? ''} onChange={(event) => {
            const value = event.target.value;
            setPathValues((current) => ({ ...current, [field]: value }));
          }} />
        </label>)}
        {hasBody && (
          <label className="editor">Request JSON
            <textarea value={body} rows={7} spellCheck={false} onChange={(event) => setBody(event.target.value)} />
          </label>
        )}
        <button type="button" onClick={() => void tryRequest()} disabled={pending || !canSend}>
          {pending ? 'Waiting…' : 'Send test request'}
        </button>
        {error && <p role="alert" className="error">{error}</p>}
        {result && <div className="endpoint-result">
          <strong role="status">HTTP {result.status}</strong>
          {result.id && <p className="muted">Correlation ID <code>{result.id}</code></p>}
          <pre className="code-block">{result.text}</pre>
        </div>}
      </div>
    </details>
  );
}

export function APIReference({ backend }: { backend: Backend }) {
  const { data, error, refresh } = useResource(apiPath(backend, '/api/openapi.yaml'), openAPI);
  return <section className="panel" aria-labelledby="api-title">
    <div className="panel-heading">
      <div><h2 id="api-title">API reference</h2><p>Browse the OpenAPI contract and send test requests.</p></div>
      <a className="action" href={apiPath(backend, '/api/openapi.yaml')} target="_blank" rel="noreferrer">Open YAML ↗</a>
    </div>
    {error && <p className="panel-status error" role="alert">{error} <button onClick={refresh}>Retry</button></p>}
    {!data && !error && <p className="panel-status" role="status">Loading API contract…</p>}
    {data?.map((operation) => <Endpoint key={operation.path + operation.method} backend={backend} operation={operation} />)}
  </section>;
}

const decodeTools = (response: Response): Promise<Tool[]> => response.json();

export function MCPTools({ backend }: { backend: Backend }) {
  const { data, error, refresh } = useResource(apiPath(backend, '/api/tools'), decodeTools);
  return <section className="panel" aria-labelledby="tools-title">
    <div className="panel-heading">
      <div><h2 id="tools-title">MCP tools</h2><p>Discovered from the local inventory server over stdio.</p></div>
      <button onClick={refresh}>Refresh tools</button>
    </div>
    {error && <p className="panel-status error" role="alert">{error}</p>}
    {!data && !error && <p className="panel-status" role="status">Discovering tools…</p>}
    {data?.length === 0 && <p className="panel-status">No tools discovered.</p>}
    {data?.map((tool) => <div className="tool-card" key={tool.name}>
      <h3><code>{tool.name}</code></h3>
      <p>{tool.description}</p>
      <details><summary>Input schema</summary><pre className="code-block">{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>
    </div>)}
  </section>;
}

function localDateKey(timestamp: string) {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function Logs({ backend, filter, setFilter }: { backend: Backend; filter: string; setFilter: (value: string) => void }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState('');
  const [service, setService] = useState('');
  const [level, setLevel] = useState('');
  const [date, setDate] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [live, setLive] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      let records: LogEntry[] = [];
      try {
        // The log viewer polls quietly so reading a log doesn't create logs.
        const response = await fetch(apiPath(backend, '/api/logs'), { signal: controller.signal });
        if (!response.ok) throw new Error('Server logs are unavailable.');
        records = await response.json();
        setError('');
      } catch {
        if (controller.signal.aborted) return;
        setError('Server logs are unavailable. Browser events are still shown.');
      }
      if (controller.signal.aborted) return;
      setLogs([...records, ...readBrowserLogs()].sort((a, b) => Date.parse(b.time) - Date.parse(a.time)));
      if (live) timer = setTimeout(() => void read(), 3000);
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [live, refresh]);

  const services = [...new Set(logs.flatMap((entry) => entry.service ?? []))].sort();
  const query = filter.trim().toLowerCase();
  const matches = logs.filter((entry) =>
    (!service || entry.service === service) &&
    (!level || entry.level === level) &&
    (!date || localDateKey(entry.time) === date) &&
    (!query || entry.correlation_id?.toLowerCase().includes(query)),
  );
  return <section className="panel logs-panel" aria-labelledby="logs-title">
    <div className="panel-heading">
      <div><h2 id="logs-title">Logs</h2><p>Recent browser, API, MCP, and Temporal worker events.</p></div>
      <div className="inline-controls">
        <label className="checkbox"><input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} /> Live</label>
        <button onClick={() => setRefresh((value) => value + 1)}>Refresh</button>
      </div>
    </div>
    <div className="filters">
      <label>Correlation ID<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Paste an ID" /></label>
      <label>Date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
      <label>Service<select value={service} onChange={(event) => setService(event.target.value)}>
        <option value="">All services</option>
        {services.map((name) => <option key={name}>{name}</option>)}
      </select></label>
      <label>Level<select value={level} onChange={(event) => setLevel(event.target.value)}>
        <option value="">All levels</option>
        {['debug', 'info', 'warn', 'error'].map((name) => <option key={name}>{name}</option>)}
      </select></label>
      {filter && <button onClick={() => setFilter('')}>Clear ID</button>}
      {date && <button onClick={() => setDate('')}>Clear date</button>}
    </div>
    {error && <p role="alert" className="panel-status error">{error}</p>}
    <div className="log-scroll">
      {matches.length === 0 && <p className="panel-status">No log entries match these filters.</p>}
      {matches.map((entry, index) => <details className="log-entry" key={`${entry.time}-${entry.service}-${entry.msg}-${index}`}>
        <summary>
          <time className="log-timestamp" dateTime={entry.time}>
            <span>{localDateKey(entry.time)}</span>
            <span>{new Date(entry.time).toLocaleTimeString()}</span>
          </time>
          <span className={`log-level ${entry.level ?? ''}`}>{entry.level ?? 'log'}</span>
          <span className="log-service">{entry.service ?? 'app'}</span>
          <code>{entry.msg}{entry.model && <span className="log-model"> · {entry.model}</span>}</code>
        </summary>
        <pre className="code-block">{JSON.stringify(entry, null, 2)}</pre>
      </details>)}
    </div>
  </section>;
}
