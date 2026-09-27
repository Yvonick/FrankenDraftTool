// The original Node service remains the authority for rooms, drafts and pools.
// Sites serves the interface and streams API responses through this same origin.
export const BACKEND_ORIGIN = "https://yvonick-frankendrafttool-api.onrender.com";
const UI_ROUTE = /^\/(?:pools|methods|rooms\/\d{6})?\/?$/;
const METHODS = new Set(["GET", "HEAD", "POST", "OPTIONS"]);

export function createWorker({ html, fetchBackend = fetch, backendOrigin = BACKEND_ORIGIN }) {
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        if (!METHODS.has(request.method)) {
          return new Response("Method Not Allowed", {
            status: 405, headers: { Allow: "GET, HEAD, POST, OPTIONS" }
          });
        }
        // Construct from a fixed origin: never accept an upstream URL from users.
        const target = new URL(backendOrigin);
        target.pathname = url.pathname;
        target.search = url.search;
        // Sites login cookies and authorization headers must stay on Sites.
        const headers = new Headers();
        for (const name of ["accept", "content-type", "last-event-id"]) {
          if (request.headers.has(name)) headers.set(name, request.headers.get(name));
        }
        try {
          const upstream = await fetchBackend(target, {
            method: request.method,
            headers,
            body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
            redirect: "manual",
            signal: request.signal,
            // Node's local preview requires this for streamed request bodies.
            duplex: "half"
          });
          if (upstream.status >= 300 && upstream.status < 400) {
            await upstream.body?.cancel();
            throw new Error("Unexpected API redirect");
          }
          const responseHeaders = new Headers();
          for (const name of ["content-type", "content-disposition", "allow", "retry-after"]) {
            if (upstream.headers.has(name)) responseHeaders.set(name, upstream.headers.get(name));
          }
          responseHeaders.set("cache-control", "no-store, no-transform");
          responseHeaders.set("x-content-type-options", "nosniff");
          // Pass the stream through untouched; buffering would break live rooms.
          return new Response(request.method === "HEAD" ? null : upstream.body, {
            status: upstream.status, headers: responseHeaders
          });
        } catch {
          return Response.json({
            error: "backend_unavailable",
            message: "The draft service is temporarily unavailable. Please try again."
          }, { status: 502, headers: { "cache-control": "no-store" } });
        }
      }
      if (!["GET", "HEAD"].includes(request.method)) {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      if (UI_ROUTE.test(url.pathname)) {
        return new Response(request.method === "HEAD" ? null : html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-cache",
            "referrer-policy": "same-origin",
            "x-content-type-options": "nosniff"
          }
        });
      }
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Not Found", { status: 404 });
    }
  };
}
