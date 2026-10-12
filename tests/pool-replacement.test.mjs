import test from 'node:test';
import assert from 'node:assert/strict';
import registryModule from '../services/backend/poolRegistry.js';

const tile = Nickname => ({Name: 'Custom_Tile', Nickname, CustomImage: {ImageURL: 'https://example.test/' + encodeURIComponent(Nickname)}});
const bag = (Nickname, ContainedObjects, color) => ({Name: 'Bag', Nickname, ContainedObjects, ...(color ? {ColorDiffuse: color} : {})});
const raw = (name, types) => ({ObjectStates: [bag(name, types.map(type => bag(type, [tile(`${type} old`)])))]});

test('replacement keeps pool identity and settings, removes missing types and appends new ones in import order', () => {
  const registry = registryModule.createPoolRegistry();
  const old = registry.registerUploadedTtsPool(raw('Original', ['Units', 'Abilities', 'Removed']), 'test', {
    public: true, name: 'Keep this name', defaultParameters: {
      maxSeats: 5, picksPerBag: 4, auctionSpeakerMode: 'autopick',
      typeOrder: ['Abilities', 'Speaker Order', 'Units', 'Removed'],
      itemsPerType: {Units: 4, Abilities: 0, Removed: 3, 'Speaker Order': 0}
    }
  });
  const before = structuredClone(old);
  const source = {ObjectStates: [bag('New file name', [
    bag('Units', [tile('Transport II')], {r: 1, g: 0, b: 0}),
    bag('New type B', [tile('New B')]), bag('Abilities', [tile('New ability')]), bag('New type A', [tile('New A')]),
    bag('Base Units', [tile('Transport I')]), bag('Non-draft parts', [bag('Transport II', [tile('Token')])])
  ])]};
  const replaced = registry.replacePublicTtsPool(old.id, source);
  assert.equal(replaced.id, old.id);
  assert.equal(replaced.name, old.name);
  assert.equal(replaced.public, true);
  assert.equal(registry.listPublicPools().length, 1);
  assert.deepEqual(replaced.defaultParameters, {
    maxSeats: 5, picksPerBag: 4, auctionSpeakerMode: 'autopick',
    typeOrder: ['Abilities', 'Speaker Order', 'Units', 'New type B', 'New type A'],
    itemsPerType: {Units: 4, 'New type B': 2, Abilities: 0, 'New type A': 2, 'Speaker Order': 0}
  });
  assert.deepEqual(replaced.items[0].linkedItems.map(item => item.name), ['Token', 'Transport I']);
  assert.deepEqual(replaced.exportBagColors.types.Units, {r: 1, g: 0, b: 0});
  assert.ok(replaced.items.every(item => item.id.startsWith(old.id + '-')));
  assert.deepEqual(old, before, 'existing snapshots are immutable');
  const reload = registryModule.createPoolRegistry({initialPools: [registry.serializePool(replaced)]});
  assert.deepEqual(reload.getPool(old.id), replaced);
});

test('unchanged item types retain every value and their exact order on repeated replacement', () => {
  const registry = registryModule.createPoolRegistry();
  const old = registry.registerUploadedTtsPool(raw('Pool', ['A', 'B']), 'test', {public: true, defaultParameters: {
    maxSeats: 12, picksPerBag: 8, auctionSpeakerMode: 'none', typeOrder: ['B', 'A', 'Speaker Order'], itemsPerType: {A: 0, B: 10, 'Speaker Order': 1}
  }});
  for (const name of ['New source', 'Another source']) {
    const updated = registry.replacePublicTtsPool(old.id, raw(name, ['B', 'A']));
    assert.deepEqual(updated.defaultParameters, old.defaultParameters);
    assert.equal(updated.items.length, 2);
    assert.equal(registry.draftPools.size, 1);
  }
  const current = registry.getPool(old.id);
  for (const invalid of [null, {}, {ObjectStates: []}, {ObjectStates: [{ContainedObjects: {}}]}, raw('Empty', [])]) {
    assert.equal(registry.replacePublicTtsPool(old.id, invalid), null);
    assert.equal(registry.getPool(old.id), current);
  }
  const privatePool = registry.registerUploadedTtsPool(raw('Private', ['A']), 'test');
  assert.equal(registry.replacePublicTtsPool(privatePool.id, raw('Replacement', ['B'])), null);
  assert.equal(registry.getPool(privatePool.id), privatePool);
});
