(() => {
  const $ = selector => document.querySelector(selector);
  let cursor = null, nextAfter = null, currentId = null, retry = null;
  let bagRequest = 0;
  const undone = new Map();
  const rows = new Map();
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const date = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown';
  const showMessage = (text = '', error = false) => { $('#message').textContent = text; $('#message').className = error ? 'error' : ''; };
  function lock() {
    closeBag();
    for (const id of ['listing', 'detail', 'logout', 'back', 'retry']) $(`#${id}`).hidden = true;
    $('#login').hidden = false;
    $('#draft-list').replaceChildren(); $('#detail').replaceChildren(); rows.clear(); undone.clear();
  }
  async function api(path = '', body) {
    const response = await fetch(`/api/draft-history${path}`, { method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) lock();
      const error = new Error(data.error === 'incorrect_passkey' ? 'Incorrect password.' : response.status === 401 ? 'Enter the password to access the logs'
        : data.error === 'draft_not_found' ? 'This draft is not available as a finished draft.' : 'The logs are unavailable. Please try again.');
      error.status = response.status;
      throw error;
    }
    return data;
  }
  async function run(task) {
    $('#retry').hidden = true;
    try { await task(); } catch (error) {
      showMessage(error.message, error.status !== 401);
      if (error.status !== 401) { retry = task; $('#retry').hidden = false; }
    }
  }
  async function pageAction(button, task) {
    if (button.disabled) return;
    button.disabled = true;
    try { await run(task); } finally { button.disabled = false; }
  }
  function details(title, content) {
    const section = node('details'); section.append(node('summary', title), content); return section;
  }
  function names(label, items) {
    return node('p', `${label}: ${items.map(item => item.name).join(', ') || 'None'}`, 'item-names');
  }
  function closeBag() {
    bagRequest++;
    if ($('#bag-dialog').open) $('#bag-dialog').close();
    $('#bag-title').textContent = 'Bag contents'; $('#bag-content').replaceChildren();
  }
  function renderBag(data) {
    const body = node('div');
    if (!data.available) {
      body.append(node('p', 'Bag contents are unavailable: this history did not record the opening bags.', 'notice'));
      return body;
    }
    const picked = data.items.filter(item => item.selected).length;
    body.append(node('p', `${data.items.length} items${data.opening ? '' : ` / ${picked} picked this turn`}`, 'bag-meta'));
    const groups = node('div', null, 'bag-groups');
    const types = [...new Set([...(data.typeOrder || []), ...data.items.map(item => item.type)])];
    for (const type of types) {
      const items = data.items.filter(item => item.type === type);
      if (!items.length) continue;
      const group = node('section', null, 'bag-group'); group.append(node('h3', `${type} (${items.length})`));
      const list = node('ul');
      for (const item of items) {
        const entry = node('li', null, item.selected ? 'picked' : ''); entry.append(node('span', item.name));
        if (item.selected) entry.append(node('span', 'Picked', 'pick-marker'));
        list.append(entry);
      }
      group.append(list); groups.append(group);
    }
    body.append(groups);
    return body;
  }
  async function openBag(query, draftId = currentId) {
    const request = ++bagRequest;
    $('#bag-title').textContent = 'Bag contents'; $('#bag-content').replaceChildren(node('p', 'Loading...'));
    if (!$('#bag-dialog').open) $('#bag-dialog').showModal();
    try {
      const data = await api(`/${encodeURIComponent(draftId)}/bag?${new URLSearchParams(query)}`);
      if (request !== bagRequest) return;
      $('#bag-title').textContent = data.available ? `${data.player} / ${data.opening ? 'Opening bag' : `Bag before ${data.kind === 'bag_pass' ? 'pass' : 'pick'} #${data.sequence}`}` : 'Bag contents';
      $('#bag-content').replaceChildren(renderBag(data));
    } catch (error) {
      if (error.status === 401) showMessage(error.message);
      else if (request === bagRequest) $('#bag-content').replaceChildren(node('p', 'Unable to load this bag. Close and try again.', 'notice'));
    }
  }
  function bagButton(label, query, draftId = currentId) {
    const button = node('button', label, 'bag-view'); button.type = 'button';
    button.addEventListener('click', () => openBag(query, draftId)); return button;
  }
  async function loadList(append = false) {
    const data = await api(cursor && append ? `?cursor=${encodeURIComponent(cursor)}` : '');
    if (!append) $('#draft-list').replaceChildren();
    for (const draft of data.drafts) {
      const row = node('tr');
      const room = node('td'); room.append(node('strong', `Room ${draft.roomNumber}`), node('p', draft.poolName));
      const action = node('td'); const link = node('a', 'View Draft'); link.href = `/draft-history?draft=${encodeURIComponent(draft.id)}`; action.append(link);
      row.append(node('td', date(draft.completedAt)), room, node('td', draft.methodName), node('td', draft.players.map(player => player.name).join(', ')), action);
      $('#draft-list').append(row);
    }
    cursor = data.nextCursor; $('#more-drafts').hidden = !cursor; $('#listing').hidden = false;
    showMessage($('#draft-list').children.length ? '' : 'No finished drafts recorded yet.');
  }
  function renderResults(draft) {
    const section = node('section', null, 'results'); section.append(node('h2', 'Final results'));
    const grid = node('div', null, 'player-grid');
    for (const player of draft.results?.players || []) {
      const card = node('section', null, 'player-result'); card.append(node('h3', player.name));
      const order = draft.results.speakerOrder.find(entry => entry.playerId === player.id)?.order;
      card.append(node('p', [`Seat ${player.seat}`, order ? `Speaker order ${order}` : null,
        player.credits != null ? `${player.credits} credits remaining` : null].filter(Boolean).join(' / ')));
      const types = node('div', null, 'result-types');
      const orderedTypes = [...new Set([...draft.settings.typeOrder, ...player.items.map(item => item.type)])];
      for (const type of orderedTypes) {
        const items = player.items.filter(item => item.type === type);
        if (!items.length) continue;
        const group = node('section', null, 'result-type'); group.append(node('h4', `${type} (${items.length})`));
        const list = node('ul');
        for (const item of items) {
          const entry = node('li'); entry.append(node('span', item.name));
          if (item.cost !== null) entry.append(node('span', `${item.cost} cr`, 'cost'));
          list.append(entry);
        }
        group.append(list); types.append(group);
      }
      if (draft.engine === 'bag-pass') card.append(bagButton('View Opening Bag', { player: player.id }, draft.id));
      card.append(types); grid.append(card);
    }
    section.append(grid);
    for (const [key, label] of [['permanentBin', 'Permanent bin'], ['discardedItems', 'Discarded items']]) {
      const items = draft.results?.[key] || [];
      if (items.length) section.append(details(`${label} (${items.length})`, names('Items', items)));
    }
    return section;
  }
  const titles = { draft_started: 'Started the draft', recording_started: 'History recording began', bag_pick: 'Picked from a bag', bag_pass: 'Passed a bag without picking',
    nominate: 'Nominated', mulligan: 'Mulliganed the draw', keep_draw: 'Kept the draw', ban: 'Banned an item', decline_ban: 'Declined to ban',
    wildcard: 'Chose a wildcard replacement', bid_locked: 'Locked bids', speaker_pick: 'Picked speaker order', auction_pick: 'Picked an item',
    no_ban_preset: 'Changed no-ban preset', undo: 'Undid an action', 'shuffle-pool': 'Shuffled all item types', draft_restarted: 'Restarted the room',
    seat_remove: 'Removed a participant', seat_leave: 'Left a seat', seat_claim: 'Joined a replacement seat', seat_link: 'Created a replacement link' };
  function markUndone() {
    for (const [sequence, by] of undone) {
      const row = rows.get(sequence);
      if (row && !row.classList.contains('is-undone')) {
        row.classList.add('is-undone'); row.querySelector('h3').append(node('span', `Undone by #${by}`, 'undone'));
      }
    }
  }
  function renderEvent(event) {
    const row = node('li', null, 'event'); rows.set(event.sequence, row);
    const time = node('time', new Date(event.at).toLocaleTimeString(undefined, { hour12: false })); time.dateTime = new Date(event.at).toISOString(); time.title = date(event.at);
    const content = node('div'); content.append(node('h3', [event.actor, titles[event.kind] || event.kind, event.type].filter(Boolean).join(' / ')));
    row.append(node('span', `#${event.sequence}`, 'event-number'), time, content);
    for (const [key, label] of [['items', 'Items'], ['removed', 'Set aside'], ['replacements', 'Replacement'], ['binned', 'Permanently binned'], ['returnedToPool', 'Returned and shuffled into pool']]) {
      if (event[key]?.length) content.append(names(label, event[key]));
    }
    if (event.bags) {
      const bags = node('div', null, 'opening-bags');
      for (const bag of event.bags) bags.append(bagButton(`${bag.player.name} / Seat ${bag.player.seat}`, { player: bag.player.id }));
      content.append(details(`Starting bags (${event.bags.length})`, bags));
    }
    if (event.kind === 'bag_pick' || event.kind === 'bag_pass') content.append(bagButton('View Bag', { sequence: event.sequence }));
    if (event.players) content.append(node('p', `Seats: ${event.players.map(player => `${player.seat}. ${player.name}`).join(', ')}`));
    if (event.passedTo) content.append(node('p', `Bag passed to ${event.passedTo}.`));
    if (event.bids) content.append(node('p', `First: ${event.bids.first} / Second: ${event.bids.second} / Tie: ${event.bids.tie}`));
    if (event.cost !== undefined) content.append(node('p', `Cost: ${event.cost} credits`));
    if (event.enabled !== undefined) content.append(node('p', event.enabled ? 'No-ban preset on' : 'No-ban preset off'));
    if (event.targetSequence) { undone.set(event.targetSequence, event.sequence); content.append(node('p', `Reversed action #${event.targetSequence} and its automatic outcomes.`)); }
    if (event.speakerOrder) content.append(node('p', `Speaker order: ${event.speakerOrder.join(', ')}`));
    if (event.bidRecap) {
      const wrap = node('div', null, 'table-scroll'), table = node('table'), head = node('thead'), header = node('tr'), body = node('tbody');
      for (const title of ['Order', 'Player', 'First', 'Second', 'Tie', 'Paid']) header.append(node('th', title));
      head.append(header);
      for (const record of event.bidRecap.pickOrder) {
        const bids = event.bidRecap.bids.find(bid => bid.playerId === record.playerId) || {};
        const tr = node('tr');
        for (const value of [record.position, record.player, bids.first, bids.second, bids.tie, `${record.cost} (${record.bidKind})`]) tr.append(node('td', value));
        body.append(tr);
      }
      table.append(head, body); wrap.append(table); content.append(node('p', 'Bids revealed and pick order resolved'), wrap);
    }
    if (event.note) content.append(node('p', event.note));
    if (event.completed) content.append(node('p', 'Draft finished.'));
    return row;
  }
  async function loadEvents() {
    const data = await api(`/${currentId}/events?after=${nextAfter || 0}`);
    for (const event of data.events) $('#events').append(renderEvent(event));
    nextAfter = data.nextAfter; $('#more-events').hidden = nextAfter === null; markUndone();
  }
  async function loadDetail(id) {
    closeBag();
    const draft = await api(`/${encodeURIComponent(id)}`); currentId = draft.id; nextAfter = null; rows.clear(); undone.clear();
    const detail = $('#detail'); detail.replaceChildren(node('h2', `Room ${draft.roomNumber} / ${draft.poolName}`));
    const meta = node('div', null, 'draft-meta');
    for (const value of [draft.methodName, `Started: ${date(draft.startedAt)}`, `Finished: ${date(draft.completedAt)}`, `${draft.eventCount} events`]) meta.append(node('span', value));
    detail.append(meta);
    if (draft.partial) detail.append(node('p', 'Partial history: this draft began before action recording was enabled.', 'notice'));
    const settings = node('div', null, 'settings');
    settings.append(node('span', draft.engine === 'auction' ? `Speaker mode: ${draft.settings.auctionSpeakerMode}` : `Picks per bag: ${draft.settings.picksPerBag}`));
    for (const type of draft.settings.typeOrder) settings.append(node('span', `${type}: ${draft.settings.itemsPerType[type] || 0}`));
    detail.append(details('Draft parameters', settings), renderResults(draft), node('h2', 'Action history'));
    const timeline = node('ol', null, 'timeline'); timeline.id = 'events';
    const more = node('button', 'Load More Actions'); more.id = 'more-events'; more.hidden = true; more.addEventListener('click', () => pageAction(more, loadEvents));
    detail.append(timeline, more); detail.hidden = false; $('#back').hidden = false; showMessage();
    await loadEvents();
  }
  async function openArchive() {
    await api('/session'); $('#login').hidden = true; $('#logout').hidden = false;
    const id = new URLSearchParams(location.search).get('draft');
    if (id) await loadDetail(id); else await loadList();
  }
  $('#login').addEventListener('submit', async event => {
    event.preventDefault(); const button = $('#login button'); button.disabled = true;
    await run(async () => { await api('/login', { passkey: $('#passkey').value }); $('#passkey').value = ''; await openArchive(); });
    button.disabled = false;
  });
  $('#logout').addEventListener('click', () => run(async () => { await api('/logout', {}); lock(); showMessage('Logs locked.'); }));
  $('#more-drafts').addEventListener('click', () => pageAction($('#more-drafts'), () => loadList(true)));
  $('#retry').addEventListener('click', () => run(retry));
  $('#bag-dialog').addEventListener('close', closeBag);
  run(openArchive);
})();
