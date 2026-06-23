# FrankenDraftTool

Personal project to create a web tool to help the TI4 Franken community draft and innovate.

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

The room creator can configure and launch a draft once the room is full. The current prototype includes one generated Testing Pool with 10 item types and 50 items per type. Drafts randomly seat players around the table, deal starting bags from the pool, let players lock legal picks from their current bag, pass remaining bag contents clockwise, and reveal all drafted items when every bag is empty.

The host can restart an active or completed draft back to setup. Draft views can be grouped by item type or pick order. Named spectators can be promoted to super spectators, which lets them see player draft areas and current bags while a draft is active.
