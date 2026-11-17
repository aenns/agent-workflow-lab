import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { log } from './logging.ts';

const server = new McpServer({ name: 'lab-inventory-typescript', version: '0.1.0' });
// Match the Go server's demo fixtures so prompts can be compared across backends.
const inventory = new Map([
  ['LAMP-42', { product: 'Desk lamp', stock: 7, warehouse: 'north' }],
  ['MUG-17', { product: 'Ceramic mug', stock: 0, warehouse: 'south' }],
]);
const hours = new Map([
  ['north', 'Monday–Friday, 09:00–16:00 local time'],
  ['south', 'Tuesday–Saturday, 10:00–15:00 local time'],
]);

function result(correlationId: unknown, tool: string, output: object | undefined, error: string) {
  log({ correlationId: typeof correlationId === 'string' ? correlationId : '', service: process.env.LAB_MCP_LOG_SOURCE === 'mcp-worker-typescript' ? 'mcp-worker-typescript' : 'mcp-typescript' },
    'mcp', 'mcp.request.completed', { method: 'tools/call', tool, tool_error: !output });
  return { content: [{ type: 'text' as const, text: output ? JSON.stringify(output) : error }], isError: !output };
}

server.registerTool('lookup_inventory', {
  description: 'Look up stock quantity and warehouse for a product in the demo inventory. Ask for the SKU if it is missing.',
  inputSchema: { sku: z.string().describe('Product SKU, such as LAMP-42 or MUG-17') },
  annotations: { readOnlyHint: true },
}, ({ sku }, extra) => result(extra._meta?.correlation_id, 'lookup_inventory',
  inventory.get(sku.trim().toUpperCase()), 'Unknown SKU. Demo SKUs are LAMP-42 and MUG-17.'));

server.registerTool('warehouse_hours', {
  description: 'Find pickup hours for a demo warehouse. For a product, use the warehouse ID from lookup_inventory.',
  inputSchema: { warehouse: z.string().describe('Warehouse ID returned by lookup_inventory, such as north or south') },
  annotations: { readOnlyHint: true },
}, ({ warehouse }, extra) => {
  const id = warehouse.trim().toLowerCase();
  const pickupHours = hours.get(id);
  return result(extra._meta?.correlation_id, 'warehouse_hours', pickupHours ? { warehouse: id, pickupHours } : undefined,
    'Unknown warehouse. Demo warehouse IDs are north and south.');
});

await server.connect(new StdioServerTransport());
