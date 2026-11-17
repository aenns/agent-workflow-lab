package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"agent-workflow-lab/apps/api/internal/agent"
	"agent-workflow-lab/apps/api/internal/httpapi/contract"
)

type JobService interface {
	StartJob(context.Context, string, string, string) (agent.Job, error)
	ListJobs(context.Context) ([]agent.Job, error)
	GetJob(context.Context, string) (agent.Job, error)
}

func (s server) PostJob(w http.ResponseWriter, r *http.Request, _ contract.PostJobParams) {
	var input contract.JobRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	if err := decoder.Decode(&input); err != nil {
		jobBodyError(w, err)
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		jobBodyError(w, err)
		return
	}
	input.Prompt = strings.TrimSpace(input.Prompt)
	if input.Prompt == "" || len(input.Prompt) > 8000 {
		fail(w, http.StatusBadRequest, "Enter a prompt containing 1–8,000 bytes of text.")
		return
	}
	key := rand.Text()
	if input.Key != nil {
		key = *input.Key
	}
	if !runIDPattern.MatchString(key) {
		fail(w, http.StatusBadRequest, "Job key must contain 16–64 letters, digits, underscores or hyphens.")
		return
	}
	var model string
	if input.Model != nil {
		model = *input.Model
	}
	if !s.checkModel(w, r, model) {
		return
	}
	if s.diagnostics.Jobs == nil {
		jobError(w, agent.ErrTemporal)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	job, err := s.diagnostics.Jobs.StartJob(ctx, key, input.Prompt, model)
	if err != nil {
		jobError(w, err)
		return
	}
	w.Header().Set("Location", "/api/jobs/"+job.ID)
	writeJSON(w, http.StatusAccepted, toAPIJob(job))
}

func (s server) ListJobs(w http.ResponseWriter, r *http.Request, _ contract.ListJobsParams) {
	if s.diagnostics.Jobs == nil {
		jobError(w, agent.ErrTemporal)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	jobs, err := s.diagnostics.Jobs.ListJobs(ctx)
	if err != nil {
		jobError(w, err)
		return
	}
	result := make([]contract.Job, 0, len(jobs))
	for _, job := range jobs {
		result = append(result, toAPIJob(job))
	}
	writeJSON(w, http.StatusOK, result)
}

func (s server) GetJob(w http.ResponseWriter, r *http.Request, id string, _ contract.GetJobParams) {
	key, ok := strings.CutPrefix(id, agent.JobPrefix)
	if !ok || !runIDPattern.MatchString(key) {
		jobError(w, agent.ErrJobNotFound)
		return
	}
	if s.diagnostics.Jobs == nil {
		jobError(w, agent.ErrTemporal)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	job, err := s.diagnostics.Jobs.GetJob(ctx, id)
	if err != nil {
		jobError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toAPIJob(job))
}

func jobError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, agent.ErrJobNotFound):
		fail(w, http.StatusNotFound, "Inventory job not found.")
	case errors.Is(err, agent.ErrRunInput):
		fail(w, http.StatusConflict, "That job key belongs to a different prompt or model.")
	default:
		fail(w, http.StatusServiceUnavailable, "Background jobs are unavailable. Start the Temporal server.")
	}
}

func jobBodyError(w http.ResponseWriter, err error) {
	var limit *http.MaxBytesError
	if errors.As(err, &limit) {
		fail(w, http.StatusRequestEntityTooLarge, "The job request exceeds 64 KiB.")
		return
	}
	fail(w, http.StatusBadRequest, "Expected one JSON object containing the job prompt.")
}

func toAPIJob(job agent.Job) contract.Job {
	body := contract.Job{
		Id: job.ID, Prompt: job.Prompt, Status: contract.JobStatus(job.Status),
		StartedAt: job.StartedAt, FinishedAt: job.FinishedAt,
	}
	if job.Model != "" {
		body.Model = &job.Model
	}
	if job.CorrelationID != "" {
		body.CorrelationId = &job.CorrelationID
	}
	if job.Reply != nil {
		reply := toAPIReply(*job.Reply)
		body.Report = &reply
	}
	return body
}
