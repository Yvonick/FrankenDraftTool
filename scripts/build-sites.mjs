import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Script } from "node:vm";
import { build } from "esbuild";
import { buildIcons } from './build-icons.mjs';

const root = resolve(import.meta.dirname, "..");
await buildIcons();
const html = await readFile(resolve(root, "services/frontend/index.html"), "utf8");
const historyHtml = await readFile(resolve(root, "services/frontend/history.html"), "utf8");
new Script(await readFile(resolve(root, 'services/frontend/history.js'), 'utf8'), { filename: 'services/frontend/history.js' });
for (const [, source] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
  new Script(source, { filename: "services/frontend/index.html" });
}
await rm(resolve(root, "dist"), { recursive: true, force: true });
await mkdir(resolve(root, "dist/server"), { recursive: true });
await mkdir(resolve(root, "dist/client"), { recursive: true });
for (const asset of ["favicon.svg", "pool-assets", "polish.css", "icons.js", "group-layout.js", "draft-splitter.js", "room-logs.js", "room-identity.js", "history.js", "history.css"]) {
  await cp(resolve(root, "services/frontend", asset), resolve(root, "dist/client", asset), { recursive: true });
}
await build({
  stdin: {
    contents: `import { createWorker } from './services/sites/worker.mjs'; export default createWorker({ html: ${JSON.stringify(html)}, historyHtml: ${JSON.stringify(historyHtml)} });`,
    resolveDir: root, sourcefile: "sites-entry.mjs", loader: "js"
  },
  bundle: true, platform: "browser", target: "es2022", format: "esm",
  outfile: resolve(root, "dist/server/index.js"), minify: true
});
const output = await readFile(resolve(root, "dist/server/index.js"), "utf8");
if (/onrender\.com/.test(output)) throw new Error("The Sites bundle must not depend on Render.");
await writeFile(resolve(root, "dist/server/package.json"), '{"type":"module"}\n');
console.log("Built standalone Sites backend, frontend and pool assets in dist/.");
