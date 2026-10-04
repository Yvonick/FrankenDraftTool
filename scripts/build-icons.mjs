import { build } from 'esbuild';
import { resolve } from 'node:path';
export async function buildIcons() {
  const root = resolve(import.meta.dirname, '..');
  await build({ entryPoints: [resolve(root, 'services/frontend/icons-entry.js')], bundle: true, format: 'iife', platform: 'browser', minify: true, outfile: resolve(root, 'services/frontend/icons.js') });
}
