package lab;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ChatStreamTest {
    @Test void assemblesTextCallsAndUsageFromSeparateRecords() throws Exception {
        var input = "{\"message\":{\"content\":\"Café\"},\"done\":false}\n"
            + "{\"message\":{\"content\":\"!\",\"tool_calls\":[{\"function\":{\"name\":\"lookup_inventory\",\"arguments\":{\"sku\":\"LAMP-42\"}}}]},\"done\":false}\n"
            + "{\"message\":{\"content\":\"\"},\"done\":true,\"prompt_eval_count\":12,\"eval_count\":4}\n";
        var events = new ArrayList<String>();
        // One byte per read exercises a UTF-8 character across read boundaries.
        var source = new ByteArrayInputStream(input.getBytes(StandardCharsets.UTF_8)) {
            @Override public synchronized int read(byte[] buffer, int offset, int length) {
                return super.read(buffer, offset, Math.min(1, length));
            }
        };
        var result = ChatStream.read(source, event -> events.add(event.path("text").asText()));
        assertEquals(java.util.List.of("Café", "!"), events);
        assertEquals("Café!", result.path("message").path("content").asText());
        assertEquals(1, result.path("message").path("tool_calls").size());
        assertEquals(12, result.path("prompt_eval_count").asInt());
        assertEquals(4, result.path("eval_count").asInt());
    }

    @Test void requiresTerminalDoneAndPropagatesWriteFailures() {
        for (var input : new String[]{"{\"message\":{\"content\":\"draft\"}}\n", "{broken\n", "{\"error\":\"model failed\"}\n"}) {
            assertThrows(IOException.class, () -> ChatStream.read(
                new ByteArrayInputStream(input.getBytes(StandardCharsets.UTF_8)), event -> { }));
        }
        assertThrows(IOException.class, () -> ChatStream.read(new ByteArrayInputStream(
            "{\"message\":{\"content\":\"draft\"}}\n".getBytes(StandardCharsets.UTF_8)), event -> {
                throw new IOException("browser disconnected");
            }));
    }
}
