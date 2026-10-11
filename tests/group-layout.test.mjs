import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../services/frontend/group-layout.js', import.meta.url), 'utf8');

function element(count = 1, height = 200) {
  const values = new Map([['--group-columns', count]]);
  return {
    nodeType: 1, height, isConnected: true, children: [],
    classList: { contains: name => name === 'group-section', add() {} },
    style: { setProperty: (key, value) => values.set(key, value), getPropertyValue: key => values.get(key) },
    querySelectorAll: () => [], querySelector: () => null, matches: () => true,
    getBoundingClientRect() { return { height: this.height }; }
  };
}

function fixture() {
  const first = element(2, 380), second = element(2, 140);
  const container = { ...element(), id: 'current-bag', clientWidth: 1100, children: [first, second] };
  let containers = [container], mutation;
  const observers = [], listeners = {};
  const context = {
    document: { querySelector: () => ({}), querySelectorAll: () => containers },
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
