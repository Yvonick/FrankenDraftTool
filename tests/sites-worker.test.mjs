import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localStorageBindings } from '../scripts/local-storage.mjs';
import { createWorker } from '../services/sites/worker.mjs';

export const tinyPool = { ObjectStates: [{ Name: 'Bag', Nickname: 'Persistence Test', ContainedObjects: ['Units', 'Abilities'].map(type => ({ Name: 'Bag', Nickname: type, ContainedObjects: Array.from({ length: 12 }, (_, index) => ({ Name: 'Custom_Tile', Nickname: `${type} ${index}`, GUID: `${type === 'Units' ? 'a' : 'b'}${String(index).padStart(5, '0')}`, CustomImage: { ImageURL: `https://example.test/${type}/${index}.png` } })) })) }] };

export async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'franken-native-'));
  let env = await localStorageBindings(directory);
  let worker = createWorker({ html: '<!doctype html><title>FrankenDraftTool</title>' });
  t.after(async () => { env.close(); await rm(directory, { recursive: true, force: true }); });
  const raw = (path, body, token = crypto.randomUUID(), method = body === undefined ? 'GET' : 'POST') => worker.fetch(new Request(`https://draft.test${path}`, { method, headers: { 'content-type': 'application/json', 'x-franken-session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  const api = async (path, body, token) => {
    const result = await raw(path, body, token);
    const data = await result.json();
    assert.ok(result.ok, `${path}: ${result.status} ${JSON.stringify(data)}`);
    return data;
  };
  return {
    api, raw, get env() { return env; },
    async restart() { env.close(); env = await localStorageBindings(directory); worker = createWorker({ html: 'restarted' }); },
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
  await f.api(`${room.base}/settings`, { ...room.auth, poolId: uploaded.pool.id, picksPerBag: 1 }, room.host.token);
  await f.api(`${room.base}/pool/save`, { ...room.auth, poolName: 'Room saved pool' }, room.host.token);
  await f.restart();
  const view = await room.connect(room.host);
  assert.equal(view.room.draft.settings.pool.name, 'Room saved pool');
  await room.start();
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
    let usedMulligan = false;
    let usedBan = false;
    for (let step = 0; step < 50 && state.draft.status === 'active'; step++) {
      if (method === 'bag-passing-default') {
        for (const player of room.players) {
          state = (await room.connect(player)).room;
          if (state.draft.status === 'complete') break;
          const bag = state.draft.currentPlayer.currentBag;
          if (bag) state = await f.api(`${room.base}/draft/pick`, { playerId: player.id, bagId: bag.id, itemIds: bag.eligibleItemIds.slice(0, bag.requiredPickCount) }, player.token);
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
    assert.equal(state.draft.revealedDrafts.length, 2);
    for (const player of state.draft.revealedDrafts) assert.equal(player.items.length, 2);
    assert.equal(new Set(state.draft.revealedDrafts.flatMap(player => player.items.map(item => item.id))).size, 4);
    const exported = await f.api(`${room.base}/draft/export`);
    assert.ok(exported.ObjectStates.length > 0);
  }
});
