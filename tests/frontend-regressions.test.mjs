import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../services/frontend/index.html', import.meta.url), 'utf8');

// Exercise the actual inline functions without introducing a second implementation.
function load(names, globals = {}) {
  const context = vm.createContext(globals);
  for (const name of names) {
    const declaration = new RegExp(`^      (?:async )?function ${name}\\([^]*?^      }`, 'm').exec(html);
    assert.ok(declaration, `Inline function ${name} exists`);
    vm.runInContext(declaration[0], context);
  }
  return context;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const response = data => ({ ok: true, json: async () => data });
const flush = () => new Promise(resolve => setImmediate(resolve));

function settingsFixture() {
  const timers = new Map();
  const requests = [];
  let timerId = 0;
  let settings = { maxSeats: 6, picksPerBag: 2 };
  const room = { draft: { status: 'not_started' }, seated: [{ id: 'host' }] };
  const globals = {
    window: {
      setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
      clearTimeout(id) { timers.delete(id); }
    },
    roomSettingsSaveTimer: null, roomSettingsSavePromise: null,
    roomSettingsEditVersion: 0, roomSettingsDirty: false, roomSettingsSaveFailed: false,
    roomStartPending: false, roomPoolSavePending: false,
    latestRoom: room, currentRoomNumber: '123456', currentViewerId: 'host',
    settingsSaveStatus: { textContent: '', dataset: {} }, roomMessage: { textContent: '' },
    startDraft: { disabled: false }, poolUploadInput: {},
    hasHostRights: () => true, setRoomSettingsEditable: () => {},
    collectDraftSettings: () => ({ ...settings }), hostPayload: value => value, apiUrl: value => value,
    apiFetch(url, options) {
      const gate = deferred();
      requests.push({ url, body: JSON.parse(options.body), gate });
      return gate.promise;
    }
  };
  const context = load(['setInlineStatus', 'markRoomSettingsDirty', 'scheduleRoomSettingsSave', 'saveSettings', 'handleStartDraft'], globals);
  context.renderRoom = data => { context.latestRoom = data; };
  return { context, timers, requests, room, change(value) {
    settings = { ...settings, ...value };
    context.markRoomSettingsDirty({ target: {} });
  } };
}

test('start flushes the scheduled save and never sends settings after draft start', async () => {
  const f = settingsFixture();
  f.change({ maxSeats: 5 });
  f.context.scheduleRoomSettingsSave({ target: {} });
  assert.equal(f.timers.size, 1);
  const start = f.context.handleStartDraft();
  assert.equal(f.timers.size, 0);
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].url, /\/settings$/);
  assert.equal(f.requests[0].body.maxSeats, 5);
  f.requests[0].gate.resolve(response(f.room));
  await flush();
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[1].url, /\/draft\/start$/);
  f.requests[1].gate.resolve(response({ ...f.room, draft: { status: 'active' } }));
  await start;
  assert.equal(f.timers.size, 0);
  assert.equal(f.context.roomSettingsSavePromise, null);
  assert.equal(f.context.roomStartPending, false);
  assert.equal(f.context.settingsSaveStatus.textContent, 'Saved');
});

test('in-flight settings saves serialize newer edits before allowing start', async () => {
  const f = settingsFixture();
  f.change({ picksPerBag: 3 });
  const saving = f.context.saveSettings();
  f.change({ picksPerBag: 4 });
  f.context.scheduleRoomSettingsSave({ target: {} });
  const start = f.context.handleStartDraft();
  assert.equal(f.requests.length, 1, 'no parallel settings request');
  f.requests[0].gate.resolve(response(f.room));
  await flush();
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[1].url, /\/settings$/);
  assert.equal(f.requests[1].body.picksPerBag, 4);
  f.requests[1].gate.resolve(response(f.room));
  await flush();
  assert.equal(f.requests.length, 3);
  assert.match(f.requests[2].url, /\/draft\/start$/);
  f.requests[2].gate.resolve(response({ ...f.room, draft: { status: 'active' } }));
  await Promise.all([saving, start]);
  assert.equal(f.timers.size, 0);
});

test('failed settings retain edits, block start, and can be retried', async () => {
  const f = settingsFixture();
  f.change({ maxSeats: 1 });
  const start = f.context.handleStartDraft();
  f.requests[0].gate.resolve({ ok: false, json: async () => ({ error: 'seat_limit_below_current_players' }) });
  await start;
  assert.equal(f.requests.length, 1);
  assert.equal(f.context.roomSettingsDirty, true);
  assert.equal(f.context.roomSettingsSaveFailed, true);
  assert.equal(f.context.settingsSaveStatus.dataset.error, 'true');
  assert.equal(f.context.roomStartPending, false);
  f.change({ maxSeats: 6 });
  const retry = f.context.saveSettings();
  f.requests[1].gate.resolve(response(f.room));
  assert.equal(await retry, true);
  assert.equal(f.context.roomSettingsDirty, false);
  assert.equal(f.context.roomSettingsSaveFailed, false);
});

test('room settings renderer preserves local edits during remote updates', () => {
  const context = load(['renderDraftSettings'], { roomSettingsDirty: true, roomSettingsSavePromise: null });
  assert.doesNotThrow(() => context.renderDraftSettings({}));
  context.roomSettingsDirty = false;
  context.roomSettingsSavePromise = Promise.resolve();
  assert.doesNotThrow(() => context.renderDraftSettings({}));
});

test('same-revision personalized snapshots render after public snapshots and permission changes', () => {
  const publicRoom = { roomNumber: '123456', revision: '10:p', viewer: null, draft: { status: 'active' } };
  const rendered = new Error('render reached');
  const context = load(['renderRoom'], {
    latestRoom: publicRoom, previousDraftStatus: null, roomView: { dataset: {} },
    window: { clearTimeout() {} }, roomSettingsSaveTimer: null,
    renderSeated() { throw rendered; }
  });
  assert.doesNotThrow(() => context.renderRoom(publicRoom));
  const privateRoom = { ...publicRoom, viewer: { id: 'p', role: 'seated', admin: false } };
  assert.throws(() => context.renderRoom(privateRoom), error => error === rendered);
  assert.equal(context.currentViewerId, 'p');
  assert.equal(context.currentRole, 'seated');
  assert.doesNotThrow(() => context.renderRoom(privateRoom));
  assert.throws(() => context.renderRoom({ ...privateRoom, viewer: { ...privateRoom.viewer, admin: true } }), error => error === rendered);
  assert.throws(() => context.renderRoom(publicRoom), error => error === rendered);
  assert.equal(context.currentViewerId, null);
  assert.equal(context.roomSettingsDirty, false);
});

test('auction player rendering and pending bids are scoped to the viewer', () => {
  const rendered = new Error('render reached');
  const context = load(['renderAuctionPlayers', 'auctionBiddingKey'], {
    currentViewerId: null, getAuctionWaitingPlayerIds: () => new Set(),
    draftGrouping: { value: 'type' }, expandedAuctionPlayerIds: new Set(),
    otherAuctionAreasExpanded: false, auctionPlayersRenderKey: '',
    auctionPlayers: { replaceChildren() { throw rendered; } }
  });
  const auction = { stage: 'bidding', players: [], currentNomination: { type: 'Heroes', items: [] } };
  assert.throws(() => context.renderAuctionPlayers(auction), error => error === rendered);
  const publicKey = context.auctionBiddingKey(auction);
  assert.doesNotThrow(() => context.renderAuctionPlayers(auction));
  context.currentViewerId = 'p';
  assert.throws(() => context.renderAuctionPlayers(auction), error => error === rendered);
  assert.notEqual(context.auctionBiddingKey(auction), publicKey);
});

test('pool refresh retains existing editor nodes and their unsaved values', () => {
  const cards = ['a', 'b'].map(id => ({ dataset: { poolId: id, dirty: 'true' }, unsaved: `local ${id}`, remove() { throw Error('Existing editor removed'); } }));
  const context = load(['renderPublicPools'], {
    pools: [{ id: 'a' }, { id: 'b' }],
    publicPoolsList: { children: cards, querySelectorAll: () => cards, append() { throw Error('Existing editor rebuilt'); } }
  });
  context.renderPublicPools();
  assert.equal(cards[1].unsaved, 'local b');
  cards[0].dataset.dirty = 'false';
  cards[0].dataset.saving = 'true';
  context.renderPublicPools();
  cards[0].dataset.saving = 'false';
  cards[0].dataset.poolVersion = JSON.stringify({ id: 'a' });
  context.renderPublicPools();
});

test('saving a pool preserves edits made while its save is in flight', async () => {
  const gate = deferred();
  const button = { disabled: false };
  const status = { dataset: {}, textContent: '' };
  const title = { textContent: 'Before' };
  const card = { dataset: { poolId: 'a' }, querySelector(selector) {
    if (selector === 'h3') return title;
    if (selector === '[data-pool-status]') return status;
    return button;
  } };
  let value = 'First edit';
  const context = load(['setInlineStatus', 'markManagedPoolDirty', 'saveManagedPool'], {
    apiUrl: x => x, apiFetch: () => gate.promise, pools: [], poolsMessage: {}, renderPublicPools: () => {},
    collectManagedPoolSettings: () => ({ name: value })
  });
  const save = context.saveManagedPool(card);
  value = 'Second edit';
  gate.resolve(response({ pools: [{ id: 'a', name: 'First edit' }] }));
  await save;
  assert.equal(value, 'Second edit');
  assert.equal(title.textContent, 'First edit');
  assert.equal(card.dataset.dirty, 'true');
  assert.equal(status.textContent, 'Unsaved changes');
  assert.equal(button.disabled, false);
});

class Element {
  children = [];
  className = '';
  textContent = '';
  attributes = {};
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
}

test('only the current picking recap highlights the waiting player', () => {
  const controls = new Element();
  const context = load(['renderAuctionBidRecap'], {
    document: { createElement: () => new Element() }, auctionControls: controls,
    getAuctionWaitingPlayerIds: () => new Set(['p'])
  });
  const recap = { type: 'Heroes', revealedBids: [{ playerId: 'p', playerName: 'Player', bids: { first: 1, tie: 0 } }], pickOrder: [{ playerId: 'p', order: 1, cost: 1, bidKind: 'first' }] };
  const row = () => controls.children.at(-1).children[1].children[1].children[0];
  context.renderAuctionBidRecap({ stage: 'nomination', currentNomination: null, lastBidRecap: recap, players: [{ playerId: 'p' }] });
  assert.equal(row().className, '');
  context.renderAuctionBidRecap({ stage: 'picking', currentNomination: recap, players: [{ playerId: 'p' }] });
  assert.equal(row().className, 'waiting');
});

test('confirmation docks above and below the viewport and returns inline when visible', () => {
  let top = 1959;
  let docked = false;
  const properties = new Map();
  const style = { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) };
  const row = { getBoundingClientRect: () => ({ height: 64 }), style, classList: { toggle: (_, value) => { docked = value; } } };
  const context = load(['updateAuctionDock'], {
    auctionPanel: { hidden: false },
    auctionItemActions: { style, querySelector: () => row, getBoundingClientRect: () => ({ top, left: 240, right: 900 }) },
    window: { innerHeight: 900 }, document: { documentElement: { clientWidth: 1440 } }
  });
  context.updateAuctionDock();
  assert.equal(docked, true);
  assert.equal(properties.get('--action-height'), '64px');
  assert.equal(properties.get('--dock-width'), '660px');
  top = 700;
  context.updateAuctionDock();
  assert.equal(docked, false);
  top = -100;
  context.updateAuctionDock();
  assert.equal(docked, true);
});

test('joining only offers a seat in a lobby with space', () => {
  const context = load(['updateJoinOptions'], {
    latestRoom: { draft: { status: 'complete' }, seated: [{}], maxSeats: 6, allowSpectators: true },
    joinSeat: {}, joinSpectate: {}, joinStatus: {}
  });
  context.updateJoinOptions();
  assert.equal(context.joinSeat.disabled, true);
  context.latestRoom.draft.status = 'active';
  context.updateJoinOptions();
  assert.equal(context.joinSeat.disabled, true);
  context.latestRoom.draft.status = 'not_started';
  context.updateJoinOptions();
  assert.equal(context.joinSeat.disabled, false);
  context.latestRoom.maxSeats = 1;
  context.latestRoom.allowSpectators = false;
  context.updateJoinOptions();
  assert.equal(context.joinSeat.disabled, true);
  assert.equal(context.joinSpectate.hidden, true);
});

test('confirmation uses a native modal and initially focuses Cancel', async () => {
  let focused;
  const modal = { open: false, hidden: true, showModal() { this.open = true; }, close() { this.open = false; } };
  const context = load(['openModal', 'closeModal', 'closeConfirmModal', 'requestConfirmation'], {
    disclosures: [], confirmModal: modal, confirmTitle: {}, confirmMessage: {}, confirmAccept: {},
    confirmCancel: { focus() { focused = 'cancel'; } }, pendingConfirmation: null
  });
  const confirmation = context.requestConfirmation({ title: 'Restart', message: 'Restart draft?' });
  assert.equal(modal.open, true);
  assert.equal(focused, 'cancel');
  context.closeConfirmModal(false);
  assert.equal(await confirmation, false);
  assert.equal(modal.open, false);
  assert.equal(modal.hidden, true);
  assert.match(html, /<dialog[^>]+id="confirm-modal"[^>]+aria-labelledby="confirm-title"/);
});
