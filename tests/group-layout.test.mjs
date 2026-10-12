import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../services/frontend/group-layout.js', import.meta.url), 'utf8');

function element(count = 1, height = 200) {
  const values = new Map([['--group-columns', count]]);
  return {
    nodeType: 1, height, isConnected: true, children: [],
    classList: { contains: name => name === 'group-section', add() {}, toggle() {} },
    style: { setProperty: (key, value) => values.set(key, value), getPropertyValue: key => values.get(key) },
    querySelectorAll: () => [], querySelector: () => null, matches: () => true,
    getBoundingClientRect() { return { height: this.height }; }
  };
}

function fixture(groups = [element(2, 380), element(2, 140)], createElement) {
  const [first, second] = groups;
  const container = { ...element(), id: 'current-bag', clientWidth: 1100, children: groups };
  let containers = [container], mutation;
  const observers = [], listeners = {};
  const context = {
    document: { querySelector: () => ({}), querySelectorAll: () => containers, createElement },
    window: { innerWidth: 1920, addEventListener: (name, callback) => { listeners[name] = callback; } },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
      observe(target) { this.targets.add(target); }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
    },
    MutationObserver: class {
      constructor(callback) { mutation = callback; }
      observe() {} disconnect() {}
    }
  };
  vm.runInNewContext(source, context);
  return { context, container, first, second, observers, listeners,
    refresh() { mutation([{ addedNodes: [container], removedNodes: [] }]); },
    detach() { container.isConnected = false; containers = []; mutation([{ addedNodes: [], removedNodes: [container] }]); }
  };
}

test('group layout fits available columns without masonry row spans or replacing cards', () => {
  const f = fixture();
  assert.equal(f.container.style.getPropertyValue('--layout-columns'), 6);
  assert.equal(f.first.style.getPropertyValue('--group-span'), 2);
  assert.equal(f.first.style.gridRowEnd, undefined);
  assert.equal(f.second.style.gridRowEnd, undefined);
  f.second.height = 240;
  f.observers[0].callback();
  assert.equal(f.second.style.gridRowEnd, undefined);
  assert.equal(f.container.children[0], f.first, 'cards are never replaced during layout');
  f.container.clientWidth = 343; f.context.window.innerWidth = 390;
  f.observers[0].callback();
  assert.equal(f.container.style.getPropertyValue('--layout-columns'), 2);
  f.container.clientWidth = 210;
  f.observers[0].callback();
  assert.equal(f.first.style.getPropertyValue('--group-span'), 1);
});

test('large types fill the available row before the following speaker-order category', () => {
  const f = fixture();
  f.first.style.setProperty('--group-columns', 8);
  f.second.style.setProperty('--group-columns', 1);
  for (const [width, columns, span] of [[1300, 7, 7], [1100, 6, 6], [1700, 9, 8], [600, 3, 3]]) {
    f.container.clientWidth = width;
    f.observers[0].callback();
    assert.equal(f.container.style.getPropertyValue('--layout-columns'), columns);
    assert.equal(f.first.style.getPropertyValue('--group-span'), span);
    assert.equal(f.second.style.getPropertyValue('--group-span'), 1);
    assert.deepEqual(f.container.children, [f.first, f.second]);
  }
});

test('group grids keep source order instead of filling earlier holes with later types', async () => {
  const css = await readFile(new URL('../services/frontend/polish.css', import.meta.url), 'utf8');
  const rule = css.match(/\.item-grid\.compact-groups\s*\{([^}]+)\}/)[1];
  assert.match(rule, /grid-auto-flow:\s*row\s*;/);
  assert.doesNotMatch(rule, /dense|grid-auto-rows:\s*4px/);
  assert.match(rule, /justify-content:\s*start/);
});

test('bag, drafted items and nomination use the same card scale', () => {
  const f = fixture();
  for (const id of ['current-bag', 'private-drafted-items', 'auction-items']) {
    f.container.id = id;
    f.container.clientWidth = 600;
    f.observers[0].callback();
    assert.equal(f.container.style.getPropertyValue('--layout-columns'), 3);
    f.container.clientWidth = 330;
    f.observers[0].callback();
    assert.equal(f.container.style.getPropertyValue('--layout-columns'), 1);
  }
});

test('layout observers release replaced groups and detached containers, and resume after back navigation', () => {
  const f = fixture();
  f.container.children = [f.first];
  f.refresh();
  assert.equal(f.observers[0].targets.has(f.second), false);
  f.listeners.pagehide();
  assert.equal(f.observers[0].targets.size, 0);
  f.listeners.pageshow({ persisted: true });
  assert.equal(f.observers[1].targets.has(f.first), true);
  f.detach();
  assert.equal(f.observers[1].targets.size, 0);
});

function packedFixture(counts) {
  function node() {
    const values = new Map();
    return {
      textContent: '', attributes: {},
      classList: { contains: name => name === 'item-card' },
      style: { setProperty: (key, value) => values.set(key, value), getPropertyValue: key => values.get(key) },
      setAttribute(key, value) { this.attributes[key] = value; }
    };
  }
  const groups = counts.map((count, index) => {
    const heading = { ...node(), textContent: `Type ${index}` };
    const cards = Array.from({ length: count }, node), continuations = [];
    return {
      heading, cards, continuations,
      classList: { contains: name => name === 'group-section' },
      querySelector: selector => selector === ':scope > h4' ? heading : { children: cards },
      querySelectorAll: () => continuations,
      append(title) {
        continuations.push(title);
        title.remove = () => continuations.splice(continuations.indexOf(title), 1);
      }
    };
  });
  const context = vm.createContext({ document: { createElement: node } });
  vm.runInContext(source.match(/^  function packGroups\([^]*?^  }/m)[0], context);
  return { groups, createElement: node, pack: columns => context.packGroups(groups, columns) };
}

test('categories share every column in reading order, including rows that used to leave the seventh cell empty', () => {
  const f = packedFixture([4, 2, 2, 5, 4, 2, 2, 2, 2, 1]);
  const live = fixture(f.groups, f.createElement);
  live.container.clientWidth = 1300;
  live.observers[0].callback();
  const cards = f.groups.flatMap(group => group.cards);
  cards.forEach((card, index) => {
    assert.equal(card.style.getPropertyValue('--packed-column'), index % 7 + 1);
    assert.equal(card.style.getPropertyValue('--packed-row'), Math.floor(index / 7) * 2 + 2);
  });
  assert.equal(f.groups[2].heading.style.getPropertyValue('--packed-column'), '7 / span 1');
  assert.equal(f.groups[2].continuations[0].style.getPropertyValue('--packed-column'), '1 / span 1');
  assert.equal(cards.at(-1), f.groups.at(-1).cards[0], 'Speaker Order remains last, never backfilled ahead of earlier types');
});

test('continuation headings match their cards, reuse nodes and shrink cleanly across divider and mobile resizing', () => {
  const f = packedFixture([2, 9, 1]), originalCards = f.groups.flatMap(group => group.cards);
  for (const columns of [7, 7, 2, 1, 6, 3, 12]) {
    f.pack(columns);
    const occupiedHeadings = new Set();
    let start = 0;
    for (const group of f.groups) {
      const headings = [group.heading, ...group.continuations];
      assert.equal(headings.length, Math.ceil((start % columns + group.cards.length) / columns));
      for (const heading of headings) {
        const [column, , span] = heading.style.getPropertyValue('--packed-column').split(' ').map(Number);
        const row = heading.style.getPropertyValue('--packed-row');
        for (let offset = 0; offset < span; offset++) {
          const cell = `${row}:${column + offset}`;
          assert.ok(!occupiedHeadings.has(cell), 'headings never overlap');
          occupiedHeadings.add(cell);
          assert.ok(group.cards.some(card => card.style.getPropertyValue('--packed-row') === row + 1
            && card.style.getPropertyValue('--packed-column') === column + offset));
        }
        assert.equal(heading.textContent, group.heading.textContent);
        if (heading !== group.heading) assert.equal(heading.attributes['aria-hidden'], 'true');
      }
      start += group.cards.length;
    }
    assert.deepEqual(f.groups.flatMap(group => group.cards), originalCards, 'resizing leaves the interactive card nodes untouched');
    const continuation = f.groups[1].continuations[0];
    f.pack(columns);
    assert.equal(f.groups[1].continuations[0], continuation);
  }
});

test('packed layout shares the outer grid without stretching source images or creating independent category grids', async () => {
  const css = await readFile(new URL('../services/frontend/polish.css', import.meta.url), 'utf8');
  assert.match(css, /\.item-grid\.packed-groups > \.group-section > \.item-stack\s*\{\s*display: contents;/);
  assert.match(css, /grid-column: var\(--packed-column\); grid-row: var\(--packed-row\)/);
  assert.match(css, /\.packed-groups > \.group-section > h4[^}]*overflow-wrap: anywhere/);
});
