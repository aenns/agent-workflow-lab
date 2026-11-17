import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection } from '@temporalio/client';

const queues = {
  go: 'workflow-lab-chat',
  typescript: 'workflow-lab-typescript',
  python: 'workflow-lab-python',
};
const state = fileURLToPath(new URL('../../.lab/launcher/', import.meta.url));
const route = /^\/__lab\/temporal-worker\/(go|typescript|python)(?:\/(start|stop))?$/;

function send(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function readIdentity(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }
}

export function workerControl() {
  let connection;
  return {
    name: 'lab-worker-control',
    configureServer(server) {
      server.httpServer?.once('close', () => {
        void connection?.then((client) => client.close()).catch(() => {});
      });
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith('/__lab/temporal-worker/')) return next();
        const match = route.exec(request.url);
        if (!match) return send(response, 404, { error: 'Unknown worker.' });
        const [, backend, action] = match;
        const key = join(state, 'worker-' + backend);
        // A manually started dev server can inspect queues without managing processes.
        const managed = process.env.LAB_WORKER_CONTROL === '1' &&
          existsSync(state) && !existsSync(join(state, 'stop'));
        try {
          if (action) {
            // Browser mutations must originate from this loopback dev server.
            const host = request.headers.host;
            if (request.method !== 'POST' || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host ?? '') ||
                request.headers.origin !== 'http://' + host) {
              return send(response, 403, { error: 'Worker controls require the local lab page.' });
            }
            if (!managed) return send(response, 409, { error: 'Start the lab with Start Lab.command to manage workers.' });
            if (action === 'start') writeFileSync(key + '.run', '');
            else rmSync(key + '.run', { force: true });
            return send(response, 202, { accepted: true });
          }
          if (request.method !== 'GET') return send(response, 405, { error: 'Use GET to check worker status.' });

          const desired = managed && existsSync(key + '.run');
          const identity = managed ? readIdentity(key + '.identity') : '';
          const details = { managed, desired, queue: queues[backend] };
          try {
            connection ??= Connection.connect({
              address: process.env.TEMPORAL_ADDR || '127.0.0.1:7233', connectTimeout: '2s',
            }).catch((error) => {
              connection = undefined;
              throw error;
            });
            const client = await connection;
            const { pollers } = await client.withDeadline(Date.now() + 2000, () =>
              client.workflowService.describeTaskQueue({
                namespace: 'default', taskQueue: { name: queues[backend] },
              }));
            // Temporal retains recently seen pollers. Match this launch's unique identity
            // so a stopped worker cannot make its replacement look ready.
            if (!managed) return send(response, 200, {
              ...details, status: pollers?.length ? 'recent-pollers' : 'no-pollers',
            });
            const status = existsSync(key + '.stopping') || (!desired && identity) ? 'stopping' :
              desired ? (identity && pollers?.some((poller) => poller.identity === identity) ? 'polling' : 'starting') :
              existsSync(key + '.failed') ? 'failed' : 'stopped';
            return send(response, 200, { ...details, status });
          } catch {
            return send(response, 200, { ...details, status: 'unavailable' });
          }
        } catch {
          return send(response, 503, { error: 'Could not read or update the launcher state.' });
        }
      });
    },
  };
}
