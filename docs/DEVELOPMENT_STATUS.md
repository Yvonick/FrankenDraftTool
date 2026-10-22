# Development Status - 23 October 2026

## Current Baseline

- Live app: [FrankenDraft](https://franken-draft-tool.yvonichou.chatgpt.site).
- Latest published version: **Sites v26**, source commit `a7834afca7240b4b6fb3ef2b27f6a958347190d6`.
- This GitHub synchronization includes the 26 source commits since the original GitHub baseline, plus current documentation and repository workflow guidance. It does not change the running Site.
- Frontend and backend are fully hosted on Sites. D1 stores rooms, identities, pool metadata, presence and draft history; R2 stores immutable pool files. No Render dependency or ChatGPT login is required.

## Implemented Product

| Area | Current behavior |
| --- | --- |
| Rooms | Shareable rooms, optional homepage listing, saved name preferences, configurable seats and spectator access |
| Roles | Host, delegated admins, players, spectators, multiple super spectators and room-wide super visibility |
| Seat management | Browser-local reconnect credentials, durable seats, explicit leave/kick, single-use replacement links, confirmation before removing a seat and restarting |
| Bag Passing | Private queued bags, type caps, first-rotation constraints, optional forced-pick automation, final reveal |
| Nomination Auction | Speaker modes, hidden bids, full recaps, credits/tokens, mulligans, bans, wildcard choices, ordered picks, undo and pool shuffle |
| Pools | Private room uploads, public saved defaults, drag/drop type order, replacement imports preserving matching settings, newest-first lists |
| Linked parts | Named sub-bags in Non-draft parts, automatic matching Base Unit I/II links, attachment previews and export |
| Exports | Named player bags with non-draft sub-bags; leftover pool retaining bag colors; current items included in admin mid-draft exports |
| Logs | Durable action history, protected completed-draft page, opening/per-pick bag views and permission-filtered live room logs |
| Interface | Consistent packed item grids, adjustable picks area, hideable picks, progress checklists, muted/unmuted chimes, zoom/back/attachment/description tools |

Only Bag Passing and Nomination Auction have playable engines. Other descriptions do not represent implemented engines; there is no GPT integration.

## Persistence and Realtime Updates

- Atomic revision checks and transactional writes prevent simultaneous actions from overwriting one another. Storage failures return recoverable errors.
- Rooms pin immutable pool versions, preserving drafts and exports when a public pool is edited or removed.
- Browser-local room identity survives closing and reopening tabs. Separate private browsing contexts remain independent; clearing browser data or ending private browsing can lose credentials.
- Seat handoffs rotate credentials and preserve draft progress without granting the replacement the previous player's host/admin rights.
- Authenticated SSE observes room revisions every 250 ms in active tabs, or every two seconds in hidden tabs. Only changed snapshots are rebuilt and sent. Streams renew after 20 seconds, honor backpressure, and cancel timers on disconnect.
- Presence leases expire after 60 seconds, but seats and privileges are retained until an explicit management action.
- Draft events and final results are persisted. The archive requires the server-side `DRAFT_HISTORY_PASSKEY`; no password value belongs in Git.
- Pool update timestamps persist with the catalog. Older pools recover timestamps from stored object metadata without loading every pool or altering pinned versions.

## Validation

The current suite has **126 passing tests**, covering:

- Complete Bag Passing and Nomination Auction drafts, solo picks, type limits, automation, bidding and undo.
- Concurrent joins/actions, permissions, secret-bid filtering, seat recovery, handoffs and credential invalidation.
- Persistent rooms and pools across storage reloads, pinned versions, failed writes and storage conflicts.
- TTS imports, pool replacement, linked parts, image crops, bag colors and active/final exports.
- Archive access, complete results, opening/per-pick bag reconstruction and filtered live logs.
- Frontend selection, form-state preservation, ordering, packing, splitters, dialogs and update stability.
- Bounded streams, slow readers, disconnect cleanup and cross-worker delivery.

The v26 release also passed desktop/mobile browser checks for pool ordering, selected-pool preservation, description tooltips and dialogs. The standalone build succeeds. Docker packaging has not been independently run in this environment.

On 23 October, `npm ci`, `npm test` and `npm run build` succeeded for the GitHub synchronization. `npm audit --omit=dev` reported no findings. The full audit reported four moderate findings in the existing development-only `drizzle-kit` / `@esbuild-kit` / nested `esbuild` chain ([advisory](https://github.com/advisories/GHSA-67mh-4wv8-2f99)); these remain a separate dependency-maintenance task. No forced dependency changes were made.

## Working Agreement

Validated changes must be committed and pushed to [GitHub](https://github.com/Yvonick/FrankenDraftTool), not only published to Sites. See [AGENTS.md](../AGENTS.md). Preserve unrelated local files, avoid force pushes, and report any failed validation or push instead of calling the synchronization complete.

GitHub Actions CI is not configured in this snapshot. `npm test` and `npm run build` are the required local checks; a GitHub push does not automatically publish to Sites.

## Remaining Limits

1. Public pool management is community-editable, without an individual account gate.
2. The draft archive uses a shared password, not per-person authorization.
3. Compressed room snapshots are limited to 1.8 MB. Old rooms, history and immutable pool versions currently have no automated retention/backup policy.
4. There is no account-based cross-device seat recovery. A room admin can provide a replacement-seat link when credentials are lost.
5. Realtime database usage grows with concurrent viewers; the update interval excludes storage and network latency.
6. Further multiplayer testing remains useful for prolonged outages and unusual pool combinations. The large frontend and draft-engine modules could be split further.

## Migration Context

The original GitHub baseline was `513939fca980c6f8da39717bb84d35f734249858` (nomination undo fix). The Render catalog inspected on 27 September 2026 contained only the built-in Franken Y V6.9 pool, so no custom public pools needed copying. Old in-memory rooms and browser identities were not transferred to Sites. The Render Blueprint was removed; legacy server adapters remain only for reference.
