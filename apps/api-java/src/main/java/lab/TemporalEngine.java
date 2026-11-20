package lab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.temporal.activity.ActivityInterface;
import io.temporal.activity.ActivityOptions;
import io.temporal.api.enums.v1.WorkflowExecutionStatus;
import io.temporal.api.enums.v1.WorkflowIdReusePolicy;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowExecutionAlreadyStarted;
import io.temporal.client.WorkflowFailedException;
import io.temporal.client.WorkflowNotFoundException;
import io.temporal.client.WorkflowOptions;
import io.temporal.client.WorkflowStub;
import io.temporal.common.RetryOptions;
import io.temporal.serviceclient.WorkflowServiceStubs;
import io.temporal.serviceclient.WorkflowServiceStubsOptions;
import io.temporal.worker.WorkerFactory;
import io.temporal.workflow.Workflow;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import static lab.Support.*;

/** Submits idempotent workflows and runs their activity implementations. Workflow code only schedules durable steps; activities perform model and MCP I/O. */
final class TemporalEngine implements AutoCloseable {
    static final String JOB_PREFIX = "lab-java-job-";
    private final WorkflowServiceStubs stubs = WorkflowServiceStubs.newServiceStubs(WorkflowServiceStubsOptions
        .newBuilder().setTarget(env("TEMPORAL_ADDR", "127.0.0.1:7233")).setRpcTimeout(Duration.ofSeconds(5)).build());
    private final WorkflowClient client = WorkflowClient.newInstance(stubs);

    @WorkflowInterface
    public interface Inventory {
        @WorkflowMethod(name = "InventoryJava") String execute(String turn, String correlation, String runId);
    }

    @ActivityInterface
    public interface InventoryActivities {
        String ask(String turn, String correlation);
        String tool(String turn, String correlation);
    }

    public static final class InventoryWorkflow implements Inventory {
        private final InventoryActivities activities = Workflow.newActivityStub(InventoryActivities.class,
            ActivityOptions.newBuilder().setStartToCloseTimeout(Duration.ofMinutes(3)).setHeartbeatTimeout(Duration.ofSeconds(10))
                .setRetryOptions(RetryOptions.newBuilder().setMaximumAttempts(3).build()).build());

        @Override public String execute(String turn, String correlation, String runId) {
            // Only activities perform I/O. Replay sees their recorded return values.
            while (true) {
                turn = activities.ask(turn, correlation);
                try {
                    var state = JSON.readTree(turn);
                    if (state.path("pending").isEmpty()) return Agent.reply(state, "temporal", runId).toString();
                    while (!state.path("pending").isEmpty()) {
                        turn = activities.tool(turn, correlation);
                        state = JSON.readTree(turn);
                    }
                } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
                    throw new IllegalStateException("Invalid activity payload.", error);
                }
            }
        }
    }

    private WorkflowStub start(String id, String correlation, String model, JsonNode messages, String prompt) throws Exception {
        String key = fingerprint(model, messages);
        var workflow = client.newWorkflowStub(Inventory.class, WorkflowOptions.newBuilder().setWorkflowId(id)
            .setTaskQueue(QUEUE).setWorkflowIdReusePolicy(WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE)
            .setWorkflowExecutionTimeout(prompt.isBlank() ? Duration.ofMinutes(20) : Duration.ofHours(24))
            .setMemo(Map.of("fingerprint", key, "model", model, "prompt", prompt, "correlationId", correlation)).build());
        try {
            WorkflowClient.start(workflow::execute, Agent.turn(model, messages).toString(), correlation, id);
            return WorkflowStub.fromTyped(workflow);
        } catch (WorkflowExecutionAlreadyStarted error) {
            var existing = client.newUntypedWorkflowStub(id);
            if (!key.equals(existing.describe().getMemo("fingerprint", String.class))) {
                throw new ApiError(409, "This run ID belongs to a different request.");
            }
            return existing;
        }
    }

    JsonNode chat(String id, String correlation, String model, JsonNode messages) throws Exception {
        return chat(id, correlation, model, messages, null);
    }

    JsonNode chat(String id, String correlation, String model, JsonNode messages, ChatStream.Emit emit) throws Exception {
        if (id.startsWith(JOB_PREFIX)) throw new ApiError(400, "Choose a chat run ID.");
        var workflow = start(id, correlation, model, messages, "");
        try {
            if (emit == null) return JSON.readTree(workflow.getResult(TIMEOUT, TimeUnit.SECONDS, String.class));
            var result = workflow.getResultAsync(String.class);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(TIMEOUT);
            String previous = "";
            try {
                emit.send(object().put("type", "status").put("message", "Waiting for a Temporal worker…"));
                while (!result.isDone()) {
                    if (System.nanoTime() >= deadline) throw new TimeoutException();
                    for (var pending : workflow.describe().getRawDescription().getPendingActivitiesList()) {
                        var details = pending.getHeartbeatDetails();
                        if (details.getPayloadsCount() == 0) continue;
                        var snapshot = io.temporal.common.converter.DefaultDataConverter.STANDARD_INSTANCE
                            .fromPayload(details.getPayloads(0), JsonNode.class, JsonNode.class);
                        var event = TemporalProgress.event(snapshot);
                        if (event != null && !event.toString().equals(previous)) {
                            emit.send(event); previous = event.toString();
                        }
                    }
                    try { result.get(500, TimeUnit.MILLISECONDS); }
                    catch (TimeoutException waiting) { /* Poll progress until completion or the API deadline. */ }
                }
                return JSON.readTree(result.get());
            } catch (java.util.concurrent.ExecutionException error) {
                if (error.getCause() instanceof WorkflowFailedException failure) throw failure;
                throw error;
            } finally {
                // Cancel only this result subscription, never the durable workflow.
                result.cancel(true);
            }
        } catch (TimeoutException error) {
            // Timing out the API wait leaves the durable execution available for resume.
            throw new ApiError(504, "The chat request timed out. Resume the saved run after the worker is available.");
        } catch (WorkflowFailedException error) {
            throw new ApiError(502, "The Temporal workflow could not complete this chat.");
        }
    }

    JsonNode submit(String id, String model, String prompt) throws Exception {
        return summary(start(id, id, model, array().add(message("user", prompt)), prompt).describe());
    }

    JsonNode jobs() {
        var output = array();
        try (var executions = client.listExecutions("WorkflowType = 'InventoryJava' AND WorkflowId STARTS_WITH '" + JOB_PREFIX + "'")) {
            executions.limit(50).map(TemporalEngine::summary).forEach(output::add);
        }
        return output;
    }

    JsonNode job(String id) throws Exception {
        if (!id.startsWith(JOB_PREFIX)) throw new ApiError(404, "Job not found.");
        var workflow = client.newUntypedWorkflowStub(id);
        try {
            var result = summary(workflow.describe());
            if (result.path("status").asText().equals("completed")) {
                result.set("report", JSON.readTree(workflow.getResult(String.class)));
            }
            return result;
        } catch (WorkflowNotFoundException error) {
            throw new ApiError(404, "Job not found.");
        }
    }

    private static ObjectNode summary(io.temporal.client.WorkflowExecutionMetadata info) {
        var result = object().put("id", info.getExecution().getWorkflowId())
            .put("model", (String) info.getMemo("model", String.class)).put("prompt", (String) info.getMemo("prompt", String.class))
            .put("correlationId", (String) info.getMemo("correlationId", String.class))
            .put("startedAt", info.getStartTime().toString());
        if (info.getCloseTime() != null) result.put("finishedAt", info.getCloseTime().toString());
        var status = info.getStatus();
        return result.put("status", status == WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_COMPLETED ? "completed" :
            status == WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_RUNNING ? "running" : "failed");
    }

    static void runWorker() throws Exception {
        try (var engine = new TemporalEngine(); var agent = new Agent("temporal-worker-java", "mcp-worker-java")) {
            var factory = WorkerFactory.newInstance(engine.client);
            var options = io.temporal.worker.WorkerOptions.newBuilder()
                .setMaxHeartbeatThrottleInterval(Duration.ofMillis(500))
                .setDefaultHeartbeatThrottleInterval(Duration.ofMillis(500));
            String identity = env("LAB_WORKER_IDENTITY", "");
            if (!identity.isBlank()) options.setIdentity(identity);
            var worker = factory.newWorker(QUEUE, options.build());
            worker.registerWorkflowImplementationTypes(InventoryWorkflow.class);
            worker.registerActivitiesImplementations(new InventoryActivities() {
                @Override public String ask(String turn, String id) {
                    try (var progress = new TemporalProgress()) { return agent.ask((ObjectNode) JSON.readTree(turn), id, progress::emit).toString(); }
                    catch (Exception error) { throw io.temporal.activity.Activity.wrap(error); }
                }
                @Override public String tool(String turn, String id) {
                    try (var progress = new TemporalProgress()) { return agent.tool((ObjectNode) JSON.readTree(turn), id, progress::emit).toString(); }
                    catch (Exception error) { throw io.temporal.activity.Activity.wrap(error); }
                }
            });
            var stop = new java.util.concurrent.CountDownLatch(1);
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                factory.shutdownNow();
                factory.awaitTermination(5, TimeUnit.SECONDS);
                agent.close();
                stop.countDown();
            }));
            factory.start();
            log(agent.service, "", "worker", "worker.started", Map.of("task_queue", QUEUE));
            stop.await();
        }
    }

    @Override public void close() { stubs.shutdown(); }
}
