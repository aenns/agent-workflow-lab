package telemetry

import (
	"context"

	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/workflow"
)

// TemporalPropagation uses SDK headers to carry the ID from the API into
// workflow history and from workflow history into each activity context.
type TemporalPropagation struct{}

func (TemporalPropagation) Inject(ctx context.Context, header workflow.HeaderWriter) error {
	return writeTemporalID(header, Correlation(ctx))
}

func (TemporalPropagation) Extract(ctx context.Context, header workflow.HeaderReader) (context.Context, error) {
	id, err := readTemporalID(header)
	return WithCorrelation(ctx, id), err
}

func (TemporalPropagation) InjectFromWorkflow(ctx workflow.Context, header workflow.HeaderWriter) error {
	return writeTemporalID(header, WorkflowCorrelation(ctx))
}

func (TemporalPropagation) ExtractToWorkflow(ctx workflow.Context, header workflow.HeaderReader) (workflow.Context, error) {
	id, err := readTemporalID(header)
	if validID.MatchString(id) {
		ctx = workflow.WithValue(ctx, correlationKey{}, id)
	}
	return ctx, err
}

func WorkflowCorrelation(ctx workflow.Context) string {
	id, _ := ctx.Value(correlationKey{}).(string)
	return id
}

func writeTemporalID(header workflow.HeaderWriter, id string) error {
	if id == "" {
		return nil
	}
	payload, err := converter.GetDefaultDataConverter().ToPayload(id)
	if err == nil {
		header.Set(CorrelationField, payload)
	}
	return err
}

func readTemporalID(header workflow.HeaderReader) (string, error) {
	var id string
	if payload, ok := header.Get(CorrelationField); ok {
		err := converter.GetDefaultDataConverter().FromPayload(payload, &id)
		return id, err
	}
	return "", nil
}
