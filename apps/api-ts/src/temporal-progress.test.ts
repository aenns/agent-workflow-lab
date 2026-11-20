import assert from 'node:assert/strict';
import { test } from 'node:test';
import { progressEvent } from './temporal-progress.ts';

test('heartbeat previews preserve retry identity and empty draft resets', () => {
  assert.equal(progressEvent({ version: 0, type: 'model' }), undefined);
  assert.deepEqual(progressEvent({ version: 1, type: 'model', text: '',
    activityId: 'model-3', attempt: 2, truncated: false }), {
    type: 'model-snapshot', text: '', activityId: 'model-3', attempt: 2, truncated: false,
  });
  assert.deepEqual(progressEvent({ version: 1, type: 'tool-start', name: 'lookup_inventory' }), {
    type: 'tool-start', name: 'lookup_inventory',
  });
});
