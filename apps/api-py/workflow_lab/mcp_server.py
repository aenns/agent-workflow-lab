"""Inventory tools served as MCP over stdio by a standalone Python process."""

import asyncio
import json
import os

from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from .telemetry import log

server = Server("lab-inventory-python")
service = "mcp-worker-python" if os.getenv("LAB_MCP_LOG_SOURCE") == "mcp-worker-python" else "mcp-python"

# The same fixtures let us compare prompts across all backend languages.
inventory = {
    "LAMP-42": {"product": "Desk lamp", "stock": 7, "warehouse": "north"},
    "MUG-17": {"product": "Ceramic mug", "stock": 0, "warehouse": "south"},
}
hours = {
    "north": "Monday–Friday, 09:00–16:00 local time",
    "south": "Tuesday–Saturday, 10:00–15:00 local time",
}


def correlation_id():
    metadata = server.request_context.meta
    return (metadata.model_extra or {}).get("correlation_id", "") if metadata else ""


@server.list_tools()
async def list_tools():
    specifications = [
        ("lookup_inventory", "Look up stock quantity and warehouse for demo inventory. Ask for the SKU if missing.",
         "sku", "Product SKU, such as LAMP-42 or MUG-17"),
        ("warehouse_hours", "Find pickup hours for a demo warehouse. For a product, use the warehouse ID from lookup_inventory.",
         "warehouse", "Warehouse ID returned by lookup_inventory, such as north or south"),
    ]
    log(service, correlation_id(), "mcp", "mcp.request.completed", method="tools/list")
    return [
        types.Tool(
            name=name, description=description, annotations=types.ToolAnnotations(readOnlyHint=True),
            inputSchema={"type": "object", "properties": {field: {"type": "string", "description": help_text}},
                         "required": [field]},
        )
        for name, description, field, help_text in specifications
    ]


@server.call_tool()
async def call_tool(name, arguments):
    if name == "lookup_inventory":
        result = inventory.get(arguments["sku"].strip().upper())
        error = "Unknown SKU. Demo SKUs are LAMP-42 and MUG-17."
    else:
        warehouse = arguments["warehouse"].strip().lower()
        result = {"warehouse": warehouse, "pickupHours": hours[warehouse]} if warehouse in hours else None
        error = "Unknown warehouse. Demo warehouse IDs are north and south."
    log(service, correlation_id(), "mcp", "mcp.request.completed", method="tools/call", tool=name,
        tool_error=result is None)
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=json.dumps(result, ensure_ascii=False) if result else error)],
        isError=result is None,
    )


async def main():
    async with stdio_server() as (reader, writer):
        await server.run(reader, writer, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
