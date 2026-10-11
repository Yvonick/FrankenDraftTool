(() => {
  const list = document.querySelector('#room-log-events');
  const status = document.querySelector('#room-logs-status');
  const more = document.querySelector('#room-logs-more');
  const titles = { draft_started: 'Started the draft', recording_started: 'Recording began', bag_pick: 'Picked from a bag',
    bag_pass: 'Passed a bag', nominate: 'Nominated', mulligan: 'Mulliganed the draw', keep_draw: 'Kept the draw',
    ban: 'Banned an item', decline_ban: 'Declined to ban', wildcard: 'Chose a wildcard replacement', bid_locked: 'Locked bids',
    speaker_pick: 'Picked speaker order', auction_pick: 'Picked an item', no_ban_preset: 'Changed no-ban preset',
    undo: 'Undid an action', 'shuffle-pool': 'Shuffled all item types', draft_restarted: 'Restarted the room' };
  let state = null, contextKey = '', draftId = null, after = 0, hasMore = false, loadedRevision = null, controller = null;
  const rows = new Map();
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  function clear() {
    controller?.abort(); controller = null;
    draftId = null; after = 0; hasMore = false; loadedRevision = null;
    rows.clear(); list.replaceChildren(); status.textContent = ''; more.hidden = true; more.disabled = false;
  }
  function appendEvent(event) {
    if (rows.has(event.sequence)) return;
    const row = node('li'); row.dataset.sequence = event.sequence;
    const content = node('div');
    const time = node('time', new Date(event.at).toLocaleTimeString(undefined, { hour12: false }));
    time.dateTime = new Date(event.at).toISOString();
    content.append(node('strong', [event.actor, titles[event.kind] || event.kind, event.type].filter(Boolean).join(' / ')));
    for (const [key, label] of [['items','Items'], ['removed','Set aside'], ['replacements','Replacement'], ['binned','Permanently binned'], ['returnedToPool','Returned to pool']]) {
      if (event[key]?.length) content.append(node('p', `${label}: ${event[key].map(item => item.name).join(', ')}`));
    }
    if (event.itemCount !== undefined) content.append(node('p', `${event.itemCount} items picked (private)`));
    if (event.passedTo) content.append(node('p', `Bag passed to ${event.passedTo}`));
    if (event.cost !== undefined) content.append(node('p', `${event.cost} credits`));
    if (event.enabled !== undefined) content.append(node('p', event.enabled ? 'No-ban preset on' : 'No-ban preset off'));
    if (event.speakerOrder) content.append(node('p', `Speaker order: ${event.speakerOrder.join(', ')}`));
    if (event.bidRecap) {
      for (const pick of event.bidRecap.pickOrder) {
        const bid = event.bidRecap.bids.find(value => value.playerId === pick.playerId) || {};
        content.append(node('p', `${pick.position}. ${pick.player} / First: ${bid.first ?? 0}, Second: ${bid.second ?? 0}, Tie: ${bid.tie ?? 0} / Paid: ${pick.cost}`));
      }
    }
    if (event.targetSequence) {
      content.append(node('p', `Reversed action #${event.targetSequence} and its outcomes.`));
      const target = rows.get(event.targetSequence);
      if (target) { target.classList.add('is-undone'); target.lastElementChild.append(node('p', `Undone by #${event.sequence}`, 'undo-label')); }
    }
    if (event.note) content.append(node('p', event.note));
    if (event.completed) content.append(node('p', 'Draft finished.'));
    row.append(node('span', `#${event.sequence}`, 'event-number'), time, content);
    rows.set(event.sequence, row); list.append(row);
  }
  async function load() {
    if (controller || !state?.visible) return;
    const requestState = state, key = contextKey, cursor = after;
    const requestController = new AbortController(); controller = requestController;
    more.disabled = true;
    if (!rows.size) status.textContent = 'Loading logs...';
    let succeeded = false;
    try {
      const query = new URLSearchParams({ viewerId: requestState.viewerId, after: String(cursor) });
      const response = await apiFetch(apiUrl(`/api/rooms/${requestState.roomNumber}/logs?${query}`), { signal: requestController.signal });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (controller !== requestController || key !== contextKey || !state.visible) return;
      if (data.revealPicks !== state.revealPicks) { clear(); return; }
      if (draftId && draftId !== data.draftId) { clear(); load(); return; }
      draftId = data.draftId;
      for (const event of data.events) appendEvent(event);
      after = data.events.at(-1)?.sequence ?? after;
      hasMore = data.nextAfter !== null;
      loadedRevision = requestState.revision;
      status.textContent = data.partial ? 'Earlier actions were not recorded.' : rows.size ? '' : 'No actions recorded yet.';
      more.textContent = 'Load more actions'; more.hidden = !hasMore;
      succeeded = true;
    } catch (error) {
      if (error.name === 'AbortError' || controller !== requestController) return;
      status.textContent = 'Could not load logs. Please retry.';
      more.textContent = 'Retry'; more.hidden = false;
    } finally {
      if (controller === requestController) {
        controller = null; more.disabled = false;
        if (succeeded && !hasMore && state?.visible && loadedRevision !== state.revision) load();
      }
    }
  }
  window.frankenRoomLogs = {
    update(next) {
      const key = JSON.stringify([next.roomNumber, next.viewerId, next.status === 'not_started', next.revealPicks]);
      if (key !== contextKey) { clear(); contextKey = key; }
      state = next;
      if (!next.visible) { controller?.abort(); controller = null; more.disabled = false; return; }
      if (!hasMore && (loadedRevision !== next.revision || !rows.size)) load();
    }
  };
  more.addEventListener('click', load);
  window.addEventListener('pagehide', clear);
  if (latestRoom) renderDraft(latestRoom.draft);
})();
