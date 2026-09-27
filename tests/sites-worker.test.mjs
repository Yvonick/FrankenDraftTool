import test from "node:test";
import assert from "node:assert/strict";
import { createWorker, BACKEND_ORIGIN } from "../services/sites/worker.mjs";

const html = "<!doctype html><title>FrankenDraftTool</title>";
test("application deep links work and missing assets return 404", async () => {
  const worker = createWorker({ html });
  for (const path of ["/", "/pools", "/methods", "/rooms/123456"]) {
    const response = await worker.fetch(new Request(`https://draft.test${path}`));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), html);
  }
  assert.equal((await worker.fetch(new Request("https://draft.test/missing.png"))).status, 404);
  assert.equal((await worker.fetch(new Request("https://draft.test/", { method: "HEAD" }))).body, null);
});

test("API forwarding retains payload/query but isolates Sites credentials", async () => {
  let called = false;
  const worker = createWorker({ html, fetchBackend: async (url, options) => {
    called = true;
    assert.equal(url.origin, BACKEND_ORIGIN);
    assert.equal(url.pathname, "/api/rooms/123456/settings");
    assert.equal(url.searchParams.get("viewerId"), "player");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "manual");
    for (const header of ["cookie", "authorization", "oai-authenticated-user-email", "origin"]) {
      assert.equal(options.headers.has(header), false);
    }
    assert.equal(await new Response(options.body).text(), '{"maxSeats":6}');
    return Response.json({ ok: true }, { headers: { "set-cookie": "upstream=secret", "access-control-allow-origin": "https://old.test" } });
  }});
  const response = await worker.fetch(new Request("https://draft.test/api/rooms/123456/settings?viewerId=player", {
    method: "POST", body: '{"maxSeats":6}', headers: {
      "content-type": "application/json", cookie: "login=secret", authorization: "Bearer secret",
      "oai-authenticated-user-email": "private@example.test", origin: "https://draft.test"
    }
  }));
  assert.equal(called, true);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.has("set-cookie"), false);
  assert.equal(response.headers.has("access-control-allow-origin"), false);
  assert.match(response.headers.get("cache-control"), /no-store/);
});

test("live presence is streamed without waiting for the connection to end", async () => {
  let controller;
  let cancelled = false;
  const stream = new ReadableStream({ start(value) { controller = value; }, cancel() { cancelled = true; } });
  const worker = createWorker({ html, fetchBackend: async () => new Response(stream, {
    headers: { "content-type": "text/event-stream" }
  }) });
  const response = await worker.fetch(new Request("https://draft.test/api/presence"));
  const reader = response.body.getReader();
  controller.enqueue(new TextEncoder().encode('data: {"openPages":2}\n\n'));
  const result = await reader.read();
  assert.match(new TextDecoder().decode(result.value), /openPages/);
  assert.equal(result.done, false);
  await reader.cancel();
  assert.equal(cancelled, true);
});

test("export metadata and upstream validation errors survive the proxy", async () => {
  for (const status of [200, 400, 403, 404, 413]) {
    const worker = createWorker({ html, fetchBackend: async () => new Response('{"result":true}', {
      status, headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="draft.json"' }
    }) });
    const response = await worker.fetch(new Request("https://draft.test/api/rooms/123456/draft/export"));
    assert.equal(response.status, status);
    assert.match(response.headers.get("content-disposition"), /draft.json/);
  }
});

test("backend failures and redirects become recoverable errors", async () => {
  for (const fetchBackend of [async () => { throw new Error("offline"); }, async () => Response.redirect("https://other.test")]) {
    const response = await createWorker({ html, fetchBackend }).fetch(new Request("https://draft.test/api/pools"));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error, "backend_unavailable");
  }
});

test("unsupported methods do not reach the backend and assets use their binding", async () => {
  const worker = createWorker({ html, fetchBackend: () => { throw new Error("Must not call"); } });
  assert.equal((await worker.fetch(new Request("https://draft.test/api/pools", { method: "DELETE" }))).status, 405);
  const response = await worker.fetch(new Request("https://draft.test/favicon.svg"), {
    ASSETS: { fetch: () => new Response("icon", { headers: { "content-type": "image/svg+xml" } }) }
  });
  assert.equal(await response.text(), "icon");
});
