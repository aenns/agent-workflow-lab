package lab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import static lab.Support.*;

/** Request-scoped events are presentation data, never checkpoint state. */
final class ChatStream {
    @FunctionalInterface interface Emit { void send(ObjectNode event) throws IOException; }
    private static final java.util.concurrent.ScheduledExecutorService DEADLINES =
        Executors.newSingleThreadScheduledExecutor(task -> {
            var thread = new Thread(task, "chat-stream-deadline");
            thread.setDaemon(true);
            return thread;
        });

    static JsonNode read(InputStream body, Emit emit) throws IOException {
        // HttpClient's request timeout covers obtaining headers. Close the body
        // at the deadline as well, including when Ollama stops sending chunks.
        var deadline = DEADLINES.schedule(() -> {
            try { body.close(); } catch (IOException ignored) { }
        }, TIMEOUT, TimeUnit.SECONDS);
        var answer = message("assistant", "");
        var calls = answer.putArray("tool_calls");
        var text = new StringBuilder();
        try (var reader = new BufferedReader(new InputStreamReader(body, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) continue;
                if (line.length() > 2 * 1024 * 1024) throw new IOException("Streaming record exceeded the size limit.");
                var chunk = JSON.readTree(line);
                if (chunk.hasNonNull("error")) throw new IOException("Ollama stream failed.");
                var part = chunk.path("message");
                if (!part.path("content").asText().isEmpty()) {
                    var fragment = part.path("content").asText();
                    text.append(fragment);
                    emit.send(object().put("type", "text").put("text", fragment));
                }
                for (var call : part.path("tool_calls")) calls.add(call);
                if (chunk.path("done").asBoolean()) {
                    answer.put("content", text.toString());
                    ((ObjectNode) chunk).set("message", answer);
                    return chunk;
                }
            }
            throw new IOException("Ollama stream ended before completion.");
        } finally { deadline.cancel(false); }
    }
}
