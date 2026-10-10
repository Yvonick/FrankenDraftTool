import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../services/frontend/history.js', import.meta.url), 'utf8');
test('logs login uses compact wording and keeps an accessible password field', async () => {
  const html = await readFile(new URL('../services/frontend/history.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../services/frontend/history.css', import.meta.url), 'utf8');
  assert.match(html, /<h1>Draft Logs<\/h1>/);
  assert.match(html, /aria-label="Password" type="password"/);
  assert.match(html, /<button>Submit<\/button>/);
  assert.doesNotMatch(html, /Archive passkey|Unlock Archive|<label/);
  assert.match(source, /Enter the password to access the logs/);
  assert.match(css, /#login \{ max-width: 32rem; margin: 0; \}/);
});
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.textContent = ''; this.className = ''; this.hidden = false; this.listeners = {}; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  querySelector(tag) { return this.children.find(child => child.tag === tag) || this.children.map(child => child.querySelector(tag)).find(Boolean); }
  get classList() { return { contains: name => this.className.split(' ').includes(name), add: name => { this.className += ` ${name}`; } }; }
}
function fixture(fetch) {
  const elements = new Map();
  const context = vm.createContext({
    document: { createElement: tag => new Element(tag), querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector);
    } }, URLSearchParams, location: {search: ''}, fetch
  });
  vm.runInContext(source.replace('  run(openArchive);', '  globalThis.historyUI = {renderEvent, renderResults, renderBag, openBag, closeBag, markUndone, lock};'), context);
  return { ...context.historyUI, elements };
}
const text = element => [element.textContent, ...element.children.map(text)].join(' ');

test('bag buttons use player ids for opening bags and event numbers for pick and pass views', () => {
  const ui = fixture();
  const results = {speakerOrder: [], players: [{id: 'player-a', name: 'Same name', seat: 1, items: []}]};
  const bagDraft = ui.renderResults({id: 'draft-id', engine: 'bag-pass', settings: {typeOrder: []}, results});
  assert.equal(bagDraft.querySelector('button').textContent, 'View Opening Bag');
  const auction = ui.renderResults({engine: 'auction', settings: {typeOrder: []}, results});
  assert.equal(auction.querySelector('button'), undefined);
  for (const kind of ['bag_pick', 'bag_pass']) {
    const event = ui.renderEvent({kind, sequence: 12, at: Date.now(), items: []});
    assert.equal(event.querySelector('button').textContent, 'View Bag');
  }
  const event = ui.renderEvent({kind: 'auction_pick', sequence: 13, at: Date.now(), items: []});
  assert.equal(event.querySelector('button'), undefined);
});

test('bag viewer groups items in pool order and distinguishes selected items without HTML injection', () => {
  const ui = fixture();
  const content = ui.renderBag({available: true, opening: false, typeOrder: ['Units', 'Abilities'], items: [
    {id: 'a', type: 'Abilities', name: '<script>Ability</script>', selected: false},
    {id: 'b', type: 'Units', name: 'Unit II', selected: true}
  ]});
  assert.match(text(content), /2 items \/ 1 picked this turn/);
  assert.match(text(content), /Units \(1\).*Unit II Picked.*Abilities \(1\)/);
  assert.equal(content.querySelector('li').className, 'picked');
  assert.equal(content.querySelector('script'), undefined);
  assert.match(text(ui.renderBag({available: false})), /did not record the opening bags/);
});

test('bag modal loads on demand and a closed or locked modal cannot be repopulated by a delayed response', async () => {
  let finish, requested;
  const ui = fixture(path => { requested = path; return new Promise(resolve => { finish = resolve; }); });
  const pending = ui.openBag({sequence: 7}, 'draft-id');
  assert.equal(requested, '/api/draft-history/draft-id/bag?sequence=7');
  assert.equal(ui.elements.get('#bag-dialog').open, true);
  ui.closeBag();
  finish({ok: true, json: async () => ({available: true, player: 'Hidden', items: [], typeOrder: []})});
  await pending;
  assert.equal(ui.elements.get('#bag-content').children.length, 0);
  const second = ui.openBag({player: 'player-id'}, 'draft-id');
  assert.equal(requested, '/api/draft-history/draft-id/bag?player=player-id');
  ui.lock();
  finish({ok: true, json: async () => ({available: true, player: 'Hidden', items: [], typeOrder: []})});
  await second;
  assert.equal(ui.elements.get('#bag-dialog').open, false);
  assert.equal(ui.elements.get('#bag-content').children.length, 0);
});

test('bag modal shows a recoverable load error and returns to login when the session expires', async () => {
  const ui = fixture(async () => ({ok: false, status: 503, json: async () => ({error: 'unavailable'})}));
  await ui.openBag({sequence: 7}, 'draft-id');
  assert.match(text(ui.elements.get('#bag-content')), /Unable to load this bag/);
  const expired = fixture(async () => ({ok: false, status: 401, json: async () => ({error: 'history_passkey_required'})}));
  await expired.openBag({sequence: 7}, 'draft-id');
  assert.equal(expired.elements.get('#bag-dialog').open, false);
  assert.equal(expired.elements.get('#login').hidden, false);
  assert.match(expired.elements.get('#message').textContent, /Enter the password/);
});

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
