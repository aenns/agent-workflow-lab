import assert from 'node:assert/strict';
import { jsonLines } from '../../../packages/chat-stream.ts';
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
    const input = JSON.parse(body);
    requests.push({ headers: String(request.headers['x-correlation-id']), messages: input.messages });
    const turns = input.messages.filter((message: { role: string }) => message.role === 'tool').length;
    if (input.messages.some((message: { content: string }) => message.content === 'broken-stream')) {
      response.end(JSON.stringify({ message: { role: 'assistant', content: 'partial' }, done: false }) + '\n');
      return;
    }
    const tool = (name: string, args: object) => ({
      role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }],
    });
    const message = turns === 0 ? tool('lookup_inventory', { sku: 'LAMP-42' }) :
      turns === 1 ? tool('warehouse_hours', { warehouse: 'north' }) :
        { role: 'assistant', content: 'There are seven lamps at the north warehouse.' };
    if (input.stream) {
      response.setHeader('Content-Type', 'application/x-ndjson');
      if (message.content) {
        response.write(JSON.stringify({ message: { role: 'assistant', content: 'There are ' }, done: false }) + '\n');
        response.write(JSON.stringify({ message: { role: 'assistant', content: message.content.slice(10) }, done: false }) + '\n');
      } else response.write(JSON.stringify({ message, done: false }) + '\n');
      response.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 10, eval_count: 2 }) + '\n');
    } else {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ message, prompt_eval_count: 10, eval_count: 2 }));
    }
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
    const streamed = await fetch(base + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'Check the lamp and warehouse hours.' }] }),
    });
    assert.match(streamed.headers.get('Content-Type') ?? '', /application\/x-ndjson/);
    assert(streamed.body);
    const events = [];
    for await (const event of jsonLines(streamed.body)) events.push(event);
    assert.equal(events.filter(event => event.type === 'model-start').length, 3);
    assert.deepEqual(events.filter(event => event.type === 'tool-start').map(event => event.name), ['lookup_inventory', 'warehouse_hours']);
    assert.equal(events.filter(event => event.type === 'tool-complete').length, 2);
    assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), reply.message.content);
    assert.equal(events.at(-1).type, 'complete');
    assert.deepEqual(events.at(-1).reply.usage, reply.usage);
    assert.deepEqual(events.at(-1).reply.tools.map((tool: {name: string}) => tool.name), reply.tools.map((tool: {name: string}) => tool.name));
    const broken = await fetch(base + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'broken-stream' }] }),
    });
    const brokenEvents = [];
    for await (const event of jsonLines(broken.body!)) brokenEvents.push(event);
    assert.equal(brokenEvents.at(-1).type, 'error');
    assert.ok(!brokenEvents.some(event => event.type === 'complete'));
    // Optional real PostgreSQL coverage, enabled by the integration validation command.
    if (process.env.TEST_STREAM_GRAPH) {
      const body = { stream: true, engine: 'state-machine', runId: 'stream-test-' + Date.now(),
        messages: [{ role: 'user', content: 'Check the lamp and warehouse hours.' }] };
      for (const cached of [false, true]) {
        const response = await fetch(base + '/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const events = [];
        for await (const event of jsonLines(response.body!)) events.push(event);
        assert.equal(events.at(-1).type, 'complete', JSON.stringify(events));
        assert.equal(events.at(-1).reply.tools.length, 2);
        assert.equal(events.at(-1).reply.states.at(-1), 'Complete');
        assert.equal(events.filter(event => event.type === 'tool-start').length, cached ? 0 : 2);
      }
    }
    const invalidStream = await fetch(base + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: 'true', engine: 'temporal', messages: [{ role: 'user', content: 'Hello' }] }),
    });
    assert.equal(invalidStream.status, 400);
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

// Exercise the same decoder used by the browser and Ollama adapter with real
// byte boundaries, including a multibyte character split across chunks.
test('NDJSON decoder handles fragmented UTF-8 and rejects malformed records', async () => {
  const bytes = new TextEncoder().encode('{"text":"café"}\n\n{"done":true}');
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  }});
  const values = [];
  for await (const value of jsonLines(body)) values.push(value);
  assert.deepEqual(values, [{ text: 'café' }, { done: true }]);
  const broken = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"incomplete":')); controller.close();
  }});
  await assert.rejects(async () => { for await (const value of jsonLines(broken)) void value; }, SyntaxError);
});
