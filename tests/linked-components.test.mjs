import test from 'node:test';
import assert from 'node:assert/strict';
import registryModule from '../services/backend/poolRegistry.js';

const registry = () => registryModule.createPoolRegistry();
const tile = (name, extra = {}) => ({Name: 'Custom_Tile', Nickname: name, CustomImage: {ImageURL: `https://example.test/${encodeURIComponent(name)}.png`}, ...extra});
const bag = (name, items) => ({Name: 'Bag', Nickname: name, ContainedObjects: items});
const pool = bags => ({ObjectStates: [bag('Linked components', bags)]});

test('named non-draft bags link across all types, independent of descriptions', () => {
  const raw = pool([
    bag('Abilities', [tile('Ability', {Description: 'Non-draft: Unrelated\nBase Unit: Wrong'})]),
    bag('Techs', [tile('Unit II')]),
    bag('Non Draft Parts', [bag(' ability ', [tile('Token')]), bag('UNIT   II', [tile('Unit I')]), tile('Unrelated'), bag('Typo', [tile('Unused')])]),
    bag('Base Units', [tile('Wrong')])
  ]);
  const before = structuredClone(raw);
  const parsed = registry().parseTtsPool(raw);
  assert.deepEqual(parsed.types, ['Abilities', 'Techs']);
  assert.deepEqual(parsed.items.map(item => item.linkedItems.map(link => link.name)), [['Token'], ['Unit I']]);
  assert.equal(parsed.items[0].content, raw.ObjectStates[0].ContainedObjects[0].ContainedObjects[0].Description);
  assert.deepEqual(parsed.unmatchedLinkedBags, ['Typo']);
  assert.deepEqual(raw, before);
  const oldFormat = registry().parseTtsPool(pool([bag('Abilities', [tile('Ability', {Description: 'Non-draft: Token'})]), bag('Non-draft parts', [tile('Token')])]));
  assert.deepEqual(oldFormat.items[0].linkedItems, [], 'new imports do not infer links from descriptions');
});

test('all copies and containers are retained for export with lightweight nested previews', () => {
  const deck = {Name: 'DeckCustom', Nickname: 'Cards', ContainedObjects: [tile('Card A'), tile('Card B')]};
  const contents = [tile('Token'), tile('Token'), bag('Nested bag', [deck]), {Name: 'Die_10', Nickname: 'Omen Die'}];
  const raw = pool([bag('Abilities', [tile('Ability')]), bag('Non-draft parts', [bag('Ability', contents), bag('Ability', [tile('Extra')])])]);
  const parsed = registry().parseTtsPool(raw);
  const linked = parsed.items[0].linkedItems;
  assert.deepEqual(linked.slice(0, 4).map(item => item.ttsObject), contents);
  assert.equal(linked.length, 5, 'matching bags combine their contents without removing repeated copies');
  const nested = linked[2].containedItems[0];
  assert.equal(nested.name, 'Cards');
  assert.deepEqual(nested.containedItems.map(item => item.name), ['Card A', 'Card B']);
  assert.doesNotMatch(JSON.stringify(nested), /ttsObject|ContainedObjects/);
  assert.equal(linked[3].imageUrl, null, 'objects without an image still belong to the export');
  const ids = linked.flatMap(item => [item.id, ...(item.containedItems || []).flatMap(child => [child.id, ...(child.containedItems || []).map(leaf => leaf.id)])]);
  assert.equal(new Set(ids).size, ids.length);
  const serialized = registry().serializePool(parsed);
  const restored = registryModule.createPoolRegistry({initialPools: [serialized]}).getPool(parsed.id);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.items)), JSON.parse(JSON.stringify(parsed.items)));
});

test('existing saved links are preserved rather than reinterpreted using new import rules', () => {
  const old = registry().parseTtsPool(pool([bag('Abilities', [tile('Old ability')])]));
  old.items[0].linkedItems = [{id: 'old-linked-item', name: 'Old token', type: 'Non-draft', ttsObject: tile('Old token')}];
  const restored = registryModule.createPoolRegistry({initialPools: [old]}).getPool(old.id);
  assert.equal(restored.items[0].linkedItems[0].name, 'Old token');
  assert.deepEqual(restored.items[0].linkedItems[0].ttsObject, tile('Old token'));
});

test('Base Unit bags link exact I/II names across types without drafting the base units', () => {
  const base = tile('  SUPER-DREADNOUGHT   I  ', {LuaScript: 'original base script'});
  const raw = pool([
    bag('Techs', [tile('Super-Dreadnought II'), tile('Unit III'), tile('Missing II'), tile('Unit I')]),
    bag('Mechs', [tile('Other II')]),
    bag('Base Unit Tiles', [base, tile('Unit I'), bag('Nested', [tile('Other I')])]),
    bag('Non-draft parts', [bag('Super-Dreadnought II', [tile('Token')])])
  ]);
  const before = structuredClone(raw);
  const parsed = registry().parseTtsPool(raw);
  assert.deepEqual(parsed.types, ['Techs', 'Mechs']);
  assert.deepEqual(parsed.items.map(item => item.linkedItems.map(link => link.name)), [
    ['Token', 'SUPER-DREADNOUGHT   I'], [], [], [], ['Other I']
  ]);
  assert.deepEqual(parsed.items[0].linkedItems[1].ttsObject, base);
  assert.equal(parsed.items[0].linkedItems[1].type, 'Base Unit');
  assert.deepEqual(raw, before);
});

test('explicit linked base units take precedence, including nested contents; ambiguous bases are not guessed', () => {
  const parsed = registry().parseTtsPool(pool([
    bag('Techs', [tile('Direct II'), tile('Nested II'), tile('Ambiguous II')]),
    bag('Non-draft parts', [bag('Direct II', [tile('Direct I'), tile('Direct I')]), bag('Nested II', [bag('Parts', [tile('Nested I')])])]),
    bag('Base Units', [tile('Direct I'), tile('Nested I'), tile('Ambiguous I'), tile('Ambiguous I', {Description: 'Another variant'})])
  ]));
  assert.deepEqual(parsed.items.map(item => item.linkedItems.length), [2, 1, 0]);
});

test('saved pool base-unit repair preserves IDs, explicit parts and settings, is idempotent and rejects unrelated sources', () => {
  const raw = pool([bag('Techs', [tile('Unit II')]), bag('Non-draft parts', [bag('Unit II', [tile('Token')])])]);
  const pools = registry();
  const saved = pools.registerUploadedTtsPool(raw, 'test', {public: true, name: 'Renamed', defaultParameters: {maxSeats: 4, picksPerBag: 2, typeOrder: ['Speaker Order', 'Techs']}});
  const before = structuredClone(saved);
  raw.ObjectStates[0].ContainedObjects.push(bag('Base Unit Tiles', [tile('Unit I')]));
  const repaired = pools.updatePublicPool(saved.id, {baseUnitSource: raw});
  assert.deepEqual(repaired.items[0].linkedItems.map(item => item.name), ['Token', 'Unit I']);
  assert.equal(repaired.id, saved.id);
  assert.equal(repaired.items[0].id, saved.items[0].id);
  assert.deepEqual(repaired.defaultParameters, saved.defaultParameters);
  assert.equal(repaired.name, 'Renamed');
  assert.deepEqual(saved, before, 'an already-pinned pool is immutable');
  assert.deepEqual(pools.updatePublicPool(saved.id, {baseUnitSource: raw}), repaired);
  raw.ObjectStates[0].ContainedObjects[0].ContainedObjects[0].Nickname = 'Different II';
  assert.equal(pools.updatePublicPool(saved.id, {baseUnitSource: raw}), null);
  assert.deepEqual(pools.getPool(saved.id), repaired);
  const restored = registryModule.createPoolRegistry({initialPools: [pools.serializePool(repaired)]}).getPool(saved.id);
  assert.deepEqual(restored.items[0].linkedItems, repaired.items[0].linkedItems);
});
