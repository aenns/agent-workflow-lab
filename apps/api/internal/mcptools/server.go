package mcptools

import (
	"context"
	"fmt"
	"strings"

	"agent-workflow-lab/apps/api/internal/telemetry"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type inventoryInput struct {
	SKU string `json:"sku" jsonschema:"Product SKU, such as LAMP-42 or MUG-17"`
}

type inventoryResult struct {
	Product   string `json:"product"`
	Stock     int    `json:"stock"`
	Warehouse string `json:"warehouse"`
}

type warehouseInput struct {
	Warehouse string `json:"warehouse" jsonschema:"Warehouse ID returned by lookup_inventory, such as north or south"`
}

type warehouseResult struct {
	Warehouse   string `json:"warehouse"`
	PickupHours string `json:"pickupHours"`
}

// AddTool uses the handler’s typed input and output to build the schemas.
// The tool descriptions also tell the model when each call is useful.
func Server() *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "lab-inventory", Version: "0.1.0"}, nil)
	server.AddReceivingMiddleware(telemetry.MCPServer)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "lookup_inventory",
		Description: "Look up stock quantity and warehouse for a product in the demo inventory. Ask for the SKU if it is missing.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true},
	}, lookupInventory)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "warehouse_hours",
		Description: "Find pickup hours for a demo warehouse. For a product, use the warehouse ID from lookup_inventory.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true},
	}, warehouseHours)
	return server
}

func lookupInventory(_ context.Context, _ *mcp.CallToolRequest, input inventoryInput) (*mcp.CallToolResult, inventoryResult, error) {
	switch strings.ToUpper(strings.TrimSpace(input.SKU)) {
	case "LAMP-42":
		return nil, inventoryResult{"Desk lamp", 7, "north"}, nil
	case "MUG-17":
		return nil, inventoryResult{"Ceramic mug", 0, "south"}, nil
	default:
		return nil, inventoryResult{}, fmt.Errorf("unknown SKU; demo SKUs are LAMP-42 and MUG-17")
	}
}

func warehouseHours(_ context.Context, _ *mcp.CallToolRequest, input warehouseInput) (*mcp.CallToolResult, warehouseResult, error) {
	switch strings.ToLower(strings.TrimSpace(input.Warehouse)) {
	case "north":
		return nil, warehouseResult{"north", "Monday–Friday, 09:00–16:00 local time"}, nil
	case "south":
		return nil, warehouseResult{"south", "Tuesday–Saturday, 10:00–15:00 local time"}, nil
	default:
		return nil, warehouseResult{}, fmt.Errorf("unknown warehouse; demo warehouse IDs are north and south")
	}
}
