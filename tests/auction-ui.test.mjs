import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../services/frontend/index.html', import.meta.url), 'utf8');
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {}; this.value = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  focus() { this.focused = true; }
  scrollIntoView() {}
  get classList() { return { add: value => { this.className = `${this.className || ''} ${value}`; } }; }
}
function fixture(name) {
  const actions = [];
  const context = vm.createContext({
    document: { createElement: tag => new Element(tag) },
    auctionControls: new Element('div'), currentViewerId: 'speaker', auctionWildcardState: null,
    renderItemImage: item => Object.assign(new Element('image'), { textContent: item.name }),
    renderItemTools: () => new Element('tools'),
    getAuctionBidValues: () => ({ first: 4, second: 0, tie: 1 }),
    updateAuctionPendingBid() {}, postAuctionAction: (action, body) => actions.push({ action, body })
  });
  vm.runInContext(html.match(new RegExp(`^      function ${name}\\([^]*?^      }`, 'm'))[0], context);
  return { context, actions, render: auction => context[name](auction), root: context.auctionControls };
}
const auction = () => ({ speakerId: 'speaker', currentNomination: {
  wildcardItem: { id: 'wild', name: 'Wild Card' }, items: [{ id: 'wild' }],
  wildcardChoiceItems: [{ id: 'a', name: 'Élite Cruiser' }, { id: 'b', name: 'Heavy Cruiser' }, { id: 'c', name: 'Carrier II' }]
} });
const event = () => ({ preventDefault() {} });

test('wildcard search narrows live, handles accents and empty results, and submits only a visible choice', () => {
  const f = fixture('renderAuctionWildcardControls'); f.render(auction());
  const form = f.root.children[0], input = form.children[0].children[0];
  const [options, preview] = form.children[1].children, submit = form.children[3];
  assert.equal(options.children.length, 3);
  input.value = 'ELITE'; input.listeners.input();
  assert.equal(options.children.length, 1);
  assert.equal(options.children[0].textContent, 'Élite Cruiser');
  assert.equal(preview.children[0].textContent, 'Élite Cruiser');
  form.listeners.submit(event());
  assert.equal(f.actions[0].body.itemId, 'a');
  input.value = 'missing'; input.listeners.input();
  assert.equal(submit.disabled, true);
  assert.equal(preview.children.length, 0);
  form.listeners.submit(event()); assert.equal(f.actions.length, 1);
  input.value = 'carrier ii'; input.listeners.input();
  form.listeners.submit(event()); assert.equal(f.actions.at(-1).body.itemId, 'c');
});

test('hover previews do not accidentally select an item; keyboard choices and search survive same-draw updates', () => {
  const f = fixture('renderAuctionWildcardControls'); f.render(auction());
  const form = f.root.children[0], input = form.children[0].children[0];
  const [options, preview] = form.children[1].children;
  options.children[1].listeners.pointerenter();
  assert.equal(preview.children[0].textContent, 'Heavy Cruiser');
  form.listeners.submit(event()); assert.equal(f.actions[0].body.itemId, 'a');
  input.listeners.keydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(input.attributes['aria-activedescendant'], 'wildcard-option-b');
  form.listeners.submit(event()); assert.equal(f.actions.at(-1).body.itemId, 'b');
  input.value = 'cruiser'; input.listeners.input();
  f.render(auction());
  assert.equal(f.root.children[1].children[0].children[0].value, 'cruiser');
  const next = auction(); next.currentNomination.items.push({ id: 'new-draw' });
  f.render(next);
  assert.equal(f.root.children[2].children[0].children[0].value, '');
});

test('locked bids expose an unlock action and preserve values, while zero-credit automatic bids stay locked', () => {
  const f = fixture('renderAuctionBidControls');
  const state = { stage: 'bidding', players: [{}, {}], player: { credits: 40, auctionBidLocked: true } };
  f.render(state);
  let form = f.root.children[0], button = form.children.at(-1);
  assert.equal(button.textContent, 'Unlock Bids');
  assert.equal(button.disabled, false);
  assert.equal(form.children[1].children[1].value, 4);
  assert.equal(form.children[1].children[1].disabled, true);
  button.listeners.click(); assert.equal(f.actions[0].action, 'unlock-bid');
  form.listeners.submit(event()); assert.equal(f.actions.length, 1);
  state.player.credits = 0; f.render(state);
  assert.equal(f.root.children[1].children.at(-1).disabled, true);
  state.player = { credits: 40, auctionBidLocked: false }; f.render(state);
  form = f.root.children[2]; button = form.children.at(-1);
  assert.equal(button.textContent, 'Lock Bids');
  assert.equal(form.children[1].children[1].disabled, false);
  form.listeners.submit(event()); assert.equal(f.actions.at(-1).action, 'bid');
});
