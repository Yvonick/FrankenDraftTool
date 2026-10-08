import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../services/frontend/history.js', import.meta.url), 'utf8');
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.textContent = ''; this.className = ''; this.hidden = false; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
  addEventListener() {}
  querySelector(tag) { return this.children.find(child => child.tag === tag) || this.children.map(child => child.querySelector(tag)).find(Boolean); }
  get classList() { return { contains: name => this.className.split(' ').includes(name), add: name => { this.className += ` ${name}`; } }; }
}
function fixture() {
  const elements = new Map();
  const context = vm.createContext({
    document: { createElement: tag => new Element(tag), querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector);
    } }, URLSearchParams, location: {search: ''}
  });
  vm.runInContext(source.replace('  run(openArchive);', '  globalThis.historyUI = {renderEvent, renderResults, markUndone, lock};'), context);
  return { ...context.historyUI, elements };
}
const text = element => [element.textContent, ...element.children.map(text)].join(' ');

test('history renders full bid values by identity even when players share a name, and marks undone picks', () => {
  const ui = fixture();
  const event = ui.renderEvent({sequence: 1, at: Date.now(), kind: 'auction_pick', actor: '<script>Example</script>',
    type: 'Units', items: [{name: 'Unit II'}], cost: 7, bidRecap: {
      bids: [{playerId: 'a', player: 'Same', first: 7, second: 0, tie: 1}, {playerId: 'b', player: 'Same', first: 2, second: 0, tie: 4}],
      pickOrder: [{playerId: 'a', player: 'Same', position: 1, cost: 7, bidKind: 'first'}, {playerId: 'b', player: 'Same', position: 2, cost: 4, bidKind: 'tie'}]
    }});
  const body = event.querySelector('tbody');
  assert.deepEqual(body.children.map(row => row.children[2].textContent), [7, 2]);
  assert.match(text(event), /<script>Example<\/script>/);
  assert.equal(event.querySelector('script'), undefined, 'names remain text, never HTML');
  ui.renderEvent({sequence: 2, at: Date.now(), kind: 'undo', targetSequence: 1});
  ui.markUndone();
  assert.ok(event.classList.contains('is-undone'));
  assert.match(text(event), /Undone by #2/);
});

test('archive results group all picked items by type with their cost and locking clears sensitive content', () => {
  const ui = fixture();
  const rendered = ui.renderResults({settings: {typeOrder: ['Units', 'Abilities']}, results: {
    speakerOrder: [], players: [{id: 'a', name: 'Alice', seat: 1, credits: 33, items: [
      {name: 'Unit II', type: 'Units', cost: 7}, {name: 'Fleet Ability', type: 'Abilities', cost: 0}
    ]}], permanentBin: [{name: 'Unused unit'}], discardedItems: []
  }});
  assert.match(text(rendered), /Unit II 7 cr/);
  assert.match(text(rendered), /Fleet Ability 0 cr/);
  assert.match(text(rendered), /33 credits remaining/);
  ui.lock();
  assert.equal(ui.elements.get('#detail').hidden, true);
  assert.equal(ui.elements.get('#login').hidden, false);
  assert.equal(ui.elements.get('#detail').children.length, 0);
  assert.equal(ui.elements.get('#draft-list').children.length, 0);
});
