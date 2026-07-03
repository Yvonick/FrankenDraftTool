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
const nominationAuctionStartingCredits = 40;
const nominationAuctionMulligans = 2;
const nominationAuctionBans = 1;
const auctionUndoLimit = 30;
const defaultAuctionSpeakerMode = "bid-and-pick";
const auctionSpeakerModes = new Set(["none", "autopick", "bid-and-pick"]);
const sseHeartbeatMs = 25000;
const emptyRoomTtlMs = 60 * 60 * 1000;
const roomCleanupIntervalMs = 10 * 60 * 1000;
const compactItemRefKey = "__frankenItemRef";

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

function sendSseHeartbeat(response) {
  if (!response.destroyed && !response.writableEnded) {
    response.write(": heartbeat\n\n");
  }
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
  const heartbeat = setInterval(() => sendSseHeartbeat(response), sseHeartbeatMs);

  request.on("close", () => {
    clearInterval(heartbeat);
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
      auctionSpeakerMode: defaultAuctionSpeakerMode,
      typeOrder: [],
      itemsPerType: {}
    };
  }

  return {
    poolId: pool.id,
    methodId: method.id,
    maxSeats: pool.defaultParameters.maxSeats,
    picksPerBag: pool.defaultParameters.picksPerBag,
    auctionSpeakerMode: cleanAuctionSpeakerMode(pool.defaultParameters.auctionSpeakerMode),
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
    creatorId: null,
    maxSeats: draftSettings.maxSeats,
    allowSpectators: true,
    draftSettings,
    draft: null,
    revision: 0,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    participants: new Map(),
    clients: new Map()
  });

  return roomNumber;
}

function touchRoom(room) {
  if (room) {
    room.lastActiveAt = Date.now();
  }
}

function cleanupIdleRooms() {
  const now = Date.now();

  for (const [roomNumber, room] of rooms.entries()) {
    if (room.clients.size > 0) {
      continue;
    }

    const lastActiveAt = room.lastActiveAt || room.createdAt || now;

    if (now - lastActiveAt > emptyRoomTtlMs) {
      rooms.delete(roomNumber);
    }
  }
}

function isRoomHost(room, participantId) {
  return Boolean(room.creatorId && String(participantId || "") === room.creatorId);
}

function getSeatedParticipants(room) {
  return [...room.participants.values()]
    .filter((participant) => participant.role === "seated")
    .map((participant) => ({
      id: participant.id,
      name: participant.name,
      admin: Boolean(participant.admin),
      host: isRoomHost(room, participant.id)
    }));
}

function getRoomViewerSnapshot(room, viewerId) {
  const viewer = room.participants.get(String(viewerId || ""));

  if (!viewer) {
    return null;
  }

  return {
    id: viewer.id,
    role: viewer.role,
    name: viewer.name,
    admin: Boolean(viewer.admin),
    host: isRoomHost(room, viewer.id),
    superSpectator: viewer.role === "spectator" && Boolean(viewer.superSpectator)
  };
}

function hasRoomAdminRights(room, body = {}) {
  if (body.creatorToken === room.creatorToken) {
    return true;
  }

  const actorId = String(body.actorId || body.viewerId || body.participantId || "");
  const actor = room.participants.get(actorId);

  return Boolean(actor?.admin);
}

function sendAdminRequired(response) {
  sendJson(response, 403, { error: "admin_required" });
}

function getRoomSnapshot(roomNumber, viewerId = null) {
  const room = rooms.get(roomNumber);

  if (!room) {
    return null;
  }

  return {
    roomNumber,
    revision: room.revision || 0,
    maxSeats: room.maxSeats,
    allowSpectators: room.allowSpectators !== false,
    seated: getSeatedParticipants(room),
    spectators: [...room.participants.values()]
      .filter((participant) => participant.role === "spectator")
      .length,
    namedSpectators: [...room.participants.values()]
      .filter((participant) => participant.role === "spectator" && participant.name)
      .map((participant) => ({
        id: participant.id,
        name: participant.name,
        superSpectator: Boolean(participant.superSpectator),
        admin: Boolean(participant.admin),
        host: isRoomHost(room, participant.id)
      })),
    viewer: getRoomViewerSnapshot(room, viewerId),
    draft: getDraftSnapshot(room, viewerId)
  };
}

function broadcastRoom(roomNumber) {
  const room = rooms.get(roomNumber);

  if (!room) {
    return;
  }

  touchRoom(room);
  room.revision = (room.revision || 0) + 1;

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

function cleanAuctionSpeakerMode(value, fallback = defaultAuctionSpeakerMode) {
  return auctionSpeakerModes.has(value) ? value : fallback;
}

function cleanNonnegativeInteger(value, max = 9999) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    return null;
  }

  return Math.min(Math.max(parsed, 0), max);
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

function isWildcardItem(item) {
  return /^wild\s*cards?\b/i.test(String(item?.name || "").trim());
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
    linkedItems: Array.isArray(item.linkedItems)
      ? item.linkedItems.map(cloneItem)
      : []
  };
}

function cloneJson(value, options = {}) {
  return JSON.parse(JSON.stringify(value, options.replacer));
}

function isDraftItemLike(value) {
  return Boolean(value)
    && typeof value === "object"
    && typeof value.id === "string"
    && typeof value.type === "string"
    && (
      "imageUrl" in value
      || "sourceObjectType" in value
      || "ttsObject" in value
      || "metaType" in value
    );
}

function compactDraftItem(item) {
  if (item.metaType === "speaker-order" || isSpeakerOrderType(item.type)) {
    return cloneItem(item);
  }

  return {
    [compactItemRefKey]: item.id
  };
}

function addItemsToIndex(index, items = []) {
  for (const item of items) {
    if (!item?.id || index.has(item.id)) {
      continue;
    }

    index.set(item.id, item);
    addItemsToIndex(index, item.linkedItems || []);
  }
}

function createPoolItemIndex(pool) {
  const index = new Map();
  addItemsToIndex(index, pool?.items || []);
  return index;
}

function hydrateCompactUndoValue(value, itemIndex) {
  if (Array.isArray(value)) {
    return value.map((entry) => hydrateCompactUndoValue(entry, itemIndex));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (typeof value[compactItemRefKey] === "string") {
    const sourceItem = itemIndex.get(value[compactItemRefKey]);

    return sourceItem ? cloneItem(sourceItem) : {
      id: value[compactItemRefKey],
      name: "Missing item",
      content: "",
      type: "Unknown",
      imageUrl: null,
      imageSecondaryUrl: null,
      imageSheet: null,
      sourceObjectType: "Unknown",
      linkedItems: []
    };
  }

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    hydrateCompactUndoValue(entry, itemIndex)
  ]));
}

function hydrateAuctionUndoDraft(snapshot) {
  const pool = getPool(snapshot?.poolId);

  if (!pool) {
    return null;
  }

  return hydrateCompactUndoValue(snapshot, createPoolItemIndex(pool));
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
    order: item.order,
    isWildcard: isWildcardItem(item),
    linkedItems: Array.isArray(item.linkedItems)
      ? item.linkedItems.map(getItemSnapshot)
      : []
  };
}

function getDraftGroupSnapshot(group) {
  return {
    id: group.id,
    pickNumber: group.pickNumber,
    bagId: group.bagId,
    label: group.label,
    cost: group.cost,
    bidKind: group.bidKind,
    nominationType: group.nominationType,
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

function resolvePoolItemForExport(pool, item) {
  if (!pool || item.metaType === "speaker-order") {
    return item;
  }

  return pool.items.find((poolItem) => poolItem.id === item.id) || item;
}

function getResolvedDraftItemExportItems(pool, item) {
  const sourceItem = resolvePoolItemForExport(pool, item);

  return [
    sourceItem,
    ...(Array.isArray(sourceItem.linkedItems) ? sourceItem.linkedItems : [])
  ];
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

function uniquifyTtsObjectGuids(value, usedGuids) {
  if (!value || typeof value !== "object") {
    return;
  }

  if (typeof value.GUID === "string") {
    if (usedGuids.has(value.GUID)) {
      value.GUID = createTtsGuid(usedGuids);
    } else {
      usedGuids.add(value.GUID);
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (key !== "GUID") {
      uniquifyTtsObjectGuids(child, usedGuids);
    }
  }
}

function cloneTtsObjectForExport(item, usedGuids) {
  const object = cloneJson(item.ttsObject);
  uniquifyTtsObjectGuids(object, usedGuids);
  return object;
}

function createTtsDraftItem(item, usedGuids) {
  if (item.ttsObject) {
    return cloneTtsObjectForExport(item, usedGuids);
  }

  if (item.metaType === "speaker-order") {
    return createTtsSpeakerOrderNotecard(item, usedGuids);
  }

  return null;
}

function createTtsContainerBag({ nickname, description, containedObjects, index, usedGuids, color }) {
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
    Nickname: nickname,
    Description: description,
    GMNotes: "",
    AltLookAngle: { x: 0, y: 0, z: 0 },
    ColorDiffuse: color || { r: 0.7058823, g: 0.366520882, b: 0 },
    LayoutGroupSortIndex: 0,
    Value: containedObjects.length,
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
    ContainedObjects: containedObjects
  };
}

function createTtsBag(player, index, usedGuids, pool) {
  return createTtsContainerBag({
    nickname: player.name,
    description: `Drafted items for ${player.name}`,
    index,
    usedGuids,
    containedObjects: player.draftedItems
      .flatMap((item) => getResolvedDraftItemExportItems(pool, item)
        .map((exportItem) => createTtsDraftItem(exportItem, usedGuids)))
      .filter(Boolean)
  });
}

function createTtsDraftableItems(items, pool, usedGuids) {
  return items
    .map((item) => createTtsDraftItem(resolvePoolItemForExport(pool, item), usedGuids))
    .filter(Boolean);
}

function createTtsCurrentBag({ nickname, description, items, pool, index, usedGuids, color }) {
  return createTtsContainerBag({
    nickname,
    description,
    index,
    usedGuids,
    color,
    containedObjects: createTtsDraftableItems(items, pool, usedGuids)
  });
}

function createTtsBagDraftCurrentBags(pool, draft, index, usedGuids) {
  const queuedBags = [];

  for (const player of draft.players) {
    for (const [queueIndex, bag] of (player.queue || []).entries()) {
      if (!bag.items?.length) {
        continue;
      }

      queuedBags.push(createTtsCurrentBag({
        nickname: `${player.name} - ${queueIndex === 0 ? "Current Bag" : `Queue Bag ${queueIndex + 1}`}`,
        description: `Bag draft queue for ${player.name}`,
        items: bag.items,
        pool,
        index: queuedBags.length,
        usedGuids,
        color: { r: 0.24, g: 0.24, b: 0.42 }
      }));
    }
  }

  if (queuedBags.length === 0) {
    return null;
  }

  return createTtsContainerBag({
    nickname: "Current Bag Draft Queues",
    description: "Bags currently being viewed or waiting in player queues",
    index,
    usedGuids,
    color: { r: 0.12, g: 0.18, b: 0.36 },
    containedObjects: queuedBags
  });
}

function createTtsAuctionCurrentBags(pool, draft, index, usedGuids) {
  const nomination = draft.auction?.currentNomination;

  if (!nomination) {
    return null;
  }

  const nominationBags = [];

  if (nomination.items?.length) {
    nominationBags.push(createTtsCurrentBag({
      nickname: `Current Nomination - ${nomination.type}`,
      description: `Items currently open during ${draft.auction.stage}`,
      items: nomination.items,
      pool,
      index: nominationBags.length,
      usedGuids,
      color: { r: 0.35, g: 0.22, b: 0.1 }
    }));
  }

  if (nomination.temporaryBin?.length) {
    nominationBags.push(createTtsCurrentBag({
      nickname: `Temporary Bin - ${nomination.type}`,
      description: "Items set aside by mulligans during the current nomination",
      items: nomination.temporaryBin,
      pool,
      index: nominationBags.length,
      usedGuids,
      color: { r: 0.34, g: 0.18, b: 0.28 }
    }));
  }

  if (nominationBags.length === 0) {
    return null;
  }

  return createTtsContainerBag({
    nickname: "Current Auction Items",
    description: "Items currently open or temporarily set aside in the active nomination",
    index,
    usedGuids,
    color: { r: 0.18, g: 0.12, b: 0.32 },
    containedObjects: nominationBags
  });
}

function createTtsCurrentDraftBags(pool, draft, startIndex, usedGuids) {
  const currentBag = draft.engine === "auction"
    ? createTtsAuctionCurrentBags(pool, draft, startIndex, usedGuids)
    : createTtsBagDraftCurrentBags(pool, draft, startIndex, usedGuids);

  return currentBag ? [currentBag] : [];
}

function addDraftItemIds(ids, items = []) {
  for (const item of items) {
    if (item?.id) {
      ids.add(item.id);
    }
  }
}

function getInFlightDraftItems(draft) {
  if (!draft || draft.status !== "active") {
    return [];
  }

  if (draft.engine === "auction") {
    const nomination = draft.auction?.currentNomination;

    return [
      ...(nomination?.items || []),
      ...(nomination?.temporaryBin || [])
    ];
  }

  return draft.players.flatMap((player) => (
    player.queue || []
  ).flatMap((bag) => bag.items || []));
}

function getUsedDraftableItemIds(draft) {
  const usedIds = new Set();

  for (const player of draft.players) {
    for (const item of player.draftedItems) {
      usedIds.add(item.id);
    }
  }

  for (const item of draft.discardedItems || []) {
    usedIds.add(item.id);
  }

  for (const item of draft.auction?.permanentBin || []) {
    usedIds.add(item.id);
  }

  addDraftItemIds(usedIds, getInFlightDraftItems(draft));

  return usedIds;
}

function getRemainingDraftableItems(pool, draft) {
  const usedIds = getUsedDraftableItemIds(draft);

  return pool.items.filter((item) => !usedIds.has(item.id));
}

function getRemainingItemsByType(pool, draft) {
  const itemsByType = new Map();

  for (const item of getRemainingDraftableItems(pool, draft)) {
    if (!itemsByType.has(item.type)) {
      itemsByType.set(item.type, []);
    }

    itemsByType.get(item.type).push(item);
  }

  return itemsByType;
}

function createTtsRemainingTypeBag(type, items, index, usedGuids) {
  return createTtsContainerBag({
    nickname: type,
    description: `Remaining draftable ${type}`,
    index,
    usedGuids,
    color: { r: 0.1, g: 0.28, b: 0.45 },
    containedObjects: items
      .map((item) => createTtsDraftItem(item, usedGuids))
      .filter(Boolean)
  });
}

function createTtsRemainingPoolBag(pool, draft, index, usedGuids) {
  const itemsByType = getRemainingItemsByType(pool, draft);
  const orderedTypes = [
    ...pool.types.filter((type) => itemsByType.has(type)),
    ...[...itemsByType.keys()].filter((type) => !pool.types.includes(type))
  ];
  const typeBags = orderedTypes
    .map((type, typeIndex) => createTtsRemainingTypeBag(type, itemsByType.get(type), typeIndex, usedGuids))
    .filter((bag) => bag.ContainedObjects.length > 0);

  return createTtsContainerBag({
    nickname: "Remaining Draftable Pool",
    description: "Draftable pool items not used during this draft",
    index,
    usedGuids,
    color: { r: 0.08, g: 0.16, b: 0.32 },
    containedObjects: typeBags
  });
}

function createTtsDraftExport(roomNumber, draft) {
  const pool = getPool(draft.poolId);

  if (!pool) {
    return {
      error: "pool_unavailable"
    };
  }

  const missingDraftedItemCount = draft.players.reduce((count, player) => (
    count + player.draftedItems
      .flatMap((item) => getResolvedDraftItemExportItems(pool, item))
      .filter((item) => !isExportableDraftItem(item)).length
  ), 0);
  const missingCurrentItemCount = getInFlightDraftItems(draft)
    .map((item) => resolvePoolItemForExport(pool, item))
    .filter((item) => !isExportableDraftItem(item)).length;
  const missingRemainingItemCount = getRemainingDraftableItems(pool, draft)
    .filter((item) => !isExportableDraftItem(item))
    .length;
  const missingItemCount = missingDraftedItemCount + missingCurrentItemCount + missingRemainingItemCount;

  if (missingItemCount > 0) {
    return {
      error: "tts_source_unavailable",
      missingItemCount
    };
  }

  const usedGuids = new Set();
  const playerBags = draft.players.map((player, index) => createTtsBag(player, index, usedGuids, pool));
  const currentBags = createTtsCurrentDraftBags(pool, draft, playerBags.length, usedGuids);

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
    ObjectStates: [
      ...playerBags,
      ...currentBags,
      createTtsRemainingPoolBag(pool, draft, playerBags.length + currentBags.length, usedGuids)
    ]
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
  const auctionSpeakerMode = defaultParameters.auctionSpeakerMode === undefined
    ? cleanAuctionSpeakerMode(pool.defaultParameters.auctionSpeakerMode)
    : cleanAuctionSpeakerMode(defaultParameters.auctionSpeakerMode);

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
      auctionSpeakerMode,
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

  if (!hasRoomAdminRights(room, body)) {
    sendAdminRequired(response);
    return;
  }

  if (room.draft) {
    sendJson(response, 409, { error: "draft_already_started" });
    return;
  }

  const maxSeats = body.maxSeats === undefined ? room.maxSeats : cleanSeatLimit(body.maxSeats);
  const allowSpectators = body.allowSpectators === undefined
    ? room.allowSpectators !== false
    : body.allowSpectators !== false;

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
  const auctionSpeakerMode = body.auctionSpeakerMode === undefined
    ? cleanAuctionSpeakerMode(room.draftSettings.auctionSpeakerMode)
    : cleanAuctionSpeakerMode(body.auctionSpeakerMode);

  if (!picksPerBag) {
    sendJson(response, 400, { error: "invalid_picks_per_bag" });
    return;
  }

  if (!itemsPerType) {
    sendJson(response, 400, { error: "invalid_items_per_type" });
    return;
  }

  room.maxSeats = maxSeats;
  room.allowSpectators = allowSpectators;
  room.draftSettings = {
    poolId: pool.id,
    methodId: method.id,
    maxSeats,
    picksPerBag,
    auctionSpeakerMode,
    typeOrder,
    itemsPerType
  };

  broadcastRoom(roomNumber);
  sendJson(response, 200, getRoomSnapshot(roomNumber, body.viewerId || body.actorId || body.participantId));
}

function saveRoomPoolWithDefaults(room, poolName) {
  return savePool(room.draftSettings.poolId, {
    name: cleanOptionalName(poolName),
    defaultParameters: {
      maxSeats: room.maxSeats,
      picksPerBag: room.draftSettings.picksPerBag,
      auctionSpeakerMode: cleanAuctionSpeakerMode(room.draftSettings.auctionSpeakerMode),
      typeOrder: room.draftSettings.typeOrder,
      itemsPerType: room.draftSettings.itemsPerType
    }
  });
}

async function handleSaveRoomPool(roomNumber, request, response) {
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

  if (!hasRoomAdminRights(room, body)) {
    sendAdminRequired(response);
    return;
  }

  if (room.draft) {
    sendJson(response, 409, { error: "draft_already_started" });
    return;
  }

  const savedPool = saveRoomPoolWithDefaults(room, body.poolName);

  if (!savedPool) {
    sendJson(response, 400, { error: "invalid_pool" });
    return;
  }

  room.draftSettings = {
    ...room.draftSettings,
    poolId: savedPool.id
  };

  broadcastRoom(roomNumber);
  sendJson(response, 200, {
    ...getRoomSnapshot(roomNumber, body.viewerId || body.actorId || body.participantId),
    savedPool: getPoolSummary(savedPool),
    pools: listPublicPools().map(getPoolSummary)
  });
}

function handleRoomDetails(roomNumber, request, response) {
  touchRoom(rooms.get(roomNumber));
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
  const hasCreatorToken = url.searchParams.get("creatorToken") === room.creatorToken;

  if (hasCreatorToken && (!room.creatorId || !room.participants.has(room.creatorId) || room.creatorId === participantId)) {
    room.creatorId = participantId;
  }

  const requestedRole = url.searchParams.get("role") === "seated" ? "seated" : "spectator";

  if (requestedRole === "spectator" && room.allowSpectators === false && existingParticipant?.role !== "spectator") {
    sendJson(response, 403, { error: "spectators_disabled" });
    return;
  }

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
    admin: isRoomHost(room, participantId) ? false : Boolean(existingParticipant?.admin),
    connectionToken
  });
  room.clients.set(response, { participantId });
  response.write("event: viewer\n");
  response.write(`data: ${JSON.stringify({
    id: participantId,
    role,
    name,
    seatDenied,
    superSpectator: role === "spectator" && Boolean(existingParticipant?.superSpectator),
    admin: isRoomHost(room, participantId) ? false : Boolean(existingParticipant?.admin),
    host: isRoomHost(room, participantId)
  })}\n\n`);
  const heartbeat = setInterval(() => sendSseHeartbeat(response), sseHeartbeatMs);
  broadcastRoom(roomNumber);

  request.on("close", () => {
    clearInterval(heartbeat);
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

function getTablePlayerSnapshot(player, room) {
  const participant = room.participants.get(player.id);

  return {
    id: player.id,
    name: player.name,
    seat: player.seat,
    admin: Boolean(participant?.admin),
    host: isRoomHost(room, player.id),
    queueLength: player.queue.length,
    lookingAtBag: Boolean(player.queue[0]),
    credits: player.credits,
    mulliganTokens: player.mulliganTokens,
    banTokens: player.banTokens
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

function getAuctionPlayerSnapshot(player, draft, viewerId, room = null) {
  const nomination = draft.auction.currentNomination;
  const pickRecord = nomination?.pickOrder?.find((record) => record.playerId === player.id);
  const revealedBids = nomination?.revealedBids?.find((record) => record.playerId === player.id);
  const isViewer = player.id === viewerId;
  const participant = room?.participants.get(player.id);

  return {
    playerId: player.id,
    name: player.name,
    seat: player.seat,
    admin: Boolean(participant?.admin),
    host: room ? isRoomHost(room, player.id) : Boolean(player.host),
    credits: player.credits,
    mulliganTokens: player.mulliganTokens,
    banTokens: player.banTokens,
    noBanPreset: Boolean(player.noBanPreset),
    isSpeaker: getAuctionSpeaker(draft)?.id === player.id,
    draftedItems: player.draftedItems.map(getItemSnapshot),
    draftedGroups: player.draftedGroups.map(getDraftGroupSnapshot),
    auctionBidLocked: Boolean(player.auctionBidLocked),
    currentBids: isViewer || ["picking"].includes(draft.auction.stage)
      ? (player.currentBids || null)
      : null,
    revealedBids: revealedBids?.bids || null,
    pickRecord: pickRecord || null
  };
}

function getAuctionSnapshot(draft, viewerId, room = null) {
  const speaker = getAuctionSpeaker(draft);
  const nomination = draft.auction.currentNomination;
  const lastBidRecap = draft.auction.lastBidRecap || null;
  const viewerPlayer = getAuctionPlayer(draft, viewerId);
  const currentPick = nomination?.pickOrder?.[nomination.pickCursor] || null;
  const wildcardItem = getAuctionWildcardItem(nomination);
  const revealedBids = (nomination?.revealedBids || []).map((record) => ({
    ...record,
    playerName: getAuctionPlayer(draft, record.playerId)?.name || "Unknown"
  }));

  return {
    stage: draft.auction.stage,
    speakerMode: cleanAuctionSpeakerMode(draft.auction.speakerMode),
    undoAvailable: Boolean(draft.undoStack?.length),
    speakerId: speaker?.id || null,
    speakerName: speaker?.name || null,
    speakerIndex: draft.auction.speakerIndex,
    speakerOrder: draft.auction.speakerOrder.map((playerId) => {
      const player = getAuctionPlayer(draft, playerId);
      const result = draft.auction.speakerOrderResults.find((entry) => entry.playerId === playerId);

      return {
        playerId,
        name: player?.name || "Unknown",
        order: result?.order ?? null,
        bidKind: result?.bidKind ?? null,
        bid: result?.bid ?? null,
        cost: result?.cost ?? null
      };
    }),
    eligibleTypes: getEligibleNominationTypes(draft),
    nominationsByType: draft.auction.nominationsByType,
    permanentBinCount: draft.auction.permanentBin.length,
    permanentBinItems: draft.auction.permanentBin.map(getItemSnapshot),
    players: draft.players.map((player) => getAuctionPlayerSnapshot(player, draft, viewerId, room)),
    lastBidRecap: lastBidRecap ? {
      type: lastBidRecap.type,
      isSpeakerOrder: Boolean(lastBidRecap.isSpeakerOrder),
      pickOrder: (lastBidRecap.pickOrder || []).map((record, index) => ({
        ...record,
        order: index + 1,
        playerName: getAuctionPlayer(draft, record.playerId)?.name || "Unknown"
      })),
      revealedBids: (lastBidRecap.revealedBids || []).map((record) => ({
        ...record,
        playerName: getAuctionPlayer(draft, record.playerId)?.name || "Unknown"
      }))
    } : null,
    currentNomination: nomination ? {
      type: nomination.type,
      isSpeakerOrder: Boolean(nomination.isSpeakerOrder),
      items: nomination.items.map(getItemSnapshot),
      wildcardItem: wildcardItem ? getItemSnapshot(wildcardItem) : null,
      wildcardChoiceItems: wildcardItem
        ? getAuctionWildcardChoices(draft, nomination.type).map(getItemSnapshot)
        : [],
      temporaryBinCount: nomination.temporaryBin.length,
      temporaryBinItems: nomination.temporaryBin.map(getItemSnapshot),
      permanentBinCount: draft.auction.permanentBin.length,
      banPlayerId: nomination.banPlayerId || null,
      banPlayerName: getAuctionPlayer(draft, nomination.banPlayerId)?.name || null,
      pickOrder: (nomination.pickOrder || []).map((record, index) => ({
        ...record,
        order: index + 1,
        playerName: getAuctionPlayer(draft, record.playerId)?.name || "Unknown"
      })),
      pickCursor: nomination.pickCursor || 0,
      currentPickPlayerId: currentPick?.playerId || null,
      currentPickPlayerName: getAuctionPlayer(draft, currentPick?.playerId)?.name || null,
      revealedBids
    } : null,
    player: viewerPlayer ? {
      playerId: viewerPlayer.id,
      credits: viewerPlayer.credits,
      mulliganTokens: viewerPlayer.mulliganTokens,
      banTokens: viewerPlayer.banTokens,
      noBanPreset: Boolean(viewerPlayer.noBanPreset),
      currentBids: viewerPlayer.currentBids,
      auctionBidLocked: Boolean(viewerPlayer.auctionBidLocked)
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
  const table = draft.players.map((player) => getTablePlayerSnapshot(player, room));

  if (draft.status === "complete") {
    return {
      status: "complete",
      engine: draft.engine || method.engine,
      poolId: draft.poolId,
      methodId: method.id,
      method: getDraftMethodSummary(method),
      picksPerBag: draft.picksPerBag,
      auctionSpeakerMode: cleanAuctionSpeakerMode(draft.auctionSpeakerMode),
      typeOrder: draft.typeOrder,
      itemsPerType: draft.itemsPerType,
      undoAvailable: draft.engine === "auction" && Boolean(draft.undoStack?.length),
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
    engine: draft.engine || method.engine,
    poolId: draft.poolId,
    methodId: method.id,
    method: getDraftMethodSummary(method),
    picksPerBag: draft.picksPerBag,
    auctionSpeakerMode: cleanAuctionSpeakerMode(draft.auctionSpeakerMode),
    typeOrder: draft.typeOrder,
    itemsPerType: draft.itemsPerType,
    table,
    currentPlayer: draft.engine === "auction" ? null : (player ? getPlayerDraftView(player, draft, true) : null),
    superSpectator: isSuperSpectator ? {
      players: draft.engine === "auction"
        ? draft.players.map((candidate) => getAuctionPlayerSnapshot(candidate, draft, viewerId, room))
        : draft.players.map((candidate) => getPlayerDraftView(candidate, draft, true))
    } : null,
    auction: draft.engine === "auction" ? getAuctionSnapshot(draft, viewerId, room) : null
  };
}

function validateDraftCanStart(room) {
  if (room.draft) {
    return "draft_already_started";
  }

  const seated = getSeatedParticipants(room);

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

  if (!method.playable || !["bag-pass", "auction"].includes(method.engine)) {
    return "unsupported_draft_method";
  }

  for (const type of cleanTypeOrder(pool, room.draftSettings.typeOrder)) {
    if (isSpeakerOrderType(type)) {
      continue;
    }

    const requested = method.engine === "auction"
      ? (room.draftSettings.itemsPerType[type] || 0) * (seated.length + 1)
      : (room.draftSettings.itemsPerType[type] || 0) * seated.length;
    const available = pool.items.filter((item) => item.type === type && !isWildcardItem(item)).length;

    if (requested > available) {
      return "not_enough_pool_items";
    }
  }

  if (method.engine === "auction" && getAuctionTypeOrder(room.draftSettings, pool).length === 0) {
    return "no_nomination_types";
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
      : shuffle(pool.items.filter((item) => item.type === type && !isWildcardItem(item)))
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

function getAuctionTypeOrder(draftOrSettings, pool = null) {
  const typeOrder = pool
    ? cleanTypeOrder(pool, draftOrSettings.typeOrder)
    : draftOrSettings.typeOrder;
  const itemsPerType = draftOrSettings.itemsPerType || {};

  return typeOrder.filter((type) => !isSpeakerOrderType(type) && (itemsPerType[type] || 0) > 0);
}

function createAuctionItemSources(pool, settings) {
  const sources = {};

  for (const type of getAuctionTypeOrder(settings, pool)) {
    sources[type] = shuffle(pool.items.filter((item) => item.type === type).map(cloneItem));
  }

  return sources;
}

function createAuctionPlayers(seated) {
  return shuffle(seated).map((participant, index) => ({
    id: participant.id,
    name: participant.name,
    seat: index + 1,
    queue: [],
    draftedItems: [],
    draftedGroups: [],
    credits: nominationAuctionStartingCredits,
    mulliganTokens: nominationAuctionMulligans,
    banTokens: nominationAuctionBans,
    noBanPreset: false,
    currentBids: null,
    auctionBidLocked: false
  }));
}

function cloneDraftForUndo(draft) {
  const snapshot = cloneJson(draft, {
    replacer: (key, value) => {
      if (key === "undoStack" || key === "ttsObject") {
        return undefined;
      }

      if (isDraftItemLike(value)) {
        return compactDraftItem(value);
      }

      return value;
    }
  });
  return snapshot;
}

function pushAuctionUndo(draft) {
  if (!draft || draft.engine !== "auction") {
    return;
  }

  const undoStack = Array.isArray(draft.undoStack) ? draft.undoStack : [];
  undoStack.push(cloneDraftForUndo(draft));

  while (undoStack.length > auctionUndoLimit) {
    undoStack.shift();
  }

  draft.undoStack = undoStack;
}

function getAuctionPlayer(draft, playerId) {
  return draft.players.find((player) => player.id === playerId) || null;
}

function getAuctionSpeaker(draft) {
  if (!draft.auction.speakerOrder.length) {
    return null;
  }

  return getAuctionPlayer(draft, draft.auction.speakerOrder[draft.auction.speakerIndex]);
}

function getEligibleNominationTypes(draft) {
  return getAuctionTypeOrder(draft).filter((type) => (
    (draft.auction.nominationsByType[type] || 0) < (draft.itemsPerType[type] || 0)
  ));
}

function drawAuctionItems(draft, type, count) {
  const source = draft.auction.itemSources[type] || [];
  const items = [];

  for (let index = 0; index < count; index += 1) {
    const item = source.pop();

    if (item) {
      items.push(item);
    }
  }

  return items;
}

function returnAuctionItems(draft, type, items) {
  const source = draft.auction.itemSources[type] || [];
  draft.auction.itemSources[type] = shuffle([...source, ...items]);
}

function shuffleAuctionItemSources(draft) {
  for (const [type, items] of Object.entries(draft.auction.itemSources || {})) {
    draft.auction.itemSources[type] = shuffle(items);
  }
}

function getAuctionWildcardItem(nomination) {
  return nomination?.items.find(isWildcardItem) || null;
}

function getAuctionWildcardChoices(draft, type) {
  return (draft.auction.itemSources[type] || []).filter((item) => !isWildcardItem(item));
}

function canDrawAuctionItems(draft, type, count) {
  return getAuctionWildcardChoices(draft, type).length >= count;
}

function createAuctionNomination(type, items, options = {}) {
  return {
    type,
    isSpeakerOrder: Boolean(options.isSpeakerOrder),
    items,
    temporaryBin: [],
    banDeclines: [],
    banCursor: options.banCursor ?? 0,
    banPlayerId: null,
    bids: {},
    pickOrder: [],
    pickCursor: 0,
    revealedBids: []
  };
}

function orderPlayersByBid(players, getBid) {
  const bidGroups = new Map();

  for (const player of players) {
    const bid = getBid(player);

    if (!bidGroups.has(bid)) {
      bidGroups.set(bid, []);
    }

    bidGroups.get(bid).push(player);
  }

  return [...bidGroups.entries()]
    .sort(([left], [right]) => right - left)
    .flatMap(([, group]) => shuffle(group));
}

function completeAuctionIfDone(draft) {
  if (getEligibleNominationTypes(draft).length > 0) {
    return false;
  }

  draft.status = "complete";
  draft.completedAt = new Date().toISOString();
  return true;
}

function startAuctionBidding(draft, stage = "bidding") {
  const nomination = draft.auction.currentNomination;
  nomination.bids = {};
  nomination.pickOrder = [];
  nomination.pickCursor = 0;
  nomination.revealedBids = [];

  for (const player of draft.players) {
    player.currentBids = null;
    player.auctionBidLocked = false;
  }

  draft.auction.stage = stage;
}

function startSpeakerOrderBidding(draft) {
  draft.auction.currentNomination = createAuctionNomination(
    speakerOrderType,
    createSpeakerOrderItems(draft.players),
    { isSpeakerOrder: true }
  );
  startAuctionBidding(draft, "speaker_order_bidding");
}

function finishAuctionSpeakerOrder(draft, records) {
  const playerById = new Map(draft.players.map((player) => [player.id, player]));
  const orderedRecords = [...records]
    .filter((record) => playerById.has(record.playerId))
    .sort((left, right) => (left.itemOrder || 999) - (right.itemOrder || 999));

  draft.players = orderedRecords.map((record, index) => {
    const player = playerById.get(record.playerId);
    player.seat = index + 1;
    return player;
  });
  draft.auction.speakerOrder = draft.players.map((player) => player.id);
  draft.auction.speakerIndex = 0;
  draft.auction.speakerOrderResults = orderedRecords.map((record) => ({
    playerId: record.playerId,
    order: record.itemOrder || null,
    bidKind: record.bidKind,
    bid: record.bid,
    cost: record.cost
  }));
  draft.auction.currentNomination = null;
  draft.auction.stage = "nomination";
}

function startAuctionWithRandomSpeakerOrder(draft) {
  const records = draft.players.map((player, index) => ({
    playerId: player.id,
    itemOrder: index + 1,
    bidKind: "random",
    bid: 0,
    cost: 0
  }));

  finishAuctionSpeakerOrder(draft, records);
}

function advanceAuctionBanWindow(draft) {
  const nomination = draft.auction.currentNomination;

  if (!nomination) {
    return;
  }

  if (!canDrawAuctionItems(draft, nomination.type, 1)) {
    nomination.banPlayerId = null;
    startAuctionBidding(draft);
    return;
  }

  nomination.banDeclines = nomination.banDeclines || [];

  for (let attempts = 0; attempts < draft.players.length * 2; attempts += 1) {
    const eligiblePlayers = draft.players.filter((player) => player.banTokens > 0);

    if (eligiblePlayers.length === 0 || eligiblePlayers.every((player) => nomination.banDeclines.includes(player.id))) {
      nomination.banPlayerId = null;
      startAuctionBidding(draft);
      return;
    }

    const index = nomination.banCursor ?? draft.auction.speakerIndex;
    const player = draft.players[index % draft.players.length];
    nomination.banCursor = (index + 1) % draft.players.length;

    if (!player || player.banTokens <= 0 || nomination.banDeclines.includes(player.id)) {
      continue;
    }

    if (player.noBanPreset) {
      nomination.banDeclines.push(player.id);
      continue;
    }

    nomination.banPlayerId = player.id;
    draft.auction.stage = "ban";
    return;
  }

  nomination.banPlayerId = null;
  startAuctionBidding(draft);
}

function moveAuctionToPostDrawStage(draft) {
  const speaker = getAuctionSpeaker(draft);
  const nomination = draft.auction.currentNomination;
  const drawCount = draft.players.length + 1;

  if (getAuctionWildcardItem(nomination)) {
    draft.auction.stage = "wildcard";
    return;
  }

  if (speaker?.mulliganTokens > 0 && canDrawAuctionItems(draft, nomination.type, drawCount)) {
    draft.auction.stage = "mulligan";
    return;
  }

  nomination.banCursor = draft.auction.speakerIndex;
  nomination.banDeclines = [];
  advanceAuctionBanWindow(draft);
}

function resolveAuctionBids(draft) {
  const nomination = draft.auction.currentNomination;
  const playerCount = draft.players.length;
  const records = [];
  const firstWinner = orderPlayersByBid(draft.players, (player) => nomination.bids[player.id]?.first || 0)[0];

  records.push({
    playerId: firstWinner.id,
    bidKind: "first",
    bid: nomination.bids[firstWinner.id]?.first || 0,
    cost: nomination.bids[firstWinner.id]?.first || 0
  });

  if (playerCount >= 5) {
    const secondWinner = orderPlayersByBid(
      draft.players.filter((player) => player.id !== firstWinner.id),
      (player) => nomination.bids[player.id]?.second || 0
    )[0];

    records.push({
      playerId: secondWinner.id,
      bidKind: "second",
      bid: nomination.bids[secondWinner.id]?.second || 0,
      cost: nomination.bids[secondWinner.id]?.second || 0
    });
  }

  const alreadyPicked = new Set(records.map((record) => record.playerId));
  const tieBreakerPlayers = orderPlayersByBid(
    draft.players.filter((player) => !alreadyPicked.has(player.id)),
    (player) => nomination.bids[player.id]?.tie || 0
  );

  for (const player of tieBreakerPlayers) {
    records.push({
      playerId: player.id,
      bidKind: "tie",
      bid: nomination.bids[player.id]?.tie || 0,
      cost: nomination.bids[player.id]?.tie || 0
    });
  }

  for (const record of records) {
    const player = getAuctionPlayer(draft, record.playerId);
    player.credits = Math.max(player.credits - record.cost, 0);
  }

  nomination.pickOrder = records;
  nomination.pickCursor = 0;
  nomination.revealedBids = draft.players.map((player) => ({
    playerId: player.id,
    bids: nomination.bids[player.id]
  }));

  if (nomination.isSpeakerOrder && draft.auction.speakerMode === "autopick") {
    nomination.pickOrder = records.map((record, index) => ({
      ...record,
      itemOrder: index + 1
    }));
    draft.auction.lastBidRecap = {
      type: nomination.type,
      isSpeakerOrder: true,
      pickOrder: nomination.pickOrder,
      revealedBids: nomination.revealedBids
    };
    finishAuctionSpeakerOrder(draft, nomination.pickOrder);
    return;
  }

  draft.auction.lastBidRecap = {
    type: nomination.type,
    isSpeakerOrder: Boolean(nomination.isSpeakerOrder),
    pickOrder: nomination.pickOrder,
    revealedBids: nomination.revealedBids
  };

  draft.auction.stage = "picking";
}

function finishAuctionNomination(draft) {
  const nomination = draft.auction.currentNomination;

  if (nomination.isSpeakerOrder) {
    finishAuctionSpeakerOrder(draft, nomination.pickOrder);
    return;
  }

  if (nomination.items.length > 0) {
    draft.auction.permanentBin.push(...nomination.items);
  }

  if (nomination.temporaryBin.length > 0) {
    returnAuctionItems(draft, nomination.type, nomination.temporaryBin);
  }

  draft.auction.nominationsByType[nomination.type] = (draft.auction.nominationsByType[nomination.type] || 0) + 1;
  draft.auction.currentNomination = null;

  if (completeAuctionIfDone(draft)) {
    return;
  }

  draft.auction.speakerIndex = (draft.auction.speakerIndex + 1) % draft.auction.speakerOrder.length;
  draft.auction.stage = "nomination";
}

function startBagPassingDraft(room, pool, method) {
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
    engine: "bag-pass",
    poolId: pool.id,
    methodId: method.id,
    picksPerBag: room.draftSettings.picksPerBag,
    auctionSpeakerMode: cleanAuctionSpeakerMode(room.draftSettings.auctionSpeakerMode),
    typeOrder: cleanTypeOrder(pool, room.draftSettings.typeOrder),
    itemsPerType: room.draftSettings.itemsPerType,
    players,
    discardedItems: []
  };
}

function startNominationAuctionDraft(room, pool, method) {
  const players = createAuctionPlayers(getSeatedParticipants(room));
  const typeOrder = cleanTypeOrder(pool, room.draftSettings.typeOrder);
  const nominationsByType = {};

  for (const type of typeOrder) {
    nominationsByType[type] = 0;
  }

  room.draft = {
    status: "active",
    engine: "auction",
    poolId: pool.id,
    methodId: method.id,
    picksPerBag: room.draftSettings.picksPerBag,
    auctionSpeakerMode: cleanAuctionSpeakerMode(room.draftSettings.auctionSpeakerMode),
    typeOrder,
    itemsPerType: room.draftSettings.itemsPerType,
    players,
    discardedItems: [],
    undoStack: [],
    auction: {
      stage: "speaker_order_bidding",
      speakerMode: cleanAuctionSpeakerMode(room.draftSettings.auctionSpeakerMode),
      speakerOrder: [],
      speakerIndex: 0,
      speakerOrderResults: [],
      nominationsByType,
      itemSources: createAuctionItemSources(pool, room.draftSettings),
      currentNomination: null,
      permanentBin: []
    }
  };

  if (room.draft.auction.speakerMode === "none") {
    startAuctionWithRandomSpeakerOrder(room.draft);
  } else {
    startSpeakerOrderBidding(room.draft);
  }
}

function startDraft(room) {
  const pool = getPool(room.draftSettings.poolId);
  const method = getDraftMethod(room.draftSettings.methodId) || getDefaultDraftMethod();

  if (method.engine === "auction") {
    startNominationAuctionDraft(room, pool, method);
  } else {
    startBagPassingDraft(room, pool, method);
  }
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

  if (!hasRoomAdminRights(room, body)) {
    sendAdminRequired(response);
    return;
  }

  const validationError = validateDraftCanStart(room);

  if (validationError) {
    sendJson(response, 409, { error: validationError });
    return;
  }

  if (body.savePool) {
    const savedPool = saveRoomPoolWithDefaults(room, body.poolName);

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

function handleDraftExport(roomNumber, url, response) {
  const room = rooms.get(roomNumber);

  if (!room) {
    sendJson(response, 404, { error: "room_not_found" });
    return;
  }

  if (!room.draft || !["active", "complete"].includes(room.draft.status)) {
    sendJson(response, 409, { error: "draft_not_exportable" });
    return;
  }

  if (room.draft.status !== "complete" && !hasRoomAdminRights(room, {
    creatorToken: url.searchParams.get("creatorToken"),
    actorId: url.searchParams.get("actorId"),
    viewerId: url.searchParams.get("viewerId"),
    participantId: url.searchParams.get("participantId")
  })) {
    sendAdminRequired(response);
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

  if (!hasRoomAdminRights(room, body)) {
    sendAdminRequired(response);
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

  if (!hasRoomAdminRights(room, body)) {
    sendAdminRequired(response);
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

async function handleParticipantAdmin(roomNumber, request, response) {
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

  if (!hasRoomAdminRights(room, body)) {
    sendAdminRequired(response);
    return;
  }

  const participant = room.participants.get(String(body.participantId || ""));

  if (!participant) {
    sendJson(response, 404, { error: "participant_not_found" });
    return;
  }

  if (isRoomHost(room, participant.id)) {
    participant.admin = false;
    sendJson(response, 409, { error: "host_cannot_be_admin" });
    return;
  }

  participant.admin = Boolean(body.admin);
  broadcastRoom(roomNumber);
  sendJson(response, 200, getRoomSnapshot(roomNumber, body.viewerId || body.actorId));
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

  if (draft.engine === "auction") {
    sendJson(response, 409, { error: "wrong_draft_engine" });
    return;
  }

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

async function readAuctionBody(request, response) {
  try {
    return await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return null;
  }
}

function getActiveAuctionDraft(roomNumber, response) {
  const room = rooms.get(roomNumber);

  if (!room) {
    sendJson(response, 404, { error: "room_not_found" });
    return null;
  }

  if (!room.draft || room.draft.status !== "active") {
    sendJson(response, 409, { error: "draft_not_active" });
    return null;
  }

  if (room.draft.engine !== "auction") {
    sendJson(response, 409, { error: "wrong_draft_engine" });
    return null;
  }

  return { room, draft: room.draft };
}

function sendAuctionSnapshot(roomNumber, room, response, viewerId) {
  broadcastRoom(roomNumber);
  sendJson(response, 200, getRoomSnapshot(roomNumber, viewerId));
}

async function handleAuctionNominate(roomNumber, request, response) {
  const active = getActiveAuctionDraft(roomNumber, response);

  if (!active) {
    return;
  }

  const body = await readAuctionBody(request, response);

  if (!body) {
    return;
  }

  const { room, draft } = active;
  const speaker = getAuctionSpeaker(draft);

  if (!speaker || speaker.id !== body.playerId) {
    sendJson(response, 403, { error: "speaker_required" });
    return;
  }

  if (draft.auction.stage !== "nomination") {
    sendJson(response, 409, { error: "wrong_auction_stage" });
    return;
  }

  const type = String(body.type || "");

  if (!getEligibleNominationTypes(draft).includes(type)) {
    sendJson(response, 400, { error: "invalid_nomination_type" });
    return;
  }

  const drawCount = draft.players.length + 1;

  if (!canDrawAuctionItems(draft, type, drawCount)) {
    sendJson(response, 409, { error: "not_enough_pool_items" });
    return;
  }

  pushAuctionUndo(draft);
  draft.auction.lastBidRecap = null;
  draft.auction.currentNomination = createAuctionNomination(
    type,
    drawAuctionItems(draft, type, drawCount),
    { banCursor: draft.auction.speakerIndex }
  );

  moveAuctionToPostDrawStage(draft);
  sendAuctionSnapshot(roomNumber, room, response, speaker.id);
}

async function handleAuctionMulligan(roomNumber, request, response) {
  const active = getActiveAuctionDraft(roomNumber, response);

  if (!active) {
    return;
  }

  const body = await readAuctionBody(request, response);

  if (!body) {
    return;
  }

  const { room, draft } = active;
  const speaker = getAuctionSpeaker(draft);
  const nomination = draft.auction.currentNomination;

  if (!speaker || speaker.id !== body.playerId) {
    sendJson(response, 403, { error: "speaker_required" });
    return;
  }

  if (draft.auction.stage !== "mulligan" || !nomination) {
    sendJson(response, 409, { error: "wrong_auction_stage" });
    return;
  }

  if (body.mulligan) {
    const drawCount = draft.players.length + 1;

    if (speaker.mulliganTokens <= 0) {
      sendJson(response, 409, { error: "no_mulligan_tokens" });
      return;
    }

    if (!canDrawAuctionItems(draft, nomination.type, drawCount)) {
      sendJson(response, 409, { error: "not_enough_pool_items" });
      return;
    }

    pushAuctionUndo(draft);
    speaker.mulliganTokens -= 1;
    nomination.temporaryBin.push(...nomination.items);
    nomination.items = drawAuctionItems(draft, nomination.type, drawCount);
    moveAuctionToPostDrawStage(draft);
  } else {
    pushAuctionUndo(draft);
    nomination.banCursor = draft.auction.speakerIndex;
    nomination.banDeclines = [];
    advanceAuctionBanWindow(draft);
  }

  sendAuctionSnapshot(roomNumber, room, response, speaker.id);
}

async function handleAuctionWildcard(roomNumber, request, response) {
  const active = getActiveAuctionDraft(roomNumber, response);

  if (!active) {
    return;
  }

  const body = await readAuctionBody(request, response);

  if (!body) {
    return;
  }

  const { room, draft } = active;
  const speaker = getAuctionSpeaker(draft);
  const nomination = draft.auction.currentNomination;

  if (!speaker || speaker.id !== body.playerId) {
    sendJson(response, 403, { error: "speaker_required" });
    return;
  }

  if (draft.auction.stage !== "wildcard" || !nomination) {
    sendJson(response, 409, { error: "wrong_auction_stage" });
    return;
  }

  const wildcardIndex = nomination.items.findIndex(isWildcardItem);

  if (wildcardIndex < 0) {
    sendJson(response, 409, { error: "no_wildcard_pending" });
    return;
  }

  const itemId = String(body.itemId || "");
  const source = draft.auction.itemSources[nomination.type] || [];
  const choiceIndex = source.findIndex((item) => item.id === itemId && !isWildcardItem(item));

  if (choiceIndex < 0) {
    sendJson(response, 400, { error: "invalid_wildcard_choice" });
    return;
  }

  pushAuctionUndo(draft);
  const wildcardItem = nomination.items[wildcardIndex];
  const [chosenItem] = source.splice(choiceIndex, 1);
  draft.discardedItems.push(wildcardItem);
  nomination.items.splice(wildcardIndex, 1, chosenItem);
  moveAuctionToPostDrawStage(draft);
  sendAuctionSnapshot(roomNumber, room, response, speaker.id);
}

async function handleAuctionBan(roomNumber, request, response) {
  const active = getActiveAuctionDraft(roomNumber, response);

  if (!active) {
    return;
  }

  const body = await readAuctionBody(request, response);

  if (!body) {
    return;
  }

  const { room, draft } = active;
  const nomination = draft.auction.currentNomination;
  const player = getAuctionPlayer(draft, body.playerId);

  if (!player) {
    sendJson(response, 403, { error: "player_not_in_draft" });
    return;
  }

  if (draft.auction.stage !== "ban" || !nomination || nomination.banPlayerId !== player.id) {
    sendJson(response, 409, { error: "wrong_auction_stage" });
    return;
  }

  const itemId = body.itemId ? String(body.itemId) : null;

  if (itemId) {
    if (player.banTokens <= 0) {
      sendJson(response, 409, { error: "no_ban_tokens" });
      return;
    }

    if (!canDrawAuctionItems(draft, nomination.type, 1)) {
      sendJson(response, 409, { error: "no_replacement_available" });
      return;
    }

    const itemIndex = nomination.items.findIndex((item) => item.id === itemId);

    if (itemIndex < 0) {
      sendJson(response, 400, { error: "item_not_in_nomination" });
      return;
    }

    pushAuctionUndo(draft);
    const [bannedItem] = nomination.items.splice(itemIndex, 1);
    draft.auction.permanentBin.push(bannedItem);
    nomination.items.push(...drawAuctionItems(draft, nomination.type, 1));
    player.banTokens -= 1;
    moveAuctionToPostDrawStage(draft);
    sendAuctionSnapshot(roomNumber, room, response, player.id);
    return;
  } else {
    pushAuctionUndo(draft);

    if (!nomination.banDeclines.includes(player.id)) {
      nomination.banDeclines.push(player.id);
    }
  }

  advanceAuctionBanWindow(draft);
  sendAuctionSnapshot(roomNumber, room, response, player.id);
}

async function handleAuctionNoBanPreset(roomNumber, request, response) {
  const active = getActiveAuctionDraft(roomNumber, response);

  if (!active) {
    return;
  }

  const body = await readAuctionBody(request, response);

  if (!body) {
    return;
  }

  const { room, draft } = active;
  const player = getAuctionPlayer(draft, body.playerId);

  if (!player) {
    sendJson(response, 403, { error: "player_not_in_draft" });
    return;
  }

  player.noBanPreset = Boolean(body.noBanPreset);

  if (player.noBanPreset && draft.auction.stage === "ban" && draft.auction.currentNomination?.banPlayerId === player.id) {
    const nomination = draft.auction.currentNomination;

    if (!nomination.banDeclines.includes(player.id)) {
      nomination.banDeclines.push(player.id);
    }

    advanceAuctionBanWindow(draft);
  }

  sendAuctionSnapshot(roomNumber, room, response, player.id);
}

async function handleAuctionUndo(roomNumber, request, response) {
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

  if (!hasRoomAdminRights(room, body)) {
    sendAdminRequired(response);
    return;
  }

  if (!room.draft || room.draft.engine !== "auction") {
    sendJson(response, 409, { error: "wrong_draft_engine" });
    return;
  }

  const undoStack = Array.isArray(room.draft.undoStack) ? room.draft.undoStack : [];
  const previousDraft = undoStack.pop();

  if (!previousDraft) {
    sendJson(response, 409, { error: "nothing_to_undo" });
    return;
  }

  const restoredDraft = hydrateAuctionUndoDraft(previousDraft);

  if (!restoredDraft) {
    sendJson(response, 409, { error: "undo_source_unavailable" });
    return;
  }

  room.draft = {
    ...restoredDraft,
    undoStack
  };
  broadcastRoom(roomNumber);
  sendJson(response, 200, getRoomSnapshot(roomNumber, body.viewerId || body.actorId || body.participantId));
}

async function handleAuctionShufflePool(roomNumber, request, response) {
  const active = getActiveAuctionDraft(roomNumber, response);

  if (!active) {
    return;
  }

  let body;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  const { room, draft } = active;

  if (!hasRoomAdminRights(room, body)) {
    sendAdminRequired(response);
    return;
  }

  pushAuctionUndo(draft);
  shuffleAuctionItemSources(draft);
  sendAuctionSnapshot(roomNumber, room, response, body.viewerId || body.actorId || body.participantId);
}

async function handleAuctionBid(roomNumber, request, response) {
  const active = getActiveAuctionDraft(roomNumber, response);

  if (!active) {
    return;
  }

  const body = await readAuctionBody(request, response);

  if (!body) {
    return;
  }

  const { room, draft } = active;
  const nomination = draft.auction.currentNomination;
  const player = getAuctionPlayer(draft, body.playerId);

  if (!player) {
    sendJson(response, 403, { error: "player_not_in_draft" });
    return;
  }

  if (!["speaker_order_bidding", "bidding"].includes(draft.auction.stage) || !nomination) {
    sendJson(response, 409, { error: "wrong_auction_stage" });
    return;
  }

  if (player.auctionBidLocked) {
    sendJson(response, 409, { error: "bid_already_locked" });
    return;
  }

  const first = cleanNonnegativeInteger(body.first, player.credits);
  const second = draft.players.length >= 5
    ? cleanNonnegativeInteger(body.second, player.credits)
    : 0;
  const tie = cleanNonnegativeInteger(body.tie, player.credits);

  if (first === null || second === null || tie === null) {
    sendJson(response, 400, { error: "invalid_bid" });
    return;
  }

  const bids = { first, second, tie };
  pushAuctionUndo(draft);
  player.currentBids = bids;
  player.auctionBidLocked = true;
  nomination.bids[player.id] = bids;

  if (draft.players.every((candidate) => candidate.auctionBidLocked)) {
    resolveAuctionBids(draft);
  }

  sendAuctionSnapshot(roomNumber, room, response, player.id);
}

async function handleAuctionPick(roomNumber, request, response) {
  const active = getActiveAuctionDraft(roomNumber, response);

  if (!active) {
    return;
  }

  const body = await readAuctionBody(request, response);

  if (!body) {
    return;
  }

  const { room, draft } = active;
  const nomination = draft.auction.currentNomination;
  const pickRecord = nomination?.pickOrder?.[nomination.pickCursor];
  const player = getAuctionPlayer(draft, body.playerId);

  if (!player) {
    sendJson(response, 403, { error: "player_not_in_draft" });
    return;
  }

  if (draft.auction.stage !== "picking" || !nomination || !pickRecord || pickRecord.playerId !== player.id) {
    sendJson(response, 409, { error: "wrong_auction_stage" });
    return;
  }

  const itemId = String(body.itemId || "");
  const itemIndex = nomination.items.findIndex((item) => item.id === itemId);

  if (itemIndex < 0) {
    sendJson(response, 400, { error: "item_not_in_nomination" });
    return;
  }

  pushAuctionUndo(draft);
  const [item] = nomination.items.splice(itemIndex, 1);
  player.draftedItems.push(item);
  player.draftedGroups.push({
    id: crypto.randomUUID(),
    pickNumber: player.draftedGroups.length + 1,
    label: `${nomination.isSpeakerOrder ? "Speaker order" : nomination.type} - ${pickRecord.bidKind} pick`,
    nominationType: nomination.type,
    cost: pickRecord.cost,
    bidKind: pickRecord.bidKind,
    items: [item]
  });
  pickRecord.itemId = item.id;
  pickRecord.itemName = item.name;
  pickRecord.itemOrder = item.order || null;
  nomination.pickCursor += 1;

  if (nomination.pickCursor >= nomination.pickOrder.length) {
    finishAuctionNomination(draft);
  }

  sendAuctionSnapshot(roomNumber, room, response, player.id);
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

  const saveRoomPoolMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})\/pool\/save$/);

  if (saveRoomPoolMatch && request.method === "POST") {
    await handleSaveRoomPool(saveRoomPoolMatch[1], request, response);
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

  const auctionActionMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})\/draft\/auction\/([a-z-]+)$/);

  if (auctionActionMatch && request.method === "POST") {
    const [, roomNumber, action] = auctionActionMatch;

    if (action === "nominate") {
      await handleAuctionNominate(roomNumber, request, response);
      return;
    }

    if (action === "mulligan") {
      await handleAuctionMulligan(roomNumber, request, response);
      return;
    }

    if (action === "wildcard") {
      await handleAuctionWildcard(roomNumber, request, response);
      return;
    }

    if (action === "ban") {
      await handleAuctionBan(roomNumber, request, response);
      return;
    }

    if (action === "no-ban-preset") {
      await handleAuctionNoBanPreset(roomNumber, request, response);
      return;
    }

    if (action === "undo") {
      await handleAuctionUndo(roomNumber, request, response);
      return;
    }

    if (action === "shuffle-pool") {
      await handleAuctionShufflePool(roomNumber, request, response);
      return;
    }

    if (action === "bid") {
      await handleAuctionBid(roomNumber, request, response);
      return;
    }

    if (action === "pick") {
      await handleAuctionPick(roomNumber, request, response);
      return;
    }

    sendJson(response, 404, { error: "auction_action_not_found" });
    return;
  }

  const exportDraftMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})\/draft\/export$/);

  if (exportDraftMatch && request.method === "GET") {
    handleDraftExport(exportDraftMatch[1], url, response);
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

  const participantAdminMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})\/participants\/admin$/);

  if (participantAdminMatch && request.method === "POST") {
    await handleParticipantAdmin(participantAdminMatch[1], request, response);
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

const roomCleanupInterval = setInterval(cleanupIdleRooms, roomCleanupIntervalMs);
roomCleanupInterval.unref?.();

server.listen(port, () => {
  console.log(`${serviceName} listening on http://0.0.0.0:${port}`);
});
