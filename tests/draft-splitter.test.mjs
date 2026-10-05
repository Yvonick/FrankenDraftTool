import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../services/frontend/draft-splitter.js', import.meta.url), 'utf8');

function fixture(saved = null) {
  const handlers = {}, attributes = {}, properties = {}, captures = new Set(), values = new Map([['franken-draft:picks-width', saved]]);
  const classes = new Set();
  const classList = { add: key => classes.add(key), remove: key => classes.delete(key) };
  const layout = { clientWidth: 1000, style: { setProperty: (key, value) => { properties[key] = value; } } };
  const divider = { offsetWidth: 12, classList, focus() {}, setAttribute: (key, value) => { attributes[key] = value; },
    addEventListener: (key, fn) => { handlers[key] = fn; },
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id) };
  const picks = { getBoundingClientRect: () => ({ width: parseFloat(properties['--picks-width']) / 100 * 956 }) };
  const desktop = { matches: true, addEventListener: (_, fn) => { handlers.media = fn; } };
  let resize;
  vm.runInNewContext(source, {
    document: { querySelector: selector => ({ '#bag-draft-layout': layout, '#bag-divider': divider, '#bag-picks-panel': picks })[selector], body: {classList} },
    window: { matchMedia: () => desktop, addEventListener: (_, fn) => { handlers.pagehide = fn; } },
    localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    getComputedStyle: () => ({columnGap: '16px'}),
    ResizeObserver: class { constructor(fn) { resize = fn; } observe() {} }
  });
  return { attributes, properties, values, classes, captures, desktop, layout, resize,
    event(type, data = {}) { handlers[type]({ button: 0, pointerId: 1, clientX: 500, preventDefault() {}, ...data }); } };
}

test('divider pointer drag clamps, saves on release and restores on cancel', () => {
  const f = fixture();
  assert.equal(f.attributes['aria-valuenow'], '37');
  f.event('pointerdown'); f.event('pointermove', {clientX: 200});
  assert.ok(Number(f.attributes['aria-valuenow']) > 60);
  assert.equal(f.values.get('franken-draft:picks-width'), null);
  f.event('pointerup');
  const saved = f.values.get('franken-draft:picks-width');
  assert.ok(Number(saved) > 60);
  assert.equal(f.classes.size, 0);
  assert.equal(f.captures.size, 0);
  f.event('pointerdown'); f.event('pointermove', {clientX: 9999});
  assert.equal(f.attributes['aria-valuenow'], '25');
  assert.equal(f.attributes['aria-valuemin'], '25');
  f.event('pointercancel');
  assert.equal(Number(f.attributes['aria-valuenow']), Math.round(Number(saved)));
  assert.equal(f.values.get('franken-draft:picks-width'), saved);
});

test('divider restores preferences, supports keys and ignores the stacked mobile layout', () => {
  const f = fixture('55');
  assert.equal(f.attributes['aria-valuenow'], '55');
  f.event('keydown', {key: 'ArrowLeft'});
  assert.equal(f.attributes['aria-valuenow'], '57');
  f.event('keydown', {key: 'End'});
  assert.equal(f.attributes['aria-valuenow'], '75');
  f.event('keydown', {key: 'Enter'});
  assert.equal(f.attributes['aria-valuenow'], '37');
  f.layout.clientWidth = 650; f.resize();
  assert.equal(f.attributes['aria-valuemin'], '40');
  assert.equal(f.attributes['aria-valuemax'], '60');
  f.desktop.matches = false; f.event('media'); f.event('pointerdown');
  assert.equal(f.captures.size, 0);
  f.event('keydown', {key: 'End'});
  assert.equal(f.values.get('franken-draft:picks-width'), '37');
});
