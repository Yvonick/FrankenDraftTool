import test from 'node:test';
import assert from 'node:assert/strict';
import registryModule from '../services/backend/poolRegistry.js';

const bag = (Nickname, ContainedObjects, ColorDiffuse) => ({Name: 'Bag', Nickname, ContainedObjects, ...(ColorDiffuse ? {ColorDiffuse} : {})});
const tile = Nickname => ({Name: 'Custom_Tile', Nickname, CustomImage: {ImageURL: 'https://example.test/item.png'}});

test('imported root and type bag colors survive private saves, renames, reordering and serialization', () => {
  const red = {r: 1, g: 0.01, b: 0.2, a: 0.8}, black = {r: 0, g: 0, b: 0};
  const raw = {ObjectStates: [bag('Colored pool', [bag('Units', [tile('Unit')], red), bag('Abilities', [tile('Ability')], black)], black)]};
  const original = structuredClone(raw);
  const registry = registryModule.createPoolRegistry();
  const pool = registry.registerUploadedTtsPool(raw, 'test');
  assert.equal(pool.public, false);
  const expected = {root: black, types: {Units: red, Abilities: black}};
  assert.deepEqual(pool.exportBagColors, expected);
  const saved = registry.savePool(pool.id, {name: 'Renamed pool', defaultParameters: {typeOrder: ['Abilities', 'Speaker Order', 'Units']}});
  const serialized = registry.serializePool(saved);
  const restored = registryModule.createPoolRegistry({initialPools: [serialized]}).getPool(pool.id);
  assert.deepEqual(restored.exportBagColors, expected);
  assert.deepEqual(restored.defaultParameters.typeOrder, ['Abilities', 'Speaker Order', 'Units']);
  assert.deepEqual(raw, original);
  serialized.exportBagColors.types.Units.r = 0;
  assert.equal(pool.exportBagColors.types.Units.r, 1, 'serialized color objects are independent');
});

test('missing and malformed colors leave the exporter fallback available', () => {
  const raw = {ObjectStates: [bag('Old pool', [bag('Units', [tile('Unit')], {r: 'red', g: 0, b: 0})])]};
  const registry = registryModule.createPoolRegistry();
  assert.deepEqual(registry.parseTtsPool(raw).exportBagColors, {root: null, types: {}});
  const legacy = registry.parseTtsPool(raw);
  delete legacy.exportBagColors;
  const saved = registry.serializePool(legacy);
  assert.equal(saved.exportBagColors, undefined);
});
