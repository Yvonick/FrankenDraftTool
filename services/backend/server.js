const http = require("node:http");

const port = Number(process.env.PORT || 3000);
const serviceName = "franken-draft-tool-backend";
const frontendOrigin = process.env.FRONTEND_ORIGIN || "*";
const presenceClients = new Set();

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": frontendOrigin
  });
  response.end(JSON.stringify(body));
}

function sendPresenceEvent(response) {
  response.write(`data: ${JSON.stringify({ openPages: presenceClients.size })}\n\n`);
}

function broadcastPresence() {
  for (const client of presenceClients) {
    sendPresenceEvent(client);
  }
}

function handlePresenceStream(request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": frontendOrigin
  });

  presenceClients.add(response);
  sendPresenceEvent(response);
  broadcastPresence();

  request.on("close", () => {
    presenceClients.delete(response);
    broadcastPresence();
  });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": frontendOrigin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    response.end();
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD, OPTIONS" });
    response.end("Method Not Allowed");
    return;
  }

  if (url.pathname === "/api/presence") {
    handlePresenceStream(request, response);
    return;
  }

  if (url.pathname === "/" || url.pathname === "/api/health") {
    const body = {
      status: "ok",
      service: serviceName,
      openPages: presenceClients.size
    };

    if (request.method === "HEAD") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": frontendOrigin
      });
      response.end();
      return;
    }

    sendJson(response, 200, body);
    return;
  }

  sendJson(response, 404, {
    error: "not_found"
  });
});

server.listen(port, () => {
  console.log(`${serviceName} listening on http://0.0.0.0:${port}`);
});
