import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";

// Local equivalents of the exact D1/R2 interfaces used by the Worker. No network.
export async function localStorageBindings(directory) {
  await mkdir(directory, { recursive: true });
  const database = new DatabaseSync(resolve(directory, "drafts.sqlite"));
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL)");
  const migrations = resolve(import.meta.dirname, "../drizzle");
  for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
    const sql = await readFile(resolve(migrations, name), "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");
    const applied = database.prepare("SELECT hash FROM local_migrations WHERE name = ?").get(name);
    if (applied) {
      if (applied.hash !== hash) throw new Error(`Applied migration changed: ${name}`);
      continue;
    }
    database.exec("BEGIN");
    try {
      database.exec(sql);
      database.prepare("INSERT INTO local_migrations (name, hash) VALUES (?, ?)").run(name, hash);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }
  const normalize = value => value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  function prepared(sql, values = []) {
    return {
      bind(...values) { return prepared(sql, values.map(normalize)); },
      async first() { return database.prepare(sql).get(...values) || null; },
      async all() { return { results: database.prepare(sql).all(...values), success: true }; },
      runSync() { const result = database.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
      async run() { return this.runSync(); }
    };
  }
  const bucketRoot = resolve(directory, "pools");
  await mkdir(bucketRoot, { recursive: true });
  const filename = key => {
    const path = resolve(bucketRoot, key);
    if (!path.startsWith(bucketRoot + sep)) throw new Error("Invalid object key");
    return path;
  };
  return {
    DB: {
      prepare: prepared,
      async batch(statements) {
        database.exec("BEGIN IMMEDIATE");
        try {
          const results = statements.map(statement => statement.runSync());
          database.exec("COMMIT");
          return results;
        } catch (error) { database.exec("ROLLBACK"); throw error; }
      }
    },
    BUCKET: {
      async get(key) {
        try { const text = await readFile(filename(key), "utf8"); return { json: async () => JSON.parse(text), text: async () => text }; }
        catch (error) { if (error.code === "ENOENT") return null; throw error; }
      },
      async put(key, value) {
        const path = filename(key);
        await mkdir(resolve(path, ".."), { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, value);
        await rename(temporary, path);
      },
      async delete(key) { try { await unlink(filename(key)); } catch (error) { if (error.code !== "ENOENT") throw error; } }
    },
    close() { database.close(); }
  };
}
