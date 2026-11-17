import { apiPath, type Backend } from './backend';
import { useEffect, useState, type FormEvent } from 'react';
import { correlatedFetch } from './telemetry';

type SavedQuery = { id: string; title: string; description: string; sql: string; requiresRunId: boolean };
type QueryResult = { columns: string[]; rows: unknown[][] };

async function readJSON<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload === null) throw new Error(payload?.error ?? 'The database request failed.');
  return payload as T;
}

export function Database({ backend, initialRunId }: { backend: Backend; initialRunId: string }) {
  const [queries, setQueries] = useState<SavedQuery[]>();
  const [catalogError, setCatalogError] = useState('');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState(initialRunId ? 'run-history' : 'recent-runs');
  const [runId, setRunId] = useState(initialRunId);
  const [result, setResult] = useState<QueryResult>();
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const query = queries?.find((item) => item.id === selected);

  useEffect(() => {
    const controller = new AbortController();
    setCatalogError('');
    void correlatedFetch(apiPath(backend, '/api/database/queries'), { signal: controller.signal })
      .then(readJSON<SavedQuery[]>)
      .then((items) => { if (!controller.signal.aborted) setQueries(items); })
      .catch((cause: Error) => { if (!controller.signal.aborted) setCatalogError(cause.message); });
    return () => controller.abort();
  }, [backend, revision]);

  function select(id: string) {
    setSelected(id);
    setResult(undefined);
    setError('');
  }

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query || running) return;
    setRunning(true);
    setResult(undefined);
    setError('');
    try {
      const response = await correlatedFetch(apiPath(backend, '/api/database/query'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queryId: query.id, runId: query.requiresRunId ? runId.trim() : undefined }),
      });
      setResult(await readJSON<QueryResult>(response));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not run the query.');
    } finally {
      setRunning(false);
    }
  }

  return <section className="panel" aria-labelledby="database-title">
    <div className="panel-heading">
      <div><h2 id="database-title">Database</h2><p>Read-only queries for state-machine checkpoints in PostgreSQL.</p></div>
    </div>
    {catalogError && <p className="panel-status error" role="alert">{catalogError} <button onClick={() => setRevision((value) => value + 1)}>Retry</button></p>}
    {!queries && !catalogError && <p className="panel-status" role="status">Loading saved queries…</p>}
    {!!queries?.length && <div className="database-content">
      <form className="database-controls" onSubmit={(event) => void run(event)}>
        <label>Saved query<select value={selected} onChange={(event) => select(event.target.value)} disabled={running}>
          {queries.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select></label>
        {query?.requiresRunId && <label>State-machine Run ID
          <input value={runId} onChange={(event) => setRunId(event.target.value)} disabled={running} maxLength={64} placeholder="Paste a Run ID" />
        </label>}
        <button type="submit" disabled={running || !query || (query.requiresRunId && !runId.trim())}>
          {running ? 'Running…' : 'Run query'}
        </button>
      </form>
      {query && <>
        <p className="muted">{query.description}</p>
        {query.sql && <details className="tool-trace"><summary>View SQL</summary><pre className="code-block">{query.sql}</pre></details>}
      </>}
      {error && <p className="error" role="alert">{error}</p>}
      {result && <>
        <p className="muted" role="status">{result.rows.length} {result.rows.length === 1 ? 'row' : 'rows'} returned</p>
        {result.rows.length === 0 ? <p>No records match this query.</p> : <div className="database-table" tabIndex={0} aria-label="Query results">
          <table>
            <thead><tr>{result.columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
            <tbody>{result.rows.map((row, rowIndex) => <tr key={rowIndex}>
              {row.map((value, index) => <td key={index}>
                {result.columns[index] === 'run_id' && typeof value === 'string' ?
                  <button type="button" className="text-button" onClick={() => { setRunId(value); select('run-history'); }}>{value}</button> :
                  value === null ? <span className="muted">NULL</span> :
                  typeof value === 'object' ? <details><summary>View JSON</summary>
                    <pre className="code-block">{JSON.stringify(value, null, 2)}</pre>
                  </details> : String(value)}
              </td>)}
            </tr>)}</tbody>
          </table>
        </div>}
      </>}
    </div>}
  </section>;
}
