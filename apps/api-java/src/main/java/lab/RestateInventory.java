package lab;

import static lab.Support.JSON;
import static lab.Support.MODEL;
import static lab.Support.array;
import static lab.Support.env;
import static lab.Support.log;
import static lab.Support.message;
import static lab.Support.object;

import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;

import dev.restate.sdk.Restate;
import dev.restate.sdk.annotation.Handler;
import dev.restate.sdk.annotation.Shared;
import dev.restate.sdk.annotation.Workflow;
import dev.restate.sdk.common.DurablePromiseKey;
import dev.restate.sdk.common.StateKey;
import dev.restate.sdk.common.TerminalException;
import dev.restate.sdk.endpoint.Endpoint;
import dev.restate.sdk.http.vertx.RestateHttpServer;
import lab.Support.ApiError;

/** Implements the configurable inventory and approval demo. Restate journals completed steps and the approval promise so service restarts can resume the same run. */
public final class RestateInventory {
    private static final String NAME = "ApprovalWorkflow";
    private static final StateKey<String> STATUS = StateKey.of("status", String.class);
    private static final DurablePromiseKey<Boolean> DECISION = DurablePromiseKey.of("decision", Boolean.class);
    private static final String INGRESS = env("RESTATE_URL", "http://127.0.0.1:8090").replaceAll("/+$", "");

    @Workflow
    public static final class ApprovalWorkflow {
        private final Agent agent;
        ApprovalWorkflow(Agent agent) { this.agent = agent; }

        @Handler
        public String run(String payload) throws Exception {
            String id = Restate.key();
            ObjectNode definition;
            try {
                definition = definition(JSON.readTree(payload));
            } catch (ApiError | com.fasterxml.jackson.core.JsonProcessingException error) {
                // Also validate requests that arrive directly through Restate ingress.
                throw new TerminalException(400, "Invalid inventory workflow definition.");
            }
            var state = object().put("id", id).put("status", "running");
            var inventory = state.putArray("inventory");
            var pickup = state.putArray("pickup");
            var steps = state.putArray("steps");
            save(state);
            boolean unavailable = false;
            var warehouses = new LinkedHashSet<String>();
            for (var item : definition.path("items")) {
                String sku = item.asText();
                var record = JSON.readTree(Restate.run("Check " + sku, String.class,
                    () -> lookup("lookup_inventory", object().put("sku", sku), id)));
                var result = object().put("sku", sku);
                result.set("result", record);
                inventory.add(result);
                steps.add("Checked " + sku);
                if (record.path("stock").asInt() > 0) warehouses.add(record.path("warehouse").asText());
                else unavailable = true;
                save(state);
            }
            if (definition.path("pickupHours").asBoolean()) {
                for (String warehouse : warehouses) {
                    pickup.add(JSON.readTree(Restate.run("Pickup hours for " + warehouse, String.class,
                        () -> lookup("warehouse_hours", object().put("warehouse", warehouse), id))));
                    steps.add("Looked up " + warehouse + " pickup hours");
                    save(state);
                }
            }
            if (unavailable && definition.path("requireApproval").asBoolean()) {
                state.put("status", "waiting-for-approval");
                save(state);
                // Restate persists the decision and can suspend the service while it waits.
                boolean approved = Restate.promise(DECISION).future().await();
                state.put("decision", approved ? "continue" : "cancel");
                steps.add(approved ? "Approved remaining items" : "Cancelled by user");
                if (!approved) {
                    state.put("status", "cancelled");
                    save(state);
                    return state.toString();
                }
                state.put("status", "running");
                save(state);
            }
            if (definition.path("summarize").asBoolean()) {
                String facts = object().set("inventory", inventory).toString() + "\nPickup hours: " + pickup;
                try {
                    var policy = dev.restate.sdk.common.RetryPolicy.defaultPolicy().setMaxAttempts(3);
                    String summary = Restate.run("Summarize pickup", String.class, policy, () -> {
                        var turn = Agent.turn(MODEL, array().add(message("user",
                            "Summarize these inventory facts for pickup. Do not call tools. " + facts)));
                        turn.put("rounds", 4);
                        return Agent.reply(agent.ask(turn, id), "loop", null).path("message").path("content").asText();
                    });
                    state.put("summary", summary);
                    steps.add("Summarized pickup");
                } catch (TerminalException error) {
                    state.put("status", "failed").put("error", "Ollama could not summarize the inventory results.");
                    save(state);
                    return state.toString();
                }
            }
            state.put("status", "completed");
            save(state);
            return state.toString();
        }

        @Shared
        public String status() {
            return Restate.state().get(STATUS).orElseGet(() -> object().put("id", Restate.key()).put("status", "queued").toString());
        }

        @Shared
        public String decide(Boolean proceed) throws Exception {
            if (proceed == null) throw new TerminalException(400, "Choose a decision.");
            var current = JSON.readTree(status());
            String choice = proceed ? "continue" : "cancel";
            if (choice.equals(current.path("decision").asText())) return current.toString();
            if (!current.path("status").asText().equals("waiting-for-approval")) {
                throw new TerminalException(409, "This run is not waiting for a decision.");
            }
            Restate.promiseHandle(DECISION).resolve(proceed);
            return object().put("accepted", true).toString();
        }

        private String lookup(String name, ObjectNode input, String id) throws Exception {
            var result = agent.mcp.call(name, input, id);
            log(agent.service, id, "mcp-client", "mcp.call.completed", Map.of("tool", name, "tool_error", result.error()));
            return result.error() ? object().put("error", result.text()).toString() : result.text();
        }

        private static void save(ObjectNode value) {
            Restate.state().set(STATUS, value.toString());
        }
    }

    static void serve() throws Exception {
        var agent = new Agent("restate-java", "mcp-restate-java");
        var server = RestateHttpServer.fromEndpoint(Endpoint.bind(new ApprovalWorkflow(agent)));
        var address = env("RESTATE_SERVICE_HOST", "127.0.0.1");
        int port = Integer.parseInt(env("RESTATE_SERVICE_PORT", "9080"));
        try {
            server.listen(port, address).toCompletionStage().toCompletableFuture().get();
        } catch (Exception error) {
            agent.close();
            throw error;
        }
        Runtime.getRuntime().addShutdownHook(new Thread(agent::close));
        log(agent.service, "", "restate", "service.started", Map.of("port", port));
    }

    static void route(HttpExchange exchange, String path, String correlation) throws Exception {
        String method = exchange.getRequestMethod();
        if (method.equals("POST") && path.equals("/api/workflows")) {
            var definition = definition(Main.body(exchange, 8192));
            String id = UUID.randomUUID().toString();
            ingress(id, "run/send", JSON.writeValueAsString(definition.toString()), correlation);
            exchange.getResponseHeaders().set("X-Correlation-ID", id);
            log("api-java", id, "restate", "workflow.submitted", Map.of("workflow_id", id));
            Main.send(exchange, 202, object().put("id", id).put("status", "queued"));
            return;
        }
        String[] parts = path.split("/");
        if (parts.length < 4 || !parts[3].matches("[a-fA-F0-9-]{36}")) throw new ApiError(404, "Workflow not found.");
        String id = parts[3];
        if (method.equals("GET") && parts.length == 4) {
            Main.send(exchange, 200, ingress(id, "status", null, id));
        } else if (method.equals("POST") && parts.length == 5 && parts[4].equals("decision")) {
            String decision = Main.text(Main.body(exchange, 4096), "decision");
            if (!Set.of("continue", "cancel").contains(decision)) throw new ApiError(400, "Choose continue or cancel.");
            Main.send(exchange, 200, ingress(id, "decide", Boolean.toString(decision.equals("continue")), id));
            log("api-java", id, "restate", "workflow.decision", Map.of("decision", decision));
        } else throw new ApiError(404, "Workflow route not found.");
    }

    static ObjectNode definition(JsonNode raw) {
        if (raw == null || !raw.isObject()) throw new ApiError(400, "Expected an inventory workflow definition.");
        var items = raw.path("items");
        if (!items.isArray() || items.size() < 1 || items.size() > 3) throw new ApiError(400, "Enter 1 to 3 inventory SKUs.");
        var unique = new LinkedHashSet<String>();
        for (var item : items) {
            if (!item.isTextual() || !item.asText().matches("[A-Za-z0-9-]{1,40}")) throw new ApiError(400, "Enter valid inventory SKUs.");
            unique.add(item.asText().toUpperCase(java.util.Locale.ROOT));
        }
        var output = object();
        var normalized = output.putArray("items");
        unique.forEach(normalized::add);
        for (String flag : Set.of("pickupHours", "requireApproval", "summarize")) {
            if (raw.has(flag) && !raw.path(flag).isBoolean()) throw new ApiError(400, "Use a boolean for " + flag + ".");
            output.put(flag, raw.path(flag).asBoolean(true));
        }
        return output;
    }

    private static JsonNode ingress(String id, String handler, String body, String correlation) throws Exception {
        var request = HttpRequest.newBuilder(URI.create(INGRESS + "/" + NAME + "/" + id + "/" + handler))
            .timeout(Duration.ofSeconds(8)).header("X-Correlation-ID", correlation);
        if (body != null) request.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body));
        var response = Agent.HTTP.send(request.build(), HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() == 409) throw new ApiError(409, "This workflow cannot accept another decision.");
        if (response.statusCode() / 100 != 2) throw new ApiError(503, "Restate could not handle the workflow. Check the server and Java service.");
        if (response.body().isBlank()) return object();
        var result = JSON.readTree(response.body());
        return result.isTextual() ? JSON.readTree(result.asText()) : result;
    }

    private RestateInventory() {}
}
