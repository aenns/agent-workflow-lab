package httpapi

import (
	"agent-workflow-lab/apps/api/internal/chat"
	"agent-workflow-lab/apps/api/internal/httpapi/contract"
)

// Keep HTTP models at the edge. The agent and Temporal history use their own
// types, which can evolve separately from the public wire contract.
func toChatRequest(body contract.ChatRequest) chat.Request {
	request := chat.Request{Messages: make([]chat.Message, 0, len(body.Messages))}
	if body.Model != nil {
		request.Model = *body.Model
	}
	if body.Engine != nil {
		request.Engine = chat.Engine(*body.Engine)
	}
	if body.RunId != nil {
		request.RunID = *body.RunId
	}
	for _, message := range body.Messages {
		request.Messages = append(request.Messages, chat.Message{Role: string(message.Role), Content: message.Content})
	}
	return request
}

func toAPIReply(reply chat.Reply) contract.ChatReply {
	body := contract.ChatReply{
		Engine:  contract.Engine(reply.Engine),
		Message: contract.AssistantMessage{Role: contract.AssistantMessageRole(reply.Message.Role), Content: reply.Message.Content},
	}
	if reply.Model != "" {
		body.Model = &reply.Model
	}
	if reply.RunID != "" {
		body.RunId = &reply.RunID
	}
	if len(reply.States) > 0 {
		states := make([]contract.ChatReplyStates, 0, len(reply.States))
		for _, state := range reply.States {
			states = append(states, contract.ChatReplyStates(state))
		}
		body.States = &states
	}
	if len(reply.Usage) > 0 {
		usage := make([]contract.TokenUsage, 0, len(reply.Usage))
		for _, call := range reply.Usage {
			usage = append(usage, contract.TokenUsage{
				InputTokens: call.InputTokens, OutputTokens: call.OutputTokens,
			})
		}
		body.Usage = &usage
	}
	if len(reply.Tools) > 0 {
		tools := make([]contract.ToolEvent, 0, len(reply.Tools))
		for _, tool := range reply.Tools {
			arguments := any(tool.Arguments)
			tools = append(tools, contract.ToolEvent{
				Name: tool.Name, Arguments: &arguments, Result: tool.Result,
				IsError: tool.IsError, DurationMs: tool.DurationMS,
			})
		}
		body.Tools = &tools
	}
	return body
}
