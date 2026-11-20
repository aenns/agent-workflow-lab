package lab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

/** Shared configuration, JSON helpers, fingerprints, and structured logging. Correlation IDs follow a chat across HTTP, Temporal activities, and MCP calls. */
final class Support {
    static final ObjectMapper JSON = new ObjectMapper();
    static final Path ROOT = Path.of(env("LAB_ROOT", "../..")).toAbsolutePath().normalize();
    static final String MODEL = env("OLLAMA_MODEL", "qwen3:14b");
    static final int TIMEOUT = Integer.parseInt(env("JAVA_CHAT_TIMEOUT_SECONDS", "180"));
    static final String QUEUE = "workflow-lab-java";
    static final Path LOGS = ROOT.resolve(env("LAB_LOG_DIR", ".lab/logs"));
    static final int LOG_BYTES = 512 * 1024;
    private static final List<String> SOURCES = List.of(
        "api", "api-mcp", "temporal-worker", "worker-mcp",
        "api-typescript", "mcp-typescript", "temporal-worker-typescript", "mcp-worker-typescript",
        "api-python", "mcp-python", "temporal-worker-python", "mcp-worker-python",
        "api-java", "mcp-java", "temporal-worker-java", "mcp-worker-java", "restate-java", "mcp-restate-java");

    static String env(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value.strip();
    }

    static ObjectNode object() { return JSON.createObjectNode(); }
    static ArrayNode array() { return JSON.createArrayNode(); }

    static ObjectNode message(String role, String content) {
        return object().put("role", role).put("content", content);
    }

    static String fingerprint(String model, JsonNode messages) throws Exception {
        // Normalize message field ordering so equivalent JSON requests hash alike.
        var canonical = array();
        for (var item : messages) canonical.add(message(item.path("role").asText(), item.path("content").asText()));
        var value = array().add(model).add(canonical);
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(JSON.writeValueAsBytes(value)));
    }

    static synchronized void log(String service, String id, String component, String message, Map<String, ?> fields) {
        var record = object().put("time", Instant.now().toString()).put("level", "info")
            .put("service", service).put("backend", "java").put("correlation_id", id)
            .put("component", component).put("msg", message);
        fields.forEach((key, value) -> record.set(key, JSON.valueToTree(value)));
        String line = record + "\n";
        System.err.print(line); // MCP reserves stdout for protocol messages.
        try {
            Files.createDirectories(LOGS);
            Path file = LOGS.resolve(service + ".jsonl");
            if (Files.exists(file) && Files.size(file) + line.getBytes(StandardCharsets.UTF_8).length > LOG_BYTES) {
                Files.move(file, LOGS.resolve(service + ".jsonl.previous"), StandardCopyOption.REPLACE_EXISTING);
            }
            Files.writeString(file, line, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException ignored) { /* The terminal still has the record. */ }
    }

    static List<JsonNode> recentLogs() {
        var entries = new ArrayList<JsonNode>();
        for (String source : SOURCES) {
            for (String suffix : List.of(".jsonl", ".jsonl.previous")) {
                try (var reader = Files.newBufferedReader(LOGS.resolve(source + suffix))) {
                    for (String line; (line = reader.readLine()) != null; ) {
                        try {
                            JsonNode record = JSON.readTree(line);
                            if (record.hasNonNull("msg")) {
                                Instant.parse(record.path("time").asText());
                                entries.add(record);
                            }
                        } catch (Exception ignored) { /* Skip incomplete writes. */ }
                    }
                } catch (IOException ignored) { /* No file for this service yet. */ }
            }
        }
        entries.sort(Comparator.comparing((JsonNode entry) -> Instant.parse(entry.path("time").asText())).reversed());
        return entries.subList(0, Math.min(500, entries.size()));
    }

    static final class ApiError extends RuntimeException {
        final int status;
        ApiError(int status, String message) { super(message); this.status = status; }
    }

    private Support() {}
}
