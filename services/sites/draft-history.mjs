// Journal projections deliberately exclude TTS payloads, credentials and undo snapshots.
const item = value => ({ id: value.id, name: value.name, type: value.type });
const person = value => ({ id: value.id, name: value.name, seat: value.seat });
const compactNomination = nomination => nomination && ({
  type: nomination.type, isSpeakerOrder: nomination.isSpeakerOrder,
  items: nomination.items.map(value => ({ ...item(value), pickedBy: value.pickedBy?.playerId || null })),
  temporaryBin: nomination.temporaryBin.map(item),
  pickOrder: nomination.pickOrder.map(value => ({ ...value }))
});

export function captureHistoryBefore(room, body, action) {
  if (!room?.draft || !action) return null;
  const draft = room.draft;
  const player = draft.players.find(value => value.id === body.playerId);
  return {
    status: draft.status, completedAt: draft.completedAt,
    nomination: compactNomination(draft.auction?.currentNomination),
    stage: draft.auction?.stage,
    speakerOrder: draft.auction?.speakerOrder.join(','),
    recap: JSON.stringify(draft.auction?.lastBidRecap),
    bag: player?.queue[0] && { id: player.queue[0].id, items: player.queue[0].items.map(item) },
    baseline: !room.history ? historyBaseline(room, true) : null,
    legacyResults: !room.history && draft.status === 'complete' ? historyResults(draft) : null
  };
}

function historyResults(draft) {
  return {
    players: draft.players.map(player => ({
      ...person(player), credits: player.credits, mulliganTokens: player.mulliganTokens, banTokens: player.banTokens,
      items: player.draftedItems.map(value => {
        const group = player.draftedGroups.find(group => group.items.some(entry => entry.id === value.id));
        return { ...item(value), cost: group?.cost ?? null, pick: group?.pickNumber ?? null };
      })
    })),
    speakerOrder: draft.auction?.speakerOrderResults || [],
    permanentBin: (draft.auction?.permanentBin || []).map(item),
    discardedItems: (draft.discardedItems || []).map(item)
  };
}

function historyBaseline(room, partial) {
  const draft = room.draft;
  return {
    engine: draft.engine, methodId: draft.methodId,
    methodName: draft.engine === 'auction' ? 'Nomination Auction' : 'Bag Passing',
    poolId: draft.poolId, startedAt: partial ? null : Date.now(), recordingStartedAt: Date.now(), partial,
    players: draft.players.map(player => ({ ...person(player), credits: player.credits,
      mulliganTokens: player.mulliganTokens, banTokens: player.banTokens })),
    settings: { picksPerBag: draft.picksPerBag, auctionSpeakerMode: draft.auctionSpeakerMode,
      typeOrder: [...draft.typeOrder], itemsPerType: { ...draft.itemsPerType } }
  };
}

export function recordDraftAction({ before, room, roomId, actorId, action, body, pools }) {
  if (!action || (!room.draft && !before)) return null;
  const now = Date.now();
  const draft = room.draft;
  let history = room.history && structuredClone(room.history);
  const events = [];
  const add = (kind, data = {}, actor = null) => {
    const event = { sequence: ++history.sequence, at: now, kind, actor, ...data };
    events.push(event);
    return event.sequence;
  };
  if (action === 'start' || !history) {
    const summary = action === 'start' ? historyBaseline(room, false) : before.baseline;
    summary.roomNumber = roomId;
    summary.poolName = pools.getPool(summary.poolId)?.name || 'Custom pool';
    history = { id: crypto.randomUUID(), sequence: 0, undoSequences: [], summary };
    add(action === 'start' ? 'draft_started' : 'recording_started', {
      players: summary.players,
      ...(draft?.engine === 'bag-pass' && action === 'start' ? {
        bags: draft.players.map(player => ({ player: person(player), bagId: player.queue[0]?.id,
          items: (player.queue[0]?.items || []).map(item) }))
      } : {}),
      ...(action !== 'start' ? { note: 'Earlier actions were not recorded.' } : {})
    });
  }
  const players = draft?.players || history.summary.players;
  const actor = players.find(player => player.id === actorId) || room.participants.get(actorId);
  const actorName = actor?.name || 'Host / admin';
  if (action === 'start') events[0].actor = actorName;
  const previous = before?.nomination;
  const current = draft?.auction?.currentNomination;
  const data = {};
  let kind = action.replace('auction/', '');
  if (action === 'pick') {
    if (body.automatic === true) data.automatic = true;
    kind = body.itemIds?.length ? 'bag_pick' : 'bag_pass';
    data.bagId = before.bag.id;
    data.items = before.bag.items.filter(value => body.itemIds?.includes(value.id));
    data.passedTo = draft.players.find(player => player.queue.some(bag => bag.id === before.bag.id))?.name || null;
    if (!data.passedTo) data.binned = before.bag.items.filter(value => !body.itemIds?.includes(value.id));
  } else if (action.startsWith('auction/')) {
    data.type = previous?.type || current?.type || null;
    if (kind === 'nominate') data.items = current.items.map(item);
    if (kind === 'mulligan') {
      kind = body.mulligan ? 'mulligan' : 'keep_draw';
      if (body.mulligan) { data.removed = previous.items; data.items = current.items.map(item); }
    }
    if (kind === 'ban') {
      kind = body.itemId ? 'ban' : 'decline_ban';
      if (body.itemId) {
        data.items = previous.items.filter(value => value.id === body.itemId);
        data.replacements = current.items.filter(value => !previous.items.some(old => old.id === value.id)).map(item);
      }
    }
    if (kind === 'wildcard') {
      data.removed = previous.items.filter(value => !current.items.some(next => next.id === value.id));
      data.items = current.items.filter(value => !previous.items.some(old => old.id === value.id)).map(item);
    }
    if (kind === 'bid') {
      kind = 'bid_locked';
      data.bids = { ...draft.players.find(player => player.id === actorId).currentBids };
    }
    if (kind === 'pick') {
      kind = previous.isSpeakerOrder ? 'speaker_pick' : 'auction_pick';
      data.items = previous.items.filter(value => value.id === body.itemId);
      data.cost = previous.pickOrder.find(value => value.playerId === actorId)?.cost ?? 0;
    }
    if (kind === 'no-ban-preset') {
      kind = 'no_ban_preset';
      data.enabled = Boolean(body.noBanPreset);
    }
    if (kind === 'undo') data.targetSequence = history.undoSequences.pop() ?? null;
  } else if (action === 'restart') kind = 'draft_restarted';

  if (action !== 'start') {
    const sequence = add(kind, data, actorName);
    if (action.startsWith('auction/') && !['auction/undo', 'auction/no-ban-preset'].includes(action)) {
      history.undoSequences.push(sequence);
      history.undoSequences = history.undoSequences.slice(-draft.undoStack.length);
    }
  }
  // Automatic transitions belong to the action that caused them. Undo retains
  // that action in the audit trail and links back to its sequence number.
  const outcome = events.at(-1);
  if (draft?.auction) {
    outcome.stage = draft.auction.stage;
    const recap = draft.auction.lastBidRecap;
    if (action !== 'auction/undo' && recap?.revealedBids?.length && JSON.stringify(recap) !== before?.recap
      && (before?.stage !== 'picking' || action === 'start')) {
      outcome.bidRecap = {
        type: recap.type,
        bids: recap.revealedBids.map(value => ({ playerId: value.playerId, player: players.find(player => player.id === value.playerId)?.name, ...value.bids })),
        pickOrder: recap.pickOrder.map((value, index) => ({ playerId: value.playerId, player: players.find(player => player.id === value.playerId)?.name,
          position: index + 1, bidKind: value.bidKind, cost: value.cost }))
      };
    }
    if (draft.auction.speakerOrder.length && draft.auction.speakerOrder.join(',') !== before?.speakerOrder) {
      outcome.speakerOrder = draft.auction.speakerOrder.map(id => players.find(player => player.id === id)?.name);
    }
    if (previous && !current && action === 'auction/pick' && !previous.isSpeakerOrder) {
      outcome.binned = previous.items.filter(value => !value.pickedBy && value.id !== body.itemId);
      outcome.returnedToPool = previous.temporaryBin;
    }
  }
  if (draft?.status === 'complete' && before?.status !== 'complete') outcome.completed = true;
  const status = action === 'restart' ? (before.status === 'complete' ? 'complete' : 'abandoned') : draft.status;
  const completedAt = status === 'complete' ? Date.parse(draft?.completedAt || before?.completedAt) || now : null;
  const results = status === 'complete' ? (draft ? historyResults(draft) : before.legacyResults) : null;
  room.history = action === 'restart' ? null : history;
  return { id: history.id, roomId, status, completedAt, summary: history.summary, eventCount: history.sequence, events,
    results, preserveResults: action === 'restart' && status === 'complete' && !before.legacyResults };
}
