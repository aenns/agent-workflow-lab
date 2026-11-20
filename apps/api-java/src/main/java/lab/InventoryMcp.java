package lab;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import io.modelcontextprotocol.client.McpClient;
import io.modelcontextprotocol.client.McpSyncClient;
import io.modelcontextprotocol.client.transport.ServerParameters;
import io.modelcontextprotocol.client.transport.StdioClientTransport;
import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.server.McpServer;
import io.modelcontextprotocol.server.McpServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.server.transport.StdioServerTransportProvider;
import io.modelcontextprotocol.spec.McpSchema.*;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Function;
import java.util.stream.Collectors;
import static lab.Support.*;

/** Owns the Java MCP protocol adapter and demo tool registry. Each API or worker gets its own subprocess, with stdout reserved for MCP and stderr for JSON logs. */
final class InventoryMcp {
    record Result(String text, boolean error) {}

    static final class Client implements AutoCloseable {
        private final McpSyncClient client;
        private final AtomicBoolean closed = new AtomicBoolean();

        Client(String service) {
            var java = Path.of(System.getProperty("java.home"), "bin/java").toString();
            var parameters = ServerParameters.builder(java)
                .args("-cp", System.getProperty("java.class.path"), "lab.Main", "mcp")
                .addEnvVar("LAB_ROOT", ROOT.toString()).addEnvVar("LAB_LOG_DIR", LOGS.toString())
                .addEnvVar("LAB_MCP_LOG_SOURCE", service).build();
            var transport = new StdioClientTransport(parameters, McpJsonDefaults.getMapper());
            transport.setStdErrorHandler(System.err::println);
            client = McpClient.sync(transport).requestTimeout(Duration.ofSeconds(10)).build();
            try { client.initialize(); }
            catch (RuntimeException error) { client.close(); throw error; }
        }

        List<JsonNode> tools() {
            return client.listTools().tools().stream().map(tool -> {
                var schema = object().put("type", tool.inputSchema().type());
                schema.set("properties", JSON.valueToTree(tool.inputSchema().properties()));
                schema.set("required", JSON.valueToTree(tool.inputSchema().required()));
                return (JsonNode) object().put("name", tool.name()).put("description", tool.description()).set("inputSchema", schema);
            }).toList();
        }

        Result call(String name, JsonNode args, String id) {
            Map<String, Object> arguments = JSON.convertValue(args, new TypeReference<>() {});
            var result = client.callTool(new CallToolRequest(name, arguments, Map.of("correlation_id", id)));
            return new Result(result.content().stream().filter(TextContent.class::isInstance)
                .map(item -> ((TextContent) item).text()).collect(Collectors.joining("\n")), Boolean.TRUE.equals(result.isError()));
        }

        @Override public void close() {
            if (closed.compareAndSet(false, true)) client.closeGracefully();
        }
    }

    private static final Map<String, Map<String, Object>> ITEMS = Map.of(
        "LAMP-42", Map.of("product", "Desk lamp", "stock", 7, "warehouse", "north"),
        "MUG-17", Map.of("product", "Ceramic mug", "stock", 0, "warehouse", "south"));
    private static final Map<String, String> HOURS = Map.of(
        "north", "Monday–Friday, 09:00–16:00 local time",
        "south", "Tuesday–Saturday, 10:00–15:00 local time");

    static void serve() {
        var transport = new StdioServerTransportProvider(McpJsonDefaults.getMapper());
        var server = McpServer.sync(transport).serverInfo("lab-inventory-java", "0.1.0")
            .capabilities(ServerCapabilities.builder().tools(false).build())
            .tools(tool("lookup_inventory", "Look up stock and warehouse by SKU.", "sku",
                    sku -> ITEMS.get(sku.toUpperCase(java.util.Locale.ROOT)), "Unknown SKU."),
                tool("warehouse_hours", "Look up pickup hours for a warehouse returned by lookup_inventory.", "warehouse",
                    input -> {
                        String warehouse = input.toLowerCase(java.util.Locale.ROOT);
                        return HOURS.containsKey(warehouse) ? Map.of("warehouse", warehouse, "pickupHours", HOURS.get(warehouse)) : null;
                    }, "Unknown warehouse."))
            .build();
        // A subprocess must not keep running after its owning API or worker exits.
        ProcessHandle.current().parent().ifPresent(parent -> parent.onExit().join());
        server.closeGracefully();
    }

    private static SyncToolSpecification tool(String name, String description, String field,
                                              Function<String, Map<String, Object>> lookup, String unknown) {
        var schema = new JsonSchema("object", Map.of(field, Map.of("type", "string")), List.of(field), false, null, null);
        var tool = Tool.builder().name(name).description(description).inputSchema(schema).build();
        return new SyncToolSpecification(tool, (exchange, request) -> {
            Object argument = request.arguments() == null ? null : request.arguments().get(field);
            var result = argument instanceof String text ? lookup.apply(text.strip()) : null;
            String correlation = request.meta() == null ? "" : String.valueOf(request.meta().getOrDefault("correlation_id", ""));
            log(env("LAB_MCP_LOG_SOURCE", "mcp-java"), correlation, "mcp", "mcp.request.completed",
                Map.of("method", "tools/call", "tool", name, "tool_error", result == null));
            return CallToolResult.builder().content(List.of(new TextContent(result == null ? unknown : JSON.valueToTree(result).toString())))
                .isError(result == null).build();
        });
    }

    private InventoryMcp() {}
}
