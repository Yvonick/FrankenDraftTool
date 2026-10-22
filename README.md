# FrankenDraftTool

A multiplayer drafting tool for the Twilight Imperium 4 Franken community. Import Tabletop Simulator pools, draft together through shareable rooms, and export the results back into TTS.

**[Open FrankenDraft](https://franken-draft-tool.yvonichou.chatgpt.site)** | [Development status](docs/DEVELOPMENT_STATUS.md)

The complete frontend and backend run on **Sites**, with durable D1 database storage and R2 pool files. Players do not need a ChatGPT account. Render and GitHub Pages are not part of the current deployment.

## What You Can Do

### Rooms and Players

- Create shareable rooms, choose a pool and draft method, and configure the seat limit. A draft can start with fewer players than the limit.
- List rooms on the homepage or keep them unlisted. New rooms are listed by default.
- Join as a named player or spectator; hosts can disable spectators, delegate admin rights, and grant super-spectator visibility individually or to all spectators.
- Reopen a room in the same browser to recover your seat. Closing a tab changes online presence, not seat ownership. Private browser contexts remain separate for testing.
- Leave or remove participants explicitly. During a draft, hand an open seat to a replacement through a single-use link, or remove the seat and restart after confirmation.
- Spectate individual players, all players, or live logs, subject to the room's visibility rules.

### Draft Methods

- **Bag Passing:** randomized seating, queued bags passed clockwise, private picks, per-type limits, and no duplicate type within a pick during the first rotation. Optional automatic picks handle bags with no remaining choice. Default picks per bag: **3**.
- **Nomination Auction:** 40 credits, two mulligan tokens and one ban token per player; configurable speaker-order bidding; rotating nominations; sealed bids with revealed recaps; random tie resolution; and ordered picks. Hosts/admins can undo actions and shuffle the remaining pool.
- Both methods show type-progress checklists and final results. Item previews support zoom, distinct backs, linked components, and descriptions; hovering the description icon shows its text.
- Players can hide drafted items from their personal view without changing their draft or export, resize their picks area, and mute bag-arrival chimes.

Only Bag Passing and Nomination Auction are playable engines. The Methods page describes methods; it is not a GPT-based method generator.

### Pools and TTS Exports

- Import TTS Saved Object JSON files directly. Room uploads remain private until saved publicly.
- Public pools store default player counts, picks per bag, auction speaker mode, type order, and per-type quantities. Ordinary types default to **2**; Speaker Order is a separate 0/1 meta type.
- Manage, rename, reorder types, remove, or **Update** a pool from a replacement JSON. Updating preserves matching type order and quantities, removes missing types, and appends new types.
- Pools are ordered by latest upload or saved update, both in the library and room selector. Active rooms retain their pinned pool version.
- Link extra components with a **Non-draft parts** bag containing sub-bags named after draftable items. Matching **Base Unit** items also link automatically from `Name I` to `Name II`. These components are not drafted separately.
- Export one named bag per player, with linked non-draft items in a sub-bag. The leftover pool preserves type bags and their original colors.
- Hosts/admins can export mid-draft, including currently open/queued items. Finished drafts can be exported from the final results.

## Draft Logs

The unlinked `/draft-history` page lists completed drafts, action sequences and final results. Bag-draft logs can show each player's opening bag and the bag before each pick.

Access requires the server-side `DRAFT_HISTORY_PASSKEY` secret. Set it through the Sites runtime environment; never commit its value or place it in frontend code. Without a non-empty value, the history API remains unavailable. This is a shared-password gate, not individual user accounts.

## Local Development

Use **Node.js 24** and npm:

```sh
npm ci
npm run dev
```

Open [localhost:4173](http://127.0.0.1:4173). The local server runs the same Worker API against SQLite and filesystem equivalents of D1/R2 under `.sites-runtime/storage`. Data survives process restarts and stays separate from production.

```sh
npm test
npm run build
```

The test suite covers both draft engines, persistence, concurrent actions, permissions, seat recovery and handoffs, logs, imports/exports, and frontend regressions. The build bundles the Worker, frontend and built-in pool into `dist/`.

| Setting | Purpose |
| --- | --- |
| `SITES_DEV_PORT` | Local port; defaults to 4173 |
| `SITES_DEV_HOST` | Local bind address; defaults to 127.0.0.1 |
| `DRAFT_HISTORY_PASSKEY` | Enables the local draft-history password gate |

Set local values in your shell before starting the server. `.env.example` documents the history secret; `npm run dev` does not automatically load an `.env` file. To load one explicitly, use `node --env-file=.env scripts/dev-sites.mjs`.

Alternatively, `docker compose up --build` serves the app at [localhost:8080](http://127.0.0.1:8080), with persistent storage in the `draft-data` volume. The supplied Compose configuration does not pass a history password; provide it to the container separately to enable draft logs locally.

## Architecture

| Location | Responsibility |
| --- | --- |
| `services/backend/draftEngine.js` | Shared Bag Passing and Nomination Auction rules |
| `services/backend/poolRegistry.js` | TTS imports, linked components and pool metadata |
| `services/sites/api.mjs` | Same-origin Worker API and session validation |
| `services/sites/storage.mjs` | D1 transactions, persistent state and immutable R2 pool versions |
| `services/sites/room-stream.mjs` | Authenticated server-sent room updates |
| `services/sites/seat-management.mjs` | Leaving, removal and seat handoffs |
| `services/sites/draft-history.mjs`, `history-api.mjs` | Action recording and protected archive access |
| `services/frontend/` | Room, pool, method and history interfaces |
| `db/schema.ts`, `drizzle/` | Database schema and versioned SQL migrations |
| `scripts/`, `tests/` | Local storage adapters, build scripts and regression tests |

Atomic revision checks protect concurrent actions. Room state is compressed in D1, and each room pins an immutable pool version so public edits or deletion cannot break an ongoing draft or its export. Browser-local per-room credentials recover seats; clearing site data or ending a private browsing session can still lose that identity.

Active tabs receive authenticated server-sent events. Streams check the indexed room revision every 250 ms, or every two seconds for hidden tabs, and only send changed snapshots. Streams renew every 20 seconds, honor backpressure, and stop on disconnect. Presence refreshes every ten seconds and expires after 60 seconds without deleting the seat. The 250 ms interval is not a guaranteed end-to-end latency.

## Publishing and GitHub Workflow

- This GitHub repository tracks the validated application source. Commit and push validated changes as part of each completed task, unless explicitly asked to pause or keep work local. Repository instructions are in [AGENTS.md](AGENTS.md).
- Run `npm test` and `npm run build` before pushing. Keep related documentation current, and exclude secrets, local runtime data, build output and unrelated working files.
- Sites has its own source repository. When working in a Sites checkout, synchronize the validated changes back into the GitHub checkout and push them too. A successful Sites publication alone does not update GitHub.
- Publish through the Sites workflow using the existing project in `.openai/hosting.json`, with `DB` (D1) and `BUCKET` (R2). Preserve the public audience and existing runtime secrets. A GitHub push alone does not deploy the live Site.
- For schema changes, edit `db/schema.ts`, run `npm run db:generate`, and inspect the generated SQL. Never edit an already deployed migration. Local startup applies new migrations automatically; Sites publication applies the checked-in migrations.

The legacy Node server/filesystem adapters in `services/backend` are retained for reference, not used by Sites, `npm run dev`, or Docker Compose.
