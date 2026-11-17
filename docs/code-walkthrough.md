# Follow a chat turn through the code

## From React to the API

Start in [main.tsx](../apps/web/src/main.tsx). The `App` component keeps the prompt, selected engine, and chat transcript in React state. On submit, `send` builds an array with the previous messages and the new user message, then sends it to `POST /api/chat`. It keeps run details, such as token counts, separate from the messages sent back on the next turn.

The [HTTP handler](../apps/api/internal/httpapi/server.go) decodes the request, validates the conversation, and calls `Agent.Reply`. The [OpenAPI YAML](../apps/api/internal/httpapi/contract/openapi.yaml) defines the public routes and JSON types. Run `make generate-api` after editing the contract. The [transport adapter](../apps/api/internal/httpapi/transport.go) converts between those generated types and the types used inside the agent.

## How the model uses a tool

In [agent.go](../apps/api/internal/agent/agent.go), the agent discovers tools and their input schemas through MCP. It passes those schemas and a conversation transcript to Ollama. A model response can contain a final answer or one or more proposed tool calls. The agent checks that each tool was advertised, sends its arguments to MCP, and appends the result to the transcript. The model then gets another request and can use the result in its answer or ask for another tool.

The [MCP server](../apps/api/internal/mcptools/server.go) is a child process with two read-only tools backed by demo data. The Go SDK uses the tool arguments' struct tags to help describe their input schemas. The tool responses contain inventory facts, which the model uses to write the answer.

## Where progress lives

| Engine | Where to read | What happens on interruption |
| --- | --- | --- |
| Go loop | [agent.go](../apps/api/internal/agent/agent.go), `runLoop` | The working transcript lives in memory for the current request. Restarting the API loses that in-progress turn. |
| State machine | [state_machine.go](../apps/api/internal/agent/state_machine.go) | The PostgreSQL checkpoint holds the transcript, completed tool results, and the next graph node. Resubmitting the same run ID and messages reloads that checkpoint. |
| Temporal | [temporal.go](../apps/api/internal/agent/temporal.go) | A worker executes Ollama and MCP calls as activities. Temporal records completed activity results, which a replacement worker uses during replay. An activity interrupted before completion was recorded can run again. |

## How a background job finishes

In the chat, **Run in background** posts a standalone prompt to `POST /api/jobs`. The API returns HTTP 202 when Temporal accepts the workflow. The worker still needs to pick it up and finish it. The [job service](../apps/api/internal/agent/jobs.go) lists audits from Temporal and retrieves the report for a completed workflow.

[The Jobs view](../apps/web/src/jobs.tsx) periodically fetches job summaries. It uses browser storage to remember which finished jobs you’ve opened. Temporal holds the job status and report, so closing the browser doesn’t cancel the work.

## Tracing a turn

The browser sends a correlation ID through [the TypeScript request helper](../apps/web/src/telemetry.ts). The [Go telemetry package](../apps/api/internal/telemetry/log.go) places it in the request context. MCP carries it in request metadata and Temporal carries it in workflow and activity headers. Use **View logs** under a chat reply or job report to see the events for that ID.
