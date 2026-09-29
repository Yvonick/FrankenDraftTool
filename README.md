# FrankenDraftTool

A multiplayer drafting tool for the TI4 Franken community, with Bag Passing, Nomination Auction, custom Tabletop Simulator pools and TTS exports.

## Standalone Sites application

The frontend **and backend run on Sites**. Rooms, players and draft progress are stored in D1; uploaded pools are stored in R2. The application makes no requests to Render and needs no Render services, disk, environment variables or credentials. The public site requires no ChatGPT login.

- Site: [Franken Draft Tool](https://franken-draft-tool.yvonichou.chatgpt.site)
- [Development recap](docs/DEVELOPMENT_STATUS.md)
- [GitHub source](https://github.com/Yvonick/FrankenDraftTool)

## Local development

Use Node 24 and npm:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:4173`. This runs the complete application against a local SQLite database and a local pool directory under `.sites-runtime/storage`. Both survive restarting the process. Local data is separate from the published Site. No external backend is needed.

```sh
npm test
npm run build
```

Alternatively, `docker compose up --build` serves the same standalone application at `http://127.0.0.1:8080`, with storage in the `draft-data` Docker volume. The old two-service Docker setup is retired.

## Architecture and publishing

- `services/backend/draftEngine.js`: shared draft rules, isolated from HTTP server lifecycle and persistence.
- `services/backend/poolRegistry.js`: TTS parsing and pool registry.
- `services/sites/api.mjs`: native Worker API and browser-session validation.
- `services/sites/storage.mjs`: D1 transactions and immutable R2 pool versions.
- `services/sites/room-stream.mjs`: authenticated, bounded server-sent event streams observing durable room revisions.
- `services/frontend/index.html`: the existing interface; same-origin API calls and streamed multiplayer updates with automatic reconnects.
- `db/schema.ts` and `drizzle/`: schema and generated SQL migrations.

The build bundles the engine, built-in Franken Y V6.9 pool and interface into `dist/server/index.js`; images are packaged in `dist/client`. `.openai/hosting.json` binds the existing Sites project to `DB` (D1) and `BUCKET` (R2). Publish with the Sites plugin, which packages and applies the checked-in migrations. Keep public access enabled.

For schema changes, edit `db/schema.ts`, run `npm run db:generate`, and inspect the generated SQL. Never edit an already deployed migration. Local development applies new migrations automatically on startup.

Room updates use atomic revision checks to prevent simultaneous actions from overwriting each other. Room state is compressed in D1; each room pins its pool version so edits or deletion from the public catalog do not break an ongoing draft or TTS export. Browser session credentials stay in session storage, so reloading the same tab reconnects to its player.

Active tabs receive authenticated server-sent events. Each stream checks an indexed D1 revision every 250 ms, loading and sending the full private-safe snapshot only when changed. This is a check interval, not a guaranteed end-to-end latency: database and network time are additional. Hidden tabs check every two seconds. Streams renew every 20 seconds, stop polling under backpressure, and cancel their timers on disconnect. Presence is refreshed every ten seconds and expires after 60 seconds. Reconnects resume from the current persisted snapshot; older responses cannot roll back newer displayed state. No external realtime service or shared Worker memory is required. At steady state, each active viewer adds approximately four small indexed reads per second; database usage grows with concurrent viewers.

## Migration from Render

Render is no longer part of the deployed application. Its public pool catalog was checked on 27 September 2026 and contained only the built-in Franken Y V6.9 pool, which is bundled here. No saved custom public pools needed copying. Existing in-memory rooms and browser sessions on the old URL were not transferred: create new rooms on the Sites URL.

The Render Blueprint has been removed. Legacy Node server/filesystem adapters remain in `services/backend` for reference; they are not used by Sites, `npm run dev`, or Docker Compose. Render services can be retired independently once any games on the old URL have finished.
