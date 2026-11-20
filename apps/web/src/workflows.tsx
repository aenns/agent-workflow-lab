import { useEffect, useState, type FormEvent } from 'react';
import { correlatedFetch } from './telemetry';

type WorkflowRun = {
  id: string;
  status: 'queued' | 'running' | 'waiting-for-approval' | 'completed' | 'cancelled' | 'failed';
  inventory?: { sku: string; result: { stock?: number; warehouse?: string; error?: string } }[];
  pickup?: { warehouse?: string; pickupHours?: string; error?: string }[];
  steps?: string[];
  summary?: string;
  error?: string;
};

const endpoint = '/java/api/workflows';
const storageKey = 'workflow-lab:restate-run';
const statusLabels: Record<WorkflowRun['status'], string> = {
  queued: 'Queued', running: 'Running', 'waiting-for-approval': 'Waiting for your decision',
  completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed',
};

async function read(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error(body?.error || 'The Java workflow service is unavailable.');
  return body;
}

export function Workflows({ onLogs }: { onLogs: (id: string) => void }) {
  const [items, setItems] = useState('LAMP-42, MUG-17');
  const [pickupHours, setPickup] = useState(true);
  const [requireApproval, setApproval] = useState(true);
  const [summarize, setSummary] = useState(true);
  const [id, setId] = useState(() => localStorage.getItem(storageKey) ?? '');
  const [run, setRun] = useState<WorkflowRun>();
  const [busy, setBusy] = useState(false);
  const [decisionSent, setDecisionSent] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let terminal = false;
      try {
        const next: WorkflowRun = await read(await fetch(endpoint + '/' + encodeURIComponent(id), { signal: controller.signal }));
        if (controller.signal.aborted) return;
        setRun(next);
        setPollError('');
        terminal = ['completed', 'cancelled', 'failed'].includes(next.status);
      } catch (cause) {
        if (!controller.signal.aborted) setPollError((cause as Error).message);
      } finally {
        if (!terminal && !controller.signal.aborted) timer = setTimeout(() => void poll(), 1500);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id]);

  async function start(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const next: WorkflowRun = await read(await correlatedFetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.split(',').map((item) => item.trim()).filter(Boolean), pickupHours, requireApproval, summarize }),
      }));
      localStorage.setItem(storageKey, next.id);
      setDecisionSent(false);
      setRun(next);
      setId(next.id);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function decide(decision: 'continue' | 'cancel') {
    setBusy(true);
    setError('');
    try {
      await read(await correlatedFetch(endpoint + '/' + encodeURIComponent(id) + '/decision', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }),
      }, id));
      setDecisionSent(true);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="panel" aria-labelledby="workflow-title">
    <div className="panel-heading">
      <div><h2 id="workflow-title">Inventory workflow</h2><p>Configure an inventory audit and run it on Restate.</p></div>
    </div>
    <form className="workflow-form" onSubmit={(event) => void start(event)}>
      <label>Inventory SKUs <input required maxLength={128} value={items} onChange={(event) => setItems(event.target.value)} /></label>
      <label><input type="checkbox" checked={pickupHours} onChange={(event) => setPickup(event.target.checked)} /> Look up pickup hours</label>
      <label><input type="checkbox" checked={requireApproval} onChange={(event) => setApproval(event.target.checked)} /> Pause for approval if any item is unavailable</label>
      <label><input type="checkbox" checked={summarize} onChange={(event) => setSummary(event.target.checked)} /> Summarize the result with Ollama</label>
      <button disabled={busy || (!!run && !['completed', 'cancelled', 'failed'].includes(run.status))}>Start workflow</button>
    </form>
    {(error || pollError) && <p className="panel-status error" role="alert">{error || pollError}</p>}
    {run && <div className="workflow-run">
      <h3 role="status">{statusLabels[run.status]}</h3>
      <p className="run-meta">Run ID <code>{run.id}</code> <button type="button" onClick={() => onLogs(run.id)}>View logs ↗</button></p>
      {!!run.inventory?.length && <ul>{run.inventory.map(({ sku, result }) => <li key={sku}>
        <strong>{sku}</strong> · {result.error ?? `${result.stock} in stock at ${result.warehouse}`}
      </li>)}</ul>}
      {!!run.pickup?.length && <ul>{run.pickup.map((item, index) => <li key={index}>{item.error ?? `${item.warehouse} · ${item.pickupHours}`}</li>)}</ul>}
      {run.status === 'waiting-for-approval' && <div className="inline-controls">
        <button type="button" disabled={busy || decisionSent} onClick={() => void decide('continue')}>Continue with available items</button>
        <button type="button" disabled={busy || decisionSent} onClick={() => void decide('cancel')}>Cancel this run</button>
      </div>}
      {run.summary && <p>{run.summary}</p>}
      {run.error && <p className="error">{run.error}</p>}
      {!!run.steps?.length && <details open><summary>Workflow steps</summary><ol>{run.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></details>}
    </div>}
  </section>;
}
