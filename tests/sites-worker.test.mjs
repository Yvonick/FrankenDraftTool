import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localStorageBindings } from '../scripts/local-storage.mjs';
import { createWorker } from '../services/sites/worker.mjs';
import { createStorage } from '../services/sites/storage.mjs';

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
  const { pool } = await f.api('/api/pools/upload', { poolJson: tinyPool, savePool: true });
  for (const method of ['bag-passing-default', 'nomination-auction']) {
    const room = await f.room(method);
    await f.api(`${room.base}/settings`, { ...room.auth, poolId: pool.id, picksPerBag: 1, auctionSpeakerMode: 'none', itemsPerType: { Units: 1, Abilities: 1, 'Speaker Order': 0 } }, room.host.token);
    let state = await room.start();
    const bagSnapshots = [];
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
  await f.api(`${room.base}/presence?${new URLSearchParams({ participantId: replacement.id, name: 'New player', role: 'seated' })}`, undefined, replacement.token);
  const returned = await room.connect(room.host);
  assert.equal(returned.viewer.host, true);
  assert.equal(returned.viewer.role, 'spectator');
  assert.equal(returned.room.seated.length, 1);
  assert.equal((await f.api(room.base)).seated.length, 1);
});
