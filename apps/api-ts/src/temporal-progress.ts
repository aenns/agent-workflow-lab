import { Context } from '@temporalio/activity';
import type { ChatEvent, Emit } from '../../../packages/chat-stream.ts';

// Heartbeats keep only the latest preview in Temporal's mutable activity state.
// No workflow signal, timer, or token-sized history event is introduced.
export function activityProgress() {
  const context = Context.current();
  let snapshot = { version: 1, type: 'model', text: '', name: '', truncated: false,
    activityId: context.info.activityId, attempt: context.info.attempt };
  let sent = 0;
  const beat = () => { context.heartbeat({ ...snapshot }); sent = Date.now(); };
  const timer = setInterval(beat, 2000);
  const emit: Emit = async (event) => {
    if (event.type === 'model-start') snapshot = { ...snapshot, type: 'model', text: '', truncated: false };
    else if (event.type === 'text') {
      const text = snapshot.text + event.text;
      snapshot = { ...snapshot, text: text.slice(0, 16000), truncated: snapshot.truncated || text.length > 16000 };
      if (Date.now() - sent < 400) return;
    } else if (event.type === 'tool-start' || event.type === 'tool-complete') {
      snapshot = { ...snapshot, type: event.type, name: event.name, text: '' };
    } else return;
    beat();
  };
  return { emit, close: () => clearInterval(timer) };
}

export function progressEvent(value: unknown): ChatEvent | undefined {
  const snapshot = value as Record<string, unknown> | null;
  if (snapshot?.version !== 1) return;
  if (snapshot.type === 'model' && typeof snapshot.text === 'string') return {
    type: 'model-snapshot', text: snapshot.text, activityId: String(snapshot.activityId),
    attempt: Number(snapshot.attempt), truncated: snapshot.truncated === true,
  };
  if ((snapshot.type === 'tool-start' || snapshot.type === 'tool-complete') && typeof snapshot.name === 'string') {
    return { type: snapshot.type, name: snapshot.name };
  }
}
