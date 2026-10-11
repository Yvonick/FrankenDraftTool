import { RequestError } from './storage.mjs';

// Live logs are a permission-filtered projection, never the archive payload.
export function publicRoomEvent(event, revealPicks) {
  const result = { sequence: event.sequence, at: event.at, kind: event.kind, actor: event.actor };
  for (const key of ['type', 'passedTo', 'cost', 'enabled', 'targetSequence', 'speakerOrder', 'bidRecap', 'note', 'completed']) {
    if (event[key] !== undefined) result[key] = event[key];
  }
  if (revealPicks || !['bag_pick', 'bag_pass'].includes(event.kind)) {
    for (const key of ['items', 'removed', 'replacements', 'binned', 'returnedToPool']) {
      if (event[key]) result[key] = event[key].map(({ id, name, type }) => ({ id, name, type }));
    }
  } else {
    result.itemCount = event.items?.length || 0;
  }
  // Opening bags and sealed bid fields are never included. Bid recaps are
  // already revealed outcomes, including outcomes later reversed by undo.
  return result;
}

export async function readRoomLogs(store, roomId, actorId, hash, after) {
  if (!actorId || !hash) throw new RequestError(401, 'participant_session_required');
  if (!Number.isSafeInteger(after) || after < 0) throw new RequestError(400, 'invalid_cursor');
  const session = await store.session(roomId, actorId);
  if (!session || session.token_hash !== hash) throw new RequestError(403, 'participant_session_mismatch');
  const stored = await store.room(roomId);
  if (!stored) throw new RequestError(404, 'room_not_found');
  const room = stored.state;
  const viewer = new Map(room.participants).get(actorId);
  if (!viewer) throw new RequestError(403, 'participant_session_required');
  const revealPicks = room.draft?.status === 'complete'
    || (viewer.role === 'spectator' && Boolean(viewer.superSpectator || room.superSpectators));
  if (!room.history) return { draftId: null, events: [], nextAfter: null, revealPicks };
  const page = await store.roomDraftEvents(room.history.id, after, room.history.sequence);
  return { ...page, events: page.events.map(event => publicRoomEvent(event, revealPicks)),
    draftId: room.history.id, revealPicks, partial: Boolean(room.history.summary.partial) };
}
