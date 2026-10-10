import { createStorage, RequestError } from './storage.mjs';

const encoder = new TextEncoder();
const cookieName = 'franken_history';
const reply = (body, status = 200, headers = {}) => Response.json(body, { status, headers: {
  'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', ...headers
} });
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const digest = value => crypto.subtle.digest('SHA-256', encoder.encode(value));
const cookie = (value, age, secure) => `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/api/draft-history; Max-Age=${age}${secure ? '; Secure' : ''}`;

async function signingKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function authenticated(request, secret) {
  const value = request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  const match = value?.match(/^(\d{13})\.([a-f0-9]{64})$/);
  if (!match || Number(match[1]) <= Date.now() || Number(match[1]) > Date.now() + 8 * 3600000) return false;
  return crypto.subtle.verify('HMAC', await signingKey(secret), Uint8Array.from(match[2].match(/../g).map(value => parseInt(value, 16))), encoder.encode(`draft-history:${match[1]}`));
}
async function loginBody(request) {
  const reader = request.body?.getReader();
  let bytes = 0;
  const chunks = [];
  if (reader) for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 1024) { await reader.cancel(); throw new RequestError(413, 'request_body_too_large'); }
    chunks.push(value);
  }
  try { return JSON.parse(await new Blob(chunks).text()); }
  catch { throw new RequestError(400, 'invalid_json'); }
}

export async function handleHistoryApi(request, env) {
  const url = new URL(request.url);
  const secret = env.DRAFT_HISTORY_PASSKEY;
  if (typeof secret !== 'string' || !secret.trim()) return reply({ error: 'history_not_configured' }, 503);
  if (request.method === 'POST') {
    if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return reply({ error: 'invalid_origin' }, 403);
    if (!request.headers.get('content-type')?.includes('application/json')) return reply({ error: 'json_required' }, 415);
    if (url.pathname === '/api/draft-history/logout') return reply({ authenticated: false }, 200, { 'set-cookie': cookie('', 0, url.protocol === 'https:') });
    if (url.pathname !== '/api/draft-history/login') return reply({ error: 'method_not_allowed' }, 405);
    const body = await loginBody(request);
    const supplied = typeof body?.passkey === 'string' ? body.passkey : '';
    const expectedHash = new Uint8Array(await digest(secret));
    const suppliedHash = new Uint8Array(await digest(supplied));
    let difference = 0;
    for (let i = 0; i < expectedHash.length; i++) difference |= expectedHash[i] ^ suppliedHash[i];
    if (difference) return reply({ error: 'incorrect_passkey' }, 401);
    const expiry = String(Date.now() + 8 * 3600000);
    const signature = hex(await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(`draft-history:${expiry}`)));
    return reply({ authenticated: true }, 200, { 'set-cookie': cookie(`${expiry}.${signature}`, 8 * 3600, url.protocol === 'https:') });
  }
  if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
  if (!await authenticated(request, secret)) return reply({ error: 'history_passkey_required' }, 401);
  if (url.pathname === '/api/draft-history/session') return reply({ authenticated: true });
  const store = createStorage(env);
  if (url.pathname === '/api/draft-history') {
    const rawCursor = url.searchParams.get('cursor');
    const cursor = rawCursor?.match(/^(\d{13})\.([a-f0-9-]{36})$/);
    if (rawCursor && !cursor) return reply({ error: 'invalid_cursor' }, 400);
    return reply(await store.finishedDrafts(cursor ? { at: Number(cursor[1]), id: cursor[2] } : null));
  }
  const match = url.pathname.match(/^\/api\/draft-history\/([a-f0-9-]{36})(\/events|\/bag)?$/);
  if (!match) return reply({ error: 'not_found' }, 404);
  if (match[2] === '/bag') {
    const playerId = url.searchParams.get('player');
    const rawSequence = url.searchParams.get('sequence');
    const sequence = rawSequence === null ? null : Number(rawSequence);
    if ((playerId === null) === (rawSequence === null) || (playerId !== null && (!playerId || playerId.length > 128))
      || (rawSequence !== null && (!/^\d+$/.test(rawSequence) || !Number.isSafeInteger(sequence) || sequence < 1))) {
      return reply({ error: 'invalid_bag_query' }, 400);
    }
    return reply(await store.draftBag(match[1], { playerId, sequence }));
  }
  if (match[2] === '/events') {
    const after = Number(url.searchParams.get('after') || 0);
    if (!Number.isSafeInteger(after) || after < 0) return reply({ error: 'invalid_cursor' }, 400);
    return reply(await store.draftEvents(match[1], after));
  }
  const draft = await store.finishedDraft(match[1]);
  return draft ? reply(draft) : reply({ error: 'draft_not_found' }, 404);
}
