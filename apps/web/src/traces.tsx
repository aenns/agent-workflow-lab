export type ToolEvent = {
  name: string;
  arguments: unknown;
  result: string;
  isError: boolean;
  durationMs: number;
};

export type TokenUsage = { inputTokens?: number; outputTokens?: number };

export function TokenTrace({ calls }: { calls: TokenUsage[] }) {
  const format = (count?: number) => count === undefined ? '—' : count.toLocaleString();
  const total = (key: keyof TokenUsage) => calls.every((call) => call[key] !== undefined)
    ? calls.reduce((sum, call) => sum + (call[key] ?? 0), 0)
    : undefined;
  return <details className="tool-trace">
    <summary>Tokens · {format(total('inputTokens'))} input · {format(total('outputTokens'))} output</summary>
    <table className="token-table">
      <caption>{calls.length} model {calls.length === 1 ? 'call' : 'calls'}. A dash means Ollama did not report the count.</caption>
      <thead><tr><th scope="col">Call</th><th scope="col">Input</th><th scope="col">Output</th></tr></thead>
      <tbody>{calls.map((call, index) => <tr key={index}>
        <th scope="row">{index + 1}</th><td>{format(call.inputTokens)}</td><td>{format(call.outputTokens)}</td>
      </tr>)}</tbody>
    </table>
  </details>;
}

export function ToolTrace({ tools }: { tools: ToolEvent[] }) {
  return (
    <details className="tool-trace">
      <summary>{tools.length} tool {tools.length === 1 ? 'call' : 'calls'}</summary>
      <ol>
        {tools.map((tool, index) => (
          <li key={index}>
            <strong>{tool.name || 'Unknown tool'}</strong>
            <span> · {tool.isError ? 'Error' : 'Completed'} · {tool.durationMs} ms</span>
            <dl>
              <dt>Arguments</dt>
              <dd><pre>{JSON.stringify(tool.arguments, null, 2)}</pre></dd>
              <dt>Result</dt>
              <dd><pre>{tool.result}</pre></dd>
            </dl>
          </li>
        ))}
      </ol>
    </details>
  );
}
