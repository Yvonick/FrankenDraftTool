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

The frontend also opens a live presence stream at `/api/presence` to show how many browser tabs currently have the page open. This count is in-memory per backend instance.
