# Development status — 27 September 2026

## Starting point

- GitHub: [Yvonick/FrankenDraftTool](https://github.com/Yvonick/FrankenDraftTool), `main` at `513939fca980c6f8da39717bb84d35f734249858`.
- 65 commits; latest commit: **Fix nomination undo picked item state**, 4 July 2026 UTC (5 July in Berlin).
- No open issues or pull requests were returned by GitHub on 27 September.
- The latest visible GitHub Actions run was the legacy **pages build and deployment**, which failed on 4 July at `6b4ffb0`. There is no checked-in CI workflow or automated test suite in the imported revision. The old Pages result does not establish Render's health.
- The existing Render API returned a successful health response during this review.

## Implemented features

| Area | Current behavior |
| --- | --- |
| Rooms | Numbered shareable rooms, configurable seats, display names, live presence and reconnects |
| Roles | Host, delegated admins, players, spectators and super spectators |
| Bag Passing | Randomized seats, private bags, legal picks and type caps, clockwise queues, final reveal |
| Nomination Auction | Speaker order modes, nominations, 40-credit budgets, hidden bids, mulligans, bans, wildcard selection, undo and pool reshuffling |
| Pools | Built-in Franken Y V6.9, TTS JSON parsing, image overrides, public saved pools and configurable type counts |
| Export | TTS JSON with player bags and remaining pool items; admin exports during active drafts |
| Interface | Existing dark space theme, item previews, grouping, progress indicators and optional sound cues |

Recent development concentrated on nomination undo correctness, UI stability, draft controls, compact undo snapshots and reduced auction memory growth. The methods module implements two playable methods. Names such as snake/open-pick/custom also appear as definition options, but they are not additional implemented draft engines.

## Sites implementation

The existing frontend is now deployable on Sites, with a Cloudflare Worker forwarding `/api/*` to the existing Render backend. This keeps the multiplayer engine, live SSE streams, saved pools and exports intact. It is a hosting adapter, not a migration of the backend or its stored data.

- Public Sites access is requested: no ChatGPT login should be required.
- `/`, `/pools`, `/methods` and `/rooms/123456` are served by the Worker; card images and the favicon are packaged as static assets.
- API responses stream without buffering. The adapter preserves request payloads, query parameters, API status codes and export filenames.
- Sites cookies, authorization and identity headers are not forwarded to Render. API responses are not cached.
- The original Docker and Render configuration remains usable.
- The frontend has optional read-only WebMCP tools for the draft catalog and current viewer's room.

The source of truth remains Render. Pools and rooms are shared with the existing app, rather than copied into an independent Sites environment. Browser session identifiers and host tokens are origin-local, so an existing host session does not automatically transfer between the old URL and the new Sites URL.

## Remaining work and limitations

1. **Durable rooms:** Rooms, participants and in-progress drafts remain in backend memory. Restarts lose drafts; multiple backend instances would need shared room state and coordination. Public saved pools use the configured Render disk; its actual disk configuration was not audited.
2. **Authorization:** The existing API relies on room creator tokens and client participant IDs. Public-pool writes have no application account gate. A public Sites URL retains these existing permissions; Sites login removal does not add application-level security.
3. **Coverage:** The new tests cover the adapter and representative draft flows. Full multiplayer auction rules, reconnection timing, large uploads and every undo edge case still need dedicated regression coverage.
4. **Maintenance:** The UI is largely one inline HTML/CSS/JavaScript file, and the backend is a large server module. Separating transport, rules and UI state would make future changes easier to test.
5. **Hosting dependency:** The Sites interface requires the Render API. A completely independent Sites backend would need a separate persistence and real-time transport migration.

## Validation

- **7 automated tests passed**, including a separate local backend exercising room creation, seat configuration, host authorization, live room presence, both draft engines, legal bag picks, speaker-order bidding, active TTS export and draft restart.
- Adapter checks cover deep links, streamed responses, request payloads, credential isolation, export headers, error statuses and unavailable-backend handling.
- Local browser smoke checks confirmed the homepage's live presence and both method descriptions from the real backend. An empty room was opened to check frontend navigation; no production draft was started and no production pool was changed.
- WebMCP catalog read and the expected no-room error were checked in the supported in-app browser.
- The production build and Sites deployment are checked as part of publishing. Full concurrent multiplayer playtesting remains outstanding.
