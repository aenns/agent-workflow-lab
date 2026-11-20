import { jsonLines } from '../../../packages/chat-stream';
import { apiPath, backendLabels, jobCorrelationId, readBackend, type Backend } from './backend';
import { Database } from './database';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { ModelLibrary } from './model-library';
import { Jobs, useJobs, type Job } from './jobs';
import { TokenTrace, ToolTrace, type TokenUsage, type ToolEvent } from './traces';
import { APIReference, Logs, MCPTools } from './diagnostics';
import { correlatedFetch, correlationHeader } from './telemetry';
import { Workflows } from './workflows';
import { WorkerControl } from './worker-control';
import './style.css';

type Engine = 'loop' | 'state-machine' | 'temporal';
type View = 'chat' | 'api' | 'tools' | 'logs' | 'jobs' | 'models' | 'database' | 'workflows';
const views: { id: View; label: string; icon: string }[] = [
  { id: 'chat', label: 'Chat', icon: '◫' },
  { id: 'jobs', label: 'Jobs', icon: '◷' },
  { id: 'workflows', label: 'Workflows', icon: '↪' },
  { id: 'models', label: 'Models', icon: '◆' },
  { id: 'api', label: 'API reference', icon: '{}' },
  { id: 'tools', label: 'MCP tools', icon: '◇' },
  { id: 'database', label: 'Database', icon: '▤' },
  { id: 'logs', label: 'Logs', icon: '≡' },
];
type DurableEngine = Exclude<Engine, 'loop'>;
const engineLabels: Record<Engine, string> = { loop: 'Direct loop', 'state-machine': 'State machine', temporal: 'Temporal' };
const stateLabels: Record<string, string> = {
  asking_model: 'Ask model',
  running_tools: 'Run tools',
  completed: 'Complete',
};

type Run = { backend: Backend; engine: Engine; model?: string; correlationId: string; runId?: string; states?: string[]; tools?: ToolEvent[]; usage?: TokenUsage[] };

type Message = { role: 'user' | 'assistant'; content: string };
type Readiness = { ready: boolean; model?: string; detail: string };

// Keep an unfinished durable request in this browser tab. Reusing the ID
// also requires sending the same messages, so save them together.
type SavedTurn = { backend?: Backend; runId: string; model?: string; engine: DurableEngine; messages: Message[] };
const savedTurnKey = 'workflow-lab:pending-state-machine';

function readSavedTurn(): SavedTurn | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(savedTurnKey) ?? 'null');
    return saved ? { ...saved, engine: saved.engine ?? 'state-machine' } : null;
  } catch {
    return null;
  }
}

function storeTurn(turn: SavedTurn | null) {
  try {
    if (turn) sessionStorage.setItem(savedTurnKey, JSON.stringify(turn));
    else sessionStorage.removeItem(savedTurnKey);
  } catch {
    // Checkpoint retries still work in this page if browser storage is blocked.
  }
}

function App() {
  const [view, setView] = useState<View>('chat');
  const [databaseRunId, setDatabaseRunId] = useState('');
  const [logFilter, setLogFilter] = useState('');
  const [selectedJob, setSelectedJob] = useState('');
  const [jobPending, setJobPending] = useState(false);
  const jobDraft = useRef<{ prompt: string; model: string; key: string }>(null);
  const [savedTurn, setSavedTurn] = useState(readSavedTurn);
  const [backend, setBackend] = useState<Backend>(() =>
    savedTurn?.backend ?? readBackend());
  const jobFeed = useJobs(backend);
  const firstUnread = jobFeed.unread[0];
  // React rerenders when a state setter runs. These initializers restore
  // the draft once, when the component first mounts.
  const [messages, setMessages] = useState<Message[]>(() => savedTurn?.messages.slice(0, -1) ?? []);
  const [engine, setEngine] = useState<Engine>(() => savedTurn?.engine ?? 'loop');
  const [model, setModel] = useState(() => savedTurn?.model ?? '');
  const [catalog, setCatalog] = useState<{ defaultModel: string; models: string[] }>();
  const [modelError, setModelError] = useState('');
  const [openedLibrary, setOpenedLibrary] = useState(false);
  // Keep run details separate so the selected backend receives only conversation text.
  const [runs, setRuns] = useState<Record<number, Run>>({});
  const [prompt, setPrompt] = useState(() => savedTurn?.messages.at(-1)?.content ?? '');
  const [stream, setStream] = useState(false);
  const [partial, setPartial] = useState('');
  const [streamStatus, setStreamStatus] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [readiness, setReadiness] = useState<Readiness>({ ready: false, detail: 'Checking connection…' });
  const composer = useRef<HTMLTextAreaElement>(null);
  const latest = useRef<HTMLDivElement>(null);
  // Readiness checks the backend's configured default. The label follows the chat picker.
  const sidebarModel = model || catalog?.defaultModel || readiness.model || 'Local model';
  const selectedModelUnavailable = !!model && !!catalog && !catalog.models.includes(model);
  const sidebarStatus = selectedModelUnavailable
    ? 'Selected model unavailable'
    : readiness.ready ? 'Backend ready' : readiness.detail;
  const promptBytes = new TextEncoder().encode(prompt.trim()).length;
  const full = messages.length >= 42;
  // Saved run IDs belong to the backend and engine that created them.
  const canResume = !!savedTurn && (savedTurn.backend ?? 'go') === backend && savedTurn.engine === engine && (savedTurn.model ?? '') === model &&
    savedTurn.messages.at(-1)?.content === prompt.trim();

  async function checkReadiness(signal?: AbortSignal) {
    try {
      const response = await correlatedFetch(apiPath(backend, '/api/ready'), { signal });
      const result = await response.json();
      const ready = response.ok && result.status === 'ready';
      setReadiness({
        ready,
        model: result.model,
        detail: ready ? 'Ready' : result.error || 'API unavailable',
      });
    } catch {
      if (!signal?.aborted) {
        setReadiness({ ready: false, detail: `Start the ${backendLabels[backend]} API and check again.` });
      }
    }
  }

  async function loadModels(signal?: AbortSignal) {
    try {
      const response = await correlatedFetch(apiPath(backend, '/api/models'), { signal });
      if (!response.ok) throw new Error('Could not load installed models.');
      const data = await response.json();
      if (!signal?.aborted) {
        setCatalog(data);
        setModelError('');
        return data.models as string[];
      }
    } catch {
      if (!signal?.aborted) setModelError('Could not load installed models.');
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void checkReadiness(controller.signal);
    void loadModels(controller.signal);
    return () => controller.abort();
  }, [backend]);

  useEffect(() => {
    latest.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, pending, view, partial, streamStatus]);

  // Send the conversation as JSON and keep the draft available on failure.
  // Prevent the HTML form from navigating away from the chat page.
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || jobPending || !promptBytes || promptBytes > 8000 || full) return;
    const conversation: Message[] = [...messages, { role: 'user', content: prompt.trim() }];
    setError('');
    setPending(true);
    setPartial('');
    setStreamStatus('Waiting for the model…');
    try {
      const runId = engine !== 'loop'
        ? (canResume ? savedTurn?.runId : crypto.randomUUID())
        : undefined;
      if (runId && engine !== 'loop') {
        const active = { backend, runId, engine, model, messages: conversation };
        setSavedTurn(active);
        storeTurn(active);
      }
      // Durable retries reuse their run ID as the browser's correlation ID.
      const correlationId = runId ?? crypto.randomUUID();
      const response = await correlatedFetch(apiPath(backend, '/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: conversation, engine, model: model || undefined, runId, stream: stream || undefined }),
      }, correlationId, { engine, backend });
      let result;
      if (response.ok && response.headers.get('Content-Type')?.includes('application/x-ndjson')) {
        if (!response.body) throw new Error('The API returned no response stream.');
        let completed = false;
        for await (const event of jsonLines(response.body)) {
          if (event.type === 'model-start') {
            setPartial('');
            setStreamStatus('Generating reply…');
          } else if (event.type === 'model-snapshot') {
            // A retry or reconnect supplies a whole draft, replacing the old attempt.
            setPartial(event.text);
            setStreamStatus(event.truncated ? 'Preview limit reached. Waiting for the complete reply…' :
              `Generating reply…${event.attempt > 1 ? ` (attempt ${event.attempt})` : ''}`);
          } else if (event.type === 'status') {
            setStreamStatus(event.message);
          } else if (event.type === 'text') {
            setPartial((current) => current + event.text);
          } else if (event.type === 'tool-start') {
            setPartial('');
            setStreamStatus('Running ' + event.name + '…');
          } else if (event.type === 'tool-complete') {
            setStreamStatus('Completed ' + event.name);
          } else if (event.type === 'error') {
            throw new Error(event.error);
          } else if (event.type === 'complete') {
            result = event.reply;
            completed = true;
            break;
          }
        }
        if (!completed) throw new Error('The response stream ended before completion. Try again or resume the saved run.');
      } else {
        result = await response.json().catch(() => null);
      }
      if (!response.ok) throw new Error(result?.error || `Could not reach the ${backendLabels[backend]} API. Try again.`);
      if (result?.message?.role !== 'assistant' || typeof result.message.content !== 'string') {
        throw new Error('The API returned an invalid reply. Try again.');
      }
      setRuns((current) => ({
        ...current,
        [conversation.length]: {
          backend,
          engine,
          model: result.model,
          correlationId: response.headers.get(correlationHeader) ?? correlationId,
          runId: result.runId,
          states: result.states,
          tools: result.tools,
          usage: result.usage,
        },
      }));
      // Build a new array so React sees the appended assistant message.
      setMessages([...conversation, result.message]);
      setSavedTurn(null);
      storeTurn(null);
      setPrompt('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send the message. Try again.');
    } finally {
      setPending(false);
      composer.current?.focus();
    }
  }

  function openJob(job: Job) {
    setSelectedJob(job.id);
    setView('jobs');
    if (job.status !== 'running') jobFeed.markRead(job.id);
  }

  async function startJob() {
    const text = prompt.trim();
    if (pending || jobPending || !promptBytes || promptBytes > 8000) return;
    // Reuse the key when retrying a failed submission with the same prompt.
    if (jobDraft.current?.prompt !== text || jobDraft.current.model !== model) {
      jobDraft.current = { prompt: text, model, key: crypto.randomUUID() };
    }
    const { key } = jobDraft.current;
    setJobPending(true);
    setError('');
    try {
      const response = await correlatedFetch(apiPath(backend, '/api/jobs'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, key, model: model || undefined }),
      }, jobCorrelationId(backend, key), { backend });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.id) throw new Error(result?.error || 'Could not start the background job.');
      const job = result as Job;
      jobFeed.add(job);
      setPrompt('');
      jobDraft.current = null;
      openJob(job);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the background job.');
    } finally {
      setJobPending(false);
    }
  }

  function selectBackend(next: Backend) {
    setBackend(next);
    if (view === 'workflows' && next !== 'java') setView('chat');
    sessionStorage.setItem('workflow-lab:backend', next);
    setReadiness({ ready: false, detail: 'Checking connection…' });
    setCatalog(undefined);
    setModelError('');
    setSelectedJob('');
    setDatabaseRunId('');
    setError('');
  }

  function changeView(next: View) {
    if (next === 'workflows' && backend !== 'java') {
      if (pending || jobPending) return;
      selectBackend('java');
    }
    if (next === 'models') {
      setOpenedLibrary(true);
      void loadModels();
    }
    setView(next);
  }

  function openLogs(id: string) {
    setLogFilter(id);
    setView('logs');
  }

  function reset() {
    setSavedTurn(null);
    storeTurn(null);
    setMessages([]);
    setRuns({});
    setPrompt('');
    setError('');
    composer.current?.focus();
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">&gt;_</span>
          <div><strong>Workflow Lab</strong><span>AI agent workspace</span></div>
        </div>
        <nav aria-label="Workspace">
          {views.map((item) => (
            <button type="button" key={item.id} disabled={item.id === 'workflows' && backend !== 'java' && (pending || jobPending)} aria-current={view === item.id ? 'page' : undefined}
              onClick={() => changeView(item.id)}>
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>{item.label}
              {item.id === 'jobs' && !!jobFeed.unread.length && <span className="job-count" aria-label={`${jobFeed.unread.length} unread job notifications`}>{jobFeed.unread.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="connection">
            <span className={`connection-dot ${readiness.ready && !selectedModelUnavailable ? 'online' : ''}`} aria-hidden="true" />
            <span role="status"><strong>{sidebarModel}</strong>
              <span>{sidebarStatus}</span>
            </span>
          </div>
          <button type="button" onClick={() => void checkReadiness()}>Check connection</button>
        </div>
      </aside>
      <main>
        <header className="page-header">
          <h1>AI Agent &amp; MCP Workflow Lab</h1>
          <label>Backend{' '}
            <select value={backend} disabled={pending || jobPending} onChange={(event) => selectBackend(event.target.value as Backend)}>
              {Object.entries(backendLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </header>
        <div aria-live="polite">
          {firstUnread && <div className="job-notice">
            <span>{firstUnread.status === 'completed' ? 'Inventory audit complete' : 'Inventory audit failed'}{jobFeed.unread.length > 1 ? ` · ${jobFeed.unread.length} unread` : ''}</span>
            <button type="button" onClick={() => openJob(firstUnread)}>Open job</button>
          </div>}
        </div>
        {/* Keep the worker mounted across Chat and Jobs, with a key distinct from its sibling views. */}
        {(view === 'jobs' || (view === 'chat' && engine === 'temporal')) &&
          <WorkerControl key={`worker-${backend}`} backend={backend} waitingForReply={view === 'chat' && pending} />}
        {view === 'jobs' && <Jobs key={`jobs-${backend}`} backend={backend} jobs={jobFeed.jobs} unread={jobFeed.unread} error={jobFeed.error}
          selectedId={selectedJob} onSelect={openJob} onLogs={openLogs} />}
        {openedLibrary && <div hidden={view !== 'models'}>
          <ModelLibrary key={backend} backend={backend} installed={catalog?.models ?? []} onInstalled={loadModels}
            onUse={(tag, openChat = true) => { setModel(tag); if (openChat) setView('chat'); }} />
        </div>}
        {view === 'workflows' && <Workflows onLogs={openLogs} />}
        {view === 'api' && <APIReference key={`api-${backend}`} backend={backend} />}
        {view === 'tools' && <MCPTools key={`tools-${backend}`} backend={backend} />}
        {view === 'database' && <Database key={`database-${backend}`} backend={backend} initialRunId={databaseRunId} />}
        {view === 'logs' && <Logs key={`logs-${backend}`} backend={backend} filter={logFilter} setFilter={setLogFilter} />}
        {view === 'chat' && (
      <section className="chat" aria-label="Chat">
        <div className="toolbar">
          <h2>Local chat</h2>
          <div className="chat-controls">
            <label htmlFor="model">Model</label>
            <select id="model" value={model} disabled={pending || jobPending}
              onChange={(event) => setModel(event.target.value)}>
              <option value="">{catalog?.defaultModel ? `Default (${catalog.defaultModel})` : 'Configured default'}</option>
              {model && !catalog?.models.includes(model) && <option value={model}>{model}</option>}
              {catalog?.models.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
            </select>
            <button type="button" onClick={() => changeView('models')}>Add models</button>
            <label htmlFor="engine">Engine</label>
            <select id="engine" value={engine} disabled={pending}
              onChange={(event) => setEngine(event.target.value as Engine)}>
              <option value="loop">{backendLabels[backend]} loop</option>
              <option value="state-machine">State machine</option>
              <option value="temporal">Temporal</option>
            </select>
            <label className="checkbox" title="Streams replies sent with Send. Temporal previews arrive in batches. Background jobs return a complete report in Jobs.">
              <input type="checkbox" checked={stream} disabled={pending || jobPending}
                onChange={(event) => setStream(event.target.checked)} /> Stream response
            </label>
            <button type="button" onClick={reset} disabled={pending || jobPending}>New chat</button>
          </div>
        </div>
        {modelError && <p className="panel-status error" role="status">{modelError}</p>}
        <div className="transcript" role="log" aria-label="Conversation">
          {!messages.length && !pending && <div className="chat-empty">
            <div className="empty-mark" aria-hidden="true">◇</div>
            <h3>Start a conversation</h3>
            <p>Check stock and pickup hours for one or more demo items.</p>
            <div className="suggestions">
              {[
                'How many LAMP-42 desk lamps are in stock?',
                'Is LAMP-42 in stock, and when can I pick it up?',
                'Check stock for LAMP-42 and MUG-17, then look up pickup hours for each warehouse. List stock and hours by item.',
              ].map((example) => <button type="button" key={example} onClick={() => {
                setPrompt(example);
                composer.current?.focus();
              }}>{example}</button>)}
            </div>
          </div>}
          {messages.map((message, index) => {
            const run = runs[index];
            return (
              <article key={index} className={message.role}>
                <strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong>
                {run && <span className="run-engine"> · {backendLabels[run.backend]} · {engineLabels[run.engine]}{run.model && ` · ${run.model}`}</span>}
                <p>{message.content}</p>
                {run && <div className="run-meta">
                  <span>Correlation ID <code>{run.correlationId}</code></span>
                  <button className="text-button" type="button" onClick={() => openLogs(run.correlationId)}>View logs ↗</button>
                </div>}
                {run?.engine === 'temporal' && run.runId && (
                  <p className="run-engine">Workflow ID <code>{run.runId}</code></p>
                )}
                {!!run?.states?.length && (
                  <details className="tool-trace">
                    <summary>State transitions</summary>
                    {run.runId && <div className="run-meta">
                      <span>Run ID <code>{run.runId}</code></span>
                      <button className="text-button" type="button" onClick={() => {
                        if (run.backend !== backend) selectBackend(run.backend);
                        setDatabaseRunId(run.runId ?? '');
                        setView('database');
                      }}>Inspect checkpoints ↗</button>
                    </div>}
                    <ol>{run.states.map((state, step) => <li key={step}>{stateLabels[state] ?? state}</li>)}</ol>
                  </details>
                )}
                {!!run?.usage?.length && <TokenTrace calls={run.usage} />}
                {run && (run.tools?.length
                  ? <ToolTrace tools={run.tools} />
                  : <div className="tool-trace no-tools">No tools called</div>)}
              </article>
            );
          })}
          {pending && <>
            <article className="user"><strong>You</strong><p>{prompt.trim()}</p></article>
            {stream ? <article className="assistant">
              <strong>Assistant · Streaming</strong>
              {partial && <p>{partial}</p>}
              <small role="status">{streamStatus}</small>
            </article> : <p className="empty">Waiting for the model…</p>}
          </>}
          <div ref={latest} />
        </div>
        <form onSubmit={send}>
          <label htmlFor="prompt">Message</label>
          <textarea id="prompt" ref={composer} value={prompt} readOnly={pending || jobPending} rows={3}
            onChange={(event) => setPrompt(event.target.value)} />
          {promptBytes > 8000 && <p role="alert">Message exceeds 8,000 bytes.</p>}
          {full && <p role="status">This conversation has reached 21 turns. Start a new chat to continue.</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="composer-actions">
            <button type="button" disabled={pending || jobPending || !promptBytes || promptBytes > 8000} onClick={() => void startJob()}>
              {jobPending ? 'Submitting…' : 'Run in background'}
            </button>
            <button className="send" disabled={pending || jobPending || !promptBytes || promptBytes > 8000 || full}>
              {pending ? 'Sending…' : canResume ? 'Resume saved run' : 'Send message'}
            </button>
          </div>
        </form>
      </section>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
