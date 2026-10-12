import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../services/backend/draftEngine.js', import.meta.url), 'utf8');
const context = vm.createContext({});
for (const name of ['countDraftedByType', 'getRemainingTypeCapacity', 'isFirstRotationPick', 'getSelectionTypeLimit',
  'countItemsByType', 'getSelectableTypeLimits', 'getRequiredPickCount', 'getAutomaticPickIds']) {
  vm.runInContext(source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))[0], context);
}
const item = (id, type = 'Units') => ({ id, type });
function view(items, options = {}) {
  const player = { id: 'a', draftedItems: [], pickCount: 4, initialBagPickCount: 1, ...options.player };
  const draft = { players: [player, { id: 'b' }], picksPerBag: 3, itemsPerType: { Units: 3, Tech: 2 }, ...options.draft };
  return context.getAutomaticPickIds(player, { originalPlayerId: 'a', items }, draft);
}

test('automatic picks use the configured K and never choose between individually legal alternatives', () => {
  assert.deepEqual([...view([item('u1'), item('u2'), item('t1', 'Tech')])], ['u1', 'u2', 't1']);
  assert.equal(view([item('u1'), item('u2')], { draft: { picksPerBag: 1 } }), null);
  assert.equal(view([item('u1'), item('u2')], { player: { draftedItems: [item('picked1'), item('picked2')] } }), null);
  assert.equal(view([item('u1'), item('u2')], { player: { pickCount: 0, initialBagPickCount: 0 } }), null);
});

test('automatic picks ignore capped types, respect the first rotation, and allow forced empty passes', () => {
  assert.deepEqual([...view([item('u1'), item('t1', 'Tech')], { player: { pickCount: 0, initialBagPickCount: 0 } })], ['u1', 't1']);
  const player = { draftedItems: [item('p1'), item('p2'), item('p3')] };
  assert.deepEqual([...view([item('u1'), item('t1', 'Tech')], { player })], ['t1']);
  assert.deepEqual([...view([item('u1')], { player })], []);
  assert.deepEqual([...view([], { player })], []);
});
