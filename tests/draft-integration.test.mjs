import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, runInNewContext } from 'node:vm';
import { setTimeout as sleep } from 'node:timers/promises';

test('published frontend has no Render origin and all API calls carry participant identity', async () => {
  const html = await readFile(new URL('../services/frontend/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /onrender\.com|new EventSource/);
  assert.equal((html.match(/await fetch\(apiUrl/g) || []).length, 0);
  assert.match(html, /X-Franken-Session/);
  for (const [, source] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new Script(source);
});

test('browser stream handles split frames, stable viewer identity and superseded requests', async () => {
  const html = await readFile(new URL('../services/frontend/index.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('class DraftUpdates {'), html.indexOf('const homeView ='));
  const requests = [];
  const controllers = [];
  const window = new EventTarget();
  window.location = { origin: 'https://draft.test' };
  const document = new EventTarget();
  document.hidden = false;
  const DraftUpdates = runInNewContext(`${source}; DraftUpdates`, {
    window, document, URL, AbortController, TextDecoder, setTimeout, clearTimeout,
    apiFetch: async (url, options) => {
      requests.push({ url, options });
      return new Response(new ReadableStream({ start(controller) { controllers.push(controller); } }), {
        headers: { 'content-type': 'text/event-stream' }
      });
    }
  });
  const updates = new DraftUpdates('/api/rooms/123456/presence?participantId=player&role=seated');
  const messages = [];
  const viewers = [];
  updates.onmessage = event => messages.push(JSON.parse(event.data));
  updates.addEventListener('viewer', event => viewers.push(JSON.parse(event.data)));
  const frame = revision => new TextEncoder().encode(`event: room\r\ndata: ${JSON.stringify({ viewer: { id: 'player', name: 'Andr\u00e9' }, room: { revision } })}\r\n\r\n`);
  try {
    const bytes = frame('1:player');
    for (const byte of bytes) controllers[0].enqueue(new Uint8Array([byte]));
    await sleep(10);
    assert.equal(messages.length, 1);
    assert.equal(viewers[0].name, 'Andr\u00e9');
    controllers[0].enqueue(frame('2:player'));
    await sleep(10);
    assert.equal(messages.length, 2);
    assert.equal(viewers.length, 1, 'unchanged viewer identity must not interrupt inputs');
    document.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    controllers[0].enqueue(frame('stale'));
    controllers[1].enqueue(frame('3:player'));
    await sleep(10);
    assert.equal(messages.at(-1).revision, '3:player');
    assert.equal(messages.some(message => message.revision === 'stale'), false);
    assert.match(requests[1].url, /observe=1/);
    assert.match(requests[1].url, /background=1/);
    assert.equal(requests[0].options.signal.aborted, true);
  } finally {
    updates.close();
    controllers.at(-1).close();
  }
  document.dispatchEvent(new Event('visibilitychange'));
  await sleep(10);
  assert.equal(requests.length, 2, 'closed views must not reopen a connection');
  assert.equal(requests[1].options.signal.aborted, true);
});
