import { useEffect, useState } from 'react';
import { backendLabels, type Backend } from './backend';

type WorkerState = {
  managed: boolean;
  desired: boolean;
  queue: string;
  status: keyof typeof statusLabels;
};

const statusLabels = {
  polling: 'Polling', starting: 'Starting…', stopping: 'Stopping…', stopped: 'Stopped',
  unavailable: 'Temporal unavailable', failed: 'Worker exited',
  'recent-pollers': 'Recent poller seen', 'no-pollers': 'No pollers seen',
};

async function readResponse(response: Response) {
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error ?? 'Worker controls unavailable.');
  return data;
}

export function WorkerControl({ backend, waitingForReply }: { backend: Backend; waitingForReply: boolean }) {
  const endpoint = '/__lab/temporal-worker/' + backend;
  const [worker, setWorker] = useState<WorkerState>();
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    // Refresh after each response so slow Temporal checks cannot overlap.
    async function poll() {
      try {
        const state = await readResponse(await fetch(endpoint, { signal: controller.signal })) as WorkerState;
        if (!controller.signal.aborted) {
          setWorker(state);
          setStatusError('');
        }
      } catch (cause) {
        if (!controller.signal.aborted) setStatusError((cause as Error).message);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [endpoint, refresh]);

  async function changeWorker(start: boolean) {
    setPending(true);
    setError('');
    try {
      await readResponse(await fetch(endpoint + (start ? '/start' : '/stop'), { method: 'POST' }));
      setWorker((current) => current && {
        ...current, desired: start, status: start ? 'starting' : 'stopping',
      });
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(false);
    }
  }

  const label = statusError || (worker ? statusLabels[worker.status] : 'Checking…');
  return (
    <div className="worker-control" aria-label={backendLabels[backend] + ' Temporal worker'}>
      <span role="status"><strong>Temporal worker</strong> · {label}</span>
      {worker?.managed && !statusError && (
        <button type="button" onClick={() => void changeWorker(!worker.desired)}
          disabled={pending || worker.status === 'stopping' ||
            (!worker.desired && worker.status === 'unavailable')}>
          {worker.desired ? 'Stop worker' : 'Start worker'}
        </button>
      )}
      {worker && !worker.managed && <small>Start with Start Lab.command to manage this worker.</small>}
      {waitingForReply && worker?.managed && ['stopped', 'stopping', 'starting'].includes(worker.status) &&
        <small>This reply needs a polling worker. Start the worker to continue.</small>}
      {error && <span className="error" role="alert">{error}</span>}
    </div>
  );
}
