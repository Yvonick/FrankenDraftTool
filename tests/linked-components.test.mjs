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
