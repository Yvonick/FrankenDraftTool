import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { roomStream, ROOM_UPDATE_INTERVAL_MS } from '../services/sites/room-stream.mjs';

function fixture() {
  let revision = 1;
  const calls = { versions: 0, snapshots: 0 };
  const store = { async roomRevision() { calls.versions++; return revision; } };
  const snapshot = async request => {
    calls.snapshots++;
    assert.equal(request.headers.get('x-franken-session'), 'test-secret');
    if (calls.snapshots > 1) assert.equal(new URL(request.url).searchParams.get('observe'), '1');
    return Response.json({ room: { roomNumber: '123456', revision: `${revision}:player` }, viewer: { id: 'player' } });
  };
  const abort = new AbortController();
  const request = new Request('https://draft.test/api/rooms/123456/presence', {
    headers: { 'x-franken-session': 'test-secret' }, signal: abort.signal
  });
  return { calls, store, snapshot, abort, request, change() { revision++; } };
}

test('idle streams only check the small revision row; changed rooms push a snapshot', async () => {
  assert.equal(ROOM_UPDATE_INTERVAL_MS, 250);
  const f = fixture();
  const response = await roomStream(f.request, f.store, f.snapshot, { intervalMs: 10, lifetimeMs: 1000 });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  try {
    assert.match(new TextDecoder().decode((await reader.read()).value), /1:player/);
    await sleep(45);
    assert.ok(f.calls.versions >= 2);
    assert.equal(f.calls.snapshots, 1, 'idle ticks must not decompress the room or load the pool');
    f.change();
    assert.match(new TextDecoder().decode((await reader.read()).value), /2:player/);
    assert.equal(f.calls.snapshots, 2);
  } finally { await reader.cancel(); }
  const closedCalls = f.calls.versions;
  await sleep(35);
  assert.equal(f.calls.versions, closedCalls, 'closing the reader stops database polling');
});

test('slow readers do not accumulate snapshots; abort releases the stream', async () => {
  const f = fixture();
  const response = await roomStream(f.request, f.store, f.snapshot, { intervalMs: 10, lifetimeMs: 1000 });
  const reader = response.body.getReader();
  f.change();
  await sleep(40);
  assert.equal(f.calls.versions, 0, 'the initial queued snapshot applies backpressure');
  await reader.read();
  await reader.read();
  f.abort.abort();
  assert.equal((await reader.read()).done, true);
  const closedCalls = f.calls.versions;
  await sleep(30);
  assert.equal(f.calls.versions, closedCalls);
});

test('streams refresh presence and end normally for bounded automatic renewal', async () => {
  const f = fixture();
  const response = await roomStream(f.request, f.store, f.snapshot, { intervalMs: 10, lifetimeMs: 60, presenceIntervalMs: 20 });
  const text = await response.text();
  assert.match(text, /event: room/);
  assert.match(text, /: heartbeat/);
  assert.ok(f.calls.snapshots >= 2);
  const closedCalls = f.calls.versions;
  await sleep(30);
  assert.equal(f.calls.versions, closedCalls);
});

test('failed authentication never opens a stream or polls storage', async () => {
  const f = fixture();
  const response = await roomStream(f.request, f.store, async () => Response.json({ error: 'forbidden' }, { status: 403 }));
  assert.equal(response.status, 403);
  assert.equal(f.calls.versions, 0);
});
