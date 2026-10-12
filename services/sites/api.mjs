import engineModule from '../backend/draftEngine.js';
import registryModule from '../backend/poolRegistry.js';
import { builtinPool, assetOverrides } from './builtin.mjs';
import { createStorage, ConflictError, RequestError } from './storage.mjs';
import { roomStream } from './room-stream.mjs';
import { captureHistoryBefore, recordDraftAction } from './draft-history.mjs';
import { handleHistoryApi } from './history-api.mjs';
import { readRoomLogs } from './room-logs.mjs';

const encoder = new TextEncoder();
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(value);
const response = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const initialized = new WeakMap();
const poolCache = new Map();

async function tokenHash(request, header = 'x-franken-session') {
  const token = request.headers.get(header);
  if (!validId(token) || token.length < 32) throw new RequestError(401, 'session_required');
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readBody(request) {
  if (request.method !== 'POST') return { data: {}, bytes: 0 };
  const chunks = [];
  let bytes = 0;
  const reader = request.body?.getReader();
  if (reader) {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 25 * 1024 * 1024) { await reader.cancel(); throw new RequestError(413, 'request_body_too_large'); }
      chunks.push(next.value);
    }
  }
  let data;
  try { data = bytes ? JSON.parse(await new Blob(chunks).text()) : {}; }
  catch { throw new RequestError(400, 'invalid_json'); }
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new RequestError(400, 'invalid_json');
  return { data, bytes };
}

function capture() {
  return {
    status: 200, headers: {}, body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = '') { this.body = body; }
  };
}

async function loadPool(store, key) {
  if (key === `builtin:${builtinPool.id}`) return builtinPool;
  if (poolCache.has(key)) return poolCache.get(key);
  const pool = await store.pool(key);
  // Small, immutable cache only; R2 remains authoritative across isolates/restarts.
  if (JSON.stringify(pool).length < 5_000_000) {
    if (poolCache.size >= 2) poolCache.delete(poolCache.keys().next().value);
    poolCache.set(key, pool);
  }
  return pool;
}

export async function handleApi(request, env) {
  try {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/draft-history')) return await handleHistoryApi(request, env);
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) return response({ error: 'method_not_allowed' }, 405);
    const store = createStorage(env);
    if (!initialized.has(env.DB)) {
      const parser = registryModule.createPoolRegistry();
      const ready = store.initialize(builtinPool, parser.getPoolSummary(builtinPool)).catch(error => { initialized.delete(env.DB); throw error; });
      initialized.set(env.DB, ready);
    }
    await initialized.get(env.DB);
    if (url.pathname === '/api/health') return response({ status: 'ok', service: 'franken-draft-tool-sites', storage: 'D1 + R2', renderDependency: false });
    if (url.pathname === '/api/presence') return response({ openPages: await store.presence(await tokenHash(request)) });
    const parsed = await readBody(request);
    const { data: body } = parsed;
    if (url.pathname === '/api/profile') {
      if (!['GET', 'POST'].includes(request.method)) return response({ error: 'method_not_allowed' }, 405);
      const hash = await tokenHash(request, 'x-franken-profile');
      if (request.method === 'POST') {
        if (typeof body.name !== 'string' || body.name.trim().length > 40) return response({ error: 'invalid_name' }, 400);
        await store.saveProfile(hash, body.name.trim());
      }
      return response({ name: await store.profile(hash) });
    }
    if (url.pathname === '/api/rooms' && request.method === 'GET') return response({ rooms: await store.currentRooms() });
    const roomMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})(?:\/|$)/);
    const roomId = roomMatch?.[1];
    const presence = roomId && url.pathname === `/api/rooms/${roomId}/presence`;
    if (presence && request.method === 'GET' && request.headers.get('accept') === 'text/event-stream') {
      return await roomStream(request, store, snapshotRequest => {
        const headers = new Headers(snapshotRequest.headers);
        headers.set('accept', 'application/json');
        return handleApi(new Request(snapshotRequest, { headers }), env);
      });
    }
    const actorId = presence ? url.searchParams.get('participantId') : body.playerId || body.actorId || body.viewerId || body.participantId || url.searchParams.get('actorId') || url.searchParams.get('viewerId') || url.searchParams.get('participantId');
    if (presence && !validId(actorId)) return response({ error: 'invalid_participant' }, 400);
    const hash = (presence || (roomId && actorId)) ? await tokenHash(request) : null;
    if (roomId && url.pathname === `/api/rooms/${roomId}/logs` && request.method === 'GET') {
      return response(await readRoomLogs(store, roomId, actorId, hash, Number(url.searchParams.get('after') || 0)));
    }
    const participantIsTarget = /\/(participants\/admin|spectators\/promote)$/.test(url.pathname);
    if (roomId && !presence && actorId) {
      const identities = [body.playerId, body.actorId, body.viewerId, !participantIsTarget && body.participantId,
        url.searchParams.get('actorId'), url.searchParams.get('viewerId'), url.searchParams.get('participantId')].filter(Boolean);
      if (identities.some(id => id !== actorId)) return response({ error: 'participant_session_mismatch' }, 403);
    }

    for (let attempt = 0; attempt < 8; attempt++) {
      const [catalog, storedRoom] = await Promise.all([store.catalog(), roomId ? store.room(roomId) : null]);
      if (roomId && !storedRoom) return response({ error: 'room_not_found' }, 404);
      const poolRows = new Map(catalog.map(row => [row.id, row]));
      const poolPathId = url.pathname.match(/^\/api\/pools\/([^/]+)(?:\/(?:delete|replace))?$/)?.[1];
      const selectedId = (poolPathId && decodeURIComponent(poolPathId)) || body.poolId || storedRoom?.state.draftSettings.poolId || catalog.find(row => !row.deleted && JSON.parse(row.summary).public)?.id;
      const selectedRow = poolRows.get(selectedId);
      const pinnedKey = !body.poolId && storedRoom?.state.poolObjectKey;
      const selectedKey = pinnedKey || (!selectedRow?.deleted && selectedRow?.object_key);
      const initialPools = catalog.map(row => {
        const summary = JSON.parse(row.summary);
        return { ...summary, public: !row.deleted && summary.public, __summary: { ...summary, public: !row.deleted && summary.public } };
      });
      if (selectedKey) {
        const selected = await loadPool(store, selectedKey);
        const index = initialPools.findIndex(pool => pool.id === selected.id);
        if (index >= 0) initialPools[index] = selected;
        else initialPools.push(selected);
      }
      if (body.poolId && (!selectedRow || selectedRow.deleted)) return response({ error: 'invalid_pool' }, 400);
      const pools = registryModule.createPoolRegistry({ initialPools, assetOverrides });
      const engine = engineModule.createDraftEngine({ pools, roomEntries: storedRoom ? [[roomId, storedRoom.state]] : [] });
      const historyAction = request.method === 'POST' ? url.pathname.match(/^\/api\/rooms\/\d{6}\/draft\/(start|restart|pick|auction\/[a-z-]+)$/)?.[1] : null;
      const historyBefore = captureHistoryBefore(engine.rooms.get(roomId), body, historyAction);
      const out = capture();
      let session;
      let active = new Set();
      let existingSession;
      let seatRelinquished = false;
      if (roomId) {
        active = await store.activeParticipants(roomId);
        if (actorId) {
          if (!validId(actorId)) return response({ error: 'invalid_participant' }, 400);
          existingSession = await store.session(roomId, actorId);
          if (existingSession && existingSession.token_hash !== hash) return response({ error: 'participant_session_mismatch' }, 403);
          if (!presence && !existingSession) return response({ error: 'participant_session_required' }, 403);
          if (existingSession) {
            active.add(actorId);
            if (existingSession.last_seen < Date.now() - 10000) await store.heartbeat(roomId, actorId, hash);
          }
        }
        const room = engine.rooms.get(roomId);
        for (const id of room.participants.keys()) if (!active.has(id)) room.participants.delete(id);
        const returning = room.participants.get(actorId);
        if (presence && existingSession?.last_seen < Date.now() - 60000 && returning?.role === 'seated'
          && !room.draft?.players.some(player => player.id === actorId)
          && [...room.participants.values()].filter(player => player.id !== actorId && player.role === 'seated').length >= room.maxSeats) {
          returning.role = 'spectator';
          seatRelinquished = true;
        }
      }
      let joined;
      let changed = request.method === 'POST';
      if (presence) {
        const room = engine.rooms.get(roomId);
        const member = room.participants.get(actorId);
        const requestedRole = url.searchParams.get('role') === 'seated' ? 'seated' : 'spectator';
        const name = url.searchParams.get('name');
        const canSeat = [...room.participants.values()].filter(p => p.role === 'seated').length < room.maxSeats;
        const observe = url.searchParams.get('observe') === '1';
        if (observe && !existingSession) return response({ error: 'participant_session_required' }, 403);
        changed = seatRelinquished || !member || (!observe && ((requestedRole !== member.role && (requestedRole !== 'seated' || canSeat)) || (name && name !== member.name) || (url.searchParams.get('creatorToken') === room.creatorToken && !room.creatorId)));
        if (changed) {
          joined = engine.joinRoom(roomId, url, out);
          if (!joined) return new Response(out.body, { status: out.status, headers: out.headers });
          session = { roomId, participantId: actorId, expected: existingSession?.token_hash ?? null, hash };
        } else {
          joined = { room: engine.getRoomSnapshot(roomId, actorId), viewer: { ...engine.getRoomSnapshot(roomId, actorId).viewer, seatDenied: requestedRole === 'seated' && member.role !== 'seated' } };
        }
        active.add(actorId);
      } else {
        // All draft actions use the same tested rules as the original backend.
        await engine.handleRequest({
          url: url.pathname + url.search, method: request.method, headers: { host: url.host },
          async readJson(limit) { if (parsed.bytes > limit) throw new Error('request_body_too_large'); return structuredClone(body); }
        }, out);
        if (out.status >= 400) return new Response(out.body, { status: out.status, headers: out.headers });
      }
      try {
        const id = roomId || (url.pathname === '/api/rooms' && request.method === 'POST' ? JSON.parse(out.body).roomNumber : null);
        let room;
        let history;
        if (id && changed) {
          if (historyAction) history = recordDraftAction({ before: historyBefore, room: engine.rooms.get(id), roomId: id, actorId, action: historyAction, body, pools });
          const state = engine.serializeRoom(id);
          // Presence expiry is not revocation. Keep offline identities and their
          // permissions while snapshots/counts continue to use live participants.
          state.participants = [...new Map([...(storedRoom?.state.participants || []), ...state.participants])];
          state.poolObjectKey = selectedKey || `builtin:${builtinPool.id}`;
          const summary = { poolName: pools.getPool(state.draftSettings.poolId)?.name || 'Custom pool',
            methodId: state.draftSettings.methodId, status: state.draft?.status || 'not_started',
            maxSeats: state.maxSeats, allowSpectators: state.allowSpectators !== false };
          room = { id, expected: storedRoom?.revision ?? null, state, summary };
        }
        const poolChanges = [...pools.changes].map(([id, pool]) => ({ id, pool, expected: poolRows.get(id)?.revision ?? null, previousKey: poolRows.get(id)?.object_key, summary: pool && pools.getPoolSummary(pool) }));
        await store.commit({ room, poolChanges, session, history });
        if (joined) {
          // Presence changes can happen without a draft revision changing.
          joined.room.revision = `${(storedRoom.revision || 0) + (changed ? 1 : 0)}:${[...active].sort().join(',')}`;
          return response(joined);
        }
        const headers = new Headers(out.headers);
        headers.delete('access-control-allow-origin');
        headers.set('cache-control', 'no-store');
        if (id && out.body && headers.get('content-type')?.includes('application/json') && !headers.has('content-disposition')) {
          const snapshot = JSON.parse(out.body);
          if (snapshot.roomNumber === id && snapshot.draft) {
            snapshot.revision = `${(storedRoom?.revision || 0) + (changed ? 1 : 0)}:${[...active].sort().join(',')}`;
            out.body = JSON.stringify(snapshot);
          }
        }
        return new Response(request.method === 'HEAD' ? null : out.body, { status: out.status, headers });
      } catch (error) {
        if (error instanceof ConflictError) continue;
        throw error;
      }
    }
    return response({ error: 'room_busy', message: 'Another action just changed this room. Please try again.' }, 409);
  } catch (error) {
    if (error instanceof RequestError) return response({ error: error.message }, error.status);
    console.error('Sites draft storage failure:', error.message);
    return response({ error: 'storage_unavailable', message: 'Could not save or load the draft. Your last saved state is safe. Please try again.' }, 503);
  }
}
