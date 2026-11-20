package lab;

import com.fasterxml.jackson.databind.JsonNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
import static lab.Support.*;

/** Starts the API, worker, MCP child, or Restate service. The HTTP process validates requests before opening a stream and leaves durable execution to the selected engine. */
public final class Main {
    private static final String SERVICE = "api-java";
    private static final Pattern ID = Pattern.compile("[a-zA-Z0-9_-]{16,64}");
    private final Agent agent;
    private final TemporalEngine temporal;
    private final GraphEngine graph = new GraphEngine();
    private final ModelLibrary library = new ModelLibrary();

    private Main(Agent agent, TemporalEngine temporal) {
        this.agent = agent;
        this.temporal = temporal;
    }

    public static void main(String[] args) throws Exception {
        String mode = args.length == 0 ? "api" : args[0];
        switch (mode) {
            case "mcp" -> InventoryMcp.serve();
            case "temporal-worker" -> TemporalEngine.runWorker();
            case "restate" -> RestateInventory.serve();
            case "api" -> runApi();
            default -> throw new IllegalArgumentException("Unknown mode: " + mode);
        }
    }

    private static void runApi() throws Exception {
        var agent = new Agent(SERVICE, "mcp-java");
        var temporal = new TemporalEngine();
        var app = new Main(agent, temporal);
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", Integer.parseInt(env("JAVA_API_PORT", "8083"))), 0);
        var executor = Executors.newFixedThreadPool(16);
        server.setExecutor(executor);
        server.createContext("/api/", app::handle);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            server.stop(0);
            executor.shutdownNow();
            temporal.close();
            agent.close();
        }));
        server.start();
        log(SERVICE, "", "http", "api.started", Map.of("port", server.getAddress().getPort(), "model", MODEL));
    }

    private void handle(HttpExchange exchange) throws IOException {
        String id = exchange.getRequestHeaders().getFirst("X-Correlation-ID");
        if (id == null || !ID.matcher(id).matches()) id = UUID.randomUUID().toString();
        exchange.getResponseHeaders().set("X-Correlation-ID", id);
        exchange.getResponseHeaders().set("X-Lab-Backend", "java");
        String path = exchange.getRequestURI().getPath();
        long started = System.nanoTime();
        try {
            route(exchange, path, id);
        } catch (ApiError error) {
            if (exchange.getResponseCode() < 0) send(exchange, error.status, object().put("error", error.getMessage()));
        } catch (Exception error) {
            log(SERVICE, id, "http", "request.failed", Map.of("level", "warn", "error_type", error.getClass().getSimpleName()));
            if (exchange.getResponseCode() < 0) send(exchange, 503, object().put("error", "The Java backend could not complete this request."));
        } finally {
            if (!path.equals("/api/logs")) log(SERVICE, exchange.getResponseHeaders().getFirst("X-Correlation-ID"),
                "http", "http.request.completed", Map.of("route", path, "method", exchange.getRequestMethod(),
                    "status", exchange.getResponseCode(), "duration_ms", (System.nanoTime() - started) / 1_000_000));
            exchange.close();
        }
    }

    private void route(HttpExchange exchange, String path, String id) throws Exception {
        String method = exchange.getRequestMethod();
        switch (method + " " + path) {
            case "GET /api/health" -> send(exchange, 200, object().put("status", "ok"));
            case "GET /api/ready" -> {
                try {
                    if (!agent.models(id).contains(MODEL) || agent.mcp.tools().isEmpty()) throw new IllegalStateException();
                    send(exchange, 200, object().put("status", "ready").put("model", MODEL));
                } catch (Exception error) {
                    send(exchange, 503, object().put("status", "unavailable").put("model", MODEL)
                        .put("error", "Check Ollama, the default model, and the Java MCP server."));
                }
            }
            case "GET /api/openapi.yaml" -> bytes(exchange, 200, "application/yaml",
                Files.readAllBytes(ROOT.resolve("apps/api/internal/httpapi/contract/openapi.yaml")));
            case "GET /api/models" -> send(exchange, 200, Map.of("defaultModel", MODEL, "models", agent.models(id)));
            case "GET /api/models/search" -> send(exchange, 200, library.search(query(exchange, "q").strip()));
            case "POST /api/models/install" -> library.install(exchange, text(body(exchange, 4096), "model").strip(), id);
            case "GET /api/tools" -> send(exchange, 200, agent.mcp.tools());
            case "GET /api/logs" -> send(exchange, 200, recentLogs());
            case "GET /api/database/queries" -> send(exchange, 200, GraphEngine.queries());
            case "POST /api/database/query" -> {
                var input = body(exchange, 4096);
                send(exchange, 200, graph.inspect(text(input, "queryId"), identifier(input, "runId", "")));
            }
            case "POST /api/chat" -> chat(exchange, id);
            case "GET /api/jobs" -> send(exchange, 200, temporal.jobs());
            case "POST /api/jobs" -> {
                var input = body(exchange, 16384);
                var prompt = text(input, "prompt").strip();
                if (prompt.isBlank() || prompt.getBytes(StandardCharsets.UTF_8).length > 8000) throw new ApiError(400, "Enter a prompt of up to 8,000 bytes.");
                String job = TemporalEngine.JOB_PREFIX + identifier(input, "key", UUID.randomUUID().toString());
                String model = model(input, id);
                var report = temporal.submit(job, model, prompt);
                exchange.getResponseHeaders().set("X-Correlation-ID", job);
                exchange.getResponseHeaders().set("Location", "jobs/" + job);
                log(SERVICE, job, "temporal", "workflow.submitted", Map.of("model", model, "workflow_id", job));
                send(exchange, 202, report);
            }
            default -> {
                if (method.equals("GET") && path.startsWith("/api/jobs/")) {
                    send(exchange, 200, temporal.job(path.substring("/api/jobs/".length())));
                } else if (path.equals("/api/workflows") || path.startsWith("/api/workflows/")) {
                    RestateInventory.route(exchange, path, id);
                } else throw new ApiError(404, "Route not found.");
            }
        }
    }

    private void chat(HttpExchange exchange, String id) throws Exception {
        var input = body(exchange, 512 * 1024);
        String engine = input.has("engine") ? text(input, "engine") : "loop";
        if (!Set.of("loop", "state-machine", "temporal").contains(engine)) throw new ApiError(400, "Choose a supported engine.");
        if (input.has("stream") && !input.get("stream").isBoolean()) throw new ApiError(400, "Supply stream as a boolean.");
        boolean stream = input.path("stream").asBoolean();
        var messages = input.path("messages");
        if (!messages.isArray() || messages.size() > 41 || messages.size() % 2 == 0) {
            throw new ApiError(400, "Send an odd number of messages, up to 41.");
        }
        for (int i = 0; i < messages.size(); i++) {
            var role = i % 2 == 0 ? "user" : "assistant";
            var content = text(messages.get(i), "content");
            if (!role.equals(text(messages.get(i), "role")) || content.isBlank() ||
                (role.equals("user") && content.getBytes(StandardCharsets.UTF_8).length > 8000)) {
                throw new ApiError(400, "Use alternating nonblank user and assistant messages.");
            }
        }
        String runId = identifier(input, "runId", UUID.randomUUID().toString());
        String model = model(input, id);
        if (!engine.equals("loop")) exchange.getResponseHeaders().set("X-Run-ID", runId);
        log(SERVICE, id, "chat", "chat.started", Map.of("engine", engine, "model", model));
        if (!stream) {
            send(exchange, 200, switch (engine) {
                case "state-machine" -> graph.chat(agent, runId, id, model, messages);
                case "temporal" -> temporal.chat(runId, id, model, messages);
                default -> agent.loop(Agent.turn(model, messages), id);
            });
            return;
        }
        exchange.getResponseHeaders().set("Content-Type", "application/x-ndjson");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.getResponseHeaders().set("X-Accel-Buffering", "no");
        exchange.sendResponseHeaders(200, 0);
        ChatStream.Emit emit = event -> {
            exchange.getResponseBody().write((event.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            exchange.getResponseBody().flush();
        };
        try {
            var result = switch (engine) {
                case "state-machine" -> graph.chat(agent, runId, id, model, messages, emit);
                case "temporal" -> temporal.chat(runId, id, model, messages, emit);
                default -> agent.loop(Agent.turn(model, messages), id, emit);
            };
            emit.send(object().put("type", "complete").set("reply", result));
        } catch (Exception error) {
            log(SERVICE, id, "chat", "chat.failed", Map.of("stream", true, "error_type", error.getClass().getSimpleName()));
            emit.send(object().put("type", "error").put("error", error instanceof ApiError ? error.getMessage()
                : "The streaming request failed. Try again or resume the saved run."));
        }
    }

    private String model(JsonNode input, String id) throws Exception {
        if (!input.hasNonNull("model")) return MODEL;
        String model = text(input, "model").strip();
        if (model.isBlank()) return MODEL;
        if (model.length() > 255 || !agent.models(id).contains(model)) {
            throw new ApiError(400, "Choose an installed Ollama model that supports tools.");
        }
        return model;
    }

    static String identifier(JsonNode input, String field, String fallback) {
        if (!input.hasNonNull(field)) return fallback;
        var id = text(input, field);
        if (!ID.matcher(id).matches()) throw new ApiError(400, "Invalid " + field + ".");
        return id;
    }

    static String text(JsonNode input, String field) {
        if (!input.path(field).isTextual()) throw new ApiError(400, "Supply " + field + " as text.");
        return input.get(field).asText();
    }

    static JsonNode body(HttpExchange exchange, int limit) throws IOException {
        var contentType = exchange.getRequestHeaders().getFirst("Content-Type");
        if (contentType == null || !contentType.split(";")[0].trim().equalsIgnoreCase("application/json")) {
            throw new ApiError(415, "Send an application/json request.");
        }
        byte[] bytes = exchange.getRequestBody().readNBytes(limit + 1);
        if (bytes.length > limit) throw new ApiError(413, "Request is too large.");
        try {
            var value = JSON.reader().with(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(bytes);
            if (!value.isObject()) throw new ApiError(400, "Expected a JSON object.");
            return value;
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new ApiError(400, "Invalid JSON request.");
        }
    }

    private static String query(HttpExchange exchange, String name) {
        var raw = exchange.getRequestURI().getRawQuery();
        if (raw == null) return "";
        for (String pair : raw.split("&")) {
            var parts = pair.split("=", 2);
            if (parts.length == 2 && parts[0].equals(name)) return URLDecoder.decode(parts[1], StandardCharsets.UTF_8);
        }
        return "";
    }

    static void send(HttpExchange exchange, int status, Object value) throws IOException {
        bytes(exchange, status, "application/json", JSON.writeValueAsBytes(value));
    }

    private static void bytes(HttpExchange exchange, int status, String type, byte[] data) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", type);
        exchange.sendResponseHeaders(status, data.length);
        exchange.getResponseBody().write(data);
    }
}
