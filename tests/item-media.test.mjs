import test from 'node:test';
import assert from 'node:assert/strict';
import registryModule from '../services/backend/poolRegistry.js';

const registry = () => registryModule.createPoolRegistry();
const card = (unique = false) => ({Name: 'CardCustom', Nickname: 'Unit II', CardID: 103,
  CustomDeck: {'1': {FaceURL: 'https://example.test/front.png', BackURL: 'http://cloud-3.steamusercontent.com/ugc/123/BACK/', NumWidth: 2, NumHeight: 2, UniqueBack: unique}}});
const tile = {Name: 'Custom_Model', Nickname: 'Home system', CustomMesh: {MeshURL: 'https://example.test/mesh.obj', DiffuseURL: 'https://example.test/tile.png'}};
const wrap = (type, items) => ({ObjectStates: [{Name: 'Bag', Nickname: 'Media pool', ContainedObjects: [{Name: 'Bag', Nickname: type, ContainedObjects: items}]}]});

test('card backs use a whole shared image or the matching unique-back sheet cell', () => {
  const pool = registry().parseTtsPool(wrap('Units', [card(false), card(true)]));
  assert.equal(pool.items[0].imageSecondaryUrl, 'https://steamusercontent-a.akamaihd.net/ugc/123/BACK/');
  assert.equal(pool.items[0].imageSecondarySheet, null);
  assert.deepEqual(pool.items[1].imageSecondarySheet, {columns: 2, rows: 2, index: 3});
  assert.deepEqual(pool.items[0].imageSheet, {columns: 2, rows: 2, index: 3});
});

test('system fronts and backs remain separate crops and tile secondary images are available on request', () => {
  const pool = registry().parseTtsPool(wrap('Home Systems', [tile, {Name: 'Custom_Tile', Nickname: 'Separate images', CustomImage: {ImageURL: 'https://example.test/front.png', ImageSecondaryURL: 'https://example.test/back.png'}}]));
  assert.deepEqual(pool.items[0].imageSheet, {columns: 2, rows: 1, index: 0});
  assert.deepEqual(pool.items[0].imageSecondarySheet, {columns: 2, rows: 1, index: 1});
  assert.equal(pool.items[0].imageSecondaryUrl, pool.items[0].imageUrl);
  assert.equal(pool.items[1].imageSecondaryUrl, 'https://example.test/back.png');
  assert.equal(pool.items[1].imageSecondarySheet, null);
  const otherModel = registry().parseTtsPool(wrap('Mechs', [tile]));
  assert.equal(otherModel.items[0].imageSecondaryUrl, null, 'unknown meshes do not invent a backside');
});

test('saved pools recover previously omitted backs without editing their original TTS objects or attachment rules', () => {
  const raw = wrap('Home Systems', [{...tile, Description: 'Non-draft: Token\nBase Unit: Unit I'}]);
  raw.ObjectStates[0].ContainedObjects.push(
    {Name: 'Bag', Nickname: 'Non-draft parts', ContainedObjects: [{Name: 'Bag', Nickname: 'Home system', ContainedObjects: [
      {Name: 'Custom_Tile', Nickname: 'Token', CustomImage: {ImageURL: 'https://example.test/token.png'}},
      {...card(true), Nickname: 'Unit I'}
    ]}]}
  );
  const original = registry().parseTtsPool(raw);
  original.items[0].imageSecondaryUrl = null;
  for (const item of [original.items[0], ...original.items[0].linkedItems]) delete item.imageSecondarySheet;
  const before = structuredClone(original);
  const recovered = registryModule.createPoolRegistry({initialPools: [original]}).getPool(original.id);
  assert.deepEqual(recovered.items[0].imageSecondarySheet, {columns: 2, rows: 1, index: 1});
  assert.deepEqual(recovered.items[0].linkedItems.map(item => item.name), ['Token', 'Unit I']);
  assert.deepEqual(recovered.items[0].linkedItems[1].imageSecondarySheet, {columns: 2, rows: 2, index: 3});
  assert.deepEqual(recovered.items[0].ttsObject, before.items[0].ttsObject);
  assert.deepEqual(original, before);
});
