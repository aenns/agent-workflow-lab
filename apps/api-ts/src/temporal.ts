import { setTimeout as delay } from 'node:timers/promises';
import { defaultPayloadConverter } from '@temporalio/common';
import type { Emit } from '../../../packages/chat-stream.ts';
import { progressEvent } from './temporal-progress.ts';
import { randomUUID } from 'node:crypto';
import { Client, Connection, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError,
  type WorkflowExecutionInfo } from '@temporalio/client';
import { newTurn, type RunInput } from './agent.ts';
import { HttpError } from './errors.ts';
import { fingerprint } from './graph.ts';
import type { inventoryTypescript } from './workflows.ts';

// The Go and TypeScript workers share Temporal and poll separate queues.
export const taskQueue = 'workflow-lab-typescript';
export const temporalAddress = process.env.TEMPORAL_ADDR || '127.0.0.1:7233';
const jobPrefix = 'lab-ts-job-';
let connection: Promise<Connection> | undefined;

async function client() {
  connection ??= Connection.connect({ address: temporalAddress, connectTimeout: '3s' }).catch((error: unknown) => {
    connection = undefined;
    throw error;
  });
  return new Client({ connection: await connection });
}

async function start(input: RunInput, workflowId: string, prompt?: string) {
  const { workflow } = await client();
  const key = fingerprint(input);
  try {
    return await workflow.start<typeof inventoryTypescript>('inventoryTypescript', {
      workflowId, taskQueue, args: [newTurn(input), input],
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      workflowExecutionTimeout: prompt ? '24 hours' : '20 minutes',
      memo: { key, prompt, model: input.model, correlationId: input.correlationId },
    });
  } catch (error) {
    // Temporal owns submission deduplication. Check the fingerprint before reusing a workflow.
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    const handle = workflow.getHandle<typeof inventoryTypescript>(workflowId);
    if ((await handle.describe()).memo?.key !== key) {
      throw new HttpError(409, 'This ID belongs to a different request.');
    }
    return handle;
  }
}

export async function temporalChat(input: RunInput, signal: AbortSignal, emit?: Emit) {
  const workflowId = input.runId ?? randomUUID();
  if (workflowId.startsWith(jobPrefix)) throw new HttpError(400, 'Choose a chat run ID.');
  const handle = await start({ ...input, runId: workflowId }, workflowId);
  // Stop waiting when the HTTP request ends while leaving the durable job running.
  const connection = (await client()).connection;
  if (!emit) return connection.withAbortSignal(signal, () => handle.result());
  const stop = new AbortController();
  const waiting = AbortSignal.any([signal, stop.signal]);
  let settled = false;
  // Handle both outcomes immediately so a failed workflow cannot cause an
  // unhandled promise rejection while DescribeWorkflowExecution is in flight.
  const result = connection.withAbortSignal(waiting, () => handle.result()).then(
    value => { settled = true; return { value, error: undefined }; },
    error => { settled = true; return { value: undefined, error }; },
  );
  let last = '';
  try {
    await emit({ type: 'status', message: 'Waiting for a Temporal worker…' });
    while (!settled) {
      signal.throwIfAborted();
      const info = await connection.withAbortSignal(waiting, () => handle.describe());
      for (const pending of info.raw.pendingActivities ?? []) {
        const payload = pending.heartbeatDetails?.payloads?.[0];
        if (!payload) continue;
        const event = progressEvent(defaultPayloadConverter.fromPayload(payload));
        if (!event) continue;
        const key = JSON.stringify(event);
        if (key !== last) { await emit(event); last = key; }
      }
      await Promise.race([result, delay(500, undefined, { signal: waiting })]);
    }
    const outcome = await result;
    if (outcome.error) throw outcome.error;
    return outcome.value;
  } finally { stop.abort(); }

}

function job(info: Pick<WorkflowExecutionInfo, 'workflowId' | 'memo' | 'startTime' | 'closeTime' | 'status'>) {
  return {
    id: info.workflowId, prompt: info.memo?.prompt, model: info.memo?.model,
    correlationId: info.memo?.correlationId, startedAt: info.startTime.toISOString(),
    finishedAt: info.closeTime?.toISOString(),
    status: info.status.name === 'COMPLETED' ? 'completed' : info.status.name === 'RUNNING' ? 'running' : 'failed',
  };
}

export async function submitJob(input: RunInput, key: string | undefined, prompt: string) {
  const id = jobPrefix + (key ?? randomUUID());
  const handle = await start({ ...input, runId: id, correlationId: id }, id, prompt);
  return job(await handle.describe());
}

export async function listJobs() {
  const results = [];
  // Use Temporal visibility for job summaries so they survive API restarts.
  for await (const info of (await client()).workflow.list({
    query: "WorkflowType = 'inventoryTypescript' AND WorkflowId STARTS_WITH 'lab-ts-job-'",
  })) {
    results.push(job(info));
    if (results.length >= 50) break;
  }
  return results;
}

export async function getJob(id: string) {
  if (!id.startsWith(jobPrefix)) throw new HttpError(404, 'Job not found.');
  const handle = (await client()).workflow.getHandle<typeof inventoryTypescript>(id);
  try {
    const result = job(await handle.describe());
    return { ...result, report: result.status === 'completed' ? await handle.result() : undefined };
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) throw new HttpError(404, 'Job not found.');
    throw error;
  }
}

export async function closeTemporal() {
  if (connection) await (await connection).close();
}
