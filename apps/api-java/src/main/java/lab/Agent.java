package lab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static lab.Support.*;

/** Shares model and MCP operations across engines. Each turn is a separate JSON value, so concurrent chats do not share their transcript or tool budget. */
final class Agent implements AutoCloseable {
    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    static final String OLLAMA = env("OLLAMA_URL", "http://127.0.0.1:11434").replaceAll("/+$", "");
    private static final String PROMPT = "Use the provided tools for facts about demo inventory and pickup hours. "
        + "If a SKU or warehouse is missing, ask for it unless a tool result supplies it. Do not invent inventory facts.";
    final String service;
    final InventoryMcp.Client mcp;

    Agent(String service, String mcpService) {
        this.service = service;
        this.mcp = new InventoryMcp.Client(mcpService);
    }

    static ObjectNode turn(String model, JsonNode messages) {
        var turn = object().put("model", model).put("rounds", 0);
        var transcript = turn.putArray("transcript").add(message("system", PROMPT));
        messages.forEach(transcript::add);
        turn.putArray("pending");
        turn.putArray("tools");
        turn.putArray("usage");
        return turn;
    }

    List<String> models(String id) throws Exception {
        var response = HTTP.send(HttpRequest.newBuilder(URI.create(OLLAMA + "/api/tags"))
            .timeout(Duration.ofSeconds(4)).header("X-Correlation-ID", id).build(), HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) throw new ApiError(503, "Could not list Ollama models.");
        var names = new ArrayList<String>();
        for (var model : JSON.readTree(response.body()).path("models")) {
            var capabilities = model.path("capabilities");
            boolean tools = capabilities.isEmpty();
            for (var capability : capabilities) if (capability.asText().equals("tools")) tools = true;
            if (tools && model.hasNonNull("name")) names.add(model.get("name").asText());
        }
        return names.stream().distinct().sorted().toList();
    }

    ObjectNode ask(ObjectNode state, String id) throws Exception { return ask(state, id, null); }

    ObjectNode ask(ObjectNode state, String id, ChatStream.Emit emit) throws Exception {
        var output = state.deepCopy();
        String model = state.path("model").asText();
        boolean finalCall = state.path("rounds").asInt() >= 4 || state.path("tools").size() >= 8;
        var body = object().put("model", model).put("stream", emit != null).put("think", false);
        body.set("messages", state.get("transcript"));
        var tools = body.putArray("tools");
        if (!finalCall) {
            for (var tool : mcp.tools()) {
                tools.add(object().put("type", "function").set("function", object()
                    .put("name", tool.path("name").asText()).put("description", tool.path("description").asText())
                    .set("parameters", tool.get("inputSchema"))));
            }
            log(service, id, "mcp-client", "mcp.tools.discovered", Map.of("tool_count", tools.size()));
        }
        long start = System.nanoTime();
        var request = HttpRequest.newBuilder(URI.create(OLLAMA + "/api/chat"))
            .timeout(Duration.ofSeconds(TIMEOUT)).header("Content-Type", "application/json")
            .header("X-Correlation-ID", id).POST(HttpRequest.BodyPublishers.ofString(body.toString())).build();
        JsonNode result;
        try {
            if (emit != null) {
                emit.send(object().put("type", "model-start"));
                var response = HTTP.send(request, HttpResponse.BodyHandlers.ofInputStream());
                try (var stream = response.body()) {
                    if (response.statusCode() != 200) throw new ApiError(502, "Ollama could not complete the chat request.");
                    result = ChatStream.read(stream, emit);
                }
            } else {
                var response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() != 200) throw new ApiError(502, "Ollama could not complete the chat request.");
                result = JSON.readTree(response.body());
            }
        } catch (java.net.http.HttpTimeoutException error) {
            throw new ApiError(504, "The chat request timed out.");
        } catch (java.io.IOException error) {
            throw new ApiError(502, "Ollama could not complete the chat response stream.");
        }
        log(service, id, "ollama-client", "ollama.request.completed", Map.of("route", "/api/chat",
            "status", 200, "model", model, "stream", emit != null, "duration_ms", (System.nanoTime() - start) / 1_000_000));
        var answer = result.path("message");
        if (!answer.path("role").asText().equals("assistant") || !answer.path("content").isTextual()) {
            throw new ApiError(502, "Ollama returned an invalid reply.");
        }
        var calls = answer.path("tool_calls");
        if (!calls.isArray()) calls = array();
        if (!calls.isEmpty() && (finalCall || state.path("tools").size() + calls.size() > 8)) {
            throw new ApiError(502, "The model exceeded the tool call limit.");
        }
        var assistant = message("assistant", answer.get("content").asText());
        if (!calls.isEmpty()) assistant.set("tool_calls", calls);
        output.withArray("transcript").add(assistant);
        output.set("pending", calls);
        output.put("rounds", state.path("rounds").asInt() + (calls.isEmpty() ? 0 : 1));
        var usage = object();
        if (result.path("prompt_eval_count").isIntegralNumber()) usage.set("inputTokens", result.get("prompt_eval_count"));
        if (result.path("eval_count").isIntegralNumber()) usage.set("outputTokens", result.get("eval_count"));
        output.withArray("usage").add(usage);
        return output;
    }

    ObjectNode tool(ObjectNode state, String id) throws Exception { return tool(state, id, null); }

    ObjectNode tool(ObjectNode state, String id, ChatStream.Emit emit) throws Exception {
        var output = state.deepCopy();
        var function = output.withArray("pending").remove(0).path("function");
        var name = function.path("name").asText();
        var args = function.path("arguments");
        if (emit != null) emit.send(object().put("type", "tool-start").put("name", name));
        var start = System.nanoTime();
        boolean failed = true;
        String result = "MCP tool call failed. Check the tool name and arguments.";
        if (args.isObject()) {
            try {
                var call = mcp.call(name, args, id);
                result = call.text();
                failed = call.error();
            } catch (RuntimeException ignored) { /* Return the failure to the model as a tool result. */ }
        }
        long elapsed = (System.nanoTime() - start) / 1_000_000;
        log(service, id, "mcp-client", "mcp.call.completed", Map.of("tool", name, "tool_error", failed, "duration_ms", elapsed));
        if (emit != null) emit.send(object().put("type", "tool-complete").put("name", name));
        var event = object().put("name", name).put("result", result).put("isError", failed).put("durationMs", elapsed);
        event.set("arguments", args.isMissingNode() ? JSON.nullNode() : args);
        output.withArray("tools").add(event);
        output.withArray("transcript").add(message("tool", result).put("tool_name", name));
        return output;
    }

    ObjectNode loop(ObjectNode turn, String id) throws Exception { return loop(turn, id, null); }

    ObjectNode loop(ObjectNode turn, String id, ChatStream.Emit emit) throws Exception {
        do {
            turn = ask(turn, id, emit);
            if (turn.path("pending").isEmpty()) return reply(turn, "loop", null);
            while (!turn.path("pending").isEmpty()) turn = tool(turn, id, emit);
        } while (true);
    }

    static ObjectNode reply(JsonNode turn, String engine, String runId) {
        var response = object().put("engine", engine).put("model", turn.path("model").asText());
        if (runId != null) response.put("runId", runId);
        response.set("tools", turn.path("tools"));
        response.set("usage", turn.path("usage"));
        var transcript = turn.path("transcript");
        response.set("message", message("assistant", transcript.get(transcript.size() - 1).path("content").asText()));
        return response;
    }

    @Override public void close() { mcp.close(); }
}
