import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Jobs, useJobs, type Job } from './jobs';
import { TokenTrace, ToolTrace, type TokenUsage, type ToolEvent } from './traces';
import { APIReference, Logs, MCPTools } from './diagnostics';
import { correlatedFetch, correlationHeader } from './telemetry';
import './style.css';

type Engine = 'loop' | 'state-machine' | 'temporal';
type View = 'chat' | 'api' | 'tools' | 'logs' | 'jobs';
const views: { id: View; label: string; icon: string }[] = [
  { id: 'chat', label: 'Chat', icon: '◫' },
  { id: 'jobs', label: 'Jobs', icon: '◷' },
  { id: 'api', label: 'API reference', icon: '{}' },
  { id: 'tools', label: 'MCP tools', icon: '◇' },
  { id: 'logs', label: 'Logs', icon: '≡' },
];
type DurableEngine = Exclude<Engine, 'loop'>;
const engineLabels: Record<Engine, string> = { loop: 'Go loop', 'state-machine': 'State machine', temporal: 'Temporal' };
const stateLabels: Record<string, string> = {
  asking_model: 'Ask model',
  running_tools: 'Run tools',
  completed: 'Complete',
};

type Run = { engine: Engine; correlationId: string; runId?: string; states?: string[]; tools?: ToolEvent[]; usage?: TokenUsage[] };

type Message = { role: 'user' | 'assistant'; content: string };
type Readiness = { ready: boolean; model?: string; detail: string };

// Keep an unfinished durable request in this browser tab. Reusing the ID
// also requires sending the same messages, so save them together.
type SavedTurn = { runId: string; engine: DurableEngine; messages: Message[] };
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
  const [logFilter, setLogFilter] = useState('');
  const jobFeed = useJobs();
  const [selectedJob, setSelectedJob] = useState('');
  const [jobPending, setJobPending] = useState(false);
  const jobDraft = useRef<{ prompt: string; key: string }>(null);
  const firstUnread = jobFeed.unread[0];
  const [savedTurn, setSavedTurn] = useState(readSavedTurn);
  // React rerenders when a state setter runs. These initializers restore
  // the draft once, when the component first mounts.
  const [messages, setMessages] = useState<Message[]>(() => savedTurn?.messages.slice(0, -1) ?? []);
  const [engine, setEngine] = useState<Engine>(() => savedTurn?.engine ?? 'loop');
  // Keep run details separate so only conversation text goes back to Go.
  const [runs, setRuns] = useState<Record<number, Run>>({});
  const [prompt, setPrompt] = useState(() => savedTurn?.messages.at(-1)?.content ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [readiness, setReadiness] = useState<Readiness>({ ready: false, detail: 'Checking connection…' });
  const composer = useRef<HTMLTextAreaElement>(null);
  const latest = useRef<HTMLDivElement>(null);
  const promptBytes = new TextEncoder().encode(prompt.trim()).length;
  const full = messages.length >= 42;
  const canResume = !!savedTurn && savedTurn.engine === engine &&
    savedTurn.messages.at(-1)?.content === prompt.trim();

  async function checkReadiness(signal?: AbortSignal) {
    try {
      const response = await correlatedFetch('/api/ready', { signal });
      const result = await response.json();
      const ready = response.ok && result.status === 'ready';
      setReadiness({
        ready,
        model: result.model,
        detail: ready ? 'Ready' : result.error || 'API unavailable',
      });
    } catch {
      if (!signal?.aborted) {
        setReadiness({ ready: false, detail: 'Start the Go API and check again.' });
      }
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void checkReadiness(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    latest.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, pending, view]);

  // Send the conversation as JSON and keep the draft available on failure.
  // Prevent the HTML form from navigating away from the chat page.
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || jobPending || !promptBytes || promptBytes > 8000 || full) return;
    const conversation: Message[] = [...messages, { role: 'user', content: prompt.trim() }];
    setError('');
    setPending(true);
    try {
      const runId = engine !== 'loop'
        ? (canResume ? savedTurn?.runId : crypto.randomUUID())
        : undefined;
      if (runId && engine !== 'loop') {
        const active = { runId, engine, messages: conversation };
        setSavedTurn(active);
        storeTurn(active);
      }
      // Durable retries reuse their run ID as the browser's correlation ID.
      const correlationId = runId ?? crypto.randomUUID();
      const response = await correlatedFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: conversation, engine, runId }),
      }, correlationId, { engine });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || 'Could not reach the Go API. Try again.');
      if (result?.message?.role !== 'assistant' || typeof result.message.content !== 'string') {
        throw new Error('The API returned an invalid reply. Try again.');
      }
      setRuns((current) => ({
        ...current,
        [conversation.length]: {
          engine,
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
    if (jobDraft.current?.prompt !== text) jobDraft.current = { prompt: text, key: crypto.randomUUID() };
    const { key } = jobDraft.current;
    setJobPending(true);
    setError('');
    try {
      const response = await correlatedFetch('/api/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, key }),
      }, `lab-job-${key}`);
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
            <button type="button" key={item.id} aria-current={view === item.id ? 'page' : undefined}
              onClick={() => setView(item.id)}>
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>{item.label}
              {item.id === 'jobs' && !!jobFeed.unread.length && <span className="job-count" aria-label={`${jobFeed.unread.length} unread job notifications`}>{jobFeed.unread.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="connection">
            <span className={`connection-dot ${readiness.ready ? 'online' : ''}`} aria-hidden="true" />
            <span role="status">{readiness.model ? <strong>{readiness.model}</strong> : <strong>Local model</strong>}
              <span>{readiness.detail}</span>
            </span>
          </div>
          <button type="button" onClick={() => void checkReadiness()}>Check connection</button>
        </div>
      </aside>
      <main>
        <header className="page-header"><h1>AI Agent &amp; MCP Workflow Lab</h1></header>
        <div aria-live="polite">
          {firstUnread && <div className="job-notice">
            <span>{firstUnread.status === 'completed' ? 'Inventory audit complete' : 'Inventory audit failed'}{jobFeed.unread.length > 1 ? ` · ${jobFeed.unread.length} unread` : ''}</span>
            <button type="button" onClick={() => openJob(firstUnread)}>Open job</button>
          </div>}
        </div>
        {view === 'jobs' && <Jobs jobs={jobFeed.jobs} unread={jobFeed.unread} error={jobFeed.error}
          selectedId={selectedJob} onSelect={openJob} onLogs={openLogs} />}
        {view === 'api' && <APIReference />}
        {view === 'tools' && <MCPTools />}
        {view === 'logs' && <Logs filter={logFilter} setFilter={setLogFilter} />}
        {view === 'chat' && (
      <section className="chat" aria-label="Chat">
        <div className="toolbar">
          <h2>Local chat</h2>
          <div className="chat-controls">
            <label htmlFor="engine">Engine</label>
            <select id="engine" value={engine} disabled={pending}
              onChange={(event) => setEngine(event.target.value as Engine)}>
              <option value="loop">Go loop</option>
              <option value="state-machine">State machine</option>
              <option value="temporal">Temporal</option>
            </select>
            <button type="button" onClick={reset} disabled={pending || jobPending}>New chat</button>
          </div>
        </div>
        <div className="transcript" role="log" aria-label="Conversation">
          {!messages.length && !pending && <div className="chat-empty">
            <div className="empty-mark" aria-hidden="true">◇</div>
            <h3>Start a conversation</h3>
            <p>Ask about demo inventory or try a two-tool workflow.</p>
            <div className="suggestions">
              {[
                'How many LAMP-42 desk lamps are in stock?',
                'Is LAMP-42 in stock, and when can I pick it up?',
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
                {run && <span className="run-engine"> · {engineLabels[run.engine]}</span>}
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
                    {run.runId && <p>Run ID <code>{run.runId}</code></p>}
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
            <p className="empty">Waiting for the model…</p>
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
