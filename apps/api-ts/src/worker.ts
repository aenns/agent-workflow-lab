import { fileURLToPath } from 'node:url';
import { Context } from '@temporalio/activity';
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
    const worker = await Worker.create({
      connection, taskQueue, workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
      activities: {
        ask: (turn: Turn, correlationId: string) =>
          askModel(tools, turn, { service, correlationId }, Context.current().cancellationSignal),
        callTool: (turn: Turn, correlationId: string) =>
          runNextTool(tools, turn, { service, correlationId }, Context.current().cancellationSignal),
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
