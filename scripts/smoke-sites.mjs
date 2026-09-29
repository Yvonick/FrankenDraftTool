import assert from 'node:assert/strict';

// Explicit deployment check. Creates one unlisted room and one private test pool.
const origin = process.argv[2];
if (!origin || !/^https?:\/\//.test(origin)) throw new Error('Pass the Site URL to check.');
const token = crypto.randomUUID();
const participantId = crypto.randomUUID();
async function api(path, body) {
  const result = await fetch(new URL(path, origin), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', 'x-franken-session': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  assert.ok(result.ok, `${path}: HTTP ${result.status} ${await (!result.ok ? result.text() : '')}`);
  return result.json();
}
const page = await fetch(origin, { redirect: 'manual' });
assert.equal(page.status, 200, 'anonymous homepage must not redirect to login');
assert.match(await page.text(), /FrankenDraftTool/);
assert.equal((await api('/api/health')).renderDependency, false);
const poolJson = { ObjectStates: [{ Name: 'Bag', Nickname: `Deployment check ${crypto.randomUUID()}`, ContainedObjects: [{ Name: 'Bag', Nickname: 'Check', ContainedObjects: [{ Name: 'Custom_Tile', Nickname: 'Persistence check', GUID: 'abc123', CustomImage: { ImageURL: 'https://example.test/check.png' } }] }] }] };
const { pool } = await api('/api/pools/upload', { poolJson, savePool: false });
const room = await api('/api/rooms', {});
const base = `/api/rooms/${room.roomNumber}`;
const auth = { creatorToken: room.creatorToken, actorId: participantId, participantId };
await api(`${base}/settings`, { creatorToken: room.creatorToken, poolId: pool.id, maxSeats: 1, picksPerBag: 1, itemsPerType: { Check: 1, 'Speaker Order': 0 } });
const presence = `${base}/presence?${new URLSearchParams({ participantId, creatorToken: room.creatorToken, name: 'Deployment check', role: 'seated' })}`;
await api(presence);
const abort = new AbortController();
const streamResponse = await fetch(new URL(`${presence}&observe=1`, origin), {
  headers: { accept: 'text/event-stream', 'x-franken-session': token },
  signal: AbortSignal.any([abort.signal, AbortSignal.timeout(35000)])
});
assert.equal(streamResponse.status, 200);
assert.match(streamResponse.headers.get('content-type'), /text\/event-stream/);
const reader = streamResponse.body.getReader();
const decoder = new TextDecoder();
let buffered = '';
async function nextSnapshot() {
  for (;;) {
    const boundary = buffered.indexOf('\n\n');
    if (boundary >= 0) {
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const data = frame.split('\n').find(line => line.startsWith('data: '));
      if (data) return JSON.parse(data.slice(6));
      continue;
    }
    const chunk = await reader.read();
    assert.equal(chunk.done, false, 'stream ended before a room update arrived');
    buffered += decoder.decode(chunk.value, { stream: true });
  }
}
let streamUpdateMs;
try {
  assert.equal((await nextSnapshot()).room.draft.status, 'not_started');
  const before = performance.now();
  const started = await api(`${base}/draft/start`, auth);
  const update = await nextSnapshot();
  streamUpdateMs = Math.round(performance.now() - before);
  assert.equal(update.room.draft.status, 'active');
  assert.equal(update.room.revision, started.revision);
  // Verify the stream stays healthy through presence refresh, then ends for renewal.
  while (!(await reader.read()).done) { /* Drain keepalives until normal EOF. */ }
} finally { abort.abort(); await reader.cancel().catch(() => {}); }
const view = await api(presence);
const bag = view.room.draft.currentPlayer.currentBag;
await api(`${base}/draft/pick`, { playerId: participantId, bagId: bag.id, itemIds: [bag.items[0].id] });
assert.equal((await api(presence)).room.draft.status, 'complete');
const exported = await api(`${base}/draft/export?${new URLSearchParams(auth)}`);
assert.ok(exported.ObjectStates.length > 0);
const forged = await fetch(new URL(presence, origin), { headers: { 'x-franken-session': crypto.randomUUID() }, redirect: 'manual' });
assert.equal(forged.status, 403);
console.log(JSON.stringify({ anonymousAccess: true, renderDependency: false, roomPersistence: true, privatePoolStorage: true, completedDraft: true, ttsExport: true, impersonationBlocked: true, streamedUpdates: true, boundedStreamRenewal: true, streamUpdateMs }));
