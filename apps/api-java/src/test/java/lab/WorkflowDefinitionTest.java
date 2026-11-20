package lab;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static lab.Support.*;

class WorkflowDefinitionTest {
    @Test
    void normalizesSkusWithoutChangingOrderAndHonorsExplicitFlags() throws Exception {
        var raw = JSON.readTree("""
            {"items":["lamp-42","MUG-17","LAMP-42"],"pickupHours":false}
            """);
        var result = RestateInventory.definition(raw);
        assertEquals(array().add("LAMP-42").add("MUG-17"), result.get("items"));
        assertFalse(result.get("pickupHours").asBoolean());
        assertTrue(result.get("requireApproval").asBoolean());
        assertTrue(result.get("summarize").asBoolean());
    }

    @Test
    void rejectsMalformedDefinitions() throws Exception {
        for (String bad : new String[] {
            "{\"items\":[]}", "{\"items\":[\"bad sku\"]}",
            "{\"items\":[\"A\",\"B\",\"C\",\"D\"]}",
            "{\"items\":[\"LAMP-42\"],\"requireApproval\":\"yes\"}",
        }) {
            assertEquals(400, assertThrows(ApiError.class, () ->
                RestateInventory.definition(JSON.readTree(bad))).status);
        }
    }

    @Test
    void restartFingerprintUsesMessageValuesRatherThanFieldOrdering() throws Exception {
        var original = JSON.readTree("[{\"role\":\"user\",\"content\":\"Check inventory\"}]");
        var reordered = JSON.readTree("[{\"content\":\"Check inventory\",\"role\":\"user\"}]");
        assertEquals(fingerprint("model-a", original), fingerprint("model-a", reordered));
        assertNotEquals(fingerprint("model-a", original), fingerprint("model-b", original));
    }
}
