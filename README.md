# FrankenDraftTool

Personal project to create a web tool to help the TI4 Franken community draft and innovate.

## Sites version

The same frontend can run on Sites with a Worker that streams `/api/*` to the existing Render API. It preserves the existing rooms, draft methods, pools and TTS exports. The Sites audience is public, so players do not need a ChatGPT login. Render continues to own multiplayer state and saved pools; this is not a standalone backend migration.

Use Node 24 and npm:

```sh
npm install
npm run dev
```

The preview is at `http://127.0.0.1:4173` and connects to the existing Render API by default. To keep development data isolated, start `npm run dev:backend` in another terminal and run `SITES_BACKEND_ORIGIN=http://127.0.0.1:3000 npm run dev`.

```sh
npm test
npm run build
```

The build emits `dist/server/index.js` and static assets in `dist/client`. `.openai/hosting.json` keeps the Sites project identity. Publish using the Sites plugin; the GitHub remote remains `origin`.

See [the development recap](docs/DEVELOPMENT_STATUS.md) for features, recent history, checks and remaining work.

## Run locally

The project is split into two services:

- `frontend`: static web frontend served by nginx
- `backend`: Node.js API service

Run both services with Docker:

```sh
docker compose up --build
```

The frontend runs at `http://127.0.0.1:8080`.

The frontend proxies backend routes under `/api`. The starter health endpoint is available at:

```sh
http://127.0.0.1:8080/api/health
```

For backend-only development without Docker:

```sh
npm run dev:backend
```

## Hosting

This project now has separate frontend and backend services, so it should be hosted on an app platform rather than GitHub Pages.

The repo includes a Render Blueprint in `render.yaml` that creates:

- `yvonick-frankendrafttool`: static frontend
- `yvonick-frankendrafttool-api`: Node.js backend

Deploy the Blueprint from:

```sh
https://dashboard.render.com/blueprints/new?repo=https://github.com/Yvonick/FrankenDraftTool
```

After Render creates the services, the public frontend URL should be:

```sh
https://yvonick-frankendrafttool.onrender.com
```

The backend health check should be available through the frontend proxy at:

```sh
https://yvonick-frankendrafttool.onrender.com/api/health
```

The frontend also opens a live presence stream at `/api/presence` locally, or directly against the Render backend in production, to show how many browser tabs currently have the page open. This count is in-memory per backend instance.

Rooms are also stored in memory for now. The home page can create a numbered room at `/rooms/{roomNumber}`. Anyone with that URL can join, choose to sit down with a display name, or spectate. Rooms start with 6 seats, the creator can change that limit, and spectators can sit down later if a seat is available.

The room creator can configure and launch a draft once the room is full. Drafts randomly seat players around the table, deal starting bags from the pool, let players lock legal picks from their current bag, pass remaining bag contents clockwise, and reveal all drafted items when every bag is empty.

The host can restart an active or completed draft back to setup. Draft views can be grouped by item type or pick order. Named spectators can be promoted to super spectators, which lets them see player draft areas and current bags while a draft is active.

Custom pools can be loaded directly from Tabletop Simulator saved-object JSON files placed in `services/backend/pools/raw`. The backend parses top-level TTS bags as item types and extracts item names plus image URLs from cards, custom tiles, and custom models. The included `Franken Y V69.json` file is loaded this way as the `Franken Y V6.9` pool.

Public saved pools are written to `POOL_STORE_PATH`, defaulting locally to `services/backend/data/public-pools.json`. The Render Blueprint mounts a persistent disk at `/var/data` and sets `POOL_STORE_PATH=/var/data/public-pools.json`, so uploaded/saved public pools survive backend restarts. Render persistent disks require a paid web service instance; without the disk, saved pools fall back to the service's ephemeral filesystem and can disappear after restarts.
