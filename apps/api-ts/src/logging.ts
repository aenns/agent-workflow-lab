import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = resolve(fileURLToPath(new URL('../../../', import.meta.url)), process.env.LAB_LOG_DIR || '.lab/logs');
const maxBytes = 512 * 1024;
const sources = ['api-typescript', 'mcp-typescript', 'mcp-worker-typescript', 'temporal-worker-typescript', 'api', 'api-mcp', 'temporal-worker', 'worker-mcp', 'api-python', 'mcp-python', 'mcp-worker-python', 'temporal-worker-python', 'api-java', 'mcp-java', 'temporal-worker-java', 'mcp-worker-java', 'restate-java', 'mcp-restate-java'];

export type Trace = { correlationId: string; service: string };

export function log(trace: Trace, component: string, msg: string, fields: Record<string, unknown> = {}, level = 'info') {
  const record = JSON.stringify({
    time: new Date().toISOString(), level, msg, service: trace.service,
    backend: 'typescript', component, correlation_id: trace.correlationId, ...fields,
  }) + '\n';
  process.stderr.write(record); // MCP reserves stdout for protocol messages.
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, trace.service + '.jsonl');
    // Each process role has its own file and retains one previous generation.
    if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) + Buffer.byteLength(record) > maxBytes) {
      renameSync(path, path + '.previous');
    }
    appendFileSync(path, record, { mode: 0o600 });
  } catch {
    // Terminal logs remain available when the optional local copy fails.
  }
}

export function recentLogs() {
  const entries: { time: string; msg: string }[] = [];
  for (const source of sources) {
    for (const suffix of ['.jsonl', '.jsonl.previous']) {
      let content: string;
      try {
        content = readFileSync(resolve(directory, source + suffix), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const line of content.split('\n')) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (typeof entry?.time === 'string' && typeof entry?.msg === 'string') entries.push(entry);
        } catch { /* A concurrent writer can leave a partial final line. */ }
      }
    }
  }
  return entries.sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, 500);
}
