import type { Emit } from '../../../packages/chat-stream.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import { askModel, hasCalls, newTurn, reply, runNextTool, type RunInput, type Turn } from './agent.ts';
import { HttpError } from './errors.ts';
import type { Trace } from './logging.ts';

// Keep the TypeScript saver's tables separate from Go's checkpoint format.
const schema = 'workflow_lab_typescript';
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://lab:lab@127.0.0.1:54329/lab?sslmode=disable',
  connectionTimeoutMillis: 3000, statement_timeout: 5000,
});
const saver = new PostgresSaver(pool, undefined, { schema });
let setup: Promise<void> | undefined;
// The local API allows one active request per run ID while sharing the database pool.
const running = new Set<string>();

function prepare() {
  setup ??= saver.setup().catch((error: unknown) => {
    setup = undefined;
    throw error;
  });
  return setup;
}

const State = Annotation.Root({
  turn: Annotation<Turn>(), fingerprint: Annotation<string>(), states: Annotation<string[]>(),
});

export function fingerprint(input: RunInput) {
  return createHash('sha256').update(JSON.stringify([input.model, input.messages])).digest('hex');
}

export async function runGraph(client: Client, input: RunInput, trace: Trace, signal: AbortSignal, emit?: Emit) {
  const id = input.runId ?? randomUUID();
  if (running.has(id)) throw new HttpError(409, 'This run is already in progress.');
  running.add(id);
  try {
    await prepare();
    const config = { configurable: { thread_id: id }, signal };
    const graph = new StateGraph(State)
      .addNode('ask', async ({ turn, states }) => ({
        turn: await askModel(client, turn, trace, signal, emit), states: [...states, 'Ask model'],
      }))
      .addNode('tools', async ({ turn, states }) => ({
        turn: await runNextTool(client, turn, trace, signal, emit), states: [...states, 'Run tools'],
      }))
      .addEdge(START, 'ask')
      .addConditionalEdges('ask', ({ turn }) => hasCalls(turn) ? 'tools' : END, ['tools', END])
      .addConditionalEdges('tools', ({ turn }) => hasCalls(turn) ? 'tools' : 'ask', ['tools', 'ask'])
      .compile({ checkpointer: saver });
    // A run ID is bound to its original model and messages, even after restart.
    const existing = await graph.getState(config);
    const key = fingerprint(input);
    if (existing.values.fingerprint && existing.values.fingerprint !== key) {
      throw new HttpError(409, 'This run ID belongs to a different chat request.');
    }
    // Passing null resumes the nodes scheduled by the last committed checkpoint.
    const state = existing.values.fingerprint && !existing.next.length ? existing.values :
      await graph.invoke(existing.values.fingerprint ? null : {
        fingerprint: key, turn: newTurn(input), states: [],
      }, config);
    return reply(state.turn, 'state-machine', id, [...state.states, 'Complete']);
  } finally {
    running.delete(id);
  }
}

const checkpointSQL = `SELECT thread_id AS run_id, checkpoint_id, checkpoint->>'ts' AS saved_at
FROM "${schema}".checkpoints WHERE checkpoint_ns = ''`;
const queries = [
  { id: 'recent-runs', title: 'Recent runs', description: 'Most recent TypeScript LangGraph checkpoints.',
    requiresRunId: false, sql: `SELECT * FROM (
  SELECT DISTINCT ON (thread_id) thread_id AS run_id, checkpoint_id, checkpoint->>'ts' AS saved_at
  FROM "${schema}".checkpoints WHERE checkpoint_ns = '' ORDER BY thread_id, checkpoint_id DESC
) latest ORDER BY checkpoint_id DESC LIMIT 50` },
  { id: 'run-history', title: 'Checkpoint history', description: 'Saved checkpoints for one TypeScript run.',
    requiresRunId: true, sql: checkpointSQL + ' AND thread_id = $1 ORDER BY checkpoint_id DESC LIMIT 50' },
  { id: 'latest-state', title: 'Latest state', description: 'Decode the latest LangGraph state with the PostgreSQL saver.',
    requiresRunId: true, sql: '' },
  { id: 'tool-results', title: 'Tool results', description: 'Completed tool calls in the latest checkpoint, decoded by LangGraph.',
    requiresRunId: true, sql: '' },
  { id: 'token-usage', title: 'Token usage', description: 'Ollama token counts from the latest checkpoint, decoded by LangGraph.',
    requiresRunId: true, sql: '' },
];

export { queries };
export async function databaseQuery(id: string, runId?: string) {
  const query = queries.find((item) => item.id === id);
  if (!query || (query.requiresRunId && !runId)) throw new HttpError(400, 'Choose a saved query and supply its run ID.');
  await prepare();
  // Use the saver to deserialize stored channel values rather than parsing blobs in SQL.
  if (!query.sql) {
    const tuple = await saver.getTuple({ configurable: { thread_id: runId } });
    const state = tuple?.checkpoint.channel_values;
    const turn = state?.turn as Turn | undefined;
    if (id === 'tool-results') return { columns: ['name', 'arguments', 'result', 'is_error', 'duration_ms'],
      rows: turn?.tools.map((tool) => [tool.name, tool.arguments, tool.result, tool.isError, tool.durationMs]) ?? [] };
    if (id === 'token-usage') return { columns: ['model', 'call', 'input_tokens', 'output_tokens'],
      rows: turn?.usage.map((usage, index) => [turn.model, index + 1, usage.inputTokens ?? null, usage.outputTokens ?? null]) ?? [] };
    return { columns: ['run_id', 'state'], rows: state ? [[runId, state]] : [] };
  }
  const result = await pool.query({ text: query.sql, values: query.requiresRunId ? [runId] : [], rowMode: 'array' });
  return { columns: result.fields.map((field) => field.name), rows: result.rows };
}

export function closeDatabase() { return pool.end(); }
