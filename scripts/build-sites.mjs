import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Script } from "node:vm";

const root = resolve(import.meta.dirname, "..");
const html = await readFile(resolve(root, "services/frontend/index.html"), "utf8");
for (const [, source] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
  new Script(source, { filename: "services/frontend/index.html" });
}
const worker = await readFile(resolve(root, "services/sites/worker.mjs"), "utf8");
await rm(resolve(root, "dist"), { recursive: true, force: true });
await mkdir(resolve(root, "dist/server"), { recursive: true });
await mkdir(resolve(root, "dist/client"), { recursive: true });
for (const asset of ["favicon.svg", "pool-assets"]) {
  await cp(resolve(root, "services/frontend", asset), resolve(root, "dist/client", asset), { recursive: true });
}
await writeFile(resolve(root, "dist/server/index.js"), `${worker}\nexport default createWorker({ html: ${JSON.stringify(html)} });\n`);
await writeFile(resolve(root, "dist/server/package.json"), '{"type":"module"}\n');
console.log("Built Sites Worker, frontend and pool assets in dist/.");
