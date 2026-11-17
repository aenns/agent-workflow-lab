import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { workerControl } from './worker-control.mjs';

const host = '127.0.0.1:5173';
const origin = 'http://' + host;

function fixture(t, { enabled = true, pollers = [] } = {}) {
  const state = mkdtempSync(join(tmpdir(), 'lab-worker-control-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  let middleware;
  const queries = [];
  workerControl({
    state, enabled,
    connect: async () => ({
      withDeadline: (_deadline, query) => query(),
      workflowService: { describeTaskQueue: async (query) => {
        queries.push(query);
        return { pollers };
      } },
    }),
  }).configureServer({ middlewares: { use: (handler) => { middleware = handler; } } });

  async function request(path, method = 'GET', headers = {}) {
    let status;
    let result;
    await middleware({ url: '/__lab/temporal-worker/' + path, method, headers: { host, origin, ...headers } }, {
      writeHead: (code) => { status = code; },
      end: (body) => { result = JSON.parse(body); },
    }, () => assert.fail('Worker route passed to the next middleware.'));
    return { status, result };
  }

  return { state, queries, request };
}

test('worker mutations require the local origin and change only the selected backend', async (t) => {
  const { state, request } = fixture(t);
  writeFileSync(join(state, 'worker-go.run'), '');
  assert.equal((await request('go/stop', 'POST', { origin: 'https://example.com' })).status, 403);
  assert.equal((await request('go/stop')).status, 403);
  assert.equal((await request('rust/start', 'POST')).status, 404);
  assert.equal((await request('python/start', 'POST')).status, 202);
  assert.equal((await request('python/stop', 'POST')).status, 202);
  assert.equal(existsSync(join(state, 'worker-python.run')), false);
  assert.equal(existsSync(join(state, 'worker-go.run')), true);
  writeFileSync(join(state, 'stop'), '');
  assert.equal((await request('python/start', 'POST')).status, 409);
});

test('polling status matches the current worker identity and selected task queue', async (t) => {
  const pollers = [{ identity: 'previous-python-worker' }];
  const { state, queries, request } = fixture(t, { pollers });
  writeFileSync(join(state, 'worker-python.run'), '');
  writeFileSync(join(state, 'worker-python.identity'), 'current-python-worker\n');
  assert.equal((await request('python')).result.status, 'starting');
  pollers.push({ identity: 'current-python-worker' });
  assert.equal((await request('python')).result.status, 'polling');
  await request('python/stop', 'POST');
  assert.equal((await request('python')).result.status, 'stopping');
  rmSync(join(state, 'worker-python.identity'));
  assert.equal((await request('python')).result.status, 'stopped');
  assert.ok(queries.every((query) => query.taskQueue.name === 'workflow-lab-python'));
});

test('manually started sessions can inspect recent pollers without changing launcher state', async (t) => {
  const { state, request } = fixture(t, { enabled: false, pollers: [{ identity: 'manual-worker' }] });
  assert.equal((await request('typescript')).result.status, 'recent-pollers');
  assert.equal((await request('typescript/start', 'POST')).status, 409);
  assert.equal(existsSync(join(state, 'worker-typescript.run')), false);
});
