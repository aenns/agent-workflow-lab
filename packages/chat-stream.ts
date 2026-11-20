// Both Ollama and the lab API send one JSON object per newline.
// A network chunk can contain half a UTF-8 character or several records.
export async function* jsonLines(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done) break;
      if (pending.length > 2 * 1024 * 1024) throw new Error('Streaming record exceeded the size limit.');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) yield JSON.parse(line);
    }
    if (pending.trim()) yield JSON.parse(pending);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export type ChatEvent =
  | { type: 'model-start' }
  | { type: 'model-snapshot'; text: string; activityId: string; attempt: number; truncated: boolean }
  | { type: 'status'; message: string }
  | { type: 'text'; text: string }
  | { type: 'tool-start'; name: string }
  | { type: 'tool-complete'; name: string }
  | { type: 'complete'; reply: unknown }
  | { type: 'error'; error: string };
export type Emit = (event: ChatEvent) => Promise<void>;
