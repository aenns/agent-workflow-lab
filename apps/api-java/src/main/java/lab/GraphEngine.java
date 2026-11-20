package lab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.bsc.langgraph4j.CompileConfig;
import org.bsc.langgraph4j.GraphInput;
import org.bsc.langgraph4j.RunnableConfig;
import org.bsc.langgraph4j.StateGraph;
import org.bsc.langgraph4j.checkpoint.PostgresSaverV2;
import org.bsc.langgraph4j.serializer.std.ObjectStreamStateSerializer;
import org.bsc.langgraph4j.state.AgentState;
import org.postgresql.ds.PGSimpleDataSource;
import static org.bsc.langgraph4j.StateGraph.*;
import static org.bsc.langgraph4j.action.AsyncEdgeAction.edge_async;
import static org.bsc.langgraph4j.action.AsyncNodeAction.node_async;
import static lab.Support.*;

/** Builds a LangGraph4j graph with PostgreSQL checkpoints. Connections and streaming callbacks stay in node closures; only serializable turn data is saved. */
final class GraphEngine {
    private static final String SCHEMA = "workflow_lab_java";
    private final Set<String> running = ConcurrentHashMap.newKeySet();
    private final ObjectStreamStateSerializer<AgentState> serializer = new ObjectStreamStateSerializer<>(AgentState::new);
    private PGSimpleDataSource dataSource;
    private PostgresSaverV2 saver;

    private synchronized PostgresSaverV2 checkpoints() throws Exception {
        if (saver != null) return saver;
        var uri = URI.create(env("DATABASE_URL", "postgres://lab:lab@127.0.0.1:54329/lab?sslmode=disable"));
        var source = new PGSimpleDataSource();
        source.setUrl("jdbc:postgresql://" + uri.getHost() + (uri.getPort() < 0 ? "" : ":" + uri.getPort())
            + uri.getRawPath() + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery()));
        if (uri.getUserInfo() != null) {
            var credentials = uri.getUserInfo().split(":", 2);
            source.setUser(credentials[0]);
            if (credentials.length == 2) source.setPassword(credentials[1]);
        }
        source.setConnectTimeout(3);
        try (var connection = source.getConnection(); var statement = connection.createStatement()) {
            statement.execute("CREATE SCHEMA IF NOT EXISTS " + SCHEMA);
        }
        source.setCurrentSchema(SCHEMA);
        saver = PostgresSaverV2.builder().datasource(source).stateSerializer(serializer).createTables(true).build();
        dataSource = source;
        return saver;
    }

    ObjectNode chat(Agent agent, String id, String correlation, String model, JsonNode messages) throws Exception {
        return chat(agent, id, correlation, model, messages, null);
    }

    ObjectNode chat(Agent agent, String id, String correlation, String model, JsonNode messages, ChatStream.Emit emit) throws Exception {
        if (!running.add(id)) throw new ApiError(409, "This run is already in progress.");
        try {
            var store = checkpoints();
            var config = RunnableConfig.builder().threadId(id).build();
            var key = fingerprint(model, messages);
            var prior = store.get(config);
            if (prior.isPresent() && !key.equals(prior.get().state().get("fingerprint"))) {
                throw new ApiError(409, "This run ID belongs to a different chat request.");
            }
            var graph = new StateGraph<AgentState>(serializer)
                .addNode("ask", node_async(state -> step(state, "Ask model", agent.ask(turn(state), correlation, emit))))
                .addNode("tool", node_async(state -> step(state, "Run tools", agent.tool(turn(state), correlation, emit))))
                .addEdge(START, "ask")
                .addConditionalEdges("ask", edge_async(state -> pending(state) ? "tool" : END), Map.of("tool", "tool", END, END))
                .addConditionalEdges("tool", edge_async(state -> pending(state) ? "tool" : "ask"), Map.of("tool", "tool", "ask", "ask"))
                .compile(CompileConfig.builder().checkpointSaver(store).releaseThread(false).recursionLimit(24).build());
            AgentState result;
            if (prior.isPresent() && END.equals(prior.get().nextNodeId())) {
                result = new AgentState(prior.get().state());
            } else {
                // Resume uses the persisted next node and the transcript containing prior tool results.
                var input = prior.isPresent() ? GraphInput.resume() :
                    GraphInput.args(Map.of("turn", Agent.turn(model, messages).toString(), "fingerprint", key, "states", "[]"));
                try {
                    result = graph.invoke(input, config).orElseThrow();
                } catch (RuntimeException error) {
                    for (Throwable cause = error; cause != null; cause = cause.getCause()) {
                        if (cause instanceof ApiError apiError) throw apiError;
                    }
                    throw error;
                }
            }
            var response = Agent.reply(turn(result), "state-machine", id);
            response.set("states", ((ArrayNode) JSON.readTree((String) result.data().get("states"))).add("Complete"));
            return response;
        } finally {
            running.remove(id);
        }
    }

    private static ObjectNode turn(AgentState state) throws Exception {
        return (ObjectNode) JSON.readTree((String) state.data().get("turn"));
    }

    private static boolean pending(AgentState state) throws Exception {
        return !turn(state).path("pending").isEmpty();
    }

    private static Map<String, Object> step(AgentState state, String label, ObjectNode turn) throws Exception {
        var states = ((ArrayNode) JSON.readTree((String) state.data().get("states"))).add(label);
        // Strings are safely round-tripped by the library's checkpoint serializer.
        return Map.of("turn", turn.toString(), "states", states.toString());
    }

    private record Query(String id, String title, String description, String sql, boolean requiresRunId) {}
    private static final String CHECKPOINT_SQL = "SELECT t.thread_name AS run_id, c.checkpoint_id, c.node_id, c.next_node_id, "
        + "c.saved_at::text FROM " + SCHEMA + ".lg4jcheckpoint c JOIN " + SCHEMA + ".lg4jthread t ON t.thread_id=c.thread_id";
    private static final List<Query> QUERIES = List.of(
        new Query("recent-runs", "Recent runs", "Latest checkpoint for each Java run.",
            "SELECT * FROM (" + CHECKPOINT_SQL.replace("SELECT ", "SELECT DISTINCT ON (t.thread_name) ")
                + " ORDER BY t.thread_name,c.saved_at DESC) latest ORDER BY saved_at DESC LIMIT 50", false),
        new Query("run-history", "Checkpoint history", "Read saved Java graph steps.", CHECKPOINT_SQL
            + " WHERE t.thread_name=? ORDER BY c.saved_at DESC LIMIT 50", true),
        new Query("latest-state", "Latest state", "Decode the latest checkpoint.", "", true),
        new Query("tool-results", "Tool results", "MCP results from the latest checkpoint.", "", true),
        new Query("token-usage", "Token usage", "Model token counts from the latest checkpoint.", "", true));

    static ObjectNode table(List<String> columns, ArrayNode rows) {
        var result = object();
        result.set("columns", JSON.valueToTree(columns));
        result.set("rows", rows);
        return result;
    }

    static JsonNode queries() { return JSON.valueToTree(QUERIES); }

    JsonNode inspect(String queryId, String id) throws Exception {
        var query = QUERIES.stream().filter(item -> item.id.equals(queryId)).findFirst()
            .orElseThrow(() -> new ApiError(400, "Choose a saved query."));
        if (query.requiresRunId && id.isBlank()) throw new ApiError(400, "Supply a run ID.");
        var checkpointStore = checkpoints();
        var rows = array();
        if (!query.sql.isBlank()) {
            try (var connection = dataSource.getConnection(); var statement = connection.prepareStatement(query.sql)) {
                if (query.requiresRunId) statement.setString(1, id);
                try (var result = statement.executeQuery()) {
                    var columns = new ArrayList<String>();
                    var meta = result.getMetaData();
                    for (int i = 1; i <= meta.getColumnCount(); i++) columns.add(meta.getColumnLabel(i));
                    while (result.next()) {
                        var row = rows.addArray();
                        for (int i = 1; i <= columns.size(); i++) row.add(result.getString(i));
                    }
                    return table(columns, rows);
                }
            }
        }
        var saved = checkpointStore.get(RunnableConfig.builder().threadId(id).build());
        var state = saved.isPresent() ? turn(new AgentState(saved.get().state())) : object();
        if (queryId.equals("tool-results")) {
            var columns = List.of("name", "arguments", "result", "isError", "durationMs");
            for (var tool : state.path("tools")) {
                var row = rows.addArray();
                for (var column : columns) row.add(tool.path(column));
            }
            return table(columns, rows);
        }
        if (queryId.equals("token-usage")) {
            int call = 0;
            for (var usage : state.path("usage")) rows.addArray().add(state.path("model").asText())
                .add(++call).add(usage.get("inputTokens")).add(usage.get("outputTokens"));
            return table(List.of("model", "call", "input_tokens", "output_tokens"), rows);
        }
        if (saved.isPresent()) rows.addArray().add(id).add(state);
        return table(List.of("run_id", "state"), rows);
    }
}
