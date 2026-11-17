package checkpoint

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var ErrNoCheckpoints = errors.New("checkpoint table has not been created")

type SavedQuery struct {
	ID, Title, Description, SQL string
	RequiresRunID               bool
}

// Each statement is fixed in code. The browser chooses an ID and can supply
// a run ID as a bound parameter where the statement needs one.
var savedQueries = []SavedQuery{
	{ID: "recent-runs", Title: "Recent runs", Description: "Latest step, model, and tool count for each recent state-machine turn.", SQL: `WITH latest AS (
  SELECT DISTINCT ON (thread_id) thread_id, version, state, timestamp
  FROM langgraph_checkpoints
  WHERE thread_id IS NOT NULL
  ORDER BY thread_id, version DESC
)
SELECT thread_id AS run_id, version AS checkpoint_count,
       state->>'Next' AS next_step, state->'Reply'->>'model' AS model,
       jsonb_array_length(COALESCE(state->'Reply'->'tools', '[]'::jsonb)) AS tool_calls,
       timestamp AS saved_at
FROM latest
ORDER BY saved_at DESC
LIMIT 100;`},
	{ID: "run-history", Title: "Checkpoint history", Description: "The sequence of saved steps for one run.", RequiresRunID: true, SQL: `SELECT version AS step, node_name, state->>'Next' AS next_step,
       jsonb_array_length(COALESCE(state->'Reply'->'tools', '[]'::jsonb)) AS tool_calls,
       timestamp AS saved_at
FROM langgraph_checkpoints
WHERE thread_id = $1
ORDER BY version
LIMIT 100;`},
	{ID: "tool-calls", Title: "Tool calls", Description: "Tool arguments, results, and timing from the latest checkpoint in a run.", RequiresRunID: true, SQL: `WITH latest AS (
  SELECT state FROM langgraph_checkpoints
  WHERE thread_id = $1 ORDER BY version DESC LIMIT 1
)
SELECT position AS call, tool->>'name' AS tool,
       tool->'arguments' AS arguments, tool->>'result' AS result,
       (tool->>'isError')::boolean AS failed, (tool->>'durationMs')::bigint AS duration_ms
FROM latest
CROSS JOIN LATERAL jsonb_array_elements(state->'Reply'->'tools')
  WITH ORDINALITY AS calls(tool, position)
ORDER BY position;`},
	{ID: "token-usage", Title: "Token usage", Description: "Ollama input and output token counts for each recorded model call.", RequiresRunID: true, SQL: `WITH latest AS (
  SELECT state FROM langgraph_checkpoints
  WHERE thread_id = $1 ORDER BY version DESC LIMIT 1
)
SELECT position AS call, state->'Reply'->>'model' AS model,
       (usage->>'inputTokens')::bigint AS input_tokens,
       (usage->>'outputTokens')::bigint AS output_tokens
FROM latest
CROSS JOIN LATERAL jsonb_array_elements(state->'Reply'->'usage')
  WITH ORDINALITY AS counts(usage, position)
ORDER BY position;`},
	{ID: "saved-state", Title: "Latest saved state", Description: "Inspect the full JSON snapshot, including the transcript and pending tools.", RequiresRunID: true, SQL: `SELECT version AS step, timestamp AS saved_at, state
FROM langgraph_checkpoints
WHERE thread_id = $1
ORDER BY version DESC
LIMIT 1;`},
}

func InspectionQueries() []SavedQuery {
	return append([]SavedQuery(nil), savedQueries...)
}

type QueryResult struct {
	Columns []string
	Rows    [][]any
}

func (p *Postgres) Inspect(ctx context.Context, query SavedQuery, runID string) (QueryResult, error) {
	conn, err := pgx.Connect(ctx, p.URL)
	if err != nil {
		return QueryResult{}, err
	}
	session := connection{conn}
	defer session.Close()

	tx, err := conn.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return QueryResult{}, err
	}
	defer tx.Rollback(ctx)

	var args []any
	if query.RequiresRunID {
		args = append(args, runID)
	}
	rows, err := tx.Query(ctx, query.SQL, args...)
	if err != nil {
		return QueryResult{}, inspectionError(err)
	}
	defer rows.Close()

	result := QueryResult{Columns: make([]string, 0), Rows: make([][]any, 0)}
	for _, field := range rows.FieldDescriptions() {
		result.Columns = append(result.Columns, field.Name)
	}
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return QueryResult{}, err
		}
		result.Rows = append(result.Rows, values)
	}
	return result, inspectionError(rows.Err())
}

func inspectionError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "42P01" {
		return ErrNoCheckpoints
	}
	return err
}
