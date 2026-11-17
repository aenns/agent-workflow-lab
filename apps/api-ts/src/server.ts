import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { connectTools, defaultModel, installedModels, listTools, runLoop } from './agent.ts';
import { HttpError } from './errors.ts';
import { closeDatabase, databaseQuery, queries, runGraph } from './graph.ts';
import { installModel, searchLibrary } from './library.ts';
import { log, recentLogs } from './logging.ts';
import { closeTemporal, getJob, listJobs, submitJob, temporalChat } from './temporal.ts';

const service = 'api-typescript';
const id = z.string().regex(/^[a-zA-Z0-9_-]{16,64}$/);
const text = z.string().trim().min(1).refine((value) => Buffer.byteLength(value) <= 8000);
const modelTag = z.string().trim().max(255).optional();
// Runtime validation mirrors the shared OpenAPI request shape and enforces turn order.
const chatSchema = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().refine((value) => value.trim().length > 0) })).min(1).max(41)
    .refine((messages) => messages.length % 2 === 1 &&
      messages.every(({ role, content }, index) => role === (index % 2 ? 'assistant' : 'user') &&
        (role === 'assistant' || Buffer.byteLength(content) <= 8000))),
  model: modelTag,
  engine: z.enum(['loop', 'state-machine', 'temporal']).default('loop'),
  runId: id.optional(),
});
// Serve the same source YAML as Go. Go generates bindings from it, while this API uses Zod.
const contract = readFileSync(new URL('../../api/internal/httpapi/contract/openapi.yaml', import.meta.url));
const chatTimeout = Number(process.env.TS_CHAT_TIMEOUT_MS || 180_000);
if (!Number.isSafeInteger(chatTimeout) || chatTimeout < 1 || chatTimeout > 3_600_000) {
  throw new Error('TS_CHAT_TIMEOUT_MS must be between 1 and 3600000.');
}

async function jsonBody<T>(request: IncomingMessage, schema: z.ZodType<T>, limit: number): Promise<T> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Send an application/json request.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw new HttpError(413, 'Request is too large.');
    }
    chunks.push(chunk);
  }
  try {
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    throw new HttpError(400, 'The request does not match the API contract. Check the body and field limits.');
  }
}

function send(response: ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

const tools = await connectTools();
const server = createServer(async (request, response) => {
  const started = Date.now();
  const correlationId = id.safeParse(request.headers['x-correlation-id']).data ?? randomUUID();
  const trace = { service, correlationId };
  let target: URL;
  try {
    target = new URL(request.url ?? '/', 'http://localhost');
  } catch {
    return send(response, { error: 'Invalid request URL.' }, 400);
  }
  const { pathname, searchParams } = target;
  const route = request.method + ' ' + pathname;
  // Cancel request-scoped I/O if the browser disconnects, including streamed model pulls.
  const connection = new AbortController();
  response.on('close', () => connection.abort());
  if (pathname !== '/api/logs') response.on('finish', () => log(trace, 'http', 'http.request.completed', {
    route: pathname.startsWith('/api/jobs/') ? '/api/jobs/{jobId}' : pathname,
    method: request.method, status: response.statusCode, duration_ms: Date.now() - started,
  }));
  response.setHeader('X-Correlation-ID', correlationId);
  response.setHeader('X-Lab-Backend', 'typescript');
  const timeout = (ms: number) => AbortSignal.any([connection.signal, AbortSignal.timeout(ms)]);
  const models = () => installedModels(trace, timeout(3000));
  async function chooseModel(name?: string) {
    if (name && !(await models()).includes(name)) {
      throw new HttpError(400, 'Choose an installed Ollama model that supports tools.');
    }
    return name || defaultModel;
  }
  try {
    switch (route) {
      case 'GET /api/openapi.yaml':
        response.writeHead(200, { 'Content-Type': 'application/yaml' });
        response.end(contract);
        return;
      case 'GET /api/health':
        return send(response, { status: 'ok' });
      case 'GET /api/ready':
        try {
          if (!(await models()).includes(defaultModel)) throw new Error('Default model is unavailable.');
          await listTools(tools, trace, timeout(2000));
          return send(response, { status: 'ready', model: defaultModel });
        } catch {
          return send(response, { status: 'unavailable', model: defaultModel,
            error: 'Check that Ollama, the default model, and the TypeScript MCP server are available.' }, 503);
        }
      case 'GET /api/models':
        return send(response, { defaultModel, models: await models() });
      case 'GET /api/models/search':
        return send(response, await searchLibrary(searchParams.get('q')?.trim() ?? '', timeout(12_000)));
      case 'POST /api/models/install': {
        const body = await jsonBody(request, z.object({ model: z.string().trim() }), 4096);
        return await installModel(body.model, trace, timeout(7_200_000), response);
      }
      case 'GET /api/tools':
        return send(response, await listTools(tools, trace, timeout(2000)));
      case 'GET /api/logs':
        return send(response, recentLogs());
      case 'GET /api/database/queries':
        return send(response, queries);
      case 'POST /api/database/query': {
        const body = await jsonBody(request, z.strictObject({ queryId: z.string(), runId: id.optional() }), 4096);
        return send(response, await databaseQuery(body.queryId, body.runId));
      }
      case 'POST /api/chat': {
        const body = await jsonBody(request, chatSchema, 512 * 1024);
        const runId = body.engine === 'loop' ? undefined : body.runId ?? randomUUID();
        if (runId) response.setHeader('X-Run-ID', runId);
        const input = { ...body, runId, model: await chooseModel(body.model), correlationId };
        const signal = timeout(chatTimeout);
        log(trace, 'chat', 'chat.started', { engine: body.engine, model: input.model });
        try {
          const result = body.engine === 'state-machine' ? await runGraph(tools, input, trace, signal) :
            body.engine === 'temporal' ? await temporalChat(input, signal) : await runLoop(tools, input, trace, signal);
          return send(response, result);
        } catch (error) {
          if (signal.aborted && !connection.signal.aborted) throw new HttpError(504, 'The chat request timed out.');
          throw error;
        }
      }
      case 'GET /api/jobs':
        return send(response, await listJobs());
      case 'POST /api/jobs': {
        const body = await jsonBody(request, z.object({ prompt: text, model: modelTag, key: id.optional() }), 16 * 1024);
        const model = await chooseModel(body.model);
        const job = await submitJob({ model, correlationId, messages: [{ role: 'user', content: body.prompt }] },
          body.key, body.prompt);
        // Future worker activity must use the durable job's ID across retries.
        trace.correlationId = job.id;
        response.setHeader('X-Correlation-ID', job.id);
        response.setHeader('Location', 'jobs/' + job.id);
        log(trace, 'temporal', 'workflow.submitted', { model, workflow_id: job.id });
        return send(response, job, 202);
      }
      default:
        if (request.method === 'GET' && pathname.startsWith('/api/jobs/')) {
          return send(response, await getJob(pathname.slice('/api/jobs/'.length)));
        }
        return send(response, { error: 'Route not found.' }, 404);
    }
  } catch (error) {
    if (connection.signal.aborted) return;
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof HttpError) return send(response, { error: error.message }, error.status);
    log(trace, 'http', 'request.failed', { error_type: error instanceof Error ? error.name : 'unknown' }, 'warn');
    return send(response, { error: 'The TypeScript backend could not complete this request. Check Ollama, PostgreSQL, or Temporal and retry.' }, 503);
  }
});

const port = Number(process.env.TS_API_PORT || 8081);
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  log({ service, correlationId: '' }, 'http', 'api.started',
    { port: typeof address === 'object' ? address?.port : port, model: defaultModel });
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  await Promise.allSettled([tools.close(), closeDatabase(), closeTemporal()]);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
