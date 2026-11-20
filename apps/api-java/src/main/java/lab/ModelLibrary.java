package lab;

import com.fasterxml.jackson.databind.JsonNode;
import com.sun.net.httpserver.HttpExchange;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashSet;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;
import static lab.Support.*;

/** Searches and verifies public Ollama model tags, then forwards local installation progress. Registry discovery and local inference use separate endpoints. */
final class ModelLibrary {
    private static final Pattern TAG = Pattern.compile("[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}(?::[a-zA-Z0-9][a-zA-Z0-9._-]{0,63})?");
    private static final Pattern LINK = Pattern.compile("href=[\"']/library/([a-zA-Z0-9._:-]+)[\"']");
    private final AtomicBoolean pulling = new AtomicBoolean();

    private static boolean available(String tag) throws Exception {
        var parts = tag.split(":", 2);
        var url = "https://registry.ollama.ai/v2/library/" + parts[0] + "/manifests/" + (parts.length == 1 ? "latest" : parts[1]);
        var response = Agent.HTTP.send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(5)).build(),
            HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() == 404) return false;
        if (response.statusCode() != 200) throw new ApiError(503, "Could not verify the tag with the Ollama registry.");
        for (var layer : JSON.readTree(response.body()).path("layers")) {
            if (layer.path("mediaType").asText().equals("application/vnd.ollama.image.model")) return true;
        }
        return false;
    }

    JsonNode search(String term) throws Exception {
        if (term.isBlank() || term.getBytes(StandardCharsets.UTF_8).length > 80) throw new ApiError(400, "Enter a search query of up to 80 bytes.");
        var candidates = new LinkedHashSet<String>();
        readTags("/search?q=" + URLEncoder.encode(term, StandardCharsets.UTF_8) + "&c=tools", candidates, 8);
        if (TAG.matcher(term).matches() && !term.contains(":")) readTags("/library/" + term + "/tags", candidates, 16);
        var result = array();
        // Check candidates concurrently and bound search time when a registry request stalls.
        try (var executor = new SearchExecutor()) {
            var checks = candidates.stream().map(tag -> executor.pool.submit(() -> available(tag))).toList();
            long deadline = System.nanoTime() + Duration.ofSeconds(8).toNanos();
            int index = 0;
            for (String tag : candidates) {
                try {
                    if (checks.get(index).get(Math.max(1, deadline - System.nanoTime()), java.util.concurrent.TimeUnit.NANOSECONDS)) {
                        result.add(object().put("tag", tag).put("url", "https://ollama.com/library/" + tag));
                    }
                } catch (java.util.concurrent.ExecutionException | java.util.concurrent.TimeoutException ignored) {
                    // A single unavailable manifest does not hide other results.
                }
                index++;
            }
        }
        return result;
    }

    private static final class SearchExecutor implements AutoCloseable {
        final java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(8);
        @Override public void close() { pool.shutdownNow(); }
    }

    private static void readTags(String path, LinkedHashSet<String> candidates, int limit) throws Exception {
        var response = Agent.HTTP.send(HttpRequest.newBuilder(URI.create("https://ollama.com" + path))
            .timeout(Duration.ofSeconds(4)).build(), HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) return;
        var matcher = LINK.matcher(response.body());
        while (candidates.size() < limit && matcher.find()) {
            if (TAG.matcher(matcher.group(1)).matches()) candidates.add(matcher.group(1));
        }
    }

    void install(HttpExchange exchange, String tag, String id) throws Exception {
        if (!TAG.matcher(tag).matches()) throw new ApiError(400, "Enter a local Ollama Library tag.");
        if (!pulling.compareAndSet(false, true)) throw new ApiError(409, "A model download is already in progress.");
        try {
            if (!available(tag)) throw new ApiError(400, "That tag has no downloadable local model.");
            var request = HttpRequest.newBuilder(URI.create(Agent.OLLAMA + "/api/pull"))
                .timeout(Duration.ofHours(2)).header("Content-Type", "application/json")
                .header("X-Correlation-ID", id)
                .POST(HttpRequest.BodyPublishers.ofString(object().put("model", tag).put("stream", true).toString())).build();
            var response = Agent.HTTP.send(request, HttpResponse.BodyHandlers.ofInputStream());
            try (var input = response.body()) {
                if (response.statusCode() != 200) throw new ApiError(503, "Could not start the model download.");
                exchange.getResponseHeaders().set("Content-Type", "application/x-ndjson");
                exchange.getResponseHeaders().set("Cache-Control", "no-store");
                exchange.sendResponseHeaders(200, 0);
                log("api-java", id, "ollama-client", "ollama.pull.started", java.util.Map.of("model", tag));
                try (var output = exchange.getResponseBody()) {
                    byte[] buffer = new byte[4096];
                    for (int size; (size = input.read(buffer)) != -1;) {
                        output.write(buffer, 0, size);
                        output.flush();
                    }
                } finally {
                    log("api-java", id, "ollama-client", "ollama.pull.ended", java.util.Map.of("model", tag));
                }
            }
        } finally { pulling.set(false); }
    }
}
