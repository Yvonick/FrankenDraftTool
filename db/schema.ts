import { blob, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull(),
  state: blob("state", { mode: "buffer" }).notNull(),
  updatedAt: integer("updated_at").notNull()
});
export const pools = sqliteTable("pools", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull(),
  objectKey: text("object_key").notNull(),
  summary: text("summary").notNull(),
  deleted: integer("deleted").notNull().default(0)
});
export const sessions = sqliteTable("room_sessions", {
  roomId: text("room_id").notNull(),
  participantId: text("participant_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  lastSeen: integer("last_seen").notNull()
}, table => [primaryKey({ columns: [table.roomId, table.participantId] })]);
export const presence = sqliteTable("page_presence", {
  id: text("id").primaryKey(),
  lastSeen: integer("last_seen").notNull()
}, table => [index("idx_presence_last_seen").on(table.lastSeen)]);
// A duplicate insert intentionally aborts a batch when an optimistic check fails.
export const guard = sqliteTable("mutation_guard", { id: integer("id").primaryKey() });

export const profiles = sqliteTable("name_preferences", {
  tokenHash: text("token_hash").primaryKey(),
  name: text("name").notNull(),
  updatedAt: integer("updated_at").notNull()
});
export const directory = sqliteTable("room_directory", {
  roomId: text("room_id").primaryKey(),
  listed: integer("listed").notNull().default(0),
  status: text("status").notNull(),
  summary: text("summary").notNull()
}, table => [index("idx_directory_listed_status").on(table.listed, table.status)]);
