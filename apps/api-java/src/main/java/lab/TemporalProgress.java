package lab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.temporal.activity.Activity;
import io.temporal.activity.ActivityExecutionContext;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import static lab.Support.*;

/** Latest-value previews live in activity heartbeats, outside workflow replay. */
final class TemporalProgress implements AutoCloseable {
    private static final java.util.concurrent.ScheduledExecutorService TIMER =
        Executors.newSingleThreadScheduledExecutor(task -> {
            var thread = new Thread(task, "temporal-preview-heartbeat"); thread.setDaemon(true); return thread;
        });
    private final ActivityExecutionContext context = Activity.getExecutionContext();
    private final ObjectNode snapshot = object().put("version", 1).put("type", "model")
        .put("text", "").put("name", "").put("truncated", false)
        .put("activityId", context.getInfo().getActivityId()).put("attempt", context.getInfo().getAttempt());
    private final ScheduledFuture<?> timer;
    private long sent;

    TemporalProgress() { timer = TIMER.scheduleAtFixedRate(this::beat, 2, 2, TimeUnit.SECONDS); }

    private synchronized void beat() {
        context.heartbeat(snapshot.deepCopy());
        sent = System.nanoTime();
    }

    synchronized void emit(ObjectNode event) {
        switch (event.path("type").asText()) {
            case "model-start" -> snapshot.put("type", "model").put("text", "").put("truncated", false);
            case "text" -> {
                String text = snapshot.path("text").asText() + event.path("text").asText();
                snapshot.put("text", text.substring(0, Math.min(16000, text.length())))
                    .put("truncated", snapshot.path("truncated").asBoolean() || text.length() > 16000);
                if (System.nanoTime() - sent < 400_000_000L) return;
            }
            case "tool-start", "tool-complete" -> snapshot.put("type", event.path("type").asText())
                .put("name", event.path("name").asText()).put("text", "");
            default -> { return; }
        }
        beat();
    }

    static ObjectNode event(JsonNode snapshot) {
        if (snapshot.path("version").asInt() != 1) return null;
        String type = snapshot.path("type").asText();
        if (type.equals("model")) return object().put("type", "model-snapshot")
            .put("text", snapshot.path("text").asText()).put("activityId", snapshot.path("activityId").asText())
            .put("attempt", snapshot.path("attempt").asInt()).put("truncated", snapshot.path("truncated").asBoolean());
        if (type.equals("tool-start") || type.equals("tool-complete")) {
            return object().put("type", type).put("name", snapshot.path("name").asText());
        }
        return null;
    }

    @Override public void close() { timer.cancel(false); }
}
