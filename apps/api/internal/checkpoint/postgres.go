package checkpoint

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	"agent-workflow-lab/apps/api/internal/telemetry"
	"github.com/jackc/pgx/v5"
	"github.com/smallnest/langgraphgo/graph"
	graphpg "github.com/smallnest/langgraphgo/store/postgres"
)

var ErrBusy = errors.New("a request is already running this turn")

type Store interface {
	Open(context.Context, string) (graph.CheckpointStore, func(), error)
}

type Postgres struct {
	URL         string
	initialized atomic.Bool
}

// The run lock and the library's checkpoint writes share one connection.
// Closing it releases the lock, including when the API process exits.
func (p *Postgres) Open(ctx context.Context, id string) (graph.CheckpointStore, func(), error) {
	conn, err := pgx.Connect(ctx, p.URL)
	if err != nil {
		return nil, nil, err
	}
	session := connection{conn}
	if !p.initialized.Load() {
		if err := p.init(ctx, conn); err != nil {
			session.Close()
			return nil, nil, err
		}
	}
	var acquired bool
	err = conn.QueryRow(ctx, "SELECT pg_try_advisory_lock(hashtextextended($1, 0))", id).Scan(&acquired)
	if err != nil || !acquired {
		session.Close()
		if err != nil {
			return nil, nil, err
		}
		return nil, nil, ErrBusy
	}
	telemetry.Logger(ctx, "postgres").Info("checkpoint.run.opened", "run_id", id)
	return graphpg.NewPostgresCheckpointStoreWithPool(session, "langgraph_checkpoints"), session.Close, nil
}

func (p *Postgres) init(ctx context.Context, conn *pgx.Conn) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(573829, 1)"); err != nil {
		return err
	}
	if err := graphpg.NewPostgresCheckpointStoreWithPool(transaction{tx}, "langgraph_checkpoints").InitSchema(ctx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	p.initialized.Store(true)
	return nil
}

type transaction struct{ pgx.Tx }

// Schema setup uses the caller's transaction, whose lifetime it manages.
func (transaction) Close() {}

type connection struct{ *pgx.Conn }

func (c connection) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = c.Conn.Close(ctx)
}
