const http = require("node:http");
const crypto = require("node:crypto");
const {
  getDefaultDraftMethod,
  getDraftMethod,
  getDraftMethodSummary,
  listDraftMethods
} = require("./draftMethods");
const {
  getDefaultPublicPool,
  getPool,
  getPoolSummary,
  isSpeakerOrderType,
  listPublicPools,
  registerUploadedTtsPool,
  removePublicPool,
  savePool,
  speakerOrderType,
  updatePublicPool
} = require("./draftPools");

const port = Number(process.env.PORT || 3000);
const serviceName = "franken-draft-tool-backend";
const frontendOrigin = process.env.FRONTEND_ORIGIN || "*";
const presenceClients = new Set();
const rooms = new Map();
const defaultSeatLimit = 6;
const defaultJsonBodyLimit = 10000;
const poolUploadJsonBodyLimit = 25 * 1024 * 1024;

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": frontendOrigin
  });
  response.end(JSON.stringify(body));
}

function readJsonBody(request, options = {}) {
  return new Promise((resolve, reject) => {
    let body = "";
    const maxBytes = options.maxBytes || defaultJsonBodyLimit;

    request.on("data", (chunk) => {
      body += chunk;

      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        reject(new Error("request_body_too_large"));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("invalid_json"));
      }
    });

    request.on("error", reject);
  });
}

function sendHead(response, statusCode) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": frontendOrigin
  });
  response.end();
}

function sendJsonDownload(response, fileName, body) {
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": frontendOrigin,
    "Access-Control-Expose-Headers": "Content-Disposition"
  });
  response.end(JSON.stringify(body, null, 2));
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

function defaultDraftSettings() {
  const pool = getDefaultPublicPool();
  const method = getDefaultDraftMethod();

  if (!pool) {
    return {
      poolId: null,
      methodId: method.id,
      maxSeats: defaultSeatLimit,
      picksPerBag: 2,
      typeOrder: [],
      itemsPerType: {}
    };
  }

  return {
    poolId: pool.id,
    methodId: method.id,
    maxSeats: pool.defaultParameters.maxSeats,
    picksPerBag: pool.defaultParameters.picksPerBag,
    typeOrder: pool.defaultParameters.typeOrder,
    itemsPerType: pool.defaultParameters.itemsPerType
  };
}

function createRoom() {
  let roomNumber;

  do {
    roomNumber = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(roomNumber));

  const draftSettings = defaultDraftSettings();

  rooms.set(roomNumber, {
    creatorToken: crypto.randomUUID(),
    maxSeats: draftSettings.maxSeats,
    draftSettings,
    draft: null,
    participants: new Map(),
    clients: new Map()
  });

  return roomNumber;
}

function getSeatedParticipants(room) {
  return [...room.participants.values()]
    .filter((participant) => participant.role === "seated")
    .map((participant) => ({
      id: participant.id,
      name: participant.name
    }));
}

function getRoomSnapshot(roomNumber, viewerId = null) {
  const room = rooms.get(roomNumber);

  if (!room) {
    return null;
  }

  return {
    roomNumber,
    maxSeats: room.maxSeats,
    seated: getSeatedParticipants(room),
    spectators: [...room.participants.values()]
      .filter((participant) => participant.role === "spectator")
      .length,
    namedSpectators: [...room.participants.values()]
      .filter((participant) => participant.role === "spectator" && participant.name)
      .map((participant) => ({
        id: participant.id,
        name: participant.name,
        superSpectator: Boolean(participant.superSpectator)
      })),
    draft: getDraftSnapshot(room, viewerId)
  };
}

function broadcastRoom(roomNumber) {
  const room = rooms.get(roomNumber);

  if (!room) {
    return;
  }

  for (const [client, metadata] of room.clients.entries()) {
    client.write(`data: ${JSON.stringify(getRoomSnapshot(roomNumber, metadata.participantId))}\n\n`);
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

function cleanOptionalName(name) {
  const cleaned = String(name || "").trim().replace(/\s+/g, " ").slice(0, 40);
  return cleaned || null;
}

function cleanSeatLimit(maxSeats) {
  const parsed = Number(maxSeats);

  if (!Number.isInteger(parsed)) {
    return null;
  }

  return Math.min(Math.max(parsed, 1), 12);
}

function cleanPicksPerBag(picksPerBag) {
  const parsed = Number(picksPerBag);

  if (!Number.isInteger(parsed)) {
    return null;
  }

  return Math.min(Math.max(parsed, 1), 8);
}

function cleanItemsPerType(pool, itemsPerType) {
  const cleaned = {};

  for (const type of pool.types) {
    const parsed = Number(itemsPerType?.[type] ?? 0);

    if (!Number.isInteger(parsed)) {
      return null;
    }

    cleaned[type] = Math.min(Math.max(parsed, 0), isSpeakerOrderType(type) ? 1 : 10);
  }

  return cleaned;
}

function cleanTypeOrder(pool, typeOrder) {
  const requested = Array.isArray(typeOrder)
    ? typeOrder.map((type) => (isSpeakerOrderType(type) ? speakerOrderType : type))
    : [];

  return [
    ...requested.filter((type, index) => (
      pool.types.includes(type) && requested.indexOf(type) === index
    )),
    ...pool.types.filter((type) => !requested.includes(type))
  ];
}

function getParticipantId(value) {
  const id = String(value || "").trim();

  if (/^[a-zA-Z0-9-]{8,80}$/.test(id)) {
    return id;
  }

  return crypto.randomUUID();
}

function shuffle(values) {
  const copy = [...values];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }

  return copy;
}

function cloneItem(item) {
  return {
    id: item.id,
    name: item.name,
    content: item.content,
    type: item.type,
    imageUrl: item.imageUrl,
    imageSecondaryUrl: item.imageSecondaryUrl,
    imageSheet: item.imageSheet,
    sourceObjectType: item.sourceObjectType,
    metaType: item.metaType,
    order: item.order,
    ttsObject: item.ttsObject
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function getItemSnapshot(item) {
  return {
    id: item.id,
    name: item.name,
    content: item.content,
    type: item.type,
    imageUrl: item.imageUrl,
    imageSecondaryUrl: item.imageSecondaryUrl,
    imageSheet: item.imageSheet,
    sourceObjectType: item.sourceObjectType,
    metaType: item.metaType,
    order: item.order
  };
}

function getDraftGroupSnapshot(group) {
  return {
    id: group.id,
    pickNumber: group.pickNumber,
    bagId: group.bagId,
    items: group.items.map(getItemSnapshot)
  };
}

function createTtsGuid(usedGuids) {
  let guid;

  do {
    guid = crypto.randomBytes(3).toString("hex");
  } while (usedGuids.has(guid));

  usedGuids.add(guid);
  return guid;
}

function isExportableDraftItem(item) {
  return Boolean(item.ttsObject) || item.metaType === "speaker-order";
}

function createTtsSpeakerOrderNotecard(item, usedGuids) {
  return {
    GUID: createTtsGuid(usedGuids),
    Name: "Notecard",
    Transform: {
      posX: 0,
      posY: 1,
      posZ: 0,
      rotX: 0,
      rotY: 180,
      rotZ: 0,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1
    },
    Nickname: item.name,
    Description: item.content,
    GMNotes: "",
    ColorDiffuse: { r: 1, g: 1, b: 1 },
    Locked: false,
    Grid: true,
    Snap: true,
    IgnoreFoW: false,
    Autoraise: true,
    Sticky: true,
    Tooltip: true,
    LuaScript: "",
    LuaScriptState: "",
    XmlUI: ""
  };
}

function createTtsDraftItem(item, usedGuids) {
  if (item.ttsObject) {
    return cloneJson(item.ttsObject);
  }

  if (item.metaType === "speaker-order") {
    return createTtsSpeakerOrderNotecard(item, usedGuids);
  }

  return null;
}

function createTtsBag(player, index, usedGuids) {
  return {
    GUID: createTtsGuid(usedGuids),
    Name: "Bag",
    Transform: {
      posX: index * 3,
      posY: 1,
      posZ: 0,
      rotX: 0,
      rotY: 180,
      rotZ: 0,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1
    },
    Nickname: player.name,
    Description: `Drafted items for ${player.name}`,
    GMNotes: "",
    AltLookAngle: { x: 0, y: 0, z: 0 },
    ColorDiffuse: { r: 0.7058823, g: 0.366520882, b: 0 },
    LayoutGroupSortIndex: 0,
    Value: 0,
    Locked: false,
    Grid: false,
    Snap: true,
    IgnoreFoW: false,
    MeasureMovement: false,
    DragSelectable: true,
    Autoraise: true,
    Sticky: true,
    Tooltip: true,
    GridProjection: false,
    HideWhenFaceDown: false,
    Hands: false,
    MaterialIndex: -1,
    MeshIndex: -1,
    Bag: { Order: 0 },
    LuaScript: "",
    LuaScriptState: "",
    XmlUI: "",
    ContainedObjects: player.draftedItems
      .map((item) => createTtsDraftItem(item, usedGuids))
      .filter(Boolean)
  };
}

function createTtsDraftExport(roomNumber, draft) {
  const missingItemCount = draft.players.reduce((count, player) => (
    count + player.draftedItems.filter((item) => !isExportableDraftItem(item)).length
  ), 0);

  if (missingItemCount > 0) {
    return {
      error: "tts_source_unavailable",
      missingItemCount
    };
  }

  const usedGuids = new Set(draft.players.flatMap((player) => (
    player.draftedItems
      .map((item) => item.ttsObject?.GUID)
      .filter(Boolean)
  )));

  return {
    SaveName: `Franken Draft ${roomNumber}`,
    Date: "",
    VersionNumber: "",
    GameMode: "",
    GameType: "",
    GameComplexity: "",
    Tags: [],
    Gravity: 0.5,
    PlayArea: 0.5,
    Table: "",
    Sky: "",
    Note: "",
    TabStates: {},
    LuaScript: "",
    LuaScriptState: "",
    XmlUI: "",
    ObjectStates: draft.players.map((player, index) => createTtsBag(player, index, usedGuids))
  };
}

function handleCreateRoom(response) {
  const roomNumber = createRoom();
  const room = rooms.get(roomNumber);

  sendJson(response, 201, {
    roomNumber,
    path: `/rooms/${roomNumber}`,
    creatorToken: room.creatorToken,
    maxSeats: room.maxSeats
  });
}

async function handlePoolUpload(request, response) {
  let body;

  try {
    body = await readJsonBody(request, { maxBytes: poolUploadJsonBodyLimit });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  const fileName = cleanOptionalName(body.fileName) || "uploaded-pool.json";
  let rawJson;

  if (typeof body.fileContent === "string") {
    try {
      rawJson = JSON.parse(body.fileContent);
    } catch (error) {
      sendJson(response, 400, { error: "invalid_pool_json" });
      return;
    }
  } else if (body.poolJson && typeof body.poolJson === "object") {
    rawJson = body.poolJson;
  } else {
    sendJson(response, 400, { error: "missing_pool_file" });
    return;
  }

  const saveUploadedPool = body.savePool === true;
  const pool = registerUploadedTtsPool(rawJson, fileName.replace(/\.json$/i, ""), {
    name: cleanOptionalName(body.poolName),
    public: saveUploadedPool
  });

  if (!pool) {
    sendJson(response, 400, { error: "invalid_pool_format" });
    return;
  }

  sendJson(response, 201, {
    pool: getPoolSummary(pool),
    pools: saveUploadedPool ? listPublicPools().map(getPoolSummary) : undefined
  });
}

async function handleUpdatePublicPool(poolId, request, response) {
  const pool = getPool(poolId);

  if (!pool || !pool.public) {
    sendJson(response, 404, { error: "pool_not_found" });
    return;
  }

  let body;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  const defaultParameters = body.defaultParameters || {};
  const maxSeats = defaultParameters.maxSeats === undefined
    ? pool.defaultParameters.maxSeats
    : cleanSeatLimit(defaultParameters.maxSeats);
  const picksPerBag = defaultParameters.picksPerBag === undefined
    ? pool.defaultParameters.picksPerBag
    : cleanPicksPerBag(defaultParameters.picksPerBag);
  const typeOrder = defaultParameters.typeOrder === undefined
    ? pool.defaultParameters.typeOrder
    : cleanTypeOrder(pool, defaultParameters.typeOrder);
  const itemsPerType = defaultParameters.itemsPerType === undefined
    ? pool.defaultParameters.itemsPerType
    : cleanItemsPerType(pool, defaultParameters.itemsPerType);

  if (!maxSeats) {
    sendJson(response, 400, { error: "invalid_seat_limit" });
    return;
  }

  if (!picksPerBag) {
    sendJson(response, 400, { error: "invalid_picks_per_bag" });
    return;
  }

  if (!itemsPerType) {
    sendJson(response, 400, { error: "invalid_items_per_type" });
    return;
  }

  const updatedPool = updatePublicPool(pool.id, {
    name: body.name === undefined ? pool.name : cleanOptionalName(body.name),
    defaultParameters: {
      maxSeats,
      picksPerBag,
      typeOrder,
      itemsPerType
    }
  });

  sendJson(response, 200, {
    pool: getPoolSummary(updatedPool),
    pools: listPublicPools().map(getPoolSummary)
  });
}

function handleRemovePublicPool(poolId, response) {
  if (!removePublicPool(poolId)) {
    sendJson(response, 404, { error: "pool_not_found" });
    return;
  }

  sendJson(response, 200, {
    pools: listPublicPools().map(getPoolSummary)
  });
}

function getDraftMethodListPayload(extra = {}) {
  return {
    ...extra,
    methods: listDraftMethods().map(getDraftMethodSummary)
  };
}

async function handleRoomSettings(roomNumber, request, response) {
  const room = rooms.get(roomNumber);

  if (!room) {
    sendJson(response, 404, { error: "room_not_found" });
    return;
  }

  let body;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  if (body.creatorToken !== room.creatorToken) {
    sendJson(response, 403, { error: "creator_token_required" });
    return;
  }

  if (room.draft) {
    sendJson(response, 409, { error: "draft_already_started" });
    return;
  }

  const maxSeats = body.maxSeats === undefined ? room.maxSeats : cleanSeatLimit(body.maxSeats);

  if (!maxSeats) {
    sendJson(response, 400, { error: "invalid_seat_limit" });
    return;
  }

  const seatedCount = getSeatedParticipants(room).length;

  if (maxSeats < seatedCount) {
    sendJson(response, 409, {
      error: "seat_limit_below_current_players",
      seatedCount
    });
    return;
  }

  const pool = getPool(body.poolId || room.draftSettings.poolId);

  if (!pool) {
    sendJson(response, 400, { error: "invalid_pool" });
    return;
  }

  const method = getDraftMethod(body.methodId || room.draftSettings.methodId);

  if (!method) {
    sendJson(response, 400, { error: "invalid_draft_method" });
    return;
  }

  const picksPerBag = body.picksPerBag === undefined
    ? room.draftSettings.picksPerBag
    : cleanPicksPerBag(body.picksPerBag);
  const typeOrder = body.typeOrder === undefined
    ? cleanTypeOrder(pool, room.draftSettings.typeOrder || pool.defaultParameters.typeOrder)
    : cleanTypeOrder(pool, body.typeOrder);
  const itemsPerType = body.itemsPerType === undefined
    ? room.draftSettings.itemsPerType
    : cleanItemsPerType(pool, body.itemsPerType);

  if (!picksPerBag) {
    sendJson(response, 400, { error: "invalid_picks_per_bag" });
    return;
  }

  if (!itemsPerType) {
    sendJson(response, 400, { error: "invalid_items_per_type" });
    return;
  }

  room.maxSeats = maxSeats;
  room.draftSettings = {
    poolId: pool.id,
    methodId: method.id,
    maxSeats,
    picksPerBag,
    typeOrder,
    itemsPerType
  };

  broadcastRoom(roomNumber);
  sendJson(response, 200, getRoomSnapshot(roomNumber));
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

  const participantId = getParticipantId(url.searchParams.get("participantId"));
  const connectionToken = crypto.randomUUID();
  const existingParticipant = room.participants.get(participantId);
  const requestedRole = url.searchParams.get("role") === "seated" ? "seated" : "spectator";
  const draftPlayer = room.draft?.players.find((player) => player.id === participantId);
  const currentlySeated = existingParticipant?.role === "seated";
  const seatedCount = getSeatedParticipants(room).length;
  const canSit = requestedRole === "seated"
    && (!room.draft || draftPlayer)
    && (currentlySeated || seatedCount < room.maxSeats || Boolean(draftPlayer));
  const role = canSit ? "seated" : "spectator";
  const name = role === "seated"
    ? (draftPlayer?.name || cleanName(url.searchParams.get("name")))
    : cleanOptionalName(url.searchParams.get("name")) || existingParticipant?.name || null;
  const seatDenied = requestedRole === "seated" && role !== "seated";

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": frontendOrigin
  });

  room.participants.set(participantId, {
    id: participantId,
    role,
    name,
    superSpectator: role === "spectator" && Boolean(existingParticipant?.superSpectator),
    connectionToken
  });
  room.clients.set(response, { participantId });
  response.write("event: viewer\n");
  response.write(`data: ${JSON.stringify({
    id: participantId,
    role,
    name,
    seatDenied,
    superSpectator: role === "spectator" && Boolean(existingParticipant?.superSpectator)
  })}\n\n`);
  broadcastRoom(roomNumber);

  request.on("close", () => {
    const participant = room.participants.get(participantId);

    if (participant?.connectionToken === connectionToken) {
      room.participants.delete(participantId);
    }

    room.clients.delete(response);
    broadcastRoom(roomNumber);
  });
}

function countDraftedByType(player, type) {
  return player.draftedItems.filter((item) => item.type === type).length;
}

function getRemainingTypeCapacity(player, type, settings) {
  return Math.max((settings.itemsPerType[type] || 0) - countDraftedByType(player, type), 0);
}

function isFirstRotationPick(player, bag, draft) {
  if (bag.originalPlayerId === player.id && (player.initialBagPickCount || 0) > 0) {
    return false;
  }

  return (player.pickCount || 0) < draft.players.length;
}

function getSelectionTypeLimit(player, bag, type, draft) {
  const remainingCapacity = getRemainingTypeCapacity(player, type, draft);

  if (remainingCapacity === 0) {
    return 0;
  }

  return isFirstRotationPick(player, bag, draft) ? Math.min(remainingCapacity, 1) : remainingCapacity;
}

function countItemsByType(items) {
  return items.reduce((counts, item) => {
    counts[item.type] = (counts[item.type] || 0) + 1;
    return counts;
  }, {});
}

function getSelectableTypeLimits(player, bag, draft) {
  const bagCounts = countItemsByType(bag.items);
  const limits = {};

  for (const [type, count] of Object.entries(bagCounts)) {
    const limit = Math.min(count, getSelectionTypeLimit(player, bag, type, draft));

    if (limit > 0) {
      limits[type] = limit;
    }
  }

  return limits;
}

function getRequiredPickCount(player, bag, draft) {
  const selectableCount = Object.values(getSelectableTypeLimits(player, bag, draft))
    .reduce((total, count) => total + count, 0);

  return Math.min(draft.picksPerBag, selectableCount);
}

function getSelectionError(player, bag, selectedItems, draft) {
  const selectedCounts = countItemsByType(selectedItems);

  for (const [type, count] of Object.entries(selectedCounts)) {
    const limit = getSelectionTypeLimit(player, bag, type, draft);

    if (count > limit) {
      return isFirstRotationPick(player, bag, draft) && limit === 1
        ? "first_rotation_type_duplicate"
        : "type_limit_reached";
    }
  }

  return null;
}

function getTablePlayerSnapshot(player) {
  return {
    id: player.id,
    name: player.name,
    seat: player.seat,
    queueLength: player.queue.length,
    lookingAtBag: Boolean(player.queue[0])
  };
}

function getPlayerDraftView(player, draft, includeCurrentBag) {
  const bag = player.queue[0] || null;
  const typePickLimits = bag ? getSelectableTypeLimits(player, bag, draft) : {};

  return {
    playerId: player.id,
    name: player.name,
    queueLength: player.queue.length,
    draftedItems: player.draftedItems.map(getItemSnapshot),
    draftedGroups: player.draftedGroups.map(getDraftGroupSnapshot),
    currentBag: includeCurrentBag && bag ? {
      id: bag.id,
      items: bag.items.map(getItemSnapshot),
      eligibleItemIds: bag.items
        .filter((item) => (typePickLimits[item.type] || 0) > 0)
        .map((item) => item.id),
      requiredPickCount: getRequiredPickCount(player, bag, draft),
      typePickLimits,
      firstRotation: isFirstRotationPick(player, bag, draft)
    } : null
  };
}

function getDraftSnapshot(room, viewerId) {
  if (!room.draft) {
    const pool = getPool(room.draftSettings.poolId);
    const method = getDraftMethod(room.draftSettings.methodId) || getDefaultDraftMethod();

    return {
      status: "not_started",
      settings: {
        ...room.draftSettings,
        methodId: method.id,
        pool: pool ? getPoolSummary(pool) : null,
        method: getDraftMethodSummary(method)
      }
    };
  }

  const draft = room.draft;
  const method = getDraftMethod(draft.methodId) || getDefaultDraftMethod();
  const viewer = room.participants.get(viewerId);
  const isSuperSpectator = viewer?.role === "spectator" && viewer.superSpectator;
  const table = draft.players.map(getTablePlayerSnapshot);

  if (draft.status === "complete") {
    return {
      status: "complete",
      poolId: draft.poolId,
      methodId: method.id,
      method: getDraftMethodSummary(method),
      picksPerBag: draft.picksPerBag,
      typeOrder: draft.typeOrder,
      itemsPerType: draft.itemsPerType,
      table,
      revealedDrafts: draft.players.map((player) => ({
        playerId: player.id,
        name: player.name,
        items: player.draftedItems.map(getItemSnapshot),
        groups: player.draftedGroups.map(getDraftGroupSnapshot)
      }))
    };
  }

  const player = draft.players.find((candidate) => candidate.id === viewerId);

  return {
    status: "active",
    poolId: draft.poolId,
    methodId: method.id,
    method: getDraftMethodSummary(method),
    picksPerBag: draft.picksPerBag,
    typeOrder: draft.typeOrder,
    itemsPerType: draft.itemsPerType,
    table,
    currentPlayer: player ? getPlayerDraftView(player, draft, true) : null,
    superSpectator: isSuperSpectator ? {
      players: draft.players.map((candidate) => getPlayerDraftView(candidate, draft, true))
    } : null
  };
}

function validateDraftCanStart(room) {
  if (room.draft) {
    return "draft_already_started";
  }

  const seated = getSeatedParticipants(room);

  if (seated.length !== room.maxSeats) {
    return "room_not_full";
  }

  if (seated.length === 0) {
    return "no_players";
  }

  const pool = getPool(room.draftSettings.poolId);

  if (!pool) {
    return "invalid_pool";
  }

  const method = getDraftMethod(room.draftSettings.methodId);

  if (!method) {
    return "invalid_draft_method";
  }

  if (!method.playable || method.engine !== "bag-pass") {
    return "unsupported_draft_method";
  }

  for (const type of cleanTypeOrder(pool, room.draftSettings.typeOrder)) {
    if (isSpeakerOrderType(type)) {
      continue;
    }

    const requested = (room.draftSettings.itemsPerType[type] || 0) * seated.length;
    const available = pool.items.filter((item) => item.type === type).length;

    if (requested > available) {
      return "not_enough_pool_items";
    }
  }

  return null;
}

function createSpeakerOrderItems(players) {
  return players.map((player, index) => {
    const order = index + 1;

    return {
      id: `speaker-order-${order}`,
      name: `Speaker Order ${order}`,
      content: `Speaker order position ${order} of ${players.length}`,
      type: speakerOrderType,
      imageUrl: null,
      imageSecondaryUrl: null,
      imageSheet: null,
      sourceObjectType: "Meta",
      metaType: "speaker-order",
      order
    };
  });
}

function createStartingBags(pool, players, settings) {
  const typeOrder = cleanTypeOrder(pool, settings.typeOrder);
  const itemsByType = new Map(typeOrder.map((type) => [
    type,
    isSpeakerOrderType(type)
      ? shuffle(createSpeakerOrderItems(players))
      : shuffle(pool.items.filter((item) => item.type === type))
  ]));

  return players.map((player) => {
    const items = [];

    for (const type of typeOrder) {
      const count = settings.itemsPerType[type] || 0;
      const source = itemsByType.get(type);

      for (let index = 0; index < count; index += 1) {
        const item = source.pop();

        if (item) {
          items.push(cloneItem(item));
        }
      }
    }

    return {
      id: crypto.randomUUID(),
      originalPlayerId: player.id,
      emptyPasses: 0,
      items: shuffle(items)
    };
  });
}

function startDraft(room) {
  const pool = getPool(room.draftSettings.poolId);
  const players = shuffle(getSeatedParticipants(room)).map((participant, index) => ({
    id: participant.id,
    name: participant.name,
    seat: index + 1,
    queue: [],
    draftedItems: [],
    draftedGroups: [],
    pickCount: 0,
    initialBagPickCount: 0
  }));
  const bags = createStartingBags(pool, players, room.draftSettings);

  players.forEach((player, index) => {
    player.queue.push(bags[index]);
  });

  room.draft = {
    status: "active",
    poolId: pool.id,
    methodId: room.draftSettings.methodId,
    picksPerBag: room.draftSettings.picksPerBag,
    typeOrder: cleanTypeOrder(pool, room.draftSettings.typeOrder),
    itemsPerType: room.draftSettings.itemsPerType,
    players,
    discardedItems: []
  };
}

async function handleStartDraft(roomNumber, request, response) {
  const room = rooms.get(roomNumber);

  if (!room) {
    sendJson(response, 404, { error: "room_not_found" });
    return;
  }

  let body;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  if (body.creatorToken !== room.creatorToken) {
    sendJson(response, 403, { error: "creator_token_required" });
    return;
  }

  const validationError = validateDraftCanStart(room);

  if (validationError) {
    sendJson(response, 409, { error: validationError });
    return;
  }

  if (body.savePool) {
    const savedPool = savePool(room.draftSettings.poolId, {
      name: cleanOptionalName(body.poolName),
      defaultParameters: {
        ...room.draftSettings,
        maxSeats: room.maxSeats
      }
    });

    if (!savedPool) {
      sendJson(response, 400, { error: "invalid_pool" });
      return;
    }

    room.draftSettings = {
      ...room.draftSettings,
      poolId: savedPool.id
    };
  }

  startDraft(room);
  broadcastRoom(roomNumber);
  sendJson(response, 200, getRoomSnapshot(roomNumber, body.participantId));
}

function handleDraftExport(roomNumber, response) {
  const room = rooms.get(roomNumber);

  if (!room) {
    sendJson(response, 404, { error: "room_not_found" });
    return;
  }

  if (!room.draft || room.draft.status !== "complete") {
    sendJson(response, 409, { error: "draft_not_complete" });
    return;
  }

  const exportJson = createTtsDraftExport(roomNumber, room.draft);

  if (exportJson.error) {
    sendJson(response, 409, exportJson);
    return;
  }

  sendJsonDownload(response, `franken-draft-${roomNumber}.json`, exportJson);
}

async function handleRestartDraft(roomNumber, request, response) {
  const room = rooms.get(roomNumber);

  if (!room) {
    sendJson(response, 404, { error: "room_not_found" });
    return;
  }

  let body;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  if (body.creatorToken !== room.creatorToken) {
    sendJson(response, 403, { error: "creator_token_required" });
    return;
  }

  room.draft = null;
  broadcastRoom(roomNumber);
  sendJson(response, 200, getRoomSnapshot(roomNumber, body.participantId));
}

async function handlePromoteSpectator(roomNumber, request, response) {
  const room = rooms.get(roomNumber);

  if (!room) {
    sendJson(response, 404, { error: "room_not_found" });
    return;
  }

  let body;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  if (body.creatorToken !== room.creatorToken) {
    sendJson(response, 403, { error: "creator_token_required" });
    return;
  }

  const spectator = room.participants.get(String(body.participantId || ""));

  if (!spectator || spectator.role !== "spectator" || !spectator.name) {
    sendJson(response, 404, { error: "named_spectator_not_found" });
    return;
  }

  spectator.superSpectator = Boolean(body.superSpectator);
  broadcastRoom(roomNumber);
  sendJson(response, 200, getRoomSnapshot(roomNumber, body.viewerId));
}

function completeDraftIfDone(draft) {
  const hasQueuedBags = draft.players.some((player) => player.queue.length > 0);

  if (!hasQueuedBags) {
    draft.status = "complete";
    draft.completedAt = new Date().toISOString();
  }
}

async function handleDraftPick(roomNumber, request, response) {
  const room = rooms.get(roomNumber);

  if (!room) {
    sendJson(response, 404, { error: "room_not_found" });
    return;
  }

  if (!room.draft || room.draft.status !== "active") {
    sendJson(response, 409, { error: "draft_not_active" });
    return;
  }

  let body;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  const draft = room.draft;
  const player = draft.players.find((candidate) => candidate.id === body.playerId);

  if (!player) {
    sendJson(response, 403, { error: "player_not_in_draft" });
    return;
  }

  const bag = player.queue[0];

  if (!bag) {
    sendJson(response, 409, { error: "no_bag_available" });
    return;
  }

  const selectedIds = [...new Set(Array.isArray(body.itemIds) ? body.itemIds.map(String) : [])];
  const itemsById = new Map(bag.items.map((item) => [item.id, item]));
  const selectedItems = selectedIds.map((id) => itemsById.get(id));

  if (selectedItems.some((item) => !item)) {
    sendJson(response, 400, { error: "item_not_in_bag" });
    return;
  }

  const requiredPickCount = getRequiredPickCount(player, bag, draft);

  if (selectedItems.length !== requiredPickCount) {
    sendJson(response, 400, {
      error: "wrong_pick_count",
      requiredPickCount
    });
    return;
  }

  const selectionError = getSelectionError(player, bag, selectedItems, draft);

  if (selectionError) {
    sendJson(response, 400, { error: selectionError });
    return;
  }

  player.queue.shift();
  player.pickCount = (player.pickCount || 0) + 1;

  if (bag.originalPlayerId === player.id) {
    player.initialBagPickCount = (player.initialBagPickCount || 0) + 1;
  }

  if (selectedItems.length > 0) {
    player.draftedGroups.push({
      bagId: bag.id,
      pickNumber: player.draftedGroups.length + 1,
      items: selectedItems
    });
    player.draftedItems.push(...selectedItems);
  }

  bag.items = bag.items.filter((item) => !selectedIds.includes(item.id));

  if (bag.items.length > 0) {
    if (selectedItems.length === 0) {
      bag.emptyPasses += 1;
    } else {
      bag.emptyPasses = 0;
    }

    if (bag.emptyPasses >= draft.players.length) {
      draft.discardedItems.push(...bag.items);
    } else {
      const playerIndex = draft.players.findIndex((candidate) => candidate.id === player.id);
      const nextPlayer = draft.players[(playerIndex + 1) % draft.players.length];
      nextPlayer.queue.push(bag);
    }
  }

  completeDraftIfDone(draft);
  broadcastRoom(roomNumber);
  sendJson(response, 200, getRoomSnapshot(roomNumber, player.id));
}

const server = http.createServer(async (request, response) => {
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

  if (url.pathname === "/api/pools" && request.method === "GET") {
    sendJson(response, 200, {
      pools: listPublicPools().map(getPoolSummary)
    });
    return;
  }

  if (url.pathname === "/api/pools/upload" && request.method === "POST") {
    await handlePoolUpload(request, response);
    return;
  }

  const poolUpdateMatch = url.pathname.match(/^\/api\/pools\/([^/]+)$/);

  if (poolUpdateMatch && request.method === "POST") {
    await handleUpdatePublicPool(decodeURIComponent(poolUpdateMatch[1]), request, response);
    return;
  }

  const poolDeleteMatch = url.pathname.match(/^\/api\/pools\/([^/]+)\/delete$/);

  if (poolDeleteMatch && request.method === "POST") {
    handleRemovePublicPool(decodeURIComponent(poolDeleteMatch[1]), response);
    return;
  }

  if (url.pathname === "/api/methods" && request.method === "GET") {
    sendJson(response, 200, getDraftMethodListPayload());
    return;
  }

  if (url.pathname === "/api/rooms" && request.method === "POST") {
    handleCreateRoom(response);
    return;
  }

  const settingsMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})\/settings$/);

  if (settingsMatch && request.method === "POST") {
    await handleRoomSettings(settingsMatch[1], request, response);
    return;
  }

  const startDraftMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})\/draft\/start$/);

  if (startDraftMatch && request.method === "POST") {
    await handleStartDraft(startDraftMatch[1], request, response);
    return;
  }

  const restartDraftMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})\/draft\/restart$/);

  if (restartDraftMatch && request.method === "POST") {
    await handleRestartDraft(restartDraftMatch[1], request, response);
    return;
  }

  const exportDraftMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})\/draft\/export$/);

  if (exportDraftMatch && request.method === "GET") {
    handleDraftExport(exportDraftMatch[1], response);
    return;
  }

  const pickMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})\/draft\/pick$/);

  if (pickMatch && request.method === "POST") {
    await handleDraftPick(pickMatch[1], request, response);
    return;
  }

  const promoteSpectatorMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})\/spectators\/promote$/);

  if (promoteSpectatorMatch && request.method === "POST") {
    await handlePromoteSpectator(promoteSpectatorMatch[1], request, response);
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
