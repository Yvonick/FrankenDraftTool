import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';

test('published frontend has no Render origin and all API calls carry participant identity', async () => {
  const html = await readFile(new URL('../services/frontend/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /onrender\.com|new EventSource/);
  assert.equal((html.match(/await fetch\(apiUrl/g) || []).length, 0);
  assert.match(html, /X-Franken-Session/);
  for (const [, source] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new Script(source);
});
