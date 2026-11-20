import { fileURLToPath } from 'node:url';
import { Context } from '@temporalio/activity';
import { activityProgress } from './temporal-progress.ts';
import { NativeConnection, Worker } from '@temporalio/worker';
import { askModel, connectTools, runNextTool, type Turn } from './agent.ts';
import { log } from './logging.ts';
import { taskQueue, temporalAddress } from './temporal.ts';

// The worker owns an MCP child independently of the API process.
const tools = await connectTools('mcp-worker-typescript');
try {
  const connection = await NativeConnection.connect({ address: temporalAddress });
  try {
    const service = 'temporal-worker-typescript';
    const identity = process.env.LAB_WORKER_IDENTITY;
    const worker = await Worker.create({
      // The SDK supplies its own identity for a manually launched worker.
      ...(identity ? { identity } : {}),
      maxHeartbeatThrottleInterval: '500ms', defaultHeartbeatThrottleInterval: '500ms',
      connection, taskQueue, workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
      activities: {
        ask: async (turn: Turn, correlationId: string) => {
          const progress = activityProgress();
          try { return await askModel(tools, turn, { service, correlationId }, Context.current().cancellationSignal, progress.emit); }
          finally { progress.close(); }
        },
        callTool: async (turn: Turn, correlationId: string) => {
          const progress = activityProgress();
          try { return await runNextTool(tools, turn, { service, correlationId }, Context.current().cancellationSignal, progress.emit); }
          finally { progress.close(); }
        },
      },
    });
    log({ service, correlationId: '' }, 'worker', 'worker.started', { task_queue: taskQueue });
    await worker.run();
  } finally {
    await connection.close();
  }
} finally {
  await tools.close();
}
