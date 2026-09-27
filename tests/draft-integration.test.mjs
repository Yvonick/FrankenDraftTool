import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { createWorker } from "../services/sites/worker.mjs";

test("Sites adapter supports local room setup, both draft engines, bids and TTS export", { timeout: 20000 }, async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const backend = spawn(process.execPath, ["services/backend/server.js"], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const controllers = [];
  try {
    await Promise.race([
      once(backend.stdout, "data"),
      once(backend, "exit").then(() => { throw new Error("Backend exited before listening"); })
    ]);
    const worker = createWorker({ html: "draft", backendOrigin: `http://127.0.0.1:${port}` });
    const request = (path, data) => worker.fetch(new Request(`http://site.test${path}`, data === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data)
    }));
    const json = async (path, data) => {
      const response = await request(path, data);
      const result = await response.json();
      assert.equal(response.ok, true, `${path}: ${JSON.stringify(result)}`);
      return result;
    };
    const { pools } = await json("/api/pools");
    assert.ok(pools.length > 0);
    const { methods } = await json("/api/methods");
    assert.equal(methods.filter(method => method.playable).length, 2);
    for (const methodId of ["bag-passing-default", "nomination-auction"]) {
      const room = await json("/api/rooms", {});
      const base = `/api/rooms/${room.roomNumber}`;
      const actorId = crypto.randomUUID();
      const auth = { creatorToken: room.creatorToken, actorId, viewerId: actorId, participantId: actorId };
      const denied = await request(`${base}/settings`, { maxSeats: 1 });
      assert.equal(denied.status, 403);
      await json(`${base}/settings`, { ...auth, maxSeats: 1, methodId });
      const abort = new AbortController();
      controllers.push(abort);
      const params = new URLSearchParams({ role: "seated", name: "Sites local test", participantId: actorId, creatorToken: room.creatorToken });
      const stream = await worker.fetch(new Request(`http://site.test${base}/presence?${params}`, { signal: abort.signal }));
      assert.match(stream.headers.get("content-type"), /event-stream/);
      const reader = stream.body.getReader();
      assert.match(new TextDecoder().decode((await reader.read()).value), /event: viewer/);
      let snapshot = await json(`${base}/draft/start`, auth);
      assert.equal(snapshot.draft.status, "active");
      if (methodId === "bag-passing-default") {
        const bag = snapshot.draft.currentPlayer.currentBag;
        const items = bag.items.filter(item => bag.eligibleItemIds.includes(item.id));
        const selected = [...new Map(items.map(item => [item.type, item])).values()].slice(0, bag.requiredPickCount);
        snapshot = await json(`${base}/draft/pick`, { playerId: actorId, bagId: bag.id, itemIds: selected.map(item => item.id) });
        assert.ok(snapshot.draft.currentPlayer.draftedItems.length > 0);
      } else {
        assert.equal(snapshot.draft.auction.stage, "speaker_order_bidding");
        snapshot = await json(`${base}/draft/auction/bid`, { playerId: actorId, first: 1, second: 0, tie: 0 });
        assert.notEqual(snapshot.draft.auction.stage, "speaker_order_bidding");
      }
      const exported = await request(`${base}/draft/export?${new URLSearchParams(auth)}`);
      assert.equal(exported.status, 200);
      assert.match(exported.headers.get("content-disposition"), /\.json/);
      assert.ok((await exported.json()).ObjectStates.length > 0);
      const reset = await json(`${base}/draft/restart`, auth);
      assert.equal(reset.draft.status, "not_started");
      await reader.cancel();
      abort.abort();
    }
  } finally {
    for (const controller of controllers) controller.abort();
    backend.kill();
    await once(backend, "exit");
  }
});
