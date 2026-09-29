const encoder = new TextEncoder();
export const ROOM_UPDATE_INTERVAL_MS = 250;
const STREAM_LIFETIME_MS = 20000;
const PRESENCE_INTERVAL_MS = 10000;

// Each connection observes durable state; no cross-request in-memory broadcast.
export async function roomStream(request, store, readSnapshot, options = {}) {
  const initial = await readSnapshot(request);
  if (!initial.ok) return initial;
  const first = await initial.json();
  const roomId = first.room.roomNumber;
  const interval = options.intervalMs ?? ROOM_UPDATE_INTERVAL_MS;
  const lifetime = options.lifetimeMs ?? STREAM_LIFETIME_MS;
  const presenceInterval = options.presenceIntervalMs ?? PRESENCE_INTERVAL_MS;
  const background = new URL(request.url).searchParams.get('background') === '1';
  let stopped = false;
  let timer;
  let wake;
  let controller;
  const finish = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    wake?.();
    request.signal.removeEventListener('abort', finish);
    try { controller?.close(); } catch { /* The reader may already be cancelled. */ }
  };
  const wait = delay => new Promise(resolve => {
    wake = resolve;
    timer = setTimeout(resolve, delay);
  });
  const encode = data => encoder.encode(`event: room\ndata: ${JSON.stringify(data)}\n\n`);
  const passiveUrl = new URL(request.url);
  passiveUrl.searchParams.set('observe', '1');
  const passiveRequest = () => new Request(passiveUrl, { headers: request.headers, signal: request.signal });
  const body = new ReadableStream({
    start(streamController) {
      controller = streamController;
      request.signal.addEventListener('abort', finish, { once: true });
      if (request.signal.aborted) { finish(); return; }
      controller.enqueue(encode(first));
      void (async () => {
        let lastRevision = Number(String(first.room.revision).split(':')[0]);
        let lastView = first.room.revision;
        let nextPresence = Date.now() + presenceInterval;
        const deadline = Date.now() + lifetime;
        while (!stopped && Date.now() < deadline) {
          await wait(background ? 2000 : interval);
          if (stopped) break;
          // A slow reader gets no additional queued snapshots or database work.
          if (controller.desiredSize <= 0) continue;
          const revision = await store.roomRevision(roomId);
          if (stopped) break;
          if (revision === null) throw new Error('room_not_found');
          if (revision === lastRevision && Date.now() < nextPresence) continue;
          const result = await readSnapshot(passiveRequest());
          if (!result.ok) throw new Error(`snapshot_unavailable_${result.status}`);
          const snapshot = await result.json();
          if (stopped) break;
          lastRevision = Number(String(snapshot.room.revision).split(':')[0]);
          if (snapshot.room.revision !== lastView) {
            controller.enqueue(encode(snapshot));
            lastView = snapshot.room.revision;
          } else {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
          }
          nextPresence = Date.now() + presenceInterval;
        }
      })().catch(error => {
        if (!stopped) {
          console.warn('Room stream interrupted:', error.message);
          if (controller.desiredSize > 0) controller.enqueue(encoder.encode('event: reconnect\ndata: {}\n\n'));
        }
      }).finally(finish);
    },
    cancel() { finish(); }
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff'
    }
  });
}
