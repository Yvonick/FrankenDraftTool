import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localStorageBindings } from '../scripts/local-storage.mjs';
import { createWorker } from '../services/sites/worker.mjs';
import { createStorage } from '../services/sites/storage.mjs';
import registryModule from '../services/backend/poolRegistry.js';

export const tinyPool = { ObjectStates: [{ Name: 'Bag', Nickname: 'Persistence Test', ContainedObjects: ['Units', 'Abilities'].map(type => ({ Name: 'Bag', Nickname: type, ContainedObjects: Array.from({ length: 12 }, (_, index) => ({ Name: 'Custom_Tile', Nickname: `${type} ${index}`, GUID: `${type === 'Units' ? 'a' : 'b'}${String(index).padStart(5, '0')}`, CustomImage: { ImageURL: `https://example.test/${type}/${index}.png` } })) })) }] };

export async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'franken-native-'));
  let env = await localStorageBindings(directory);
  env.DRAFT_HISTORY_PASSKEY = 'test-only-history-passkey';
  let historyCookie = '';
  let worker = createWorker({ html: '<!doctype html><title>FrankenDraftTool</title>' });
  t.after(async () => { env.close(); await rm(directory, { recursive: true, force: true }); });
  const raw = (path, body, token = crypto.randomUUID(), method = body === undefined ? 'GET' : 'POST') => worker.fetch(new Request(`https://draft.test${path}`, { method, headers: { 'content-type': 'application/json', 'x-franken-session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  const api = async (path, body, token) => {
    const result = await raw(path, body, token);
    const data = await result.json();
    assert.ok(result.ok, `${path}: ${result.status} ${JSON.stringify(data)}`);
    return data;
  };
  const historyRaw = (path = '', body, cookie = historyCookie, extraHeaders = {}) => worker.fetch(new Request(`https://draft.test/api/draft-history${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie, ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }), env);
  const history = async (path = '') => {
    if (!historyCookie) {
      const login = await historyRaw('/login', { passkey: env.DRAFT_HISTORY_PASSKEY });
      assert.equal(login.status, 200); historyCookie = login.headers.get('set-cookie').split(';')[0];
    }
    const result = await historyRaw(path);
    assert.equal(result.status, 200);
    return result.json();
  };
  return {
    api, raw, history, historyRaw, get env() { return env; },
    async restart() { env.close(); env = await localStorageBindings(directory); env.DRAFT_HISTORY_PASSKEY = 'test-only-history-passkey'; worker = createWorker({ html: 'restarted' }); },
    async room(methodId = 'bag-passing-default', maxSeats = 2) {
      const room = await api('/api/rooms', {});
      const base = `/api/rooms/${room.roomNumber}`;
      const players = Array.from({ length: maxSeats }, () => ({ id: crypto.randomUUID(), token: crypto.randomUUID() }));
      const host = players[0];
      const auth = { creatorToken: room.creatorToken, actorId: host.id, viewerId: host.id, participantId: host.id };
      // A creator may configure the room before sitting down.
      await api(`${base}/settings`, { creatorToken: room.creatorToken, maxSeats, methodId });
      const connect = async (player, extra = {}) => api(`${base}/presence?${new URLSearchParams({ role: 'seated', name: `Player ${players.indexOf(player) + 1}`, participantId: player.id, ...(player === host ? { creatorToken: room.creatorToken } : {}), ...extra })}`, undefined, player.token);
      await Promise.all(players.map(player => connect(player)));
      return { ...room, base, players, host, auth, connect, start: () => api(`${base}/draft/start`, auth, host.token) };
    }
  };
}

test('automatic solo picks reject choices and stale submissions, and preserve history and exports', async t => {
  const f = await fixture(t), room = await f.room('bag-passing-default', 1);
  const { pool } = await f.api('/api/pools/upload', { poolJson: tinyPool, savePool: true });
  await f.api(`${room.base}/settings`, { ...room.auth, poolId: pool.id, picksPerBag: 3,
    itemsPerType: { Units: 3, Abilities: 0, 'Speaker Order': 0 } }, room.host.token);
  let state = await room.start();
  const draftId = state.draft.id;
  let bag = state.draft.currentPlayer.currentBag;
  assert.equal(bag.automaticItemIds, null, 'first rotation still requires a choice between three units');
  const send = (bag, itemIds, automatic = true) => ({ playerId: room.host.id, bagId: bag.id,
    expectedPickCount: bag.pickCount, itemIds, automatic });
  assert.equal((await f.raw(`${room.base}/draft/pick`, send(bag, [bag.items[0].id]), room.host.token)).status, 409);
  state = await f.api(`${room.base}/draft/pick`, send(bag, [bag.items[0].id], false), room.host.token);
  const previous = bag;
  bag = state.draft.currentPlayer.currentBag;
  assert.equal(bag.id, previous.id, 'solo players see the same, now smaller bag');
  assert.equal(bag.pickCount, 1);
  assert.equal(bag.automaticItemIds.length, 2);
  assert.equal((await f.raw(`${room.base}/draft/pick`, send(previous, bag.automaticItemIds), room.host.token)).status, 409);
  await f.restart();
  const results = await Promise.all([1, 2].map(() => f.raw(`${room.base}/draft/pick`, send(bag, bag.automaticItemIds), room.host.token)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  state = (await room.connect(room.host)).room;
  assert.equal(state.draft.status, 'complete');
  assert.equal(state.draft.id, draftId);
  assert.equal(state.draft.revealedDrafts[0].items.length, 3);
  const entry = (await f.history()).drafts[0];
  const events = (await f.history(`/${entry.id}/events`)).events.filter(e => e.kind === 'bag_pick');
  assert.equal(events.length, 2);
  assert.equal(events[1].automatic, true);
  assert.equal(events[1].items.length, 2);
  const exported = await f.api(`${room.base}/draft/export?${new URLSearchParams(room.auth)}`, undefined, room.host.token);
  assert.equal(exported.ObjectStates.find(o => o.Nickname === 'Player 1').ContainedObjects.length, 3);
});

test('automatic picks are viewer-scoped and simultaneous players cannot duplicate or lose items', async t => {
  const f = await fixture(t), room = await f.room();
  const { pool } = await f.api('/api/pools/upload', { poolJson: tinyPool, savePool: true });
  await f.api(`${room.base}/settings`, { ...room.auth, poolId: pool.id, picksPerBag: 3,
    itemsPerType: { Units: 1, Abilities: 1, 'Speaker Order': 0 } }, room.host.token);
  await room.start();
  assert.equal((await f.api(room.base)).draft.currentPlayer, null);
  const views = await Promise.all(room.players.map(player => room.connect(player)));
  const bag = views[0].room.draft.currentPlayer.currentBag;
  const forged = await f.raw(`${room.base}/draft/pick`, { playerId: room.host.id, bagId: bag.id,
    expectedPickCount: bag.pickCount, automatic: true, itemIds: bag.automaticItemIds }, room.players[1].token);
  assert.equal(forged.status, 403);
  await Promise.all(room.players.map((player, index) => {
    const current = views[index].room.draft.currentPlayer.currentBag;
    assert.equal(current.automaticItemIds.length, 2);
    return f.api(`${room.base}/draft/pick`, { playerId: player.id, bagId: current.id,
      expectedPickCount: current.pickCount, itemIds: current.automaticItemIds, automatic: true }, player.token);
  }));
  const final = (await room.connect(room.host)).room.draft;
  assert.equal(final.status, 'complete');
  assert.equal(new Set(final.revealedDrafts.flatMap(p => p.items.map(i => i.id))).size, 4);
});

test('automatic empty passes keep bags moving until their remaining items reach a player with capacity', async t => {
  const f = await fixture(t), room = await f.room();
  const raw = structuredClone(tinyPool);
  raw.ObjectStates[0].ContainedObjects.push({ Name: 'Bag', Nickname: 'Tech', ContainedObjects:
    Array.from({ length: 8 }, (_, index) => ({ Name: 'Custom_Tile', Nickname: `Tech ${index}`, GUID: `c0000${index}`,
      CustomImage: { ImageURL: `https://example.test/Tech/${index}.png` } })) });
  const { pool } = await f.api('/api/pools/upload', { poolJson: raw, savePool: true });
  await f.api(`${room.base}/settings`, { ...room.auth, poolId: pool.id, picksPerBag: 2,
    itemsPerType: { Units: 1, Abilities: 1, Tech: 1, 'Speaker Order': 0 } }, room.host.token);
  await room.start();
  for (const [index, player] of room.players.entries()) {
    const bag = (await room.connect(player)).room.draft.currentPlayer.currentBag;
    const types = index === 0 ? ['Units', 'Abilities'] : ['Units', 'Tech'];
    await f.api(`${room.base}/draft/pick`, { playerId: player.id, itemIds: bag.items.filter(i => types.includes(i.type)).map(i => i.id) }, player.token);
  }
  for (const player of room.players) {
    const bag = (await room.connect(player)).room.draft.currentPlayer.currentBag;
    assert.deepEqual(bag.automaticItemIds, []);
    const after = await f.api(`${room.base}/draft/pick`, { playerId: player.id, bagId: bag.id,
      expectedPickCount: bag.pickCount, itemIds: [], automatic: true }, player.token);
    assert.equal(after.draft.status, 'active');
  }
  for (const player of room.players) {
    const bag = (await room.connect(player)).room.draft.currentPlayer.currentBag;
    assert.equal(bag.automaticItemIds.length, 1);
    await f.api(`${room.base}/draft/pick`, { playerId: player.id, bagId: bag.id,
      expectedPickCount: bag.pickCount, itemIds: bag.automaticItemIds, automatic: true }, player.token);
  }
  const final = (await room.connect(room.host)).room.draft;
  assert.equal(final.status, 'complete');
  assert.ok(final.revealedDrafts.every(p => p.items.length === 3));
});

test('room-wide super visibility is admin-controlled, persistent and independent of individual promotions', async t => {
  const f = await fixture(t), room = await f.room();
  const spectator = { id: crypto.randomUUID(), token: crypto.randomUUID() };
  const second = { id: crypto.randomUUID(), token: crypto.randomUUID() };
  const spectate = person => room.connect(person, { role: 'spectator', name: person === spectator ? 'Observer' : '' });
  assert.equal((await spectate(spectator)).viewer.superSpectator, true);
  await spectate(second);
  await f.api(`${room.base}/settings`, { ...room.auth, superSpectators: false }, room.host.token);
  assert.equal((await spectate(spectator)).viewer.superSpectator, false);
  await room.start();
  assert.equal((await spectate(spectator)).room.draft.superSpectator, null);
  const path = `${room.base}/spectators/visibility`;
  assert.equal((await f.raw(path, { actorId: spectator.id, superSpectators: true }, spectator.token)).status, 403);
  assert.equal((await f.raw(path, { ...room.auth, superSpectators: 'true' }, room.host.token)).status, 400);
  await f.api(`${room.base}/participants/admin`, { ...room.auth, participantId: room.players[1].id, admin: true }, room.host.token);
  await f.api(path, { actorId: room.players[1].id, superSpectators: true }, room.players[1].token);
  await f.restart();
  for (const person of [spectator, second]) {
    const view = await spectate(person);
    assert.equal(view.viewer.superSpectator, true);
    assert.equal(view.room.draft.superSpectator.players.length, 2);
    assert.ok(view.room.draft.superSpectator.players.every(player => player.currentBag.items.length));
    assert.equal(view.room.draft.currentPlayer, null);
  }
  assert.equal((await room.connect(room.host)).room.draft.superSpectator, null, 'seated players cannot use the spectator permission');
  await f.api(`${room.base}/spectators/promote`, { ...room.auth, participantId: spectator.id, superSpectator: true }, room.host.token);
  await f.api(path, { ...room.auth, superSpectators: false }, room.host.token);
  assert.ok((await spectate(spectator)).room.draft.superSpectator);
  assert.equal((await spectate(second)).room.draft.superSpectator, null);
  const store = createStorage(f.env), saved = await store.room(room.roomNumber);
  delete saved.state.superSpectators;
  await store.commit({room: {id: room.roomNumber, expected: saved.revision, state: saved.state}});
  assert.equal((await spectate(second)).viewer.superSpectator, false, 'legacy rooms retain restricted visibility');
});

test('live room logs require that rooms session and redact bag picks when visibility is revoked', async t => {
  const f = await fixture(t), room = await f.room('bag-passing-default', 1);
  const observer = { id: crypto.randomUUID(), token: crypto.randomUUID() };
  await room.connect(observer, {role: 'spectator', name: 'Observer'});
  const logs = `${room.base}/logs?viewerId=${observer.id}`;
  assert.equal((await f.raw(`${room.base}/logs`)).status, 401);
  assert.equal((await f.raw(logs)).status, 403);
  assert.equal((await f.raw(logs + '&after=-1', undefined, observer.token)).status, 400);
  const start = await room.start();
  const bag = start.draft.currentPlayer.currentBag;
  const picks = [...new Map(bag.items.filter(item => bag.eligibleItemIds.includes(item.id)).map(item => [item.type, item])).values()].slice(0, bag.requiredPickCount);
  await f.api(`${room.base}/draft/pick`, {playerId: room.host.id, bagId: bag.id, itemIds: picks.map(item => item.id)}, room.host.token);
  const revealed = await f.api(logs, undefined, observer.token);
  assert.equal(revealed.events.length, 2);
  assert.equal(revealed.events[0].bags, undefined);
  assert.deepEqual(revealed.events[1].items.map(item => item.id).sort(), picks.map(item => item.id).sort());
  assert.equal(revealed.events[1].items[0].ttsObject, undefined);
  assert.equal((await f.raw(logs, undefined, observer.token)).headers.get('cache-control'), 'no-store');
  await f.api(`${room.base}/spectators/visibility`, {...room.auth, superSpectators: false}, room.host.token);
  const hidden = await f.api(logs, undefined, observer.token);
  assert.equal(hidden.revealPicks, false);
  assert.equal(hidden.events[1].items, undefined);
  assert.equal(hidden.events[1].itemCount, picks.length);
  assert.equal((await f.api(`${room.base}/logs?viewerId=${room.host.id}`, undefined, room.host.token)).events[1].items, undefined);
  await f.api(`${room.base}/draft/restart`, room.auth, room.host.token);
  assert.equal((await f.api(logs, undefined, observer.token)).draftId, null);
  await room.start();
  assert.notEqual((await f.api(logs, undefined, observer.token)).draftId, revealed.draftId);
});

test('super spectators live auction logs never expose sealed bids but include revealed recaps and undo', async t => {
  const f = await fixture(t), room = await f.room('nomination-auction');
  const observer = {id: crypto.randomUUID(), token: crypto.randomUUID()};
  await room.connect(observer, {role: 'spectator', name: 'Observer'});
  await room.start();
  const logs = `${room.base}/logs?viewerId=${observer.id}`;
  await f.api(`${room.base}/draft/auction/bid`, {playerId: room.host.id, first: 13, second: 0, tie: 7}, room.host.token);
  const secret = await f.api(logs, undefined, observer.token);
  assert.equal(secret.events.at(-1).kind, 'bid_locked');
  assert.equal(secret.events.at(-1).bids, undefined);
  assert.equal(secret.events.at(-1).bidRecap, undefined);
  const view = (await room.connect(observer, {role: 'spectator'})).room;
  assert.ok(view.draft.superSpectator.players.every(player => player.currentBids === null));
  await f.api(`${room.base}/draft/auction/bid`, {playerId: room.players[1].id, first: 3, second: 0, tie: 1}, room.players[1].token);
  const revealed = await f.api(logs + '&after=2', undefined, observer.token);
  assert.equal(revealed.events[0].bidRecap.bids.find(bid => bid.playerId === room.host.id).first, 13);
  await f.api(`${room.base}/draft/auction/undo`, room.auth, room.host.token);
  const undo = await f.api(logs, undefined, observer.token);
  assert.equal(undo.events.at(-1).targetSequence, 3);
  assert.ok(undo.events.every(event => event.bids === undefined));
});

test('room logs use bounded event pages without loading pool assets', async t => {
  const f = await fixture(t), room = await f.room();
  await room.start();
  const store = createStorage(f.env), saved = await store.room(room.roomNumber);
  const id = saved.state.history.id;
  saved.state.history.sequence = 105;
  await store.commit({room: {id: room.roomNumber, expected: saved.revision, state: saved.state}});
  await f.env.DB.batch(Array.from({length: 104}, (_, i) => f.env.DB.prepare('INSERT INTO draft_events (draft_id, sequence, event) VALUES (?, ?, ?)').bind(id, i + 2, JSON.stringify({sequence: i + 2, kind: 'bag_pass'}))));
  f.env.BUCKET.get = () => { throw new Error('Logs must not load assets'); };
  const first = await f.api(`${room.base}/logs?viewerId=${room.host.id}`, undefined, room.host.token);
  assert.equal(first.events.length, 100);
  assert.equal(first.nextAfter, 100);
  const rest = await f.api(`${room.base}/logs?viewerId=${room.host.id}&after=100`, undefined, room.host.token);
  assert.equal(rest.events.length, 5);
  assert.equal(rest.nextAfter, null);
});

test('server name preferences survive restarts and never grant room identity', async t => {
  const f = await fixture(t);
  const token = crypto.randomUUID();
  const profile = (body, identity = token) => createWorker({ html: '' }).fetch(new Request('https://draft.test/api/profile', {
    method: body === undefined ? 'GET' : 'POST', headers: { 'x-franken-profile': identity, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }), f.env);
  assert.equal((await profile({name: ' Yvon '})).status, 200);
  await f.restart();
  assert.equal((await (await profile()).json()).name, 'Yvon');
  assert.equal((await (await profile(undefined, crypto.randomUUID())).json()).name, '');
  assert.equal((await profile({name: 'x'.repeat(41)})).status, 400);
  assert.equal((await profile(undefined, '')).status, 401);
  const room = await f.room();
  assert.equal((await f.raw(`${room.base}/presence?participantId=${room.host.id}&role=seated`, undefined, token)).status, 403);
  await profile({ name: '' });
  assert.equal((await (await profile()).json()).name, '');
});

test('room directory lists live opted-in rooms without loading draft state', async t => {
  const f = await fixture(t);
  const room = await f.room();
  assert.equal((await f.api(room.base)).listed, true);
  const directory = await f.api('/api/rooms');
  assert.equal(directory.rooms.length, 1);
  assert.equal(directory.rooms[0].roomNumber, room.roomNumber);
  assert.equal(directory.rooms[0].online, 2);
  assert.equal(directory.rooms[0].draft, undefined);
  assert.equal(directory.rooms[0].creatorToken, undefined);
  const rejected = await f.raw(`${room.base}/settings`, { participantId: room.players[1].id, listed: false }, room.players[1].token);
  assert.equal(rejected.status, 403);
  await f.api(`${room.base}/settings`, { ...room.auth, listed: false }, room.host.token);
  assert.equal((await f.api('/api/rooms')).rooms.length, 0);
  await f.restart();
  assert.equal((await f.api(room.base)).listed, false);
  await f.api(`${room.base}/settings`, { ...room.auth, listed: true }, room.host.token);
  const original = f.env.DB.prepare;
  f.env.DB.prepare = sql => { assert.ok(!/SELECT revision, state FROM rooms/.test(sql), 'directory must not inflate room blobs'); return original(sql); };
  assert.equal((await f.api('/api/rooms')).rooms.length, 1);
  f.env.DB.prepare = original;
  await f.env.DB.prepare('UPDATE room_sessions SET last_seen = 0').run();
  assert.equal((await f.api('/api/rooms')).rooms.length, 0);
});

test('standalone routes and health require no external network or ChatGPT login', async t => {
  const f = await fixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('External network is forbidden'); };
  try {
    for (const path of ['/', '/pools', '/methods', '/rooms/123456']) assert.equal((await f.raw(path)).status, 200);
    const health = await f.api('/api/health');
    assert.equal(health.renderDependency, false);
    assert.equal(health.storage, 'D1 + R2');
    assert.equal((await f.api('/api/methods')).methods.filter(method => method.playable).length, 2);
    assert.equal((await f.api('/api/pools')).pools[0].name, 'Franken Y V6.9');
    assert.equal((await f.raw('/missing.png')).status, 404);
  } finally { globalThis.fetch = originalFetch; }
});

test('concurrent joins and picks preserve every player; private bags reject impersonation', async t => {
  const f = await fixture(t);
  const room = await f.room('bag-passing-default', 6);
  assert.equal((await f.api(room.base)).seated.length, 6);
  await room.start();
  const views = await Promise.all(room.players.map(player => room.connect(player)));
  const pickedIds = [];
  await Promise.all(views.map(async (view, index) => {
    const player = room.players[index];
    const bag = view.room.draft.currentPlayer.currentBag;
    const eligible = bag.items.filter(item => bag.eligibleItemIds.includes(item.id));
    const selected = [...new Map(eligible.map(item => [item.type, item])).values()].slice(0, bag.requiredPickCount);
    pickedIds.push(...selected.map(item => item.id));
    await f.api(`${room.base}/draft/pick`, { playerId: player.id, bagId: bag.id, itemIds: selected.map(item => item.id) }, player.token);
  }));
  const after = await Promise.all(room.players.map(player => room.connect(player)));
  assert.deepEqual(after.flatMap(view => view.room.draft.currentPlayer.draftedItems.map(item => item.id)).sort(), pickedIds.sort());
  const journal = (await f.env.DB.prepare('SELECT sequence FROM draft_events ORDER BY sequence').all()).results;
  assert.deepEqual(journal.map(event => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
  const forged = await f.raw(`${room.base}/presence?participantId=${room.host.id}&role=seated`, undefined, room.players[1].token);
  assert.equal(forged.status, 403);
  const anonymous = await f.api(room.base);
  assert.equal(anonymous.draft.currentPlayer, null);
  await f.restart();
  const restored = await room.connect(room.host);
  assert.equal(restored.room.draft.currentPlayer.draftedItems.length, after[0].room.draft.currentPlayer.draftedItems.length);
  const exported = await f.raw(`${room.base}/draft/export?${new URLSearchParams(room.auth)}`, undefined, room.host.token);
  assert.equal(exported.status, 200);
  assert.ok((await exported.json()).ObjectStates.length > 0);
});

test('pool API lists latest uploads and edits first, including after restart', async t => {
  const f = await fixture(t);
  const first = (await f.api('/api/pools/upload', {poolJson: tinyPool, savePool: true, poolName: 'First'})).pool;
  const second = (await f.api('/api/pools/upload', {poolJson: tinyPool, savePool: true, poolName: 'Second'})).pool;
  assert.equal((await f.api('/api/pools')).pools[0].id, second.id);
  const edited = await f.api(`/api/pools/${first.id}`, {name: 'Updated first'});
  assert.equal(edited.pools[0].id, first.id);
  assert.ok(edited.pools[0].updatedAt >= second.updatedAt);
  await f.restart();
  const listed = (await f.api('/api/pools')).pools;
  assert.equal(listed[0].id, first.id);
  assert.equal(listed[0].updatedAt, edited.pools[0].updatedAt);
  const created = await f.api('/api/rooms', {});
  assert.equal((await f.api(`/api/rooms/${created.roomNumber}`)).draft.settings.poolId, first.id);
});

test('legacy pool dates recover once from object metadata without loading all pools or rewriting versions', async t => {
  const f = await fixture(t), registry = registryModule.createPoolRegistry();
  const keys = new Map();
  for (const [name, date] of [['Old legacy', 1000], ['New legacy', 2000]]) {
    const pool = registry.registerUploadedTtsPool(tinyPool, name, {public: true, name});
    delete pool.updatedAt;
    const summary = registry.getPoolSummary(pool);
    delete summary.updatedAt;
    const key = `pools/legacy-${crypto.randomUUID()}.json`;
    keys.set(key, date);
    await f.env.BUCKET.put(key, JSON.stringify(pool));
    await f.env.DB.prepare('INSERT INTO pools (id, revision, object_key, summary, deleted) VALUES (?, 7, ?, ?, 0)')
      .bind(pool.id, key, JSON.stringify(summary)).run();
  }
  let heads = 0, gets = 0;
  const get = f.env.BUCKET.get;
  f.env.BUCKET.head = async key => { heads++; return {uploaded: new Date(keys.get(key))}; };
  f.env.BUCKET.get = async key => { gets++; return {...await get(key), uploaded: new Date(keys.get(key))}; };
  const listed = (await f.api('/api/pools')).pools.filter(pool => pool.name.includes('legacy'));
  assert.deepEqual(listed.map(pool => pool.name), ['New legacy', 'Old legacy']);
  assert.deepEqual(listed.map(pool => pool.updatedAt), [2000, 1000]);
  assert.equal(heads, 2);
  assert.equal(gets, 1, 'only the normally selected pool is loaded');
  await f.api('/api/pools');
  assert.equal(heads, 2, 'recovered dates are persisted');
  for (const row of await createStorage(f.env).catalog()) {
    if (keys.has(row.object_key)) {
      assert.equal(row.revision, 7);
      assert.equal(JSON.parse(row.summary).updatedAt, keys.get(row.object_key));
    }
  }
});

test('legacy date recovery tolerates missing objects and cannot overwrite a concurrent edit', async t => {
  const f = await fixture(t), store = createStorage(f.env);
  const insert = (id, key) => f.env.DB.prepare('INSERT INTO pools (id, revision, object_key, summary, deleted) VALUES (?, 1, ?, ?, 0)')
    .bind(id, key, JSON.stringify({id, name: id, public: true})).run();
  await insert('missing', 'missing.json');
  await insert('racing', 'old.json');
  f.env.BUCKET.head = async key => {
    if (key === 'missing.json') throw Error('Unavailable');
    await f.env.DB.prepare('UPDATE pools SET revision = 2, object_key = ?, summary = ? WHERE id = ?')
      .bind('new.json', JSON.stringify({id: 'racing', name: 'Edited', updatedAt: 3000}), 'racing').run();
    return {uploaded: new Date(1000)};
  };
  await store.catalog({recoverDates: true});
  const rows = await store.catalog();
  assert.equal(JSON.parse(rows.find(row => row.id === 'racing').summary).name, 'Edited');
  assert.equal(JSON.parse(rows.find(row => row.id === 'racing').summary).updatedAt, 3000);
  assert.equal(JSON.parse(rows.find(row => row.id === 'missing').summary).updatedAt, undefined);
});

test('pool uploads, edits, deletion and active draft pool versions survive restart', async t => {
  const f = await fixture(t);
  const uploaded = await f.api('/api/pools/upload', { poolJson: tinyPool, savePool: true });
  const id = uploaded.pool.id;
  const room = await f.room();
  await f.api(`${room.base}/settings`, { ...room.auth, poolId: id, picksPerBag: 1 }, room.host.token);
  await room.start();
  await f.api(`/api/pools/${id}`, { name: 'Saved test pool' });
  await f.restart();
  assert.ok((await f.api('/api/pools')).pools.some(pool => pool.name === 'Saved test pool'));
  await f.api(`/api/pools/${id}/delete`, {});
  await f.restart();
  assert.ok(!(await f.api('/api/pools')).pools.some(pool => pool.id === id));
  const exported = await f.raw(`${room.base}/draft/export?${new URLSearchParams(room.auth)}`, undefined, room.host.token);
  assert.equal(exported.status, 200, 'running draft retains its immutable pool after public deletion');
  assert.ok((await exported.json()).ObjectStates.length > 0);
});

test('pool replacement persists under the same ID while existing bag and auction rooms keep their immutable source', async t => {
  const f = await fixture(t);
  const {pool} = await f.api('/api/pools/upload', {poolJson: tinyPool, savePool: true, poolName: 'Stable name'});
  const defaults = {maxSeats: 4, picksPerBag: 3, auctionSpeakerMode: 'none', typeOrder: ['Abilities', 'Speaker Order', 'Units'], itemsPerType: {Units: 4, Abilities: 0, 'Speaker Order': 1}};
  await f.api(`/api/pools/${pool.id}`, {defaultParameters: defaults});
  const rooms = [];
  for (const method of ['bag-passing-default', 'nomination-auction']) {
    const room = await f.room(method, 1);
    await f.api(`${room.base}/settings`, {...room.auth, poolId: pool.id, auctionSpeakerMode: 'none', itemsPerType: {Units: 1, Abilities: 0, 'Speaker Order': 0}}, room.host.token);
    let state = await room.start();
    if (method === 'nomination-auction') state = await f.api(`${room.base}/draft/auction/nominate`, {playerId: room.host.id, type: 'Units'}, room.host.token);
    const items = method === 'bag-passing-default' ? state.draft.currentPlayer.currentBag.items : state.draft.auction.currentNomination.items;
    rooms.push({room, method, items});
  }
  const store = createStorage(f.env), originalRow = (await store.catalog()).find(row => row.id === pool.id);
  const original = await store.pool(originalRow.object_key);
  const replacement = structuredClone(tinyPool);
  replacement.ObjectStates[0].Nickname = 'Different import name';
  replacement.ObjectStates[0].ContainedObjects[1].Nickname = 'New type';
  replacement.ObjectStates[0].ContainedObjects[0].ContainedObjects.forEach(item => {item.Nickname = 'New ' + item.Nickname;});
  const path = `/api/pools/${pool.id}/replace`;
  const updated = await f.api(path, {fileName: 'replacement.json', fileContent: JSON.stringify(replacement), poolName: 'Ignored override', defaultParameters: {maxSeats: 12}});
  assert.equal(updated.pool.id, pool.id);
  assert.equal(updated.pool.name, 'Stable name');
  assert.equal(updated.pools.filter(item => item.id === pool.id).length, 1);
  assert.deepEqual(updated.pool.defaultParameters, {...defaults, typeOrder: ['Speaker Order', 'Units', 'New type'], itemsPerType: {Units: 4, 'New type': 2, 'Speaker Order': 1}});
  await f.restart();
  assert.deepEqual((await f.api('/api/pools')).pools.find(item => item.id === pool.id), updated.pool);
  const currentStore = createStorage(f.env), newRow = (await currentStore.catalog()).find(row => row.id === pool.id);
  assert.notEqual(newRow.object_key, originalRow.object_key);
  assert.deepEqual(await currentStore.pool(originalRow.object_key), original);
  for (const {room, method, items} of rooms) {
    const state = (await room.connect(room.host)).room;
    const current = method === 'bag-passing-default' ? state.draft.currentPlayer.currentBag.items : state.draft.auction.currentNomination.items;
    assert.deepEqual(current, items);
    const exported = await f.api(`${room.base}/draft/export?${new URLSearchParams(room.auth)}`, undefined, room.host.token);
    assert.ok(JSON.stringify(exported).includes('Abilities'));
    assert.ok(!JSON.stringify(exported).includes('New Units'));
  }
  const fresh = await f.room('bag-passing-default', 1);
  await f.api(`${fresh.base}/settings`, {...fresh.auth, poolId: pool.id, itemsPerType: {Units: 1, 'New type': 0, 'Speaker Order': 0}}, fresh.host.token);
  assert.match((await fresh.start()).draft.currentPlayer.currentBag.items[0].name, /^New Units/);
  for (const bad of [{fileContent: '{oops'}, {poolJson: {}}, {poolJson: {ObjectStates: [{ContainedObjects: [null]}]}}, {}]) {
    assert.equal((await f.raw(path, bad)).status, 400);
    assert.equal((await currentStore.catalog()).find(row => row.id === pool.id).object_key, newRow.object_key);
  }
  const put = f.env.BUCKET.put;
  f.env.BUCKET.put = () => {throw new Error('Simulated replacement storage failure');};
  assert.equal((await f.raw(path, {poolJson: tinyPool})).status, 503);
  f.env.BUCKET.put = put;
  assert.equal((await currentStore.catalog()).find(row => row.id === pool.id).object_key, newRow.object_key);
  const privatePool = await f.api('/api/pools/upload', {poolJson: tinyPool});
  assert.equal((await f.raw(`/api/pools/${privatePool.pool.id}/replace`, {poolJson: tinyPool})).status, 404);
  await f.api(`/api/pools/${pool.id}/delete`, {});
  assert.equal((await f.raw(path, {poolJson: tinyPool})).status, 404);
});

test('back images and attached components survive bag drafts, auctions, legacy room reloads and undo', async t => {
  const f = await fixture(t);
  const raw = structuredClone(tinyPool);
  raw.ObjectStates[0].ContainedObjects[0].ContainedObjects = Array.from({length: 4}, (_, index) => ({
    Name: 'CardCustom', Nickname: `Unit ${index} II`, Description: 'Non-draft: Token', CardID: 100 + index,
    CustomDeck: {'1': {FaceURL: 'https://example.test/front.png', BackURL: 'https://example.test/back.png', NumWidth: 2, NumHeight: 2, UniqueBack: true}}
  }));
  raw.ObjectStates[0].ContainedObjects.push({Name: 'Bag', Nickname: 'Non-draft parts', ContainedObjects:
    Array.from({length: 4}, (_, index) => ({Name: 'Bag', Nickname: `Unit ${index} II`, ContainedObjects: [
      {Name: 'Custom_Tile', Nickname: 'Token', CustomImage: {ImageURL: 'https://example.test/token.png'}}
    ]}))
  });
  raw.ObjectStates[0].ContainedObjects.push({Name: 'Bag', Nickname: 'Base Unit Tiles', ContainedObjects:
    Array.from({length: 4}, (_, index) => ({Name: 'Custom_Tile', Nickname: `Unit ${index} I`, CustomImage: {ImageURL: 'https://example.test/base.png'}}))
  });
  const {pool} = await f.api('/api/pools/upload', {poolJson: raw, savePool: true});
  const assertMedia = item => {
    assert.equal(item.imageSecondaryUrl, 'https://example.test/back.png');
    assert.deepEqual(item.imageSecondarySheet, item.imageSheet);
    assert.equal(item.linkedItems[0].name, 'Token');
    assert.equal(item.linkedItems[0].ttsObject, undefined);
    assert.equal(item.linkedItems[1].name, item.name.slice(0, -1));
    assert.equal(item.linkedItems[1].imageUrl, 'https://example.test/base.png');
    assert.equal(item.linkedItems[1].ttsObject, undefined);
  };
  for (const method of ['bag-passing-default', 'nomination-auction']) {
    const room = await f.room(method, 1);
    await f.api(`${room.base}/settings`, {...room.auth, poolId: pool.id, picksPerBag: 1, auctionSpeakerMode: 'none', itemsPerType: {Units: 1, Abilities: 1, 'Speaker Order': 0}}, room.host.token);
    await room.start();
    if (method === 'bag-passing-default') {
      const initial = (await room.connect(room.host)).room.draft.currentPlayer.currentBag.items.find(item => item.type === 'Units');
      assertMedia(initial);
      const store = createStorage(f.env), saved = await store.room(room.roomNumber);
      const stripMedia = value => {
        if (!value || typeof value !== 'object') return;
        if ('imageUrl' in value) { delete value.imageSecondarySheet; value.imageSecondaryUrl = null; }
        for (const child of Object.values(value)) stripMedia(child);
      };
      stripMedia(saved.state.draft);
      await store.commit({room: {id: room.roomNumber, expected: saved.revision, state: saved.state}});
      await f.restart();
      assertMedia((await room.connect(room.host)).room.draft.currentPlayer.currentBag.items.find(item => item.type === 'Units'));
    } else {
      const act = (action, body = {}) => f.api(`${room.base}/draft/auction/${action}`, {playerId: room.host.id, ...body}, room.host.token);
      let state = await act('nominate', {type: 'Units'});
      assertMedia(state.draft.auction.currentNomination.items[0]);
      state = await act('mulligan', {mulligan: false});
      state = await act('ban', {itemId: null});
      state = await act('bid', {first: 0, second: 0, tie: 0});
      const pick = state.draft.auction.currentNomination.items[0];
      await act('pick', {itemId: pick.id});
      await f.restart();
      state = await f.api(`${room.base}/draft/auction/undo`, room.auth, room.host.token);
      assertMedia(state.draft.auction.currentNomination.items.find(item => item.id === pick.id));
    }
  }
});

test('named linked contents and automatic base units preview and export intact after completed bag and auction drafts', async t => {
  const f = await fixture(t);
  const bag = (Nickname, ContainedObjects) => ({Name: 'Bag', Nickname, ContainedObjects});
  const token = name => ({Name: 'Custom_Tile', Nickname: name, CustomImage: {ImageURL: 'https://example.test/token.png'}});
  const units = Array.from({length: 4}, (_, i) => token(`Unit ${i} II`));
  const baseUnits = units.map(unit => token(unit.Nickname.slice(0, -1)));
  const contents = [token('Repeated token'), token('Repeated token'),
    {Name: 'Deck', Nickname: 'Deck', ContainedObjects: [token('Card A'), token('Card B')]},
    bag('Nested bag', [token('Inner token')]), {Name: 'Die_10', Nickname: 'Omen Die', RotationValues: []}];
  const raw = {ObjectStates: [bag('New links', [bag('Units', units), bag('Non-draft parts', [
    ...units.map(unit => bag(unit.Nickname, structuredClone(contents))), bag('Unmatched', [token('Never attached')])
  ]), bag('Base Unit Tiles', baseUnits)])]};
  const {pool} = await f.api('/api/pools/upload', {poolJson: raw, savePool: true});
  assert.deepEqual(pool.unmatchedLinkedBags, ['Unmatched']);
  await f.restart();
  assert.deepEqual((await f.api('/api/pools')).pools.find(item => item.id === pool.id).unmatchedLinkedBags, ['Unmatched']);
  for (const method of ['bag-passing-default', 'nomination-auction']) {
    const room = await f.room(method, 1);
    await f.api(`${room.base}/settings`, {...room.auth, poolId: pool.id, picksPerBag: 1, auctionSpeakerMode: 'none', itemsPerType: {Units: 1, 'Speaker Order': 0}}, room.host.token);
    let state = await room.start();
    const checkPreview = item => {
      assert.deepEqual(item.linkedItems.map(link => link.name), [...contents.map(object => object.Nickname), item.name.slice(0, -1)]);
      assert.deepEqual(item.linkedItems[2].containedItems.map(child => child.name), ['Card A', 'Card B']);
      assert.equal(item.linkedItems[3].containedItems[0].name, 'Inner token');
      assert.doesNotMatch(JSON.stringify(item), /ttsObject|ContainedObjects|RotationValues/);
    };
    if (method === 'bag-passing-default') {
      const current = state.draft.currentPlayer.currentBag;
      checkPreview(current.items[0]);
      state = await f.api(`${room.base}/draft/pick`, {playerId: room.host.id, bagId: current.id, itemIds: [current.items[0].id]}, room.host.token);
    } else {
      const act = (action, data = {}) => f.api(`${room.base}/draft/auction/${action}`, {playerId: room.host.id, ...data}, room.host.token);
      state = await act('nominate', {type: 'Units'});
      checkPreview(state.draft.auction.currentNomination.items[0]);
      state = await act('mulligan', {mulligan: false});
      state = await act('ban', {itemId: null});
      state = await act('bid', {first: 0, second: 0, tie: 0});
      const picked = state.draft.auction.currentNomination.items[0];
      await act('pick', {itemId: picked.id});
      await f.restart();
      state = await f.api(`${room.base}/draft/auction/undo`, room.auth, room.host.token);
      checkPreview(state.draft.auction.currentNomination.items.find(item => item.id === picked.id));
      state = await act('pick', {itemId: picked.id});
    }
    assert.equal(state.draft.status, 'complete');
    await f.restart();
    const exported = await f.api(`${room.base}/draft/export`);
    const playerBag = exported.ObjectStates.find(object => object.Nickname === 'Player 1');
    assert.equal(playerBag.ContainedObjects.length, 2);
    const nonDraft = playerBag.ContainedObjects[1];
    assert.equal(nonDraft.Name, 'Bag');
    assert.equal(nonDraft.Nickname, 'Non-draft parts');
    assert.equal(nonDraft.Value, contents.length + 1);
    assert.deepEqual(nonDraft.ContainedObjects.slice(0, -1), contents, 'export originals exactly once, including both token copies and intact nested containers');
    assert.deepEqual(nonDraft.ContainedObjects.at(-1), baseUnits.find(unit => unit.Nickname === playerBag.ContainedObjects[0].Nickname.slice(0, -1)));
    assert.ok(units.some(unit => unit.Nickname === playerBag.ContainedObjects[0].Nickname));
  }
});

test('active exports put each players linked parts in their own sub-bag without changing queues or source objects', async t => {
  const f = await fixture(t);
  const raw = structuredClone(tinyPool);
  const units = raw.ObjectStates[0].ContainedObjects[0].ContainedObjects;
  const token = {Name: 'Custom_Tile', Nickname: 'Linked token', GUID: 'abcdef', CustomImage: {ImageURL: 'https://example.test/linked.png'}};
  raw.ObjectStates[0].ContainedObjects.push({Name: 'Bag', Nickname: 'Non-draft parts', ContainedObjects:
    units.map(item => ({Name: 'Bag', Nickname: item.Nickname, ContainedObjects: [structuredClone(token)]}))});
  const {pool} = await f.api('/api/pools/upload', {poolJson: raw, savePool: true});
  const store = createStorage(f.env), row = (await store.catalog()).find(row => row.id === pool.id);
  const original = await store.pool(row.object_key);
  const room = await f.room('bag-passing-default', 2);
  await f.api(`${room.base}/settings`, {...room.auth, poolId: pool.id, picksPerBag: 1, itemsPerType: {Units: 1, Abilities: 0, 'Speaker Order': 0}}, room.host.token);
  await room.start();
  for (const [index, player] of room.players.entries()) {
    const current = (await room.connect(player)).room.draft.currentPlayer.currentBag;
    await f.api(`${room.base}/draft/pick`, {playerId: player.id, bagId: current.id, itemIds: [current.items[0].id]}, player.token);
    const exported = await f.api(`${room.base}/draft/export?${new URLSearchParams(room.auth)}`, undefined, room.host.token);
    for (let owner = 0; owner < 2; owner++) {
      const playerBag = exported.ObjectStates.find(item => item.Nickname === `Player ${owner + 1}`);
      const parts = playerBag.ContainedObjects.filter(item => item.Nickname === 'Non-draft parts');
      assert.equal(parts.length, owner <= index ? 1 : 0);
      if (parts.length) {
        assert.equal(playerBag.ContainedObjects.length, 2);
        assert.equal(parts[0].Value, 1);
        assert.deepEqual(parts[0].ContainedObjects.map(item => item.Nickname), ['Linked token']);
      }
    }
    const guids = [];
    const collect = object => {if (object.GUID) guids.push(object.GUID); for (const child of object.ContainedObjects || []) collect(child);};
    exported.ObjectStates.forEach(collect);
    assert.equal(new Set(guids).size, guids.length, 'container and component GUIDs are unique across players');
    const remaining = exported.ObjectStates.find(item => item.Nickname === 'Remaining Draftable Pool');
    assert.deepEqual(remaining.ColorDiffuse, {r: 0.08, g: 0.16, b: 0.32}, 'old sources without colors retain the fallback');
    assert.ok(remaining.ContainedObjects.every(bag => bag.ContainedObjects.every(item => item.Nickname !== 'Linked token')));
    if (index === 0) {
      const queues = exported.ObjectStates.find(item => item.Nickname === 'Current Bag Draft Queues');
      assert.equal(queues.ContainedObjects.length, 1);
      assert.equal(queues.ContainedObjects[0].ContainedObjects.length, 1, 'unpicked items do not export linked components');
    }
  }
  assert.deepEqual(await store.pool(row.object_key), original, 'export does not mutate stored TTS objects');
});

test('base-unit source repair updates the saved pool durably without replacing draftables or pinned rooms', async t => {
  const f = await fixture(t);
  const bag = (Nickname, ContainedObjects) => ({Name: 'Bag', Nickname, ContainedObjects});
  const tile = Nickname => ({Name: 'Custom_Tile', Nickname, CustomImage: {ImageURL: 'https://example.test/unit.png'}});
  const raw = {ObjectStates: [bag('Repair source', [bag('Units', [tile('Unit II')])])]};
  const {pool} = await f.api('/api/pools/upload', {poolJson: raw, savePool: true});
  const room = await f.room('bag-passing-default', 1);
  await f.api(`${room.base}/settings`, {...room.auth, poolId: pool.id, itemsPerType: {Units: 1, 'Speaker Order': 0}}, room.host.token);
  await room.start();
  const baseUnit = tile('Unit I');
  raw.ObjectStates[0].ContainedObjects.push(bag('Base Units', [baseUnit]));
  raw.ObjectStates[0].ColorDiffuse = {r: 0, g: 0, b: 0};
  raw.ObjectStates[0].ContainedObjects[0].ColorDiffuse = {r: 0.2, g: 0.6, b: 0.9, a: 0.8};
  const path = `/api/pools/${pool.id}`;
  const repaired = await f.api(path, {sourceJson: raw});
  assert.equal(repaired.baseUnitLinksAdded, 1);
  assert.ok(repaired.pool.updatedAt >= pool.updatedAt);
  assert.deepEqual({...repaired.pool, updatedAt: pool.updatedAt}, pool, 'catalog defaults and metadata are preserved apart from the update date');
  assert.equal((await f.api(path, {baseUnitSource: raw})).baseUnitLinksAdded, 0);
  await f.restart();
  const store = createStorage(f.env);
  const row = (await store.catalog()).find(row => row.id === pool.id);
  const saved = await store.pool(row.object_key);
  assert.deepEqual(saved.items[0].linkedItems[0].ttsObject, baseUnit);
  assert.deepEqual(saved.exportBagColors, {root: raw.ObjectStates[0].ColorDiffuse, types: {Units: raw.ObjectStates[0].ContainedObjects[0].ColorDiffuse}});
  assert.deepEqual((await room.connect(room.host)).room.draft.currentPlayer.currentBag.items[0].linkedItems, [], 'a running draft retains its pinned source');
  raw.ObjectStates[0].ContainedObjects[0].ContainedObjects[0].Description = 'Not the same source';
  const rejected = await f.raw(path, {baseUnitSource: raw, name: 'Should not change'});
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, 'pool_source_mismatch');
  assert.equal((await f.api('/api/pools')).pools.find(item => item.id === pool.id).name, pool.name);
  const newRoom = await f.room('bag-passing-default', 1);
  await f.api(`${newRoom.base}/settings`, {...newRoom.auth, poolId: pool.id, itemsPerType: {Units: 1, 'Speaker Order': 0}}, newRoom.host.token);
  assert.equal((await newRoom.start()).draft.currentPlayer.currentBag.items[0].linkedItems[0].name, 'Unit I');
});

test('a private upload saved from its room pins the new defaults across reloads', async t => {
  const f = await fixture(t);
  const uploaded = await f.api('/api/pools/upload', { poolJson: tinyPool, savePool: false });
  assert.equal((await f.api('/api/pools')).pools.length, 1);
  const room = await f.room();
  const typeOrder = [...uploaded.pool.defaultParameters.typeOrder].reverse();
  await f.api(`${room.base}/settings`, { ...room.auth, poolId: uploaded.pool.id, picksPerBag: 1, typeOrder }, room.host.token);
  await f.restart();
  assert.deepEqual((await room.connect(room.host)).room.draft.settings.typeOrder, typeOrder);
  await f.api(`${room.base}/pool/save`, { ...room.auth, poolName: 'Room saved pool' }, room.host.token);
  await f.restart();
  const view = await room.connect(room.host);
  assert.equal(view.room.draft.settings.pool.name, 'Room saved pool');
  assert.deepEqual(view.room.draft.settings.pool.defaultParameters.typeOrder, typeOrder);
  assert.deepEqual((await room.start()).draft.typeOrder, typeOrder);
  await f.restart();
  const exported = await f.raw(`${room.base}/draft/export?${new URLSearchParams(room.auth)}`, undefined, room.host.token);
  assert.equal(exported.status, 200);
  assert.ok((await exported.json()).ObjectStates.length > 0);
});

test('auction bids and undo persist without a Node server', async t => {
  const f = await fixture(t);
  const room = await f.room('nomination-auction');
  const started = await room.start();
  assert.equal(started.draft.auction.stage, 'speaker_order_bidding');
  await Promise.all(room.players.map((player, index) => f.api(`${room.base}/draft/auction/bid`, { playerId: player.id, first: index + 1, second: 0, tie: 0 }, player.token)));
  await f.restart();
  const view = await room.connect(room.host);
  assert.notEqual(view.room.draft.auction.stage, 'speaker_order_bidding');
  const undone = await f.api(`${room.base}/draft/auction/undo`, room.auth, room.host.token);
  assert.equal(undone.draft.auction.stage, 'speaker_order_bidding');
  await f.restart();
  assert.equal((await room.connect(room.host)).room.draft.auction.stage, 'speaker_order_bidding');
  const reset = await f.api(`${room.base}/draft/restart`, room.auth, room.host.token);
  assert.equal(reset.draft.status, 'not_started');
});

test('storage failures return a recoverable error, and invalid requests do not corrupt rooms', async t => {
  const f = await fixture(t);
  const room = await f.room();
  const invalid = await f.raw(`${room.base}/settings`, { ...room.auth, maxSeats: 'invalid' }, room.host.token);
  assert.equal(invalid.status, 400);
  assert.equal((await f.api(room.base)).maxSeats, 2);
  const worker = createWorker({ html: 'test' });
  const result = await worker.fetch(new Request('https://draft.test/api/health'), {});
  assert.equal(result.status, 503);
  assert.equal((await result.json()).error, 'storage_unavailable');
});

test('failed pool writes leave the catalog intact and existing rooms remain usable', async t => {
  const f = await fixture(t);
  const room = await f.room();
  const put = f.env.BUCKET.put;
  f.env.BUCKET.put = async () => { throw new Error('Simulated R2 outage'); };
  const result = await f.raw('/api/pools/upload', { poolJson: tinyPool, savePool: true });
  assert.equal(result.status, 503);
  f.env.BUCKET.put = put;
  assert.equal((await f.api('/api/pools')).pools.length, 1);
  assert.equal((await room.connect(room.host)).room.maxSeats, 2);
});

test('complete bag and auction drafts reveal every pick and export after repeated reloads', async t => {
  const f = await fixture(t);
  const raw = structuredClone(tinyPool);
  raw.ObjectStates[0].ColorDiffuse = {r: 0, g: 0, b: 0};
  raw.ObjectStates[0].ContainedObjects[0].ColorDiffuse = {r: 1, g: 0.05, b: 0.125, a: 0.7};
  raw.ObjectStates[0].ContainedObjects[1].ColorDiffuse = {r: 0.1, g: 0.6, b: 0.9};
  const checkColors = exported => {
    const leftover = exported.ObjectStates.find(item => item.Nickname === 'Remaining Draftable Pool');
    assert.deepEqual(leftover.ColorDiffuse, raw.ObjectStates[0].ColorDiffuse);
    assert.equal(leftover.ContainedObjects.length, 2);
    for (const typeBag of leftover.ContainedObjects) {
      assert.deepEqual(typeBag.ColorDiffuse, raw.ObjectStates[0].ContainedObjects.find(item => item.Nickname === typeBag.Nickname).ColorDiffuse);
      assert.equal(typeBag.Value, typeBag.ContainedObjects.length);
    }
    for (const player of exported.ObjectStates.filter(item => ['Player 1', 'Player 2'].includes(item.Nickname))) {
      assert.ok(player.ContainedObjects.every(item => item.Nickname !== 'Non-draft parts'), 'no empty non-draft bag');
    }
  };
  const { pool } = await f.api('/api/pools/upload', { poolJson: raw, savePool: true });
  for (const method of ['bag-passing-default', 'nomination-auction']) {
    const room = await f.room(method);
    await f.api(`${room.base}/settings`, { ...room.auth, poolId: pool.id, picksPerBag: 1, auctionSpeakerMode: 'none', itemsPerType: { Units: 1, Abilities: 1, 'Speaker Order': 0 } }, room.host.token);
    let state = await room.start();
    const bagSnapshots = [];
    checkColors(await f.api(`${room.base}/draft/export?${new URLSearchParams(room.auth)}`, undefined, room.host.token));
    let usedMulligan = false;
    let usedBan = false;
    for (let step = 0; step < 50 && state.draft.status === 'active'; step++) {
      if (method === 'bag-passing-default') {
        for (const player of room.players) {
          state = (await room.connect(player)).room;
          if (state.draft.status === 'complete') break;
          const bag = state.draft.currentPlayer.currentBag;
          if (bag) {
            bagSnapshots.push({bagId: bag.id, items: bag.items.map(item => ({id: item.id, name: item.name, type: item.type}))});
            state = await f.api(`${room.base}/draft/pick`, { playerId: player.id, bagId: bag.id, itemIds: bag.eligibleItemIds.slice(0, bag.requiredPickCount) }, player.token);
          }
        }
      } else {
        const auction = state.draft.auction;
        const run = async (action, id, data) => {
          const player = room.players.find(player => player.id === id);
          return f.api(`${room.base}/draft/auction/${action}`, { playerId: id, ...data }, player.token);
        };
        if (auction.stage === 'nomination') state = await run('nominate', auction.speakerId, { type: auction.eligibleTypes[0] });
        else if (auction.stage === 'mulligan') {
          state = await run('mulligan', auction.speakerId, { mulligan: !usedMulligan });
          usedMulligan = true;
        } else if (auction.stage === 'ban') {
          state = await run('ban', auction.currentNomination.banPlayerId, { itemId: usedBan ? null : auction.currentNomination.items[0].id });
          usedBan = true;
        } else if (auction.stage === 'bidding') {
          await Promise.all(room.players.map((player, index) => run('bid', player.id, { first: index + 1, second: 0, tie: 0 })));
          state = (await room.connect(room.host)).room;
        } else if (auction.stage === 'picking') {
          const item = auction.currentNomination.items.find(item => !item.pickedBy);
          state = await run('pick', auction.currentNomination.currentPickPlayerId, { itemId: item.id });
        } else assert.fail(`Unexpected auction stage: ${auction.stage}`);
      }
      if (step % 4 === 0) { await f.restart(); state = (await room.connect(room.host)).room; }
    }
    assert.equal(state.draft.status, 'complete');
    assert.ok(!(await f.api('/api/rooms')).rooms.some(entry => entry.roomNumber === room.roomNumber), 'completed drafts leave the current-room directory');
    assert.equal(state.draft.revealedDrafts.length, 2);
    for (const player of state.draft.revealedDrafts) assert.equal(player.items.length, 2);
    assert.equal(new Set(state.draft.revealedDrafts.flatMap(player => player.items.map(item => item.id))).size, 4);
    const exported = await f.api(`${room.base}/draft/export`);
    checkColors(exported);
    assert.ok(exported.ObjectStates.length > 0);
    const entry = (await f.history()).drafts.find(entry => entry.roomNumber === room.roomNumber);
    assert.ok(entry);
    const archive = await f.history(`/${entry.id}`);
    assert.equal(archive.results.players.flatMap(player => player.items).length, 4);
    assert.deepEqual(archive.results.players.flatMap(player => player.items.map(item => item.id)).sort(), state.draft.revealedDrafts.flatMap(player => player.items.map(item => item.id)).sort());
    const log = await f.history(`/${entry.id}/events`);
    assert.equal(log.events[0].kind, 'draft_started');
    assert.equal(log.events.at(-1).completed, true);
    assert.deepEqual(log.events.map(event => event.sequence), Array.from({length: entry.eventCount}, (_, i) => i + 1));
    assert.ok(!JSON.stringify({archive, log}).includes(room.creatorToken));
    assert.doesNotMatch(JSON.stringify({archive, log}), /ttsObject|undoStack|connectionToken|token_hash/);
    if (method === 'nomination-auction') {
      assert.ok(log.events.some(event => event.kind === 'mulligan' && event.removed.length));
      assert.ok(log.events.some(event => event.kind === 'ban' && event.replacements.length));
      assert.ok(log.events.some(event => event.bidRecap?.bids.length === 2));
      assert.ok(log.events.some(event => event.binned?.length));
      assert.equal((await f.historyRaw(`/${entry.id}/bag?player=${room.host.id}`)).status, 400);
    } else {
      const picks = log.events.filter(event => ['bag_pick', 'bag_pass'].includes(event.kind));
      assert.equal(picks.length, bagSnapshots.length);
      for (const [index, pick] of picks.entries()) {
        const bag = await f.history(`/${entry.id}/bag?sequence=${pick.sequence}`);
        assert.deepEqual(bag.items.map(({selected, ...item}) => item), bagSnapshots[index].items);
        assert.deepEqual(bag.items.filter(item => item.selected).map(item => item.id), pick.items.map(item => item.id));
      }
      for (const initial of log.events[0].bags) {
        const opening = await f.history(`/${entry.id}/bag?player=${initial.player.id}`);
        assert.deepEqual(opening.items.map(({selected, ...item}) => item), initial.items);
        assert.ok(opening.items.every(item => !item.selected));
      }
      assert.equal((await f.historyRaw(`/${entry.id}/bag?sequence=2`, undefined, '')).status, 401);
      assert.equal((await f.historyRaw(`/${entry.id}/bag?sequence=1`)).status, 404);
      assert.equal((await f.historyRaw(`/${entry.id}/bag?player=unknown`)).status, 404);
      for (const query of ['', 'sequence=0', 'sequence=-1', 'sequence=1.5', 'sequence=9007199254740992', 'player=', 'sequence=2&player=x']) {
        assert.equal((await f.historyRaw(`/${entry.id}/bag?${query}`)).status, 400);
      }
    }
    await f.api(`${room.base}/draft/restart`, room.auth, room.host.token);
    await f.restart();
    assert.deepEqual((await f.history(`/${entry.id}`)).results, archive.results);
    await room.start();
    assert.equal((await f.history()).drafts.filter(entry => entry.roomNumber === room.roomNumber).length, 1);
  }
});

test('solo draft history shows the opening bag unchanged and the shrinking bag before each pick', async t => {
  const f = await fixture(t), room = await f.room('bag-passing-default', 1);
  const {pool} = await f.api('/api/pools/upload', {poolJson: tinyPool, savePool: true});
  await f.api(`${room.base}/settings`, {...room.auth, poolId: pool.id, picksPerBag: 1, itemsPerType: {Units: 2, Abilities: 2, 'Speaker Order': 0}}, room.host.token);
  await room.start();
  const snapshots = [];
  for (let step = 0; step < 12; step++) {
    const state = (await room.connect(room.host)).room;
    if (state.draft.status === 'complete') break;
    const bag = state.draft.currentPlayer.currentBag;
    snapshots.push(bag.items.map(item => item.id));
    await f.api(`${room.base}/draft/pick`, {playerId: room.host.id, bagId: bag.id, itemIds: bag.eligibleItemIds.slice(0, bag.requiredPickCount)}, room.host.token);
  }
  const entry = (await f.history()).drafts[0];
  assert.ok(entry);
  const events = (await f.history(`/${entry.id}/events`)).events.filter(event => event.kind === 'bag_pick');
  assert.equal(events.length, 4);
  for (const [index, event] of events.entries()) {
    const bag = await f.history(`/${entry.id}/bag?sequence=${event.sequence}`);
    assert.deepEqual(bag.items.map(item => item.id), snapshots[index]);
  }
  await f.api(`${room.base}/draft/restart`, room.auth, room.host.token);
  await f.restart();
  const opening = await f.history(`/${entry.id}/bag?player=${room.host.id}`);
  assert.deepEqual(opening.items.map(item => item.id), snapshots[0]);
});

test('bag history reconstructs old logs across batches, handles passes and missing baselines, and never reads room or pool blobs', async t => {
  const f = await fixture(t), id = crypto.randomUUID();
  const players = [{id: 'a', name: 'Same', seat: 1}, {id: 'b', name: 'Same', seat: 2}];
  const items = Array.from({length: 130}, (_, i) => ({id: `item-${i}`, name: 'Repeated name', type: 'Units'}));
  const summary = {engine: 'bag-pass', players, settings: {typeOrder: ['Units']}};
  const events = [
    {sequence: 1, kind: 'draft_started', bags: [
      {player: players[0], bagId: 'bag-a', items}, {player: players[1], bagId: 'bag-b', items: [{id: 'other', name: 'Other bag', type: 'Units'}]}
    ]},
    ...items.slice(0, 105).map((item, i) => ({sequence: i + 2, kind: 'bag_pick', bagId: 'bag-a', actor: 'Same', items: [item]})),
    {sequence: 107, kind: 'bag_pass', bagId: 'bag-a', actor: 'Same', items: []},
    {sequence: 108, kind: 'bag_pick', bagId: 'bag-a', actor: 'Same', items: [items[105]]}
  ];
  await f.env.DB.prepare("INSERT INTO draft_history (id, room_id, status, completed_at, summary, event_count) VALUES (?, '123456', 'complete', ?, ?, 108)").bind(id, Date.now(), JSON.stringify(summary)).run();
  await f.env.DB.batch(events.map(event => f.env.DB.prepare('INSERT INTO draft_events (draft_id, sequence, event) VALUES (?, ?, ?)').bind(id, event.sequence, JSON.stringify(event))));
  const original = f.env.DB.prepare;
  f.env.DB.prepare = sql => {
    assert.doesNotMatch(sql, /FROM rooms|FROM pools|SELECT summary, results/);
    return original(sql);
  };
  const bag = await f.history(`/${id}/bag?sequence=108`);
  assert.equal(bag.items.length, 25);
  assert.equal(bag.items[0].id, items[105].id);
  assert.equal(bag.items.filter(item => item.selected).length, 1);
  const pass = await f.history(`/${id}/bag?sequence=107`);
  assert.equal(pass.items.length, 25);
  assert.ok(pass.items.every(item => !item.selected));
  assert.deepEqual((await f.history(`/${id}/bag?player=b`)).items.map(item => item.id), ['other']);
  const response = await f.historyRaw(`/${id}/bag?sequence=108`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  f.env.DB.prepare = original;
  await f.env.DB.prepare("UPDATE draft_history SET status = 'active' WHERE id = ?").bind(id).run();
  assert.equal((await f.historyRaw(`/${id}/bag?sequence=108`)).status, 404);
  await f.env.DB.prepare("UPDATE draft_history SET status = 'complete' WHERE id = ?").bind(id).run();
  await f.env.DB.prepare('UPDATE draft_events SET event = ? WHERE draft_id = ? AND sequence = 1').bind(JSON.stringify({sequence: 1, kind: 'recording_started'}), id).run();
  assert.deepEqual(await f.history(`/${id}/bag?sequence=108`), {available: false});
  assert.deepEqual(await f.history(`/${id}/bag?player=a`), {available: false});
});

test('history accepts a short configured password, checks case and rejects empty configuration', async t => {
  const f = await fixture(t);
  f.env.DRAFT_HISTORY_PASSKEY = 'TestKey';
  assert.equal((await f.historyRaw('/login', {passkey: 'TestKey'})).status, 200);
  assert.equal((await f.historyRaw('/login', {passkey: 'testkey'})).status, 401);
  for (const value of ['', '   ', undefined]) {
    f.env.DRAFT_HISTORY_PASSKEY = value;
    assert.equal((await f.historyRaw('/login', {passkey: ''})).status, 503);
  }
});

test('history is passkey-protected, read-only, no-store and hides active drafts', async t => {
  const f = await fixture(t);
  assert.equal((await f.historyRaw('', undefined, '')).status, 401);
  assert.equal((await f.historyRaw('/login', {passkey: 'wrong'})).status, 401);
  assert.equal((await f.historyRaw('/login', {passkey: f.env.DRAFT_HISTORY_PASSKEY}, '', {origin: 'https://elsewhere.test'})).status, 403);
  const login = await f.historyRaw('/login', {passkey: f.env.DRAFT_HISTORY_PASSKEY});
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(login.headers.get('set-cookie'), /Secure/);
  assert.equal(login.headers.get('cache-control'), 'no-store');
  const room = await f.room(); await room.start();
  const id = (await f.env.DB.prepare('SELECT id FROM draft_history').first()).id;
  assert.equal((await f.history()).drafts.length, 0);
  assert.equal((await f.historyRaw(`/${id}`)).status, 404);
  assert.deepEqual((await f.history(`/${id}/events`)).events, []);
  assert.equal((await f.historyRaw(`/${id}`, {})).status, 405);
  assert.equal((await f.historyRaw('', undefined, 'franken_history=9999999999999.' + 'a'.repeat(64))).status, 401);
  const logout = await f.historyRaw('/logout', {});
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  f.env.DRAFT_HISTORY_PASSKEY = 'rotated-test-history-key';
  assert.equal((await f.historyRaw()).status, 401);
  delete f.env.DRAFT_HISTORY_PASSKEY;
  assert.equal((await f.historyRaw()).status, 503);
  assert.equal((await f.raw('/draft-history')).headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('history and room updates roll back together when event storage fails', async t => {
  const f = await fixture(t), room = await f.room();
  const prepare = f.env.DB.prepare;
  f.env.DB.prepare = sql => {
    const statement = prepare(sql);
    if (!sql.startsWith('INSERT INTO draft_events')) return statement;
    return { bind(...args) { const bound = statement.bind(...args); bound.runSync = () => { throw new Error('Simulated journal failure'); }; return bound; } };
  };
  assert.equal((await f.raw(`${room.base}/draft/start`, room.auth, room.host.token)).status, 503);
  f.env.DB.prepare = prepare;
  assert.equal((await f.api(room.base)).draft.status, 'not_started');
  assert.equal((await f.env.DB.prepare('SELECT count(*) AS n FROM draft_history').first()).n, 0);
  await room.start();
  assert.equal((await f.env.DB.prepare('SELECT count(*) AS n FROM draft_events').first()).n, 1);
});

test('auction undo reopens the same history, preserves reversed actions, and saves corrected results', async t => {
  const f = await fixture(t), room = await f.room('nomination-auction', 1);
  const { pool } = await f.api('/api/pools/upload', {poolJson: tinyPool, savePool: true});
  await f.api(`${room.base}/settings`, {...room.auth, poolId: pool.id, auctionSpeakerMode: 'none', itemsPerType: {Units: 1, Abilities: 0}}, room.host.token);
  await room.start();
  const run = (action, data = {}) => f.api(`${room.base}/draft/auction/${action}`, {playerId: room.host.id, ...data}, room.host.token);
  await run('no-ban-preset', {noBanPreset: true});
  await run('nominate', {type: 'Units'});
  await run('mulligan', {mulligan: false});
  let state = await run('bid', {first: 4, second: 0, tie: 0});
  const ids = state.draft.auction.currentNomination.items.map(item => item.id);
  await run('pick', {itemId: ids[0]});
  const entry = (await f.history()).drafts[0];
  let events = (await f.history(`/${entry.id}/events`)).events;
  const originalPick = events.at(-1).sequence;
  await f.api(`${room.base}/draft/auction/undo`, room.auth, room.host.token);
  assert.equal((await f.history()).drafts.length, 0);
  await f.restart();
  await run('pick', {itemId: ids[1]});
  const result = await f.history(`/${entry.id}`);
  assert.equal(result.results.players[0].items[0].id, ids[1]);
  assert.equal(result.results.players[0].items[0].cost, 4);
  events = (await f.history(`/${entry.id}/events`)).events;
  assert.equal(events.find(event => event.kind === 'undo').targetSequence, originalPick);
  assert.equal(events.filter(event => event.kind === 'auction_pick').length, 2);
  await f.api(`/api/pools/${pool.id}/delete`, {});
  await f.api(`${room.base}/draft/restart`, room.auth, room.host.token);
  assert.equal((await f.history(`/${entry.id}`)).results.players[0].items[0].id, ids[1]);
});

test('new pools default to two of each component, preserve speaker rules and explicit saved parameters', async t => {
  const f = await fixture(t);
  const room = await f.room();
  const settings = (await f.api(room.base)).draft.settings;
  assert.equal(settings.picksPerBag, 3);
  for (const [type, count] of Object.entries(settings.itemsPerType)) assert.equal(count, type === 'Speaker Order' ? 1 : 2);
  const { pool } = await f.api('/api/pools/upload', { poolJson: tinyPool, savePool: true });
  assert.equal(pool.defaultParameters.itemsPerType.Units, 2);
  assert.equal(pool.defaultParameters.itemsPerType.Abilities, 2);
  assert.equal(pool.defaultParameters.itemsPerType['Speaker Order'], 1);
  assert.equal(pool.defaultParameters.picksPerBag, 3);
  await f.api(`/api/pools/${pool.id}`, { defaultParameters: { picksPerBag: 2, itemsPerType: { Units: 0, Abilities: 4, 'Speaker Order': 0 } } });
  await f.api(`${room.base}/settings`, { ...room.auth, picksPerBag: 1 }, room.host.token);
  await f.restart();
  const saved = (await f.api('/api/pools')).pools.find(entry => entry.id === pool.id);
  assert.deepEqual(saved.defaultParameters.itemsPerType, { Units: 0, Abilities: 4, 'Speaker Order': 0 });
  assert.equal(saved.defaultParameters.picksPerBag, 2);
  assert.equal((await f.api(room.base)).draft.settings.picksPerBag, 1);
});

test('history pages use stable cursors and bounded event batches', async t => {
  const f = await fixture(t);
  const ids = Array.from({length: 27}, () => crypto.randomUUID());
  const completed = Date.now();
  await f.env.DB.batch(ids.map(id => f.env.DB.prepare("INSERT INTO draft_history (id, room_id, status, completed_at, summary, event_count) VALUES (?, '123456', 'complete', ?, '{}', 105)").bind(id, completed)));
  await f.env.DB.batch(Array.from({length: 105}, (_, i) => f.env.DB.prepare('INSERT INTO draft_events (draft_id, sequence, event) VALUES (?, ?, ?)').bind(ids[0], i + 1, JSON.stringify({sequence: i + 1}))));
  const first = await f.history();
  assert.equal(first.drafts.length, 25);
  const second = await f.history(`?cursor=${first.nextCursor}`);
  assert.equal(second.drafts.length, 2);
  assert.equal(new Set([...first.drafts, ...second.drafts].map(draft => draft.id)).size, 27);
  assert.equal(second.nextCursor, null);
  const events = await f.history(`/${ids[0]}/events`);
  assert.equal(events.events.length, 100);
  const rest = await f.history(`/${ids[0]}/events?after=${events.nextAfter}`);
  assert.equal(rest.events.length, 5);
  assert.equal(rest.events[0].sequence, 101);
  assert.equal(rest.nextAfter, null);
  assert.equal((await f.historyRaw('?cursor=invalid')).status, 400);
});

test('drafts already running when recording is enabled receive an explicitly partial history', async t => {
  const f = await fixture(t), room = await f.room('bag-passing-default', 1);
  await room.start();
  const store = createStorage(f.env), saved = await store.room(room.roomNumber);
  delete saved.state.history;
  await store.commit({ room: {id: room.roomNumber, expected: saved.revision, state: saved.state} });
  await f.api(`${room.base}/draft/restart`, room.auth, room.host.token);
  const histories = (await f.env.DB.prepare("SELECT summary, status FROM draft_history WHERE status = 'abandoned'").all()).results;
  assert.equal(histories.length, 1);
  assert.equal(JSON.parse(histories[0].summary).partial, true);
  assert.equal(JSON.parse(histories[0].summary).startedAt, null);
});

test('authenticated streams deliver other workers actions without leaking private bids', async t => {
  const f = await fixture(t);
  const room = await f.room('nomination-auction');
  await room.start();
  const observer = room.players[1];
  const abort = new AbortController();
  const streamWorker = createWorker({ html: 'independent observer' });
  const path = `${room.base}/presence?participantId=${observer.id}&observe=1`;
  const response = await streamWorker.fetch(new Request(`https://draft.test${path}`, {
    headers: { accept: 'text/event-stream', 'x-franken-session': observer.token }, signal: abort.signal
  }), f.env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const next = async () => {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    return JSON.parse(new TextDecoder().decode(chunk.value).split('\ndata: ')[1]);
  };
  try {
    const initial = await next();
    assert.equal(initial.viewer.id, observer.id);
    const started = performance.now();
    const ownAction = await f.api(`${room.base}/draft/auction/bid`, { playerId: room.host.id, first: 13, second: 0, tie: 7 }, room.host.token);
    const update = await next();
    assert.equal(update.room.revision, ownAction.revision, 'POST and stream share a monotonic storage revision');
    assert.notEqual(update.room.revision, initial.room.revision);
    assert.ok(performance.now() - started < 1000, 'a cross-worker change arrives on the next 250 ms check');
    assert.doesNotMatch(JSON.stringify(update), /"first":13|"tie":7/, 'another player cannot see a locked secret bid');
    const hiddenBid = update.room.draft.auction.players.find(player => player.playerId === room.host.id);
    assert.equal(hiddenBid.auctionBidLocked, true);
    assert.equal(hiddenBid.currentBids, null);
    assert.equal(update.viewer.role, 'seated', 'observe mode does not turn an existing player into a spectator');
  } finally { abort.abort(); await reader.cancel(); }
  const forged = await streamWorker.fetch(new Request(`https://draft.test${path}`, {
    headers: { accept: 'text/event-stream', 'x-franken-session': room.host.token }
  }), f.env);
  assert.equal(forged.status, 403);
});

test('offline admin and super spectator permissions survive other players saves and reloads', async t => {
  const f = await fixture(t);
  const room = await f.room();
  const spectator = { id: crypto.randomUUID(), token: crypto.randomUUID() };
  await f.api(`${room.base}/presence?${new URLSearchParams({ participantId: spectator.id, name: 'Observer', role: 'spectator' })}`, undefined, spectator.token);
  await f.api(`${room.base}/participants/admin`, { ...room.auth, participantId: spectator.id, admin: true }, room.host.token);
  await f.api(`${room.base}/spectators/promote`, { ...room.auth, participantId: spectator.id, superSpectator: true }, room.host.token);
  await f.env.DB.prepare('UPDATE room_sessions SET last_seen = ? WHERE room_id = ? AND participant_id = ?').bind(Date.now() - 120000, room.roomNumber, spectator.id).run();
  await f.api(`${room.base}/settings`, { ...room.auth, picksPerBag: 1 }, room.host.token);
  assert.equal((await room.connect(room.host)).room.namedSpectators.length, 0, 'offline viewers are not shown as present');
  await f.restart();
  const returned = await f.api(`${room.base}/presence?participantId=${spectator.id}&observe=1`, undefined, spectator.token);
  assert.equal(returned.viewer.admin, true);
  assert.equal(returned.viewer.superSpectator, true);
  const changed = await f.api(`${room.base}/settings`, { actorId: spectator.id, picksPerBag: 2 }, spectator.token);
  assert.equal(changed.draft.settings.picksPerBag, 2);
});

test('reconnecting to a full lobby preserves identity without exceeding the seat limit', async t => {
  const f = await fixture(t);
  const room = await f.room('bag-passing-default', 1);
  await f.env.DB.prepare('UPDATE room_sessions SET last_seen = ? WHERE room_id = ? AND participant_id = ?').bind(Date.now() - 120000, room.roomNumber, room.host.id).run();
  const replacement = { id: crypto.randomUUID(), token: crypto.randomUUID() };
  const denied = await f.api(`${room.base}/presence?${new URLSearchParams({ participantId: replacement.id, name: 'New player', role: 'seated' })}`, undefined, replacement.token);
  assert.equal(denied.viewer.role, 'spectator', 'offline seats cannot be stolen by a new visitor');
  assert.equal(denied.room.seated[0].online, false);
  const returned = await room.connect(room.host);
  assert.equal(returned.viewer.host, true);
  assert.equal(returned.viewer.role, 'seated');
  assert.equal(returned.room.seated.length, 1);
  assert.equal((await f.api(room.base)).seated.length, 1);
});

test('seat handoff preserves a bag seat, revokes its old session and atomically admits only one replacement', async t => {
  const f = await fixture(t), room = await f.room();
  const { pool } = await f.api('/api/pools/upload', { poolJson: tinyPool, savePool: true });
  await f.api(`${room.base}/settings`, { ...room.auth, poolId: pool.id, itemsPerType: { Units: 3, Abilities: 2, 'Speaker Order': 0 } }, room.host.token);
  await room.start();
  const target = room.players[1], original = (await room.connect(target)).room.draft.currentPlayer;
  assert.equal((await f.raw(`${room.base}/participants/remove`, { actorId: target.id, targetId: room.host.id, mode: 'handoff' }, target.token)).status, 403);
  assert.equal((await f.raw(`${room.base}/participants/remove`, { actorId: room.host.id, targetId: target.id, mode: 'remove' }, room.host.token)).status, 409);
  const opened = await f.api(`${room.base}/participants/remove`, { actorId: room.host.id, targetId: target.id, mode: 'handoff' }, room.host.token);
  assert.ok(opened.handoffToken);
  assert.equal(opened.draft.table.find(p => p.id === target.id).vacant, true);
  assert.equal((await f.raw(`${room.base}/presence?participantId=${target.id}&role=seated`, undefined, target.token)).status, 403);
  assert.equal((await f.raw(`${room.base}/draft/pick`, { playerId: target.id, itemIds: [] }, target.token)).status, 403);
  assert.doesNotMatch(JSON.stringify(await f.api(room.base)), /handoffHash|handoffToken/);
  await f.restart();
  const tokens = [crypto.randomUUID(), crypto.randomUUID()];
  const claims = await Promise.all(tokens.map((token, i) => f.raw(`${room.base}/seats/claim`, { token: opened.handoffToken, name: `Successor ${i}` }, token)));
  assert.deepEqual(claims.map(r => r.status).sort(), [200, 410]);
  const index = claims.findIndex(r => r.status === 200), claimed = await claims[index].json();
  assert.equal(claimed.viewer.id, target.id);
  assert.equal(claimed.viewer.admin, false); assert.equal(claimed.viewer.host, false);
  assert.deepEqual(claimed.draft.currentPlayer.currentBag, original.currentBag);
  assert.equal(claimed.draft.currentPlayer.queueLength, original.queueLength);
  assert.equal(claimed.viewer.name, `Successor ${index}`);
  assert.equal((await f.raw(`${room.base}/seats/claim`, { token: opened.handoffToken, name: 'Replay' }, crypto.randomUUID())).status, 410);
  const exportData = await f.api(`${room.base}/draft/export?${new URLSearchParams(room.auth)}`, undefined, room.host.token);
  assert.ok(exportData.ObjectStates.some(o => o.Nickname === `Successor ${index}`));
  const logs = await f.api(`${room.base}/logs?viewerId=${room.host.id}`, undefined, room.host.token);
  assert.ok(logs.events.some(e => e.kind === 'seat_claim' && /Successor/.test(e.note)));
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(opened.handoffToken));
});

test('host can leave a seat without transferring host rights, even with spectators disabled', async t => {
  const f = await fixture(t), room = await f.room();
  await f.api(`${room.base}/settings`, { ...room.auth, allowSpectators: false }, room.host.token);
  await room.start();
  const left = await f.api(`${room.base}/participants/leave`, { actorId: room.host.id, mode: 'handoff' }, room.host.token);
  assert.equal(left.viewer.role, 'spectator'); assert.equal(left.viewer.host, true);
  assert.notEqual(left.viewer.id, room.host.id);
  const claimed = await f.api(`${room.base}/seats/claim`, { token: left.handoffToken, name: 'New host-seat occupant' }, crypto.randomUUID());
  assert.equal(claimed.viewer.host, false); assert.equal(claimed.viewer.admin, false);
  const rejoined = await f.api(`${room.base}/presence?participantId=${left.viewer.id}&role=spectator`, undefined, room.host.token);
  assert.equal(rejoined.viewer.host, true);
  const restarted = await f.api(`${room.base}/draft/restart`, { actorId: left.viewer.id, participantId: left.viewer.id }, room.host.token);
  assert.equal(restarted.draft.status, 'not_started');
});

test('auction handoff keeps resources and seat order through undo without restoring the old owner', async t => {
  const f = await fixture(t), room = await f.room('nomination-auction');
  const { pool } = await f.api('/api/pools/upload', { poolJson: tinyPool, savePool: true });
  await f.api(`${room.base}/settings`, { ...room.auth, poolId: pool.id, auctionSpeakerMode: 'none', itemsPerType: { Units: 1, Abilities: 1, 'Speaker Order': 0 } }, room.host.token);
  const started = await room.start();
  const speaker = room.players.find(p => p.id === started.draft.auction.speakerId);
  await f.api(`${room.base}/draft/auction/nominate`, { playerId: speaker.id, type: 'Units' }, speaker.token);
  const target = room.players[1];
  const before = (await room.connect(target)).room.draft.auction.players.find(p => p.playerId === target.id);
  const opened = await f.api(`${room.base}/participants/remove`, { actorId: room.host.id, targetId: target.id, mode: 'handoff' }, room.host.token);
  const token = crypto.randomUUID();
  const claimed = await f.api(`${room.base}/seats/claim`, { token: opened.handoffToken, name: 'Replacement' }, token);
  const after = claimed.draft.auction.players.find(p => p.playerId === target.id);
  for (const key of ['seat', 'credits', 'banTokens', 'mulliganTokens']) assert.equal(after[key], before[key]);
  assert.deepEqual(after.draftedItems, before.draftedItems);
  const undone = await f.api(`${room.base}/draft/auction/undo`, room.auth, room.host.token);
  assert.equal(undone.draft.auction.players.find(p => p.playerId === target.id).name, 'Replacement');
  assert.equal((await f.raw(`${room.base}/draft/auction/no-ban-preset`, { playerId: target.id, noBanPreset: true }, target.token)).status, 403);
  const connected = await f.api(`${room.base}/presence?participantId=${target.id}&role=seated`, undefined, token);
  assert.equal(connected.viewer.name, 'Replacement');
});

test('admins can remove anonymous spectators and seats; removal and restart invalidate replacement links', async t => {
  const f = await fixture(t), room = await f.room();
  const admin = room.players[1];
  await f.api(`${room.base}/participants/admin`, { ...room.auth, participantId: admin.id, admin: true }, room.host.token);
  const observer = { id: crypto.randomUUID(), token: crypto.randomUUID() };
  const observed = await f.api(`${room.base}/presence?participantId=${observer.id}&role=spectator`, undefined, observer.token);
  assert.ok(observed.room.namedSpectators.some(p => p.id === observer.id));
  await f.api(`${room.base}/participants/remove`, { actorId: admin.id, targetId: observer.id }, admin.token);
  assert.equal((await f.raw(`${room.base}/presence?participantId=${observer.id}&role=spectator`, undefined, observer.token)).status, 403);
  assert.equal((await f.raw(`${room.base}/participants/remove`, { actorId: admin.id, targetId: room.host.id }, admin.token)).status, 409);
  await room.start();
  const left = await f.api(`${room.base}/participants/leave`, { actorId: admin.id, mode: 'handoff' }, admin.token);
  const regen = await f.api(`${room.base}/seats/link`, { actorId: room.host.id, targetId: admin.id }, room.host.token);
  assert.equal((await f.raw(`${room.base}/seats/claim`, { token: left.handoffToken, name: 'Old link' }, crypto.randomUUID())).status, 410);
  const removed = await f.api(`${room.base}/participants/remove`, { actorId: room.host.id, targetId: admin.id, mode: 'remove', confirmRestart: true }, room.host.token);
  assert.equal(removed.draft.status, 'not_started'); assert.equal(removed.seated.length, 1);
  assert.equal((await f.raw(`${room.base}/seats/claim`, { token: regen.handoffToken, name: 'Late visitor' }, crypto.randomUUID())).status, 410);
  await f.restart();
  assert.equal((await f.api(room.base)).seated.length, 1);
});

test('leaving the lobby is explicit and survives reload, and claimers cannot occupy two seats', async t => {
  const f = await fixture(t), room = await f.room();
  const target = room.players[1];
  const left = await f.api(`${room.base}/participants/leave`, { actorId: target.id }, target.token);
  assert.equal(left.viewer.role, 'spectator'); assert.equal(left.seated.length, 1);
  assert.equal((await f.raw(`${room.base}/presence?participantId=${target.id}&role=seated`, undefined, target.token)).status, 403);
  await f.api(`${room.base}/presence?participantId=${left.viewer.id}&role=seated&name=Returned`, undefined, target.token);
  await room.start();
  const opened = await f.api(`${room.base}/participants/remove`, { actorId: room.host.id, targetId: left.viewer.id, mode: 'handoff' }, room.host.token);
  assert.equal((await f.raw(`${room.base}/seats/claim`, { actorId: room.host.id, token: opened.handoffToken, name: 'Two seats' }, room.host.token)).status, 409);
});

test('legacy expired duplicate seats do not overfill a lobby or resurrect seats outside an active draft', async t => {
  const f = await fixture(t), room = await f.room();
  const store = createStorage(f.env);
  let stored = await store.room(room.roomNumber);
  const ghost = crypto.randomUUID();
  stored.state.participants.unshift([ghost, { id: ghost, name: 'Expired legacy seat', role: 'seated' }]);
  await store.commit({ room: { id: room.roomNumber, expected: stored.revision, state: stored.state } });
  let snapshot = await f.api(room.base);
  assert.deepEqual(new Set(snapshot.seated.map(p => p.id)), new Set(room.players.map(p => p.id)));
  await room.start();
  stored = await store.room(room.roomNumber);
  stored.state.participants.find(([id]) => id === ghost)[1].role = 'seated';
  await store.commit({ room: { id: room.roomNumber, expected: stored.revision, state: stored.state } });
  snapshot = await f.api(room.base);
  assert.equal(snapshot.seated.length, 2); assert.equal(snapshot.draft.table.length, 2);
  assert.equal((await store.room(room.roomNumber)).state.participants.find(([id]) => id === ghost)[1].role, 'spectator');
});
