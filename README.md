# Local AI Agent & MCP Workflow Lab

The lab compares three ways to run the same AI chat turn. The Go loop runs in memory, LangGraphGo saves graph checkpoints to PostgreSQL, and Temporal saves workflow history and gives work to a separate worker. All three use the same React chat, Ollama model, and Go MCP inventory server.

## Demo walkthrough

Use the [quick start](#quick-start) to send an inventory question and inspect the MCP calls. Then try the [Temporal worker restart demo](#demo-worker-downtime) to see the same background job wait while the worker is offline, complete when it returns, and surface an in-app notification. The report shows the tool results, model, token counts, and correlated logs.

## macOS shortcuts

In Finder, open the project folder and double-click **Start Lab.command**. It opens Docker Desktop and Ollama if needed, starts PostgreSQL, Temporal, the Go API, the worker, and the web app, then opens the lab in Chrome. Install the prerequisites below and pull the model once before using the shortcut. Leave the launcher Terminal window open while the lab runs.

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

## Compare Ollama models

The **Model** picker lists installed tags. Select **Add models** to search the public Ollama Library or enter an exact tag such as `qwen3.5:9b`. Click **Install** to download the model to local Ollama. The progress bar reports the current layer, and the app refreshes the picker and selects the new model when it supports tools. Downloads can continue as you switch views within the lab. Keep the tab open during installation.

Search uses the public Ollama Library website and verifies tags against the Ollama registry. Only tags with downloadable model weights are offered. If search is unavailable, paste a library tag into **Install by tag**. The app accepts public library tags such as `qwen3.5:9b`. The picker hides models that explicitly report they lack tool support. Some Ollama versions omit capability information, so test an unfamiliar model with an MCP prompt.

Choose a model before sending a message or starting a background audit. The reply, job report, and correlated Ollama call logs show the selected model. The **Configured default** uses `OLLAMA_MODEL`. New durable runs save the resolved model with their state. Changing the picker for a pending chat turn starts a new run.

## How the pieces fit together

```mermaid
flowchart LR
    UI["React workspace"] --> API["Go API"]
    API --> O["Ollama and Qwen3"]
    API --> MCP["Inventory MCP server"]
    API --> DB["PostgreSQL checkpoints"]
    API --> T["Temporal server"]
    T <--> W["Go worker"]
    W --> O
    W --> WMCP["Worker's inventory MCP server"]
```

See the [code walkthrough](docs/code-walkthrough.md) for the path from the chat form to the model, the tools, and the final reply.

## Compare the engines

1. Select **Go loop** and ask “Is LAMP-42 in stock, and what are the pickup hours at its warehouse?” Expand the tool calls to see their arguments and results.
2. Select **New chat** to clear the conversation, choose **State machine**, and ask the same question.
3. Expand the tool calls and **State transitions** on the state-machine reply.
4. Start a new chat, choose **Temporal**, and send the same question. Expand the tool calls and use the reply’s **Workflow ID** to find its history in the [Temporal UI](http://127.0.0.1:8233).

The Go loop calls the model, runs any requested tools, and repeats until the model answers. The state-machine engine uses [LangGraphGo](https://github.com/smallnest/langgraphgo) to schedule two graph nodes, one for Ollama and one for the next MCP tool call. A two-step tool request typically visits **Ask model → Run tools → Ask model → Run tools → Ask model → Complete**. All three engines share the same tools and limits. The Go loop keeps its working state in memory. The state machine uses PostgreSQL checkpoints. Reply wording and tool selection can vary across model runs.

## Temporal workflow and worker restart

Start the Temporal server with `make dev-temporal`. Start or restart the separate Go worker with `make dev-worker`. The worker polls the `workflow-lab-chat` task queue and owns its MCP child process. Leave the API and web app running so the browser can receive the final reply.

1. Select **Temporal** in a new chat and ask “Use the inventory tool to look up LAMP-42, then use the warehouse-hours tool to check pickup hours for the warehouse it returns.”
2. In the [Temporal UI](http://127.0.0.1:8233), open the active `InventoryChat` workflow. Its history shows `DiscoverMCPTools`, `AskOllama`, and `CallMCPTool` activities. Tool activity IDs include the tool name.
3. For a mid-run restart, watch for the completion of `tool-1-1-lookup_inventory`. Press **Control+C** in the worker terminal while the workflow is still running, then run `make dev-worker` again.
4. Verify the finished reply and history. A completed activity result is available during replay. An activity interrupted before Temporal recorded completion may retry. If the browser timed out or was reloaded, select **Resume saved run** to reconnect to the same workflow.

The local Temporal server stores workflow history, including prompts and activity results, in a SQLite file on a Docker volume. The request timeout controls how long the API waits for a reply. Temporal can continue running after the browser disconnects, within its own execution deadline.

## Run a background inventory audit

Start the Temporal server and worker with `make dev-temporal` and `make dev-worker`. Keep the API and web app running. In **Chat**, enter “Check stock and pickup options for LAMP-42 and MUG-17 this week.” Select **Run in background**. The prompt is submitted as a standalone Temporal job and the **Jobs** view opens right away.

Switch views or close the browser tab while the job runs. When you open the lab again, the **Jobs** badge and in-app banner show jobs that finished while you were away. Open a completed job to see its report, tool calls, token usage, and correlated logs. Opening a finished job acknowledges its notification in that browser. Temporal stores the jobs and reports, and the list shows up to 50 recent jobs.

### Demo worker downtime

Use the background audit prompt above for this walkthrough.

1. Keep the Temporal server, API, and web app running. Press **Control+C** in the worker terminal.
2. Submit the audit with **Run in background**. The Jobs view should show **Queued or running** while the worker is offline.
3. Run `make dev-worker` again. The same job should finish and show an in-app completion notification.
4. Open the report. The fixture has seven LAMP-42 lamps at the north warehouse and zero MUG-17 mugs. Expand the trace to inspect the inventory and warehouse-hours calls.

The audit uses fixed inventory and warehouse-hours data.

## Checkpoint and resume

LangGraphGo automatically writes a PostgreSQL checkpoint after every successful model or tool node. A checkpoint includes the next node, the model transcript, completed tool results, and any remaining calls in the batch. The app stops the run if the library’s checkpointer reports an error.

If the API stops mid-turn, restart it, then select **Resume saved run** in the same browser tab. The tab remembers the run ID and request text even after a reload. For API clients, send the same `runId` and original messages again. Reusing a completed run ID returns the saved reply. An interrupted operation can run again if the process stopped before its checkpoint committed.

### Inspect checkpoints in PostgreSQL

Open **Database** in the lab to run saved queries for recent runs, checkpoint history, tool results, per-call token usage, and the latest JSON state. Select a run ID in the results to load it into the history query, or choose **Inspect checkpoints** under a state-machine reply. **View SQL** shows the statement the app will execute. Queries for a single run accept a Run ID. The server only executes saved read-only queries.

The Database view covers LangGraphGo’s PostgreSQL storage. Temporal job reports appear in **Jobs**, and Temporal execution history is available in the [Temporal UI](http://127.0.0.1:8233).

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
| `API_ADDR` | `127.0.0.1:8080` | Go listener |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Go model client |
| `OLLAMA_MODEL` | `qwen3:14b` | Go model client |
| `DATABASE_URL` | `postgres://lab:lab@127.0.0.1:54329/lab?sslmode=disable&connect_timeout=3` | State-machine checkpoints |
| `TEMPORAL_ADDR` | `127.0.0.1:7233` | API and Temporal worker |
| `LOG_LEVEL` | `INFO` | Go process logging threshold |
| `CHAT_TIMEOUT` | `3m` | Go chat request deadline |
| `API_PROXY_TARGET` | `http://127.0.0.1:8080` | Vite dev and preview proxy |

For example, run `API_ADDR=127.0.0.1:8090 make dev-api` and `API_PROXY_TARGET=http://127.0.0.1:8090 make dev-web`.

## JSON logging and correlation IDs

In the app, open **API reference** to browse the OpenAPI contract and send a test request. Open **MCP tools** to inspect the live tool list and input schemas. From a chat reply, select **View logs** to filter the **Logs** view to that turn’s correlation ID. You can also filter by date, service, and level. Log timestamps and date filtering use the browser’s local time zone.

The viewer shows up to 500 recent backend events and 100 browser events from the current tab. The API, MCP child processes, and Temporal worker keep bounded log files in `.lab/logs`. Set `LAB_LOG_DIR` to the same directory for the API and worker if you customize the location.

Each browser request sends an `X-Correlation-ID` header. The Go API accepts IDs containing 16–64 letters, digits, underscores, or hyphens, generates a replacement when needed, and echoes the accepted ID even on error responses. A reply shows its correlation ID under the assistant text. The browser reuses the ID when it resumes a saved turn.

App logs use one JSON object per line, with `time`, `level`, `service`, `component`, `msg`, and `correlation_id` for request-scoped events. Specific events add fields such as `engine`, `tool`, `status`, `duration_ms`, and `workflow_id`. Open the browser’s Developer Tools console for web logs. The Go API, worker, and MCP process write their logs to stderr. The app logs operational metadata and leaves prompts, response text, tool arguments and results out of the logs.

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

The [OpenAPI 3.1 contract](apps/api/internal/httpapi/contract/openapi.yaml) defines the health, readiness, and chat endpoints. It documents the three engine choices, error responses, tool traces, correlation IDs, and the run IDs used to retry durable turns. With the API running, open [the served specification](http://127.0.0.1:8080/api/openapi.yaml) or use the same path through Vite.

Edit `openapi.yaml` first when changing the HTTP contract. Then run `make generate-api` to regenerate the Go routes and transport models in `routes.gen.go`. The handlers enforce conversation rules such as alternating roles and UTF-8 byte limits. `make test` validates the spec and checks live handler responses against its schemas.

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

- `GET /api/health` checks the Go process. `GET /api/ready` checks Ollama, the configured model, and MCP tool discovery, returning HTTP 503 when one of those dependencies is unavailable. The state-machine chat request checks PostgreSQL when opening a run.
- `POST /api/chat` accepts alternating user and assistant messages ending with a user message. Set `"engine":"state-machine"` in the request to use the state machine. Use `"engine":"temporal"` for Temporal. The default is `"engine":"loop"`. The response includes `engine` and `message`, plus a `tools` array when calls were made and a `states` array for the state machine. The request is limited to 512 KiB and 41 messages, with an 8,000-byte limit per user message.
- `make test` exercises the HTTP contract and a two-step tool call through both engines with simulated Ollama responses and a real in-memory MCP connection. `make build` compiles Go and type-checks and bundles the frontend. Run `npm run preview --workspace apps/web` to serve the built frontend locally on port 4173 with the Go API running.

## Repository layout

- `apps/web` contains the chat interface and Vite proxy.
- `apps/api/cmd/api` starts the Go service and wires its dependencies.
- `apps/api/internal` contains configuration, HTTP handlers, the Ollama adapter, the three orchestration engines, and the inventory MCP server.

The chat displays the complete reply and tool trace at the end of each turn. A shared conversation history across browser sessions is future work.

[Official Go MCP SDK](https://github.com/modelcontextprotocol/go-sdk) · [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling) · [Temporal Go SDK walkthrough](https://learn.temporal.io/getting_started/go/first_program_in_go/)
