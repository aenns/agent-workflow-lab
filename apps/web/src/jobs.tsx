import { useEffect, useState } from 'react';
import { TokenTrace, ToolTrace, type TokenUsage, type ToolEvent } from './traces';
import { correlatedFetch } from './telemetry';

export type Job = {
  id: string;
  prompt: string;
  model?: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  correlationId?: string;
  report?: { message: { content: string }; tools?: ToolEvent[]; usage?: TokenUsage[] };
};

const readKey = 'workflow-lab:read-jobs';

function readNotifications(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(readKey) ?? '[]'));
  } catch {
    return new Set();
  }
}

export function useJobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState('');
  const [read, setRead] = useState(readNotifications);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch('/api/jobs', { signal: controller.signal });
        if (!response.ok) throw new Error('Temporal is unavailable. Run make dev-temporal and make dev-worker to use background jobs.');
        const next = await response.json() as Job[];
        if (controller.signal.aborted) return;
        const visible = new Set(next.map((job) => job.id));
        setJobs((previous) => [
          ...previous.filter((job) => job.status === 'running' && !visible.has(job.id) &&
            Date.now() - Date.parse(job.startedAt) < 30_000),
          ...next,
        ]);
        setError('');
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not list jobs.');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);

  // Workflow history owns job status. Browser storage remembers which
  // finished jobs this browser has acknowledged.
  const unread = jobs.filter((job) => job.status !== 'running' && !read.has(job.id))
    .sort((a, b) => Date.parse(b.finishedAt ?? b.startedAt) - Date.parse(a.finishedAt ?? a.startedAt));
  function markRead(id: string) {
    const next = new Set(read).add(id);
    setRead(next);
    try {
      localStorage.setItem(readKey, JSON.stringify([...next].slice(-250)));
    } catch {
      // The current tab can still acknowledge notifications.
    }
  }
  function add(job: Job) {
    setJobs((current) => [job, ...current.filter((entry) => entry.id !== job.id)]);
  }
  return { jobs, error, unread, markRead, add };
}

const statusLabel: Record<Job['status'], string> = {
  running: 'Queued or running',
  completed: 'Completed',
  failed: 'Failed',
};

export function Jobs({ jobs, unread, error, selectedId, onSelect, onLogs }: {
  jobs: Job[]; unread: Job[]; error: string; selectedId: string;
  onSelect: (job: Job) => void; onLogs: (id: string) => void;
}) {
  const selected = jobs.find((job) => job.id === selectedId);
  const status = selected?.status;
  const [details, setDetails] = useState<Job>();
  const [detailError, setDetailError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!selectedId || !status || status === 'running') return;
    const controller = new AbortController();
    setDetailError('');
    void correlatedFetch(`/api/jobs/${encodeURIComponent(selectedId)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load the job report.');
        const result = await response.json() as Job;
        if (!controller.signal.aborted) setDetails(result);
      }).catch((cause: Error) => {
        if (!controller.signal.aborted) setDetailError(cause.message);
      });
    return () => controller.abort();
  }, [selectedId, status, revision]);
  // The selected job can change while a detail request is in flight.
  const report = details?.id === selected?.id ? details?.report : undefined;
  const newIds = new Set(unread.map((job) => job.id));
  return <section className="panel" aria-labelledby="jobs-title">
    <div className="panel-heading">
      <div><h2 id="jobs-title">Jobs</h2><p>Inventory audits submitted with Run in background.</p></div>
    </div>
    {error && <p className="panel-status error" role="status">{error}</p>}
    {!jobs.length && !error && <p className="panel-status">No background jobs yet.</p>}
    {!!jobs.length && <div className="job-list">
      {jobs.map((job) => <button className="job-row" type="button" key={job.id} aria-pressed={job.id === selectedId}
        onClick={() => onSelect(job)}>
        <span>{job.prompt}</span><span className={`job-status ${job.status}`}>{statusLabel[job.status]}{newIds.has(job.id) ? ' · New' : ''}</span>
      </button>)}
    </div>}
    {selected && <div className="job-report">
      <h3>Job report</h3>
      <p className="muted">{statusLabel[selected.status]}{selected.model && ` · ${selected.model}`} · <code>{selected.id}</code></p>
      <div className="run-meta">
        {selected.correlationId && <button type="button" onClick={() => onLogs(selected.correlationId!)}>View logs ↗</button>}
        <a href="http://127.0.0.1:8233/namespaces/default/workflows" target="_blank" rel="noreferrer">Temporal history ↗</a>
      </div>
      {selected.status === 'running' && <p>The job will appear here when it finishes.</p>}
      {selected.status === 'failed' && <p className="error">The audit failed. Open Temporal history to inspect the run.</p>}
      {detailError && <p className="error" role="alert">{detailError} <button onClick={() => setRevision((value) => value + 1)}>Retry</button></p>}
      {selected.status === 'completed' && !detailError && !report && <p role="status">Loading report…</p>}
      {report && <>
        <p className="report-text">{report.message.content}</p>
        {!!report.usage?.length && <TokenTrace calls={report.usage} />}
        {!!report.tools?.length && <ToolTrace tools={report.tools} />}
      </>}
    </div>}
  </section>;
}
