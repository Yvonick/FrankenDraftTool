import { RequestError } from './storage.mjs';

export const activeMember = member => member && ['seated', 'spectator'].includes(member.role);
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');

// Seat IDs stay stable: queues, bids, undo records and history reference the seat,
// while a rotated session secret determines who is allowed to operate it.
export async function manageSeat({ room, roomId, store, actorId, hash, body, action }) {
  const sessions = [];
  const rotate = async (id, nextHash, online = false) => {
    const previous = await store.session(roomId, id);
    sessions.push({ roomId, participantId: id, expected: previous?.token_hash ?? null, hash: nextHash, online });
  };
  const actor = room.participants.get(actorId);
  const admin = activeMember(actor) && (actor.admin || room.creatorId === actorId);
  let identity = null, handoffToken = null, note = null;
  if (action === 'claim') {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 40) throw new RequestError(400, 'invalid_name');
    if (typeof body.token !== 'string' || !/^[a-f0-9-]{73}$/.test(body.token)) throw new RequestError(410, 'seat_link_invalid');
    const tokenHash = await digest(body.token);
    const target = [...room.participants.values()].find(member => member.role === 'vacant' && member.handoffHash === tokenHash);
    if (!target || !room.draft?.players.some(player => player.id === target.id)) throw new RequestError(410, 'seat_link_invalid');
    if (actor?.role === 'seated') throw new RequestError(409, 'already_seated');
    const previousName = target.name;
    if (activeMember(actor)) {
      room.participants.set(actorId, { ...actor, role: 'left', admin: false, superSpectator: false });
      await rotate(actorId, await digest(crypto.randomUUID()));
    }
    if (room.creatorId === actorId) room.creatorId = target.id;
    room.participants.set(target.id, { id: target.id, name, role: 'seated', admin: Boolean(actor?.admin), online: true });
    await rotate(target.id, hash, true);
    identity = { participantId: target.id, role: 'seated', name };
    note = `${name} took over ${previousName}'s seat.`;
  } else {
    const leaving = action === 'leave';
    const targetId = leaving ? actorId : body.targetId;
    const target = room.participants.get(targetId);
    if (!target || !['seated', 'spectator', 'vacant'].includes(target.role)) throw new RequestError(404, 'participant_not_found');
    if (!leaving && !admin) throw new RequestError(403, 'admin_required');
    if (!leaving && (targetId === room.creatorId || targetId === actorId)) throw new RequestError(409, 'use_leave_control');
    const hasSeat = Boolean(room.draft?.players.some(player => player.id === targetId));
    if (action === 'link' && target.role !== 'vacant') throw new RequestError(409, 'seat_not_open');
    if (hasSeat && !['handoff', 'remove'].includes(body.mode) && action !== 'link') throw new RequestError(400, 'seat_choice_required');
    if (hasSeat && body.mode === 'remove' && body.confirmRestart !== true) throw new RequestError(409, 'restart_confirmation_required');
    const handoff = hasSeat && (body.mode === 'handoff' || action === 'link');
    if (handoff) {
      handoffToken = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
      room.participants.set(targetId, { id: targetId, name: target.name, role: 'vacant', handoffHash: await digest(handoffToken) });
    } else {
      room.participants.set(targetId, { id: targetId, name: target.name, role: leaving ? 'left' : 'kicked' });
      if (hasSeat) {
        room.draft = null;
        for (const member of room.participants.values()) if (member.role === 'vacant') { member.role = 'left'; delete member.handoffHash; }
      }
    }
    await rotate(targetId, await digest(crypto.randomUUID()));
    if (leaving && target.role === 'seated' && (room.allowSpectators !== false || admin)) {
      const id = crypto.randomUUID();
      room.participants.set(id, { id, role: 'spectator', name: target.name, admin: Boolean(target.admin), online: true });
      if (room.creatorId === targetId) room.creatorId = id;
      await rotate(id, hash, true);
      identity = { participantId: id, role: 'spectator', name: target.name };
    }
    note = handoff ? `${target.name}'s seat is open for a replacement.` : `${target.name || 'An unnamed spectator'} ${leaving ? 'left' : 'was removed from'} the room.`;
  }
  return { sessions, identity, handoffToken, note };
}
