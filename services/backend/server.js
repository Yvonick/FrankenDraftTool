const http = require("node:http");
const crypto = require("node:crypto");

const port = Number(process.env.PORT || 3000);
const serviceName = "franken-draft-tool-backend";
const frontendOrigin = process.env.FRONTEND_ORIGIN || "*";
const presenceClients = new Set();
const rooms = new Map();

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": frontendOrigin
  });
  response.end(JSON.stringify(body));
}

function sendHead(response, statusCode) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": frontendOrigin
  });
  response.end();
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

function createRoom() {
  let roomNumber;

  do {
    roomNumber = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(roomNumber));

  rooms.set(roomNumber, {
    participants: new Map(),
    clients: new Set()
  });

  return roomNumber;
}

function getRoomSnapshot(roomNumber) {
  const room = rooms.get(roomNumber);

  if (!room) {
    return null;
  }

  return {
    roomNumber,
    people: [...room.participants.values()]
  };
}

function broadcastRoom(roomNumber) {
  const room = rooms.get(roomNumber);

  if (!room) {
    return;
  }

  const payload = JSON.stringify(getRoomSnapshot(roomNumber));

  for (const client of room.clients) {
    client.write(`data: ${payload}\n\n`);
  }
}

function cleanName(name) {
  const fallback = `Guest ${Math.floor(1000 + Math.random() * 9000)}`;

  if (!name) {
    return fallback;
  }

  const cleaned = String(name).trim().replace(/\s+/g, " ").slice(0, 40);
  return cleaned || fallback;
}

function handleCreateRoom(response) {
  const roomNumber = createRoom();

  sendJson(response, 201, {
    roomNumber,
    path: `/rooms/${roomNumber}`
  });
}

function handleRoomDetails(roomNumber, request, response) {
  const snapshot = getRoomSnapshot(roomNumber);

  if (!snapshot) {
    sendJson(response, 404, { error: "room_not_found" });
    return;
  }

  if (request.method === "HEAD") {
    sendHead(response, 200);
    return;
  }

  sendJson(response, 200, snapshot);
}

function handleRoomStream(roomNumber, url, request, response) {
  const room = rooms.get(roomNumber);

  if (!room) {
    sendJson(response, 404, { error: "room_not_found" });
    return;
  }

  const connectionId = crypto.randomUUID();
  const name = cleanName(url.searchParams.get("name"));

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": frontendOrigin
  });

  room.participants.set(connectionId, name);
  room.clients.add(response);
  broadcastRoom(roomNumber);

  request.on("close", () => {
    room.participants.delete(connectionId);
    room.clients.delete(response);
    broadcastRoom(roomNumber);
  });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": frontendOrigin,
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    response.end();
    return;
  }

  if (!["GET", "HEAD", "POST"].includes(request.method)) {
    response.writeHead(405, { Allow: "GET, HEAD, POST, OPTIONS" });
    response.end("Method Not Allowed");
    return;
  }

  if (url.pathname === "/api/rooms" && request.method === "POST") {
    handleCreateRoom(response);
    return;
  }

  if (request.method === "POST") {
    response.writeHead(405, { Allow: "GET, HEAD, OPTIONS" });
    response.end("Method Not Allowed");
    return;
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})(?:\/presence)?$/);

  if (roomMatch) {
    const roomNumber = roomMatch[1];
    const isPresenceStream = url.pathname.endsWith("/presence");

    if (isPresenceStream) {
      if (request.method === "HEAD") {
        if (rooms.has(roomNumber)) {
          sendHead(response, 200);
        } else {
          sendJson(response, 404, { error: "room_not_found" });
        }

        return;
      }

      handleRoomStream(roomNumber, url, request, response);
      return;
    }

    handleRoomDetails(roomNumber, request, response);
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
      openPages: presenceClients.size,
      rooms: rooms.size
    };

    if (request.method === "HEAD") {
      sendHead(response, 200);
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
