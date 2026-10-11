export class ConflictError extends Error {}
export class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function compress(value) {
  const bytes = await new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  if (bytes.byteLength > 1800000) throw new RequestError(413, "room_storage_limit");
  return bytes;
}
async function decompress(bytes) {
  return new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"))).json();
}

export function createStorage(env) {
  if (!env.DB || !env.BUCKET) throw new Error("Sites storage bindings are unavailable");
  const db = env.DB;
  const statement = (sql, ...values) => db.prepare(sql).bind(...values);
  return {
    async initialize(builtin, summary) {
      await db.batch([
        statement("INSERT OR IGNORE INTO mutation_guard (id) VALUES (1)"),
        statement("INSERT OR IGNORE INTO pools (id, revision, object_key, summary, deleted) VALUES (?, 1, ?, ?, 0)", builtin.id, `builtin:${builtin.id}`, JSON.stringify(summary))
      ]);
    },
    async catalog() {
      return (await statement("SELECT * FROM pools ORDER BY rowid").all()).results;
    },
    async room(id) {
      const row = await statement("SELECT revision, state FROM rooms WHERE id = ?", id).first();
      return row ? { revision: row.revision, state: await decompress(row.state) } : null;
    },
    async profile(hash) {
      return (await statement("SELECT name FROM name_preferences WHERE token_hash = ?", hash).first())?.name || '';
    },
    async saveProfile(hash, name) {
      if (!name) await statement("DELETE FROM name_preferences WHERE token_hash = ?", hash).run();
      else await statement("INSERT INTO name_preferences (token_hash, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at", hash, name, Date.now()).run();
    },
    async currentRooms() {
      const rows = await statement("SELECT d.room_id, d.summary, count(s.participant_id) AS online FROM room_directory d JOIN room_sessions s ON s.room_id = d.room_id AND s.last_seen > ? WHERE d.listed = 1 AND d.status != 'complete' GROUP BY d.room_id ORDER BY max(s.last_seen) DESC LIMIT 100", Date.now() - 60000).all();
      return rows.results.map(row => ({ ...JSON.parse(row.summary), roomNumber: row.room_id, online: row.online }));
    },
    async roomRevision(id) {
      return (await statement("SELECT revision FROM rooms WHERE id = ?", id).first())?.revision ?? null;
    },
    async finishedDrafts(cursor) {
      const rows = (await statement("SELECT id, completed_at, summary, event_count FROM draft_history WHERE status = 'complete' AND (completed_at < ? OR (completed_at = ? AND id < ?)) ORDER BY completed_at DESC, id DESC LIMIT 26", cursor?.at ?? Number.MAX_SAFE_INTEGER, cursor?.at ?? Number.MAX_SAFE_INTEGER, cursor?.id ?? '').all()).results;
      const page = rows.slice(0, 25);
      return { drafts: page.map(row => ({ ...JSON.parse(row.summary), id: row.id, completedAt: row.completed_at, eventCount: row.event_count })),
        nextCursor: rows.length > 25 ? `${page.at(-1).completed_at}.${page.at(-1).id}` : null };
    },
    async finishedDraft(id) {
      const row = await statement("SELECT summary, results, completed_at, event_count FROM draft_history WHERE id = ? AND status = 'complete'", id).first();
      return row ? { ...JSON.parse(row.summary), id, completedAt: row.completed_at, eventCount: row.event_count,
        results: row.results ? await decompress(row.results) : null } : null;
    },
    async draftEvents(id, after) {
      const rows = (await statement("SELECT event FROM draft_events WHERE draft_id = ? AND sequence > ? AND EXISTS (SELECT 1 FROM draft_history WHERE id = ? AND status = 'complete') ORDER BY sequence LIMIT 101", id, after, id).all()).results;
      const events = rows.slice(0, 100).map(row => JSON.parse(row.event));
      return { events, nextAfter: rows.length > 100 ? events.at(-1).sequence : null };
    },
    async roomDraftEvents(id, after, through) {
      const rows = (await statement('SELECT event FROM draft_events WHERE draft_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT 101', id, after, through).all()).results;
      const events = rows.slice(0, 100).map(row => JSON.parse(row.event));
      return { events, nextAfter: rows.length > 100 ? events.at(-1).sequence : null };
    },
    async draftBag(id, { playerId, sequence }) {
      const row = await statement("SELECT summary FROM draft_history WHERE id = ? AND status = 'complete'", id).first();
      if (!row) throw new RequestError(404, 'draft_not_found');
      const summary = JSON.parse(row.summary);
      if (summary.engine !== 'bag-pass') throw new RequestError(400, 'not_a_bag_draft');
      const readEvent = async number => {
        const record = await statement('SELECT event FROM draft_events WHERE draft_id = ? AND sequence = ?', id, number).first();
        return record ? JSON.parse(record.event) : null;
      };
      const opening = await readEvent(1);
      const target = sequence ? await readEvent(sequence) : null;
      if (sequence && !['bag_pick', 'bag_pass'].includes(target?.kind)) throw new RequestError(404, 'bag_not_found');
      if (playerId && !summary.players.some(player => player.id === playerId)) throw new RequestError(404, 'player_not_found');
      const bag = opening?.kind === 'draft_started' && opening.bags?.find(bag => playerId ? bag.player.id === playerId : bag.bagId === target.bagId);
      if (!bag) return { available: false };

      // Reconstruct only the requested bag, in bounded batches. No room or pool
      // blobs are loaded, and no per-pick snapshots need to be stored.
      const removed = new Set();
      if (target) {
        let after = 1;
        for (;;) {
          const records = (await statement("SELECT sequence, event FROM draft_events WHERE draft_id = ? AND sequence > ? AND sequence < ? AND json_extract(event, '$.bagId') = ? ORDER BY sequence LIMIT 100", id, after, sequence, bag.bagId).all()).results;
          for (const record of records) {
            const event = JSON.parse(record.event);
            if (event.kind === 'bag_pick' || event.kind === 'bag_pass') {
              for (const value of [...(event.items || []), ...(event.binned || [])]) removed.add(value.id);
            }
          }
          if (records.length < 100) break;
          after = records.at(-1).sequence;
        }
      }
      const selected = new Set((target?.items || []).map(value => value.id));
      return { available: true, opening: !target, player: target?.actor || bag.player.name, sequence: target?.sequence ?? null,
        kind: target?.kind, bagId: bag.bagId, typeOrder: summary.settings.typeOrder,
        items: bag.items.filter(value => !removed.has(value.id)).map(value => ({ ...value, selected: selected.has(value.id) })) };
    },
    async pool(key) {
      const object = await env.BUCKET.get(key);
      if (!object) throw new Error("Pool object is unavailable");
      return object.json();
    },
    session(roomId, participantId) {
      return statement("SELECT token_hash, last_seen FROM room_sessions WHERE room_id = ? AND participant_id = ?", roomId, participantId).first();
    },
    async activeParticipants(roomId) {
      const rows = await statement("SELECT participant_id FROM room_sessions WHERE room_id = ? AND last_seen > ?", roomId, Date.now() - 60000).all();
      return new Set(rows.results.map(row => row.participant_id));
    },
    async heartbeat(roomId, participantId, hash) {
      await statement("UPDATE room_sessions SET last_seen = ? WHERE room_id = ? AND participant_id = ? AND token_hash = ?", Date.now(), roomId, participantId, hash).run();
    },
    async presence(id) {
      const now = Date.now();
      await db.batch([
        statement("INSERT INTO page_presence (id, last_seen) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen", id, now),
        statement("DELETE FROM page_presence WHERE last_seen < ?", now - 60000)
      ]);
      return (await statement("SELECT count(*) AS count FROM page_presence WHERE last_seen > ?", now - 60000).first()).count;
    },
    async commit({ room, poolChanges = [], session, history }) {
      const checks = [];
      const values = [];
      const writes = [];
      const uploaded = [];
      try {
        for (const change of poolChanges) {
          checks.push("(SELECT revision FROM pools WHERE id = ?) IS NOT ?");
          values.push(change.id, change.expected);
          const key = change.pool ? `pools/${change.id}/${crypto.randomUUID()}.json` : change.previousKey;
          if (change.pool) {
            await env.BUCKET.put(key, JSON.stringify(change.pool), { httpMetadata: { contentType: "application/json" } });
            uploaded.push(key);
          }
          writes.push(statement("INSERT INTO pools (id, revision, object_key, summary, deleted) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, object_key = excluded.object_key, summary = excluded.summary, deleted = excluded.deleted", change.id, (change.expected || 0) + 1, key, JSON.stringify(change.summary || {}), change.pool ? 0 : 1));
          change.savedKey = key;
        }
        if (room) {
          const savedPool = poolChanges.find(change => change.pool && change.id === room.state.draftSettings.poolId);
          if (savedPool) room.state.poolObjectKey = savedPool.savedKey;
          checks.push("(SELECT revision FROM rooms WHERE id = ?) IS NOT ?");
          values.push(room.id, room.expected);
          const state = await compress(room.state);
          writes.push(statement("INSERT INTO rooms (id, revision, state, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, state = excluded.state, updated_at = excluded.updated_at", room.id, (room.expected || 0) + 1, state, Date.now()));
          writes.push(statement("INSERT INTO room_directory (room_id, listed, status, summary) VALUES (?, ?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET listed = excluded.listed, status = excluded.status, summary = excluded.summary", room.id, room.state.listed === true ? 1 : 0, room.state.draft?.status || 'not_started', JSON.stringify(room.summary || {})));
        }
        if (session) {
          checks.push("(SELECT token_hash FROM room_sessions WHERE room_id = ? AND participant_id = ?) IS NOT ?");
          values.push(session.roomId, session.participantId, session.expected);
          writes.push(statement("INSERT INTO room_sessions (room_id, participant_id, token_hash, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(room_id, participant_id) DO UPDATE SET last_seen = excluded.last_seen", session.roomId, session.participantId, session.hash, Date.now()));
        }
        if (history) {
          const results = history.results ? await compress(history.results) : null;
          writes.push(statement(`INSERT INTO draft_history (id, room_id, status, completed_at, summary, event_count, results) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, completed_at = excluded.completed_at, event_count = excluded.event_count, results = ${history.preserveResults ? 'draft_history.results' : 'excluded.results'}`,
            history.id, history.roomId, history.status, history.completedAt, JSON.stringify(history.summary), history.eventCount, results));
          for (const event of history.events) writes.push(statement("INSERT INTO draft_events (draft_id, sequence, event) VALUES (?, ?, ?)", history.id, event.sequence, JSON.stringify(event)));
        }
        if (!writes.length) return;
        await db.batch([
          statement(`INSERT INTO mutation_guard (id) SELECT 1 WHERE ${checks.join(" OR ")}`, ...values),
          ...writes
        ]);
      } catch (error) {
        if (/UNIQUE constraint failed: mutation_guard.id/.test(String(error))) {
          await Promise.all(uploaded.map(key => env.BUCKET.delete(key)));
          throw new ConflictError("concurrent_update");
        }
        // An uncertain D1 failure may already have committed. Retain its immutable
        // pool objects; do not delete data that a successful commit may reference.
        throw error;
      }
    }
  };
}
