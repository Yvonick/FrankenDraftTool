const http = require("node:http");
const pools = require("./draftPools");
const { createDraftEngine } = require("./draftEngine");
const engine = createDraftEngine({ pools, frontendOrigin: process.env.FRONTEND_ORIGIN || "*" });
const server = http.createServer(engine.handleRequest);
const cleanup = setInterval(engine.cleanupIdleRooms, 10 * 60 * 1000);
cleanup.unref?.();
const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`franken-draft-tool-backend listening on http://0.0.0.0:${server.address().port}`));
