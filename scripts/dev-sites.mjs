import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { Readable } from "node:stream";
import { createWorker } from "../services/sites/worker.mjs";

const frontend = resolve(import.meta.dirname, "../services/frontend");
const port = Number(process.env.SITES_DEV_PORT || 4173);
const types = { ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const env = {
  ASSETS: {
    async fetch(request) {
      const filename = resolve(frontend, `.${decodeURIComponent(new URL(request.url).pathname)}`);
      if (!filename.startsWith(frontend + sep)) return new Response("Forbidden", { status: 403 });
      try {
        const bytes = await readFile(filename);
        return new Response(request.method === "HEAD" ? null : bytes, {
          headers: { "content-type": types[extname(filename)] || "application/octet-stream" }
        });
      } catch { return new Response("Not Found", { status: 404 }); }
    }
  }
};
const server = createServer(async (incoming, outgoing) => {
  const abort = new AbortController();
  outgoing.on("close", () => abort.abort());
  try {
    const html = await readFile(resolve(frontend, "index.html"), "utf8");
    const worker = createWorker({ html, ...(process.env.SITES_BACKEND_ORIGIN ? { backendOrigin: process.env.SITES_BACKEND_ORIGIN } : {}) });
    const request = new Request(new URL(incoming.url, `http://127.0.0.1:${port}`), {
      method: incoming.method,
      headers: incoming.headers,
      body: ["GET", "HEAD"].includes(incoming.method) ? undefined : Readable.toWeb(incoming),
      duplex: "half", signal: abort.signal
    });
    const response = await worker.fetch(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const body = Readable.fromWeb(response.body);
      body.on("error", () => outgoing.destroy());
      outgoing.on("close", () => body.destroy());
      body.pipe(outgoing);
    } else outgoing.end();
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end("Unable to serve the local preview.");
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Local: http://127.0.0.1:${port}`));
