import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../services/frontend/room-identity.js', import.meta.url), 'utf8');
const storage = () => { const values = new Map(); return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) }; };
function tab(localStorage, sessionStorage = storage()) {
  sessionStorage.setItem('frankenDraftTool:sessionToken', sessionStorage.getItem('frankenDraftTool:sessionToken') || crypto.randomUUID());
  const context = { window: {}, localStorage, sessionStorage, URL, URLSearchParams, crypto, location: { origin: 'https://draft.test', hash: '' } };
  vm.runInNewContext(source, context);
  return { identity: context.window.frankenRoomIdentity, sessionStorage, location: context.location };
}
test('closing and reopening a tab restores its room identity and authentication secret', () => {
  const browser = storage(), first = tab(browser);
  const key = 'room:123456:';
  first.identity.setItem(key + 'participantId', 'player-a'); first.identity.setItem(key + 'role', 'seated'); first.identity.setItem(key + 'name', 'Alice');
  const original = first.identity.tokenFor('/api/rooms/123456/presence', 'none');
  const reopened = tab(browser);
  assert.equal(reopened.identity.getItem(key + 'participantId'), 'player-a');
  assert.equal(reopened.identity.getItem(key + 'role'), 'seated');
  assert.equal(reopened.identity.tokenFor('/api/rooms/123456/draft/pick', 'new-tab-token'), original);
  assert.notEqual(reopened.sessionStorage.getItem('frankenDraftTool:sessionToken'), original);
});
test('private browser contexts stay independent, while existing legacy tabs migrate their own seats', () => {
  const a = tab(storage()), b = tab(storage());
  a.identity.setItem('room:123456:participantId', 'alice'); b.identity.setItem('room:123456:participantId', 'bob');
  assert.notEqual(a.identity.tokenFor('/api/rooms/123456', ''), b.identity.tokenFor('/api/rooms/123456', ''));
  const browser = storage(), legacyA = storage(), legacyB = storage();
  for (const [store, id] of [[legacyA, 'alice'], [legacyB, 'bob']]) {
    store.setItem('room:123456:participantId', id); store.setItem('room:123456:role', 'seated');
    store.setItem('frankenDraftTool:sessionToken', id + '-token');
  }
  const oldA = tab(browser, legacyA), oldB = tab(browser, legacyB);
  assert.equal(oldA.identity.getItem('room:123456:participantId'), 'alice');
  assert.equal(oldB.identity.getItem('room:123456:participantId'), 'bob');
  assert.equal(oldA.identity.tokenFor('/api/rooms/123456', ''), 'alice-token');
  assert.equal(oldB.identity.tokenFor('/api/rooms/123456', ''), 'bob-token');
});
test('revoking an old tab cannot erase a newly adopted room identity or resurrect legacy credentials', () => {
  const browser = storage(), first = tab(browser);
  first.identity.setItem('room:123456:participantId', 'old');
  const other = tab(browser); other.identity.getItem('room:123456:participantId');
  first.identity.adopt('123456', { participantId: 'new', name: 'Alice', role: 'spectator' }, 'original-secret', 'host-secret');
  other.identity.clear('123456');
  assert.equal(other.identity.getItem('room:123456:participantId'), null);
  const reopened = tab(browser);
  assert.equal(reopened.identity.getItem('room:123456:participantId'), 'new');
  assert.equal(reopened.identity.tokenFor('/api/rooms/123456/presence', ''), 'original-secret');
  assert.equal(reopened.identity.getItem('room:123456:creatorToken'), 'host-secret');
});

test('additional player tabs share a browser but keep separate recoverable identities', () => {
  const browser = storage(), first = tab(browser);
  first.identity.setItem('room:123456:participantId', 'original');
  const second = tab(browser);
  second.identity.fork('123456'); second.identity.setItem('room:123456:participantId', 'test-player');
  assert.equal(tab(browser).identity.getItem('room:123456:participantId'), 'original');
  assert.notEqual(second.identity.tokenFor('/api/rooms/123456', ''), first.identity.tokenFor('/api/rooms/123456', ''));
  const reopened = tab(browser); reopened.location.hash = '#player=test-player';
  assert.equal(reopened.identity.getItem('room:123456:participantId'), 'test-player');
  assert.equal(reopened.identity.tokenFor('/api/rooms/123456', ''), second.identity.tokenFor('/api/rooms/123456', ''));
  reopened.identity.clear('123456'); reopened.location.hash = '';
  assert.equal(reopened.identity.getItem('room:123456:participantId'), null);
  assert.equal(tab(browser).identity.getItem('room:123456:participantId'), 'original');
});

test('an old tab cannot clear a replacement credential for the same stable seat', () => {
  const browser = storage(), old = tab(browser);
  old.identity.adopt('123456', { participantId: 'stable-seat', role: 'seated' }, 'old-secret');
  const replacement = tab(browser);
  replacement.identity.adopt('123456', { participantId: 'stable-seat', role: 'seated' }, 'new-secret');
  old.identity.clear('123456');
  assert.equal(tab(browser).identity.tokenFor('/api/rooms/123456', ''), 'new-secret');
});
