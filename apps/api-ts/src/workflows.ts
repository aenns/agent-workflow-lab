import { proxyActivities } from '@temporalio/workflow';
import type { RunInput, Turn } from './agent.ts';

const activities = proxyActivities<{
  ask(turn: Turn, correlationId: string): Promise<Turn>;
  callTool(turn: Turn, correlationId: string): Promise<Turn>;
}>({ startToCloseTimeout: '3 minutes', retry: { maximumAttempts: 3 } });

export async function inventoryTypescript(turn: Turn, input: RunInput) {
  // The workflow only schedules activities. Network and MCP calls run in the worker.
  for (;;) {
    turn = await activities.ask(turn, input.correlationId);
    if (!turn.pending.length) {
      return {
        engine: 'temporal' as const, model: turn.model, runId: input.runId, usage: turn.usage, tools: turn.tools,
        message: { role: 'assistant' as const, content: turn.transcript.at(-1)?.content ?? '' },
      };
    }
    while (turn.pending.length) turn = await activities.callTool(turn, input.correlationId);
  }
}
