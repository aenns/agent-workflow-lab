# Local AI Agent & MCP Workflow Lab

A local playground for AI agents, MCP tools, streaming chat, and durable workflows. Compare Go, TypeScript, Python, and Java backends through one React workspace, using local Ollama models and an MCP inventory server for each language.

Run the same chat with a direct loop, a LangGraph state machine backed by PostgreSQL, or a Temporal workflow with a separate worker. Enable streaming on any backend and engine to watch replies develop, then inspect tool calls, token counts, and correlated JSON logs. Temporal streams batched activity-heartbeat previews and can recover unfinished work after a worker restart.

The Java backend also includes a **Restate approval workflow**. Choose inventory items and optional pickup-hour and summary steps, then approve or cancel when an item is unavailable. Restate journals completed steps and the approval decision so the workflow can resume across service restarts.

## Demo walkthrough

- **Compare agents:** Follow the [quick start](#quick-start), select a backend and engine, and ask about inventory and pickup hours.
- **Watch replies develop:** Enable [streaming chat](#try-incremental-chat-responses) and inspect the completed reply's tool trace, model, token totals, and logs.
- **Try durable execution:** Run the [Temporal worker restart demo](#demo-worker-downtime), then retrieve the completed background report and its in-app notification.
- **Make an approval decision:** Open [Restate workflows](#run-a-configurable-inventory-workflow-with-restate), configure the inventory process, and continue or cancel its approval wait.

## macOS shortcuts

In Finder, open the project folder and double-click **Start Lab.command**. It opens Docker Desktop and Ollama if needed, starts PostgreSQL, Temporal, the Go, TypeScript, and Python APIs and workers, and the web app, then opens the lab in Chrome. Install the prerequisites below and Python 3.12, then pull the model once before using the shortcut. With JDK 17 or newer available, the launcher also builds Java and starts its API, Temporal worker, and Restate demo. The first Java build downloads Maven and its dependencies. Set `LAB_ENABLE_JAVA=0` when running the launcher from Terminal to skip Java. Set `LAB_ENABLE_RESTATE=0` to start Java without Restate. Leave the launcher Terminal window open while the lab runs.

Double-click **Stop Lab.command** or press **Control+C** in the launcher Terminal window to stop the lab processes and containers. Checkpoints and workflow history are retained. Chrome, Docker Desktop, and Ollama stay open because other apps may use them. If you started the API or web app manually, stop those terminals before using the shortcuts.

If macOS prompts for access to the project in Documents, allow Terminal to access that folder. If the launcher exits before Chrome opens, check `.lab/launcher.log` from the project folder.

## Quick start

Install Go 1.27+, Node.js 24 with npm, and Ollama. Open the Ollama app, then run `ollama pull qwen3:14b` if the model is missing from `ollama list`.

1. From the project folder, run `make install`.
2. In separate terminals, run `make dev-api` and `make dev-web`.
3. Open [the local lab](http://127.0.0.1:5173), choose the **Go loop**, and select the suggested inventory and pickup prompt. Press **Send message**.
4. Expand the tool calls and token counts under the reply. Select **View logs** to see that turn’s events.

Start Docker Desktop for the engines below that use a database or workflow server.

| Engine | Additional commands | How it continues a run |
| --- | --- | --- |
| Go loop | Ollama, API, and web app are sufficient | Go keeps the current turn in memory. |
| State machine | `make dev-db` | LangGraphGo saves a PostgreSQL checkpoint after each successful graph step. |
| Temporal | `make dev-temporal`, then `make dev-worker` in another terminal | A separate worker uses Temporal history to replay the workflow and recover completed activity results. |

The API launches an inventory MCP child process. The Temporal worker launches its own copy. Ollama runs on the host, and its first response may take longer while loading the model.

## Run the TypeScript backend

Run `make install`, then run `make dev-api-ts` and `make dev-web` in separate terminals. Open [the local lab](http://127.0.0.1:5173) and select **TypeScript** from **Backend**. The TypeScript API listens on port 8081 and launches its own TypeScript MCP server over stdio. The direct loop requires Ollama and the configured model.

- For **State machine**, start PostgreSQL with `make dev-db`. LangGraph checkpoints use the `workflow_lab_typescript` schema. The **Database** panel reads the selected backend's checkpoints.
- For **Temporal** and **Run in background**, run `make dev-temporal` and `make dev-worker-ts`. The TypeScript worker polls its own task queue. To verify recovery, submit a background audit with that worker stopped and restart it to complete the same job.
- Open **View logs** on a reply or job to filter by its correlation ID. TypeScript JSON records include `"backend":"typescript"` and identify the API, worker, or MCP server in the `service` field.
- Set `TS_API_PORT` to change the TypeScript listener and `TS_API_PROXY_TARGET` to match it in Vite. `TS_CHAT_TIMEOUT_MS` overrides the default three-minute wait for chat. All four implementations serve the same OpenAPI document.

To compare the implementations, keep the APIs you want to compare running and change **Backend** in the header. The API reference, MCP tools, jobs, and database follow that selection. A saved run belongs to the backend that created it.

## Run the Python backend

Run `make install install-py` with Python 3.12 available. Run `make dev-api-py` and `make dev-web` in separate terminals, open [the local lab](http://127.0.0.1:5173), and select **Python** from **Backend**. The FastAPI service listens on port 8082 and launches its own Python MCP server over stdio. The direct loop uses the same local Ollama model and inventory fixtures as the other backends.

- For **State machine**, run `make dev-db`. Python checkpoints live in the `workflow_lab_python` schema. The **Database** panel can inspect those checkpoints and saved tool and token results.
- For **Temporal** and **Run in background**, run `make dev-temporal` and `make dev-worker-py`. The worker uses the separate `workflow-lab-python` task queue. Submit an audit while the worker is offline, then start it to see the same job finish.
- **View logs** filters events by correlation ID. Python events include `"backend":"python"` and the API, MCP, or Temporal worker service name.
- To choose a specific Python executable for setup, run `make install-py PYTHON=python3.12`. The launcher and manual commands use the resulting virtual environment.

## Run the Java backend

Install JDK 17 or newer and run `make build-java`. The checked-in Maven wrapper selects the Maven version and runs Java tests during packaging. With Ollama running, run `make dev-api-java` and `make dev-web` in separate terminals, then select **Backend → Java**. The Java API listens on port 8083 and launches a Java MCP server over stdio.

- **Java loop** only needs Ollama and the API.
- **State machine** uses LangGraph4j and the `workflow_lab_java` PostgreSQL schema. Run `make dev-db` and use **Database** to inspect a Java run.
- **Temporal** uses the `workflow-lab-java` queue. Run `make dev-temporal` and `make dev-worker-java` for a manual session, or use the launcher and manage the worker from Chat or Jobs.
- **View logs** shows correlated events with `"backend":"java"` across the API, MCP process, and worker.

## Run a configurable inventory workflow with Restate

With **Start Lab.command**, Restate starts and registers automatically when Java is enabled. **Stop Lab.command** stops its Java process and container, preserving the journal.

For a manual session, build Java and keep the Java API and web app running. In a separate terminal, run `make dev-restate-service`. Once it is listening, run `make start-restate` and `make register-restate` from the project folder. Docker Desktop reaches the Java endpoint through `http://host.docker.internal:9080` by default. Set `RESTATE_DEPLOYMENT_URL` if you use a different address reachable from the Restate container.

Open **Workflows**. Enter up to three inventory SKUs and choose whether to look up pickup hours, pause when an item is unavailable, and ask Ollama for a summary. With the default two-item example, the workflow pauses because `MUG-17` is out of stock. Select **Continue with available items** or **Cancel this run**. The decision and saved results appear under the same run ID.

To try recovery with a manual Restate session, stop the terminal running `make dev-restate-service` while approval is pending. Start it again, then approve from **Workflows**. Restate retains the completed lookups and the approval wait. Press **Control+C** in the service terminal and run `make stop-restate` to shut down a manual session. Its journal volume is retained.

The Java API exposes `POST /api/workflows`, `GET /api/workflows/{id}`, and `POST /api/workflows/{id}/decision` for this Restate demo. The last endpoint accepts a `decision` of `continue` or `cancel`.

## Try incremental chat responses

Select any backend, choose its **loop**, **State machine**, or **Temporal** engine, and enable **Stream response**. Text appears as Ollama generates it. Tool calls show progress, and a new model call replaces the intermediate draft. The completed reply, tool trace, and token totals become part of the conversation only after the final completion event.

Streaming is off by default and is supported by Go, TypeScript, Python, and Java for all three chat engines. **Run in background** always submits a Temporal job and returns a complete report through Jobs. The checkbox applies to **Send** only. Temporal displays coalesced draft snapshots from activity heartbeats, so text arrives in small batches. Fast tool progress can be missed between polls, but the final trace includes every completed tool call. Previews are capped at 16,000 characters; the completed reply remains full length.

Try a short greeting, the two-item stock and pickup example, then turn streaming off and repeat. For a graph run interrupted by a failure, use **Resume saved run** to continue from the last checkpoint.

To test Temporal recovery, choose **Temporal**, start a new chat, enable streaming, and stop the worker before sending. The chat waits until you start the worker. You can also stop the worker while text is appearing. Temporal retries the unfinished model activity after detecting the failure, and its new draft replaces the prior attempt. Completed activity results remain recorded. Closing the tab or timing out the HTTP wait leaves the workflow running; **Resume saved run** reattaches to the same ID. An interrupted model call may generate a different draft and consume additional inference work, while the final token totals describe the successful model activities.

## Compare Ollama models

The **Model** picker lists installed tags. Select **Add models** to search the public Ollama Library or enter an exact tag such as `qwen3.5:9b`. Click **Install** to download the model to local Ollama. The progress bar reports the current layer, and the app refreshes the picker and selects the new model when it supports tools. Downloads can continue as you switch views within the lab. Keep the tab open during installation.

Search uses the public Ollama Library website and verifies tags against the Ollama registry. Only tags with downloadable model weights are offered. If search is unavailable, paste a library tag into **Install by tag**. The app accepts public library tags such as `qwen3.5:9b`. The picker hides models that explicitly report they lack tool support. Some Ollama versions omit capability information, so test an unfamiliar model with an MCP prompt.

Choose a model before sending a message or starting a background audit. The reply, job report, and correlated Ollama call logs show the selected model. The **Configured default** uses `OLLAMA_MODEL`. New durable runs save the resolved model with their state. Changing the picker for a pending chat turn starts a new run.

## How the pieces fit together

```mermaid
flowchart LR
    UI["React workspace"] --> Vite["Vite proxy"]
    Vite --> Go["Go API · 8080"]
    Vite --> TS["TypeScript API · 8081"]
    Vite --> Py["Python API · 8082"]
    Vite --> Java["Java API · 8083"]
    Go & TS & Py & Java --> Contract["Shared OpenAPI spec"]
    Go & TS & Py & Java --> Ollama["Local Ollama"]
    Go & TS & Py & Java --> MCP["API's inventory MCP child"]
    Go & TS & Py & Java --> DB["PostgreSQL · backend-specific checkpoints"]
    Go & TS & Py & Java --> Temporal["Temporal server"]
    Temporal --> GoW["Go worker · workflow-lab-chat"]
    Temporal --> TSW["TypeScript worker · workflow-lab-typescript"]
    Temporal --> PyW["Python worker · workflow-lab-python"]
    Temporal --> JavaW["Java worker · workflow-lab-java"]
    GoW & TSW & PyW & JavaW --> Ollama
    GoW & TSW & PyW & JavaW --> WorkerMCP["Worker's inventory MCP child"]
    Java --> Restate["Restate server · workflow journal"]
    Restate --> RestateJava["Java approval service"]
    RestateJava --> Ollama
    RestateJava --> RestateMCP["Approval service MCP child"]
```

See the [code walkthrough](docs/code-walkthrough.md) for the path from the chat form to the model, the tools, and the final reply.

## Compare the engines

Choose **Go**, **TypeScript**, **Python**, or **Java** in the **Backend** picker. Use the same model and a fresh chat for each run.

1. Select the direct loop for your backend and ask “Is LAMP-42 in stock, and what are the pickup hours at its warehouse?” Expand the tool calls to see their arguments and results.
2. Select **New chat** to clear the conversation, choose **State machine**, and ask the same question.
3. Expand the tool calls and **State transitions** on the state-machine reply.
4. Start a new chat, choose **Temporal**, and send the same question. Expand the tool calls and use the reply’s **Workflow ID** to find its history in the [Temporal UI](http://127.0.0.1:8233).

The Go loop calls the model, runs any requested tools, and repeats until the model answers. The state-machine engine uses [LangGraphGo](https://github.com/smallnest/langgraphgo) to schedule two graph nodes, one for Ollama and one for the next MCP tool call. A two-step tool request typically visits **Ask model → Run tools → Ask model → Run tools → Ask model → Complete**. All three engines share the same tools and limits. The Go loop keeps its working state in memory. The state machine uses PostgreSQL checkpoints. Reply wording and tool selection can vary across model runs.

Go displays one **Run tools** transition per batch. TypeScript, Python, and Java display one per tool call. All four save a checkpoint after each successful tool call. Expand **Tool calls** to compare the actual calls across runs.

## Temporal workflow and worker restart (Go)

Start the Temporal server with `make dev-temporal`. Start or restart the separate Go worker with `make dev-worker`. The worker polls the `workflow-lab-chat` task queue and owns its MCP child process. Leave the API and web app running so the browser can receive the final reply.

1. Select **Temporal** in a new chat and ask “Use the inventory tool to look up LAMP-42, then use the warehouse-hours tool to check pickup hours for the warehouse it returns.”
2. In the [Temporal UI](http://127.0.0.1:8233), open the active `InventoryChat` workflow. Its history shows `DiscoverMCPTools`, `AskOllama`, and `CallMCPTool` activities. Tool activity IDs include the tool name.
3. For a mid-run restart, watch for the completion of `tool-1-1-lookup_inventory`. Press **Control+C** in the worker terminal while the workflow is still running, then run `make dev-worker` again.
4. Verify the finished reply and history. A completed activity result is available during replay. An activity interrupted before Temporal recorded completion may retry. If the browser timed out or was reloaded, select **Resume saved run** to reconnect to the same workflow.

The local Temporal server stores workflow history, including prompts and activity results, in a SQLite file on a Docker volume. The request timeout controls how long the API waits for a reply. Temporal can continue running after the browser disconnects, within its own execution deadline.

## Control the Temporal worker from Chat or Jobs

Start the lab with **Start Lab.command**, then choose a **Backend** and select **Temporal** in Chat. The worker panel shows **Polling** after Temporal sees that worker on its task queue. **Stop worker** stops only that backend's worker. While it shows **Stopped**, submit an audit with **Run in background**. The job waits in Temporal. **Run in background** opens **Jobs**. Use **Start worker** there to watch the same job finish. The APIs, other workers, PostgreSQL, and Temporal server keep running throughout.

**Send message** with the Temporal engine also submits a durable workflow. Chat waits for the reply. If the worker restarts before the API timeout, the reply appears in Chat. If the API times out first, start the worker and select **Resume saved run** in the same chat to retrieve the same workflow. The Jobs tab tracks audits submitted with **Run in background**.

When you start services manually, the panel shows whether Temporal has recently seen a poller, and the worker buttons are unavailable. Use the corresponding worker terminal to stop or restart it.

## Run a background inventory audit

Start the Temporal server and worker with `make dev-temporal` and `make dev-worker`. Keep the API and web app running. In **Chat**, enter “Check stock and pickup options for LAMP-42 and MUG-17 this week.” Select **Run in background**. The prompt is submitted as a standalone Temporal job and the **Jobs** view opens right away.

Switch views or close the browser tab while the job runs. When you open the lab again, the **Jobs** badge and in-app banner show jobs that finished while you were away. Open a completed job to see its report, tool calls, token usage, and correlated logs. Opening a finished job acknowledges its notification in that browser. Temporal stores the jobs and reports, and the list shows up to 50 recent jobs.

### Demo worker downtime

Use the background audit prompt above for this walkthrough.

1. Launch with **Start Lab.command**. Select a backend and the **Temporal** engine, then click **Stop worker** and wait for **Stopped**.
2. Submit the audit with **Run in background**. The **Jobs** view shows **Queued or running** while the worker is offline.
3. In **Jobs**, click **Start worker**. The same job should finish and show an in-app completion notification.
4. Open the report. The fixture has seven LAMP-42 lamps at the north warehouse and zero MUG-17 mugs. Expand the trace to inspect the inventory and warehouse-hours calls.

The audit uses fixed inventory and warehouse-hours data.

## Checkpoint and resume

LangGraphGo automatically writes a PostgreSQL checkpoint after every successful model or tool node. A checkpoint includes the next node, the model transcript, completed tool results, and any remaining calls in the batch. The app stops the run if the library’s checkpointer reports an error.

If the API stops mid-turn, restart it, then select **Resume saved run** in the same browser tab. The tab remembers the run ID and request text even after a reload. For API clients, send the same `runId` and original messages again. Reusing a completed run ID returns the saved reply. An interrupted operation can run again if the process stopped before its checkpoint committed.

### Inspect checkpoints in PostgreSQL

Open **Database** in the lab to run saved queries for recent runs, checkpoint history, tool results, per-call token usage, and the latest JSON state. Select a run ID in the results to load it into the history query, or choose **Inspect checkpoints** under a state-machine reply. **View SQL** shows the statement the app will execute. Queries for a single run accept a Run ID. The server only executes saved read-only queries.

The Database view uses the selected backend’s PostgreSQL schema. The SQL examples below use the Go schema. TypeScript and Python store checkpoints in `workflow_lab_typescript` and `workflow_lab_python` and decode saved state through their LangGraph PostgreSQL savers. Temporal job reports appear in **Jobs**, and Temporal execution history is available in the [Temporal UI](http://127.0.0.1:8233).

Run `make dev-db` if PostgreSQL is stopped. Send at least one message using **State machine** to create a checkpoint. Then open the PostgreSQL terminal from the project folder.

```sh
docker compose exec postgres psql -U lab -d lab
```

List the 15 most recent checkpoints. Each row shows the step that completed and the next step for that run.

```sql
SELECT thread_id AS run_id, version AS step, node_name,
       state->>'Next' AS next_step, timestamp
FROM langgraph_checkpoints
ORDER BY timestamp DESC
LIMIT 15;
```

Copy the **Run ID** from a reply’s **State transitions** panel and replace `PASTE_RUN_ID` to inspect every saved snapshot for that turn.

```sql
SELECT version, node_name, jsonb_pretty(state) AS checkpoint
FROM langgraph_checkpoints
WHERE thread_id = 'PASTE_RUN_ID'
ORDER BY version;
```

The snapshot shows the conversation sent to Qwen3, completed tool calls and their results, any pending calls, and the next step. The Go loop keeps its working state in memory. Type `\q` to exit the PostgreSQL terminal.

The checkpoint volume stores prompts and tool outputs locally. **New chat** clears the browser view and pending retry information. Database checkpoints stay in the volume when the app or database stops. Runs saved by the earlier state-machine implementation remain in its original table. LangGraphGo starts a fresh graph run when it encounters one of those older run IDs.

## Try the MCP tools

In a new chat, select the **Check stock for LAMP-42 and MUG-17** suggestion and send it. Check the tool trace for both inventory lookups and pickup hours for the north and south warehouses. The reply should distinguish the seven available desk lamps from the out-of-stock mug.

- **No tools:** “Say hello in one sentence.”
- **Inventory:** “How many LAMP-42 desk lamps are in stock?” The demo has 7 in the north warehouse.
- **Chained tools:** “Is LAMP-42 in stock, and what are the pickup hours at its warehouse?” The model can look up the SKU, then use the returned warehouse ID to find the hours.
- **Clarification:** Ask “Can you check stock for me?” in a new chat, then give the model `MUG-17` when it asks for the SKU. The demo has 0 in the south warehouse.

Expand the tool calls under a reply to see the arguments, result, and time for each call. When Qwen3 answers directly, the reply shows **No tools called**. Arguments and results come from the current turn. Expand **Tokens** below a reply to see Ollama’s input and output counts for each model call. The summary adds the counts across the turn, so conversation history and tool results can count again when they are sent in another model request. A dash means Ollama did not report a count. The browser sends user and assistant text as history on later turns. The two tools read fixed demo data. Each turn can run up to four tool rounds and eight calls within the configured chat timeout.

### Try a three-turn conversation

Choose an engine and select **New chat**. Send these prompts in order in the same chat.

| Turn | What to send | What to look for |
| --- | --- | --- |
| 1 | “Can I pick up a desk lamp?” | The assistant asks for the SKU if it needs clarification. |
| 2 | “LAMP-42. Is it in stock, and when can I pick it up?” | It calls `lookup_inventory` and passes the returned warehouse ID to `warehouse_hours`. |
| 3 | “Can you recheck the stock now?” | It uses the earlier message to identify the SKU and calls `lookup_inventory` again to verify stock. |

Expand the tool details after each reply to check what happened. Model behavior can vary. If the last reply shows **No tools called**, try “Use the inventory tool to recheck stock for LAMP-42 now.” The stock data is fixed for this demo, so check the tool trace for evidence of a fresh lookup. Start a new chat before repeating the conversation with another engine.

## Stop the app

For a shortcut-managed session, double-click **Stop Lab.command** to stop the launcher-managed backends. For a manual TypeScript or Python session, press **Control+C** in the API and worker terminals.

- If you started the servers yourself, press **Control+C** in each terminal running `make dev-web` and `make dev-api`.
- If the servers are running in the background, use the command below to find their process IDs. Look for `node` on port 5173 (Vite) and `api` on port 8080 (Go). Run `kill` followed by the two matching PIDs. If a port has no listener, that service is already stopped.

```sh
lsof -nP -iTCP:5173 -iTCP:8080 -sTCP:LISTEN
```

Press **Control+C** in the `make dev-worker` terminal to stop the Temporal worker and its MCP process. Run `make stop-temporal` to stop the local Temporal server and retain its history. Stopping the Go API also stops its MCP child process. Run `make stop-db` to stop the database while retaining its checkpoints. You can leave Ollama running for other apps. To stop it too, choose **Quit Ollama** from the macOS menu bar, or press **Control+C** in the terminal running `ollama serve`.

## Configuration

Export these variables in the terminal that starts the corresponding service.

| Variable | Default | Used by |
| --- | --- | --- |
| `PY_API_PORT` | `8082` | Python listener |
| `PY_API_PROXY_TARGET` | `http://127.0.0.1:8082` | Vite Python proxy |
| `PY_CHAT_TIMEOUT_SECONDS` | `180` | Python chat request deadline |
| `TS_API_PORT` | `8081` | TypeScript listener |
| `TS_API_PROXY_TARGET` | `http://127.0.0.1:8081` | Vite TypeScript proxy |
| `TS_CHAT_TIMEOUT_MS` | `180000` | TypeScript chat request deadline |
| `API_ADDR` | `127.0.0.1:8080` | Go listener |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | All model clients |
| `OLLAMA_MODEL` | `qwen3:14b` | All model clients |
| `DATABASE_URL` | `postgres://lab:lab@127.0.0.1:54329/lab?sslmode=disable&connect_timeout=3` | State-machine checkpoints |
| `TEMPORAL_ADDR` | `127.0.0.1:7233` | API and Temporal worker |
| `LOG_LEVEL` | `INFO` | Go process logging threshold |
| `CHAT_TIMEOUT` | `3m` | Go chat request deadline |
| `API_PROXY_TARGET` | `http://127.0.0.1:8080` | Vite dev and preview proxy |

For example, run `API_ADDR=127.0.0.1:8090 make dev-api` and `API_PROXY_TARGET=http://127.0.0.1:8090 make dev-web`.

## JSON logging and correlation IDs

In the app, open **API reference** to browse the OpenAPI contract and send a test request. Open **MCP tools** to inspect the live tool list and input schemas. From a chat reply, select **View logs** to filter the **Logs** view to that turn’s correlation ID. You can also filter by date, service, and level. Log timestamps and date filtering use the browser’s local time zone.

The viewer shows up to 500 recent backend events and 100 browser events from the current tab. The API, MCP child processes, and Temporal worker keep bounded log files in `.lab/logs`. Set `LAB_LOG_DIR` to the same directory for the API and worker if you customize the location.

Each browser request sends an `X-Correlation-ID` header. All four APIs accept IDs containing 16–64 letters, digits, underscores, or hyphens, generate a replacement when needed, and echo the accepted ID even on error responses. A reply shows its correlation ID under the assistant text. The browser reuses the ID when it resumes a saved turn.

App logs use one JSON object per line, with `time`, `level`, `service`, `component`, `msg`, and `correlation_id` for request-scoped events. Specific events add fields such as `engine`, `tool`, `status`, `duration_ms`, and `workflow_id`. Open the browser’s Developer Tools console for web logs. The APIs, workers, and MCP processes write application logs to stderr. TypeScript and Python events include a `backend` field and language-specific service names such as `api-typescript`, `mcp-python`, and `temporal-worker-python`. The app logs operational metadata and leaves prompts, response text, tool arguments and results out of the logs.

For example, start the API and worker in separate terminals. Use `tee` if you want to search both streams after a run.

```sh
make dev-api 2>&1 | tee api.log
```

```sh
make dev-worker 2>&1 | tee worker.log
```

Copy the correlation ID from the chat and search the saved logs.

```sh
rg -F 'PASTE_CORRELATION_ID' api.log worker.log
```

You can also supply a known ID from an API client.

```sh
curl -i -H 'X-Correlation-ID: logging-demo-0001' http://127.0.0.1:8080/api/ready
```

### Reuse the logging template

- **Browser:** Import `correlatedFetch` from `apps/web/src/telemetry.ts` for same-origin API calls. It adds the header and records the request outcome.
- **Go service:** Call `telemetry.Configure("service-name", os.Stderr)` when the process starts, or pass a writer that also creates a local copy. Wrap HTTP routes with `telemetry.HTTP(mux)`, then use `telemetry.Logger(ctx, "component").Info("event.name", "field", value)` in handlers and adapters. Use the request context for downstream calls.
- **MCP:** Send `telemetry.MCPMeta(ctx)` in the request’s metadata and register `telemetry.MCPServer` as receiving middleware. The tool’s business arguments stay separate from request metadata.
- **Temporal:** Register `telemetry.TemporalPropagation{}` in the API and worker clients. Temporal stores the correlation ID in workflow and activity headers, so activity logs retain it after replay or a worker restart. An existing workflow keeps the ID from the request that started it.
- **Ollama and PostgreSQL:** The Ollama adapter forwards the HTTP header, and the checkpoint adapter logs database operations with the ID. Ollama and PostgreSQL manage their own service logs independently.

## OpenAPI contract

All four APIs serve the same [OpenAPI 3.1 contract](apps/api/internal/httpapi/contract/openapi.yaml). It covers chat, health, models, MCP discovery, logs, database inspection, and jobs. The **API reference** panel sends its test requests to the selected backend.

- Go serves the spec at [port 8080](http://127.0.0.1:8080/api/openapi.yaml). Its routes and transport models are generated from the YAML.
- TypeScript serves the same YAML at [port 8081](http://127.0.0.1:8081/api/openapi.yaml), with a Vite proxy at `/typescript/api/openapi.yaml`. It implements the routes in TypeScript and validates JSON bodies with Zod.
- Java serves the same YAML at [port 8083](http://127.0.0.1:8083/api/openapi.yaml). Vite proxies it at `/java/api/openapi.yaml`.
- Python serves the same YAML at [port 8082](http://127.0.0.1:8082/api/openapi.yaml), with a Vite proxy at `/python/api/openapi.yaml`. FastAPI handles the routes and Pydantic validates JSON bodies.

Edit the YAML first when changing the HTTP contract. Run `make generate-api` to refresh the Go bindings, then update the TypeScript, Python, and Java handlers and validation for any affected contract behavior.

## Health checks and tests

```sh
curl -fsS http://127.0.0.1:8080/api/health
curl -fsS http://127.0.0.1:8080/api/ready
curl -fsS http://127.0.0.1:8080/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Reply with exactly one word: maple."}]}'
make test
make build
```

- `GET /api/health` checks the selected API process. `GET /api/ready` checks Ollama, the configured model, and MCP tool discovery, returning HTTP 503 when one of those dependencies is unavailable. The state-machine chat request checks PostgreSQL when opening a run.
- `POST /api/chat` accepts alternating user and assistant messages ending with a user message. Set `"engine":"state-machine"` in the request to use the state machine. Use `"engine":"temporal"` for Temporal. The default is `"engine":"loop"`. The response includes `engine` and `message`, plus a `tools` array when calls were made and a `states` array for the state machine. The request is limited to 512 KiB and 41 messages, with an 8,000-byte limit per user message.
- `make test` runs the Go tests and integration tests for TypeScript and Python. These check the served spec, a chained tool call through the MCP child, token counts, and correlation IDs with simulated Ollama responses. Streaming checks cover UTF-8 decoding, incomplete responses, cancellation, preview limits, and clearing drafts on retry. The web tests cover worker status, stale poller identities, and which requests can change launcher state. `make build` compiles Go, type-checks TypeScript, compiles the Python modules, and bundles the frontend. Run `make install install-py` before these checks. Run `npm run preview --workspace apps/web` to serve the built frontend locally on port 4173 with the Go API running.

### Run the recovery integration tests

Start Docker Desktop, then run `make install install-py`, `make build-java`, and `make test-integration`. The suite tests Go, TypeScript, and Python, plus Java when the Java build is present. It simulates an Ollama failure after a real MCP call, restarts the API, verifies checkpoint recovery, and checks that the same Temporal job completes after its worker starts. It also checks duplicate submissions, rejected conflicting input, and correlated worker and MCP logs. For every backend, streamed Temporal tests disconnect and reattach a queued chat, kill the worker after draft text appears, and verify the replacement retries only the unfinished model activity. Java unit tests run during `make build-java`.

The suite uses a simulated Ollama server and disposable PostgreSQL and Temporal containers. Docker assigns separate ports, and the suite removes its test project and volumes at the end. GitHub Actions runs the same suite.

## Repository layout

- `apps/web` contains the shared chat interface and Vite proxies.
- `apps/api-java` contains the Java API, MCP server, Temporal worker, and Restate approval service.
- `apps/api-py/workflow_lab` contains the Python API, MCP server, and workflow worker.
- `apps/api-ts/src` contains the TypeScript API, MCP server, and workflow worker.
- `apps/api/cmd/api` starts the Go service and wires its dependencies.
- `apps/api/internal` contains configuration, HTTP handlers, the Ollama adapter, the three orchestration engines, and the inventory MCP server.

The chat displays the complete reply and tool trace at the end of each turn. A shared conversation history across browser sessions is future work.

[Official Go MCP SDK](https://github.com/modelcontextprotocol/go-sdk) · [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling) · [Temporal Go SDK walkthrough](https://learn.temporal.io/getting_started/go/first_program_in_go/)
