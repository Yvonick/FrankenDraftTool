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

test('group layout fills the available width and measures each group independently', () => {
  const f = fixture();
  assert.equal(f.container.style.getPropertyValue('--layout-columns'), 6);
  assert.equal(f.first.style.getPropertyValue('--group-span'), 2);
  assert.equal(f.first.style.gridRowEnd, 'span 99');
  assert.equal(f.second.style.gridRowEnd, 'span 39');
  f.second.height = 240;
  f.observers[0].callback();
  assert.equal(f.second.style.gridRowEnd, 'span 64');
  assert.equal(f.container.children[0], f.first, 'cards are never replaced during layout');
  f.container.clientWidth = 343; f.context.window.innerWidth = 390;
  f.observers[0].callback();
  assert.equal(f.container.style.getPropertyValue('--layout-columns'), 2);
  f.container.clientWidth = 210;
  f.observers[0].callback();
  assert.equal(f.first.style.getPropertyValue('--group-span'), 1);
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
