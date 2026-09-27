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
    async commit({ room, poolChanges = [], session }) {
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
        }
        if (session) {
          checks.push("(SELECT token_hash FROM room_sessions WHERE room_id = ? AND participant_id = ?) IS NOT ?");
          values.push(session.roomId, session.participantId, session.expected);
          writes.push(statement("INSERT INTO room_sessions (room_id, participant_id, token_hash, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(room_id, participant_id) DO UPDATE SET last_seen = excluded.last_seen", session.roomId, session.participantId, session.hash, Date.now()));
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
