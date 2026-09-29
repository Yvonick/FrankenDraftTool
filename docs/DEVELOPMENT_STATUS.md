# Development status — 29 September 2026

## Starting point

- Imported [Yvonick/FrankenDraftTool](https://github.com/Yvonick/FrankenDraftTool), `main` at `513939fca980c6f8da39717bb84d35f734249858`, into this local Git repository.
- 65 commits; latest upstream change: **Fix nomination undo picked item state**, 4 July 2026 UTC (5 July in Berlin).
- GitHub returned no open issues or pull requests on 27 September.
- The latest visible GitHub Actions run was the old **pages build and deployment**, which failed on 4 July. The imported revision had no checked-in CI workflow or automated test suite.
- Recent upstream work focused on nomination undo correctness, draft controls, UI stability and reduced auction memory growth.

## Implemented product

| Area | Current behavior |
| --- | --- |
| Rooms | Shareable numbered rooms, configurable seats, display names, live presence and reconnects |
| Roles | Host, delegated admins, players, spectators and super spectators |
| Bag Passing | Randomized seats, private bags, legal picks and type caps, clockwise queues, final reveal |
| Nomination Auction | Speaker order modes, nominations, 40-credit budgets, hidden bids, mulligans, bans, wildcard selection, undo and pool reshuffling |
| Pools | Built-in Franken Y V6.9, TTS JSON parsing, image overrides, public saved pools and configurable type counts |
| Export | TTS JSON containing player bags and remaining pool items; admin exports during active drafts |
| Interface | Existing dark space theme, item previews, grouping, progress indicators and sound cues |

Two draft methods are playable. Snake, open-pick and custom labels in method definitions do not represent additional implemented engines.

## Complete Sites migration

The initial Sites proxy has been replaced with an independent backend. All application requests stay on the Sites origin. No Render service, persistent disk or credential is required. Sites access is public and players do not need a ChatGPT account.

- The original draft rules are shared by a stateless Worker adapter.
- D1 stores compressed room state, session ownership, public pool metadata and presence leases. R2 stores immutable uploaded pool files.
- Atomic revision checks with bounded retries preserve concurrent actions from different Worker instances. Failed writes return a recoverable error.
- Each room pins an immutable pool version. Editing or deleting the catalog entry cannot remove an ongoing draft's export source.
- Authenticated SSE replaces the Node server's in-memory broadcasts and the initial migration's 1.5-second browser polling. Each active stream observes the durable room revision every 250 ms; hidden tabs use two seconds. Only changed snapshots are rebuilt and sent. Streams renew every 20 seconds, honor backpressure, and release timers on cancellation. Disconnected presence expires after 60 seconds.
- Participant actions require a random browser-session credential, stored only in that browser tab's session storage. Knowing another player's public ID does not authorize their actions.
- Local development runs the same Worker API with persistent SQLite and filesystem implementations of D1/R2. It needs no network backend.
- A generated schema migration provisions five tables and a presence index. The built-in pool is seeded idempotently by the runtime.
- The Render deployment configuration is removed, and Docker Compose runs the same standalone local application.

The old Render catalog contained only Franken Y V6.9 when inspected. No custom public pools needed importing. Old in-memory rooms and browser identities were not migrated; new games should use the Sites URL. No Render services have been shut down by this change.

## Validation

Automated tests cover standalone routes with external fetch forbidden; six simultaneous joins and picks; participant impersonation rejection; room and pool persistence after reopening storage; public pool edits/deletion during an active draft; room-saved private pools; auction speaker bidding and undo; full Bag Passing and Nomination Auction games with repeated reloads, mulligans, bans and final exports; unavailable storage and failed pool writes; and frontend syntax and request routing.

Streaming tests additionally cover cross-worker delivery, secret-bid filtering, matching action/stream revisions, observe-only reconnects, failed authentication, revision-only idle reads, slow-reader backpressure, cancellation, presence heartbeats and bounded renewal. The update interval excludes database and network latency; it is not a 250 ms end-to-end guarantee.

Reconnect review also corrected a migration issue where another player's save could discard an offline admin or super spectator's permissions. Live presence is filtered separately from saved identities. Returning to a full lobby cannot overfill its seats. The suite now contains 17 tests.

Local browser checks verify the homepage, room creation and joining with the built-in pool and host controls, without a login. Publication must pass the Sites build/package workflow and a live anonymous storage smoke check.

## Remaining limits and follow-up work

1. **Public pool moderation:** Public pool management retains the community-editable permissions of the original application. It has no user-account gate.
2. **Storage lifecycle:** Room snapshots have a 1.8 MB compressed limit to stay below D1's row limit. Old rooms and immutable pool versions are retained; retention/backup tooling is future work.
3. **Session recovery:** Reopening the same tab survives reloads. Clearing browser session storage loses player identity; cross-device identity recovery is not implemented.
4. **Coverage:** Both engines have end-to-end automated coverage, but every wildcard, role transition and prolonged network outage still merits multiplayer playtesting. Docker packaging has not been run in this environment.
5. **Maintenance:** The large inline UI and draft rules modules could be separated further. CI is not yet configured on GitHub.
