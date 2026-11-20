import { jsonLines, type Emit } from '../../../packages/chat-stream.ts';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { HttpError } from './errors.ts';
import { log, type Trace } from './logging.ts';

export type Message = { role: 'user' | 'assistant'; content: string };
export type Engine = 'loop' | 'state-machine' | 'temporal';
type ToolCall = { function: { name: string; arguments: unknown } };
type ToolEvent = { name: string; arguments: unknown; result: string; isError: boolean; durationMs: number };
type Usage = { inputTokens?: number; outputTokens?: number };
type ModelMessage = { role: string; content: string; tool_calls?: ToolCall[]; tool_name?: string };
export type RunInput = { messages: Message[]; model: string; runId?: string; correlationId: string };
// Each engine passes this state between steps. It contains only serializable data.
export type Turn = {
  model: string; transcript: ModelMessage[]; tools: ToolEvent[]; usage: Usage[]; rounds: number; pending: ToolCall[];
};
export const defaultModel = process.env.OLLAMA_MODEL?.trim() || 'qwen3:14b';
const ollamaURL = (process.env.OLLAMA_URL?.trim() || 'http://127.0.0.1:11434').replace(/\/+$/, '');

export async function ollama(path: string, trace: Trace, signal: AbortSignal, body?: object, model?: string) {
  const started = Date.now();
  const response = await fetch(ollamaURL + path, {
    method: body ? 'POST' : 'GET', signal,
    headers: { 'Content-Type': 'application/json', 'X-Correlation-ID': trace.correlationId },
    body: body ? JSON.stringify(body) : undefined,
  });
  log(trace, 'ollama-client', 'ollama.request.completed', {
    route: path, status: response.status, model, duration_ms: Date.now() - started,
  });
  return response;
}

export async function installedModels(trace: Trace, signal: AbortSignal): Promise<string[]> {
  const response = await ollama('/api/tags', trace, signal);
  if (!response.ok) throw new Error('Could not list installed Ollama models.');
  const data = await response.json() as { models: { name: string; capabilities?: string[] }[] };
  return [...new Set(data.models.filter(({ name, capabilities }) =>
    name && (!capabilities?.length || capabilities.includes('tools'))).map(({ name }) => name))].sort();
}

// Both the API and the Temporal worker own a TypeScript MCP subprocess.
export async function connectTools(source = 'mcp-typescript') {
  const client = new Client({ name: 'workflow-lab-typescript', version: '0.1.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('./mcp.ts', import.meta.url))],
    env: { LAB_LOG_DIR: process.env.LAB_LOG_DIR ?? '', LAB_MCP_LOG_SOURCE: source },
    stderr: 'inherit',
  }));
  return client;
}

export function newTurn(input: RunInput): Turn {
  return { model: input.model, transcript: [{
    role: 'system',
    content: 'Use the provided tools for facts about demo inventory and warehouse pickup hours. If a required SKU or warehouse ID is missing, ask for it unless it can be obtained from the conversation or a tool result. Do not invent inventory facts. Answer other questions normally.',
  }, ...input.messages], tools: [], usage: [], rounds: 0, pending: [] };
}

export async function listTools(client: Client, trace: Trace, signal: AbortSignal) {
  const { tools } = await client.listTools({ _meta: { correlation_id: trace.correlationId } }, { signal });
  log(trace, 'mcp-client', 'mcp.tools.discovered', { tool_count: tools.length });
  return tools;
}

export async function askModel(client: Client, turn: Turn, trace: Trace, signal: AbortSignal, emit?: Emit): Promise<Turn> {
  // Give the model one final request without tools after it exhausts its tool budget.
  const final = turn.rounds >= 4 || turn.tools.length >= 8;
  const tools = final ? [] : (await listTools(client, trace, signal)).map(({ name, description, inputSchema }) => ({
    type: 'function', function: { name, description, parameters: inputSchema },
  }));
  await emit?.({ type: 'model-start' });
  const response = await ollama('/api/chat', trace, signal,
    { model: turn.model, messages: turn.transcript, tools, stream: !!emit, think: false }, turn.model);
  if (!response.ok) throw new HttpError(502, 'Ollama could not complete the chat request.');
  type Completion = { message: ModelMessage; prompt_eval_count?: number; eval_count?: number };
  let data: Completion;
  if (emit) {
    if (!response.body) throw new HttpError(502, 'Ollama returned no stream.');
    const message: ModelMessage = { role: 'assistant', content: '', tool_calls: [] };
    let completed = false;
    data = { message };
    for await (const chunk of jsonLines(response.body)) {
      if (chunk.error) throw new HttpError(502, 'Ollama could not complete the stream.');
      const part = chunk.message;
      if (part?.content) {
        message.content += part.content;
        await emit({ type: 'text', text: part.content });
      }
      if (part?.tool_calls) message.tool_calls!.push(...part.tool_calls);
      if (chunk.done) {
        data.prompt_eval_count = chunk.prompt_eval_count;
        data.eval_count = chunk.eval_count;
        completed = true;
        break;
      }
    }
    if (!completed) throw new HttpError(502, 'Ollama stream ended before completion.');
  } else {
    data = await response.json() as Completion;
  }
  if (data.message?.role !== 'assistant' || typeof data.message.content !== 'string') {
    throw new HttpError(502, 'Ollama returned an invalid reply.');
  }
  const count = data.message.tool_calls?.length ?? 0;
  if (count && (final || turn.tools.length + count > 8)) throw new HttpError(502, 'The model exceeded the tool call limit.');
  // Preserve the assistant tool request for the next Ollama call.
  const { role, content, tool_calls } = data.message;
  return { ...turn, pending: tool_calls ?? [], rounds: turn.rounds + (count ? 1 : 0),
    transcript: [...turn.transcript, { role, content, tool_calls }],
    usage: [...turn.usage, { inputTokens: data.prompt_eval_count, outputTokens: data.eval_count }] };
}

export function hasCalls(turn: Turn) {
  return turn.pending.length > 0;
}

// Checkpoint and schedule one tool call at a time, even when the model
// requested several calls in its last message.
export async function runNextTool(client: Client, turn: Turn, trace: Trace, signal: AbortSignal, emit?: Emit): Promise<Turn> {
  const [call, ...pending] = turn.pending;
  signal.throwIfAborted();
  const { name, arguments: args } = call.function;
  await emit?.({ type: 'tool-start', name });
  const start = Date.now();
  let result: string;
  let isError = true;
  try {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool arguments.');
    const output = await client.callTool({ name, arguments: args as Record<string, unknown>,
      _meta: { correlation_id: trace.correlationId } }, undefined, { signal });
    result = Array.isArray(output.content) ? output.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n') : '';
    isError = output.isError === true;
  } catch {
    signal.throwIfAborted();
    result = 'MCP tool call failed. Check the tool name and arguments against the provided schemas.';
  }
  const durationMs = Date.now() - start;
  log(trace, 'mcp-client', 'mcp.call.completed', { tool: name, tool_error: isError, duration_ms: durationMs });
  await emit?.({ type: 'tool-complete', name });
  return { ...turn, pending,
    tools: [...turn.tools, { name, arguments: args ?? null, result, isError, durationMs }],
    transcript: [...turn.transcript, { role: 'tool', tool_name: name, content: result }] };
}

export function reply(turn: Turn, engine: Engine, runId?: string, states?: string[]) {
  return { engine, model: turn.model, runId, states, usage: turn.usage, tools: turn.tools,
    message: { role: 'assistant' as const, content: turn.transcript.at(-1)?.content ?? '' } };
}

export async function runLoop(client: Client, input: RunInput, trace: Trace, signal: AbortSignal, emit?: Emit) {
  let turn = newTurn(input);
  for (;;) {
    turn = await askModel(client, turn, trace, signal, emit);
    if (!hasCalls(turn)) return reply(turn, 'loop');
    while (hasCalls(turn)) turn = await runNextTool(client, turn, trace, signal, emit);
  }
}
