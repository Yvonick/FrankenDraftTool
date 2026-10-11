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
    roomView: { scrollIntoView() { this.scrolled = true; } },
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
  assert.equal(f.context.roomView.scrolled, true);
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
  dataset = {};
  className = '';
  textContent = '';
  attributes = {};
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
}

function itemViewFixture() {
  const nodes = new Map();
  class MediaElement extends Element {
    constructor(tag) {
      super(); this.tag = tag; this.listeners = {}; this.properties = {};
      this.style = {setProperty: (key, value) => { this.properties[key] = value; }};
      this.classList = {add: value => { this.className += ` ${value}`; }, toggle() {}};
    }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    querySelectorAll(tag) { return this.children.flatMap(child => [ ...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag) ]); }
    querySelector(tag) { return this.querySelectorAll(tag)[0]; }
  }
  const context = load(['setIconButton', 'getImageAspect', 'getImageShape', 'setImageRatio', 'createImageCrop', 'renderLinkedPreviewItem', 'renderItemImage', 'inspectItem', 'hasDistinctItemBack', 'renderItemTools', 'renderItemCard', 'renderAuctionDraftedItem'], {
    document: {createElement: tag => new MediaElement(tag), querySelector: id => {
      if (!nodes.has(id)) nodes.set(id, new MediaElement('div')); return nodes.get(id);
    }}, window: {innerWidth: 1200, innerHeight: 800, frankenIcon: () => new MediaElement('svg')},
    selectedItemIds: new Set(), inspectorModal: {}, inspectorClose: {}, openModal() {}
  });
  return {context, nodes};
}

test('three item icons are available in bag cards and auction rows without changing item selection', () => {
  const {context} = itemViewFixture();
  const inspected = [];
  context.inspectItem = (item, mode) => inspected.push(mode);
  const item = {id: 'item', name: 'Unit', type: 'Units', imageUrl: 'front', imageSecondaryUrl: 'back', linkedItems: [{name: 'Token'}]};
  const card = context.renderItemCard(item, {checkable: true});
  const buttons = card.querySelectorAll('button');
  assert.deepEqual(Array.from(buttons, button => button.dataset.itemView), ['zoom', 'back', 'components']);
  const checkbox = card.querySelector('input');
  for (const button of buttons) {
    let prevented = false, stopped = false;
    button.listeners.click({preventDefault() { prevented = true; }, stopPropagation() { stopped = true; }});
    assert.ok(prevented && stopped);
    assert.ok(button.title.includes(item.name));
    assert.equal(button.attributes['aria-haspopup'], 'dialog');
  }
  assert.deepEqual(inspected, ['zoom', 'back', 'components']);
  assert.equal(checkbox.checked, false);
  assert.equal(context.renderAuctionDraftedItem(item, {cost: 1}).querySelectorAll('button').length, 3);
  const unavailable = context.renderItemCard({...item, imageUrl: null, imageSecondaryUrl: null, linkedItems: []});
  assert.deepEqual(Array.from(unavailable.querySelectorAll('button'), button => button.dataset.itemView), ['zoom']);
});

test('back and attachment icons are omitted when irrelevant, but alternate texture crops count as different backs', () => {
  const {context} = itemViewFixture();
  const views = item => Array.from(context.renderItemTools(item).children, button => button.dataset.itemView);
  const item = {name: 'Item', imageUrl: 'front', imageSecondaryUrl: 'front', linkedItems: []};
  assert.deepEqual(views(item), ['zoom']);
  assert.deepEqual(views({...item, imageSecondarySheet: {columns: 1, rows: 1, index: 0}}), ['zoom']);
  assert.deepEqual(views({...item, imageSecondaryUrl: null, linkedItems: [{name: 'Token'}]}), ['zoom', 'components']);
  assert.deepEqual(views({...item, imageSecondaryUrl: 'back'}), ['zoom', 'back']);
  assert.deepEqual(views({...item, imageSheet: {columns: 2, rows: 1, index: 0}, imageSecondarySheet: {columns: 2, rows: 1, index: 1}}), ['zoom', 'back']);
  assert.deepEqual(views({...item, imageSheet: {columns: 2, rows: 1, index: 1}, imageSecondarySheet: {columns: 2, rows: 1, index: 1}}), ['zoom']);
});

test('zoom, back and attachments show distinct views with the proper crop and no source mutation', () => {
  const {context, nodes} = itemViewFixture();
  const item = {name: 'System', content: 'Non-draft: Token', imageUrl: 'texture', imageSheet: {columns: 2, rows: 1, index: 0}, imageSecondaryUrl: 'texture', imageSecondarySheet: {columns: 2, rows: 1, index: 1}, linkedItems: [{name: 'Token', imageUrl: 'token'}]};
  const before = structuredClone(item);
  context.inspectItem(item, 'back');
  let list = nodes.get('#inspector-images');
  assert.equal(list.children.length, 2);
  assert.equal(list.dataset.view, 'back');
  assert.deepEqual(Array.from(list.children, section => section.children[0].textContent), ['Front', 'Back']);
  assert.deepEqual(Array.from(list.querySelectorAll('img'), image => image.src), ['texture', 'texture']);
  assert.equal(list.children[0].children[1].children[0].properties['--sheet-left'], '0%');
  assert.equal(list.children[1].children[1].children[0].properties['--sheet-left'], '-100%');
  assert.match(nodes.get('#inspector-title').textContent, /Front & Back/);
  context.inspectItem({...item, imageSecondaryUrl: 'single-back', imageSecondarySheet: null}, 'back');
  assert.equal(list.querySelectorAll('img')[1].src, 'single-back');
  assert.equal(list.children[1].children[1].children[0].properties['--sheet-left'], undefined, 'a shared back is not cropped like the front');
  context.inspectItem(item, 'zoom');
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[1].children[0].properties['--sheet-left'], '0%');
  context.inspectItem(item, 'components');
  assert.equal(list.dataset.view, 'components');
  assert.equal(list.querySelectorAll('img')[0].src, 'token');
  assert.equal(nodes.get('#inspector-description').textContent, item.content);
  assert.deepEqual(item, before);
  context.inspectItem({name: 'Empty', linkedItems: []}, 'components');
  assert.match(list.children[0].textContent, /No attached components/);
});

test('item inspector hides empty descriptions and duplicate zoom captions without losing component labels', () => {
  const {context, nodes} = itemViewFixture();
  context.inspectItem({name: 'Item', content: '  ', imageUrl: 'front'});
  const list = nodes.get('#inspector-images');
  const description = nodes.get('#inspector-description');
  assert.equal(description.hidden, true);
  assert.equal(list.children[0].children[0].hidden, true);
  context.inspectItem({name: 'Item', content: 'Non-draft: Token', linkedItems: [{name: 'Token'}]}, 'components');
  assert.equal(description.hidden, false);
  assert.equal(description.textContent, 'Non-draft: Token');
  assert.equal(list.children[0].children[0].hidden, false);
  assert.equal(list.children[0].children[0].textContent, 'Token');
  assert.match(list.children[0].children[1].className, /without-image/);
  context.inspectItem({name: 'Item', imageUrl: 'front'});
  assert.equal(description.hidden, true, 'descriptions are cleared between items');
});

test('image crops preserve loaded aspect ratios and thumbnails do not preload backs', () => {
  const {context} = itemViewFixture();
  const frame = context.renderItemImage({name: 'System', imageUrl: 'front', imageSecondaryUrl: 'back', imageSheet: {columns: 2, rows: 1, index: 0}});
  assert.ok(frame.querySelectorAll('img').every(image => image.src === 'front'));
  const image = frame.querySelector('img');
  image.naturalWidth = 1600; image.naturalHeight = 800; image.listeners.load();
  assert.equal(frame.properties['--crop-aspect'], '1');
  assert.equal(frame.properties['--image-ratio'], '1');
  assert.equal(frame.querySelectorAll('button').length, 0, 'actions are outside the picture and its hover target');
});

test('table roster groups player identity, status and admin controls in compact rows', () => {
  const roundTable = new Element(), tableRoster = new Element(), tablePanel = new Element();
  const context = load(['renderTable'], {
    document: { createElement() { const element = new Element(); element.style = { setProperty() {} }; return element; } },
    roundTable, tableRoster, tablePanel,
    appendHostBadge() {}, appendAdminAction(card, player) { if (player.admin) card.append('admin control'); }
  });
  const draft = { status: 'active', engine: 'bag', table: [
    { name: 'Alice', seat: 1, admin: true, lookingAtBag: true, queueLength: 2 },
    { name: 'Bob', seat: 2, lookingAtBag: false, queueLength: 0 }
  ] };
  context.renderTable(draft);
  assert.equal(roundTable.children[0].children[0].textContent, 2);
  assert.equal(roundTable.children[0].children[1].textContent, 'players');
  assert.equal(tableRoster.children[0].children[0].className, 'table-identity');
  assert.equal(tableRoster.children[0].children[1].className, 'table-player-status choosing');
  assert.equal(tableRoster.children[0].children[1].children[0].textContent, 'Choosing');
  assert.equal(tableRoster.children[0].children[1].children[1].textContent, '2 bags queued');
  assert.equal(tableRoster.children[0].children[2], 'admin control');
  assert.equal(tableRoster.children[1].children[1].children[0].textContent, 'Waiting');
  context.renderTable({ ...draft, status: 'complete' });
  assert.equal(tableRoster.children[1].children[1].children[0].textContent, 'Finished');
  context.renderTable({ status: 'not_started' });
  assert.equal(tablePanel.hidden, true);
  assert.equal(tableRoster.children.length, 0);
});

test('bag waiting state restores the current-bag heading and controls when a bag arrives', () => {
  const heading = new Element(), instruction = new Element(), lockChoice = new Element();
  const placements = [];
  const context = load(['renderCurrentBag'], {
    document: { querySelector: () => heading }, draftInstruction: instruction, lockChoice,
    currentBag: new Element(), renderedCurrentBagKey: null, currentBagId: 'bag', selectedItemIds: new Set(),
    latestRoom: { draft: {} }, placeTablePanel: inside => placements.push(inside),
    getCurrentBagRenderKey: () => 'bag', renderTypeSections() {}, updateLockButton() {}
  });
  context.renderCurrentBag({ currentBag: null, queueLength: 0 });
  assert.equal(heading.textContent, 'Waiting for next bag');
  assert.equal(instruction.textContent, '0 bags queued');
  assert.equal(lockChoice.hidden, true);
  context.renderCurrentBag({ currentBag: { id: 'bag', items: [], eligibleItemIds: [], requiredPickCount: 3 }, queueLength: 1 });
  assert.equal(heading.textContent, 'Current Bag');
  assert.equal(lockChoice.hidden, false);
  assert.deepEqual(placements, [true, false]);
});

test('setup renders and collects room-specific type order, including hidden speaker settings', () => {
  const list = new Element();
  list.querySelectorAll = selector => selector === '.room-type-row' ? list.children
    : list.children.map(row => row.children[1].children[1]);
  const pool = { itemTypes: [{ type: 'Units' }, { type: 'Techs' }, { type: 'Speaker Order', isMeta: true }],
    defaultParameters: { typeOrder: ['Units', 'Techs', 'Speaker Order'], itemsPerType: { Units: 2, Techs: 2, 'Speaker Order': 1 } } };
  let auction = true;
  const context = load(['renderTypeInputs', 'collectDraftSettings'], {
    document: { createElement: () => new Element() }, window: {}, itemTypeSettings: list,
    selectedMethodIsAuction: () => auction, seatLimitInput: {value: 6}, allowSpectatorsInput: {checked: true},
    listedInput: {checked: true}, poolSelect: {value: 'pool'}, draftMethodSelect: {value: 'auction'},
    picksPerBagInput: {value: 2}, auctionSpeakerModeSelect: {value: 'none'}, auctionSpeakerModeValue: x => x
  });
  const order = ['Techs', 'Speaker Order', 'Units'];
  context.renderTypeInputs(pool, { Units: 3, Techs: 0, 'Speaker Order': 1 }, order);
  assert.deepEqual(list.children.map(row => row.dataset.itemType), order);
  assert.equal(list.children[1].hidden, true);
  const settings = JSON.parse(JSON.stringify(context.collectDraftSettings()));
  assert.deepEqual(settings.typeOrder, order);
  assert.deepEqual(settings.itemsPerType, { Techs: 0, 'Speaker Order': 1, Units: 3 });
  auction = false;
  context.renderTypeInputs(pool, settings.itemsPerType, settings.typeOrder);
  assert.equal(list.children[1].hidden, false);
  assert.deepEqual(JSON.parse(JSON.stringify(context.collectDraftSettings())).typeOrder, order);
});

test('setup keyboard reorder moves existing rows without losing count inputs', () => {
  const rows = [{type: 'Units', value: 3}, {type: 'Speaker Order', hidden: true}, {type: 'Techs', value: 0}];
  const list = { children: [...rows], insertBefore(row, before) {
    if (row === before) return;
    this.children.splice(this.children.indexOf(row), 1);
    this.children.splice(this.children.indexOf(before), 0, row);
  }, append(row) { this.children.splice(this.children.indexOf(row), 1); this.children.push(row); } };
  let saves = 0, focused = false;
  const handle = { closest: () => rows[0], focus: () => { focused = true; } };
  const context = load(['moveRoomTypeWithKeyboard'], { itemTypeSettings: list, scheduleRoomSettingsSave: () => { saves++; } });
  context.moveRoomTypeWithKeyboard(handle, 'ArrowRight');
  assert.deepEqual(list.children.map(row => row.type), ['Techs', 'Units', 'Speaker Order']);
  assert.equal(rows[0].value, 3);
  assert.equal(rows[2].value, 0);
  assert.equal(focused, true);
  assert.equal(saves, 1);
  context.moveRoomTypeWithKeyboard(handle, 'Home');
  assert.equal(list.children[0], rows[0]);
});

test('only the current picking recap highlights the waiting player', () => {
  const controls = new Element();
  const context = load(['renderAuctionBidRecap'], {
    document: { createElement: () => new Element() }, auctionRecap: controls,
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
