import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('TypeScript HTTP turn uses both MCP tools and propagates the correlation ID', { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-lab-ts-test-'));
  const correlation = 'test-typescript-correlated-turn';
  const requests: { headers: string | undefined; messages: { role: string; content: string }[] }[] = [];
  const model = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ headers: String(request.headers['x-correlation-id']), messages: JSON.parse(body).messages });
    const tool = (name: string, args: object) => ({
      role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }],
    });
    const message = requests.length === 1 ? tool('lookup_inventory', { sku: 'LAMP-42' }) :
      requests.length === 2 ? tool('warehouse_hours', { warehouse: 'north' }) :
        { role: 'assistant', content: 'There are seven lamps at the north warehouse.' };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ message, prompt_eval_count: 10, eval_count: 2 }));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const address = model.address();
  assert(address && typeof address === 'object');

  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.ts', import.meta.url))], {
    env: { ...process.env, TS_API_PORT: '0', OLLAMA_URL: `http://127.0.0.1:${address.port}`, LAB_LOG_DIR: directory },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exited = once(child, 'exit');
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('TypeScript API did not start.')), 10_000);
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`API exited with code ${code}.`)); });
      let buffered = '';
      child.stderr.on('data', (chunk) => {
        buffered += chunk.toString();
        const match = buffered.match(/"msg":"api.started".*"port":(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const contract = await fetch(base + '/api/openapi.yaml');
    assert.equal(contract.status, 200);
    assert.equal(await contract.text(),
      readFileSync(new URL('../../api/internal/httpapi/contract/openapi.yaml', import.meta.url), 'utf8'));
    const response = await fetch(base + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Correlation-ID': correlation },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Check the lamp and warehouse hours.' }] }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Correlation-ID'), correlation);
    assert.equal(response.headers.get('X-Lab-Backend'), 'typescript');
    const reply = await response.json();
    assert.deepEqual(reply.tools.map(({ name }: { name: string }) => name), ['lookup_inventory', 'warehouse_hours']);
    assert.ok(reply.tools.every(({ isError }: { isError: boolean }) => !isError));
    assert.deepEqual(reply.usage, Array.from({ length: 3 }, () => ({ inputTokens: 10, outputTokens: 2 })));
    assert.ok(requests.every(({ headers }) => headers === correlation));
    assert.match(requests[1].messages.at(-1)?.content ?? '', /"stock":7/);
    assert.match(requests[2].messages.at(-1)?.content ?? '', /09:00/);
    const logs = await (await fetch(base + '/api/logs')).json();
    const scoped = logs.filter((entry: { correlation_id: string }) => entry.correlation_id === correlation);
    assert.ok(scoped.some((entry: { service: string; backend: string }) =>
      entry.service === 'api-typescript' && entry.backend === 'typescript'));
    assert.equal(scoped.filter((entry: { service: string }) => entry.service === 'mcp-typescript').length, 2);
    const invalid = await fetch(base + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'assistant', content: 'Invalid first role' }] }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    child.kill('SIGTERM');
    await exited;
    model.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
