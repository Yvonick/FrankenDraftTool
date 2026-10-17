function createPoolRegistry({ initialPools = [], assetOverrides = {}, onChange = () => {} } = {}) {
function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const speakerOrderType = "Speaker Order";
const defaultAuctionSpeakerMode = "bid-and-pick";
const auctionSpeakerModes = new Set(["none", "autopick", "bid-and-pick"]);
const systemTileMeshUrls = new Set([
  "https://steamusercontent-a.akamaihd.net/ugc/1495712136739988324/528952D008E642AAC461C7B53CFD1CBE16C62F15/",
  "https://steamusercontent-a.akamaihd.net/ugc/1499090116261708296/E6C28AF3C9C63950CA6BE177DB5AC6E4A6EA8575/"
]);

function isSpeakerOrderType(type) {
  return /speaker\s*order/i.test(String(type || ""));
}

function normalizeSteamAssetUrl(url) {
  let parsedUrl;

  try {
    parsedUrl = new URL(url);
  } catch (error) {
    return url;
  }

  if (/^cloud-\d+\.steamusercontent\.com$/i.test(parsedUrl.hostname) && parsedUrl.pathname.startsWith("/ugc/")) {
    parsedUrl.protocol = "https:";
    parsedUrl.hostname = "steamusercontent-a.akamaihd.net";
    return parsedUrl.toString();
  }

  if (parsedUrl.protocol === "http:" && /^steamusercontent-a\.akamaihd\.net$/i.test(parsedUrl.hostname)) {
    parsedUrl.protocol = "https:";
    return parsedUrl.toString();
  }

  return url;
}

function resolveAssetUrl(url) {
  if (!url) {
    return null;
  }

  const normalizedUrl = normalizeSteamAssetUrl(url);

  return assetOverrides[url] || assetOverrides[normalizedUrl] || normalizedUrl;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function shouldCropSystemTileTexture(type, item) {
  if (item?.Name !== "Custom_Model" || !item.CustomMesh?.DiffuseURL) {
    return false;
  }

  const meshUrl = resolveAssetUrl(item.CustomMesh.MeshURL);
  const systemTileType = /(?:planet|anomaly|home\s*systems?|system|tiles?\b)/i.test(type);

  return systemTileType || systemTileMeshUrls.has(meshUrl);
}

function getSystemTileImageSheet(type, item) {
  return shouldCropSystemTileTexture(type, item)
    ? { columns: 2, rows: 1, index: 0 }
    : null;
}

function shouldIncludeImageOptionalItem(type) {
  return /speaker\s*order\s*choice/i.test(type);
}

function objectDisplayName(item) {
  return String(item?.Nickname || item?.Description || item?.Name || "").trim();
}

function normalizeReferenceName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isNonDraftBagName(name) {
  return /non[-\s]*draft/i.test(String(name || ""));
}

function isBaseUnitBagName(name) {
  return /base\s*units?/i.test(String(name || ""));
}

function getDeckForCard(item) {
  const customDeck = item.CustomDeck || {};
  const deckId = item.CardID === undefined ? null : String(Math.floor(Number(item.CardID) / 100));

  return customDeck[deckId] || Object.values(customDeck)[0] || null;
}

function getImageData(item) {
  if (item.CustomImage?.ImageURL) {
    return {
      imageUrl: item.CustomImage.ImageURL,
      imageSecondaryUrl: item.CustomImage.ImageSecondaryURL || null,
      imageSheet: null
    };
  }

  if (item.CustomMesh?.DiffuseURL) {
    return {
      imageUrl: item.CustomMesh.DiffuseURL,
      imageSecondaryUrl: null,
      imageSheet: null
    };
  }

  const deck = getDeckForCard(item);

  if (deck?.FaceURL) {
    const columns = Number(deck.NumWidth || 1);
    const rows = Number(deck.NumHeight || 1);
    const cardIndex = Number(item.CardID || 0) % 100;

    return {
      imageUrl: deck.FaceURL,
      imageSecondaryUrl: deck.BackURL || null,
      imageSheet: columns > 1 || rows > 1 ? {
        columns,
        rows,
        index: cardIndex
      } : null
    };
  }

  return {
    imageUrl: null,
    imageSecondaryUrl: null,
    imageSheet: null
  };
}

function getBackImageData(type, item) {
  if (shouldCropSystemTileTexture(type, item)) {
    return { imageSecondaryUrl: resolveAssetUrl(item.CustomMesh.DiffuseURL),
      imageSecondarySheet: { columns: 2, rows: 1, index: 1 } };
  }
  const image = getImageData(item);
  const deck = getDeckForCard(item);
  return { imageSecondaryUrl: resolveAssetUrl(image.imageSecondaryUrl),
    imageSecondarySheet: deck?.UniqueBack && image.imageSecondaryUrl ? image.imageSheet : null };
}

function extractTtsItem(item, type, poolId, index, options = {}) {
  const image = getImageData(item);

  if (!image.imageUrl && !shouldIncludeImageOptionalItem(type) && !options.allowMissingImage) {
    return null;
  }

  const typeSlug = options.idPrefix || slugify(type);
  const name = objectDisplayName(item) || `${type} ${index + 1}`;

  return {
    id: `${poolId}-${typeSlug}-${String(index + 1).padStart(3, "0")}`,
    name,
    content: item.Description || "",
    type,
    imageUrl: resolveAssetUrl(image.imageUrl),
    ...getBackImageData(type, item),
    imageSheet: getSystemTileImageSheet(type, item) || image.imageSheet,
    sourceObjectType: item.Name || "Unknown",
    ...(options.previewOnly ? {} : { ttsObject: cloneJson(item) })
  };
}

function extractLinkedComponent(item, poolId, counter, previewOnly = false) {
  const parsed = extractTtsItem(item, "Non-draft", poolId, counter.value++, {
    allowMissingImage: true,
    idPrefix: "non-draft",
    previewOnly
  });
  if (item.ContainedObjects?.length) {
    // Keep each container intact for export; only lightweight child metadata is
    // needed to preview its contents, not another copy of every raw TTS object.
    parsed.containedItems = item.ContainedObjects.map(child => extractLinkedComponent(child, poolId, counter, true));
  }
  return parsed;
}

function createLinkedItemIndex(root, poolId) {
  const index = new Map();
  const counter = { value: 0 };

  for (const bag of root.ContainedObjects || []) {
    if (!isNonDraftBagName(bag.Nickname) || bag.Name !== "Bag" || !Array.isArray(bag.ContainedObjects)) {
      continue;
    }

    for (const linkedBag of bag.ContainedObjects) {
      const key = normalizeReferenceName(linkedBag.Nickname);
      if (linkedBag.Name !== "Bag" || !key || !Array.isArray(linkedBag.ContainedObjects)) continue;
      if (!index.has(key)) index.set(key, { name: linkedBag.Nickname.trim(), items: [] });
      index.get(key).items.push(...linkedBag.ContainedObjects.map(item => extractLinkedComponent(item, poolId, counter)));
    }
  }

  return index;
}

function getLinkedItemsForTtsItem(item, linkedItemIndex) {
  return linkedItemIndex.get(normalizeReferenceName(item.Nickname))?.items || [];
}

function createBaseUnitIndex(root, poolId) {
  const index = new Map();
  let nextId = 0;
  function visit(item) {
    const key = normalizeReferenceName(item.Nickname);
    if (/\s+i$/.test(key)) {
      const parsed = extractTtsItem(item, "Base Unit", poolId, nextId++, { allowMissingImage: true });
      // Duplicate names may be different variants. Do not guess which one belongs
      // to an upgrade; an explicit Non-draft parts bag can resolve that ambiguity.
      index.set(key, index.has(key) ? null : parsed);
    } else {
      for (const child of item.ContainedObjects || []) visit(child);
    }
  }
  for (const bag of root.ContainedObjects || []) {
    if (bag.Name === "Bag" && isBaseUnitBagName(bag.Nickname)) {
      for (const item of bag.ContainedObjects || []) visit(item);
    }
  }
  return index;
}

function appendBaseUnitLink(item, linkedItems, baseUnits) {
  const name = normalizeReferenceName(item.Nickname);
  if (!/\s+ii$/.test(name)) return linkedItems;
  const baseName = name.slice(0, -1);
  const base = baseUnits.get(baseName);
  const alreadyLinked = items => items.some(link =>
    normalizeReferenceName(link.name) === baseName || alreadyLinked(link.containedItems || []));
  return base && !alreadyLinked(linkedItems) ? [...linkedItems, base] : linkedItems;
}

function getExportBagColors(root) {
  const color = object => {
    const value = object?.ColorDiffuse;
    return value && [value.r, value.g, value.b].every(Number.isFinite) ? cloneJson(value) : null;
  };
  return {
    root: color(root),
    types: Object.fromEntries((root.ContainedObjects || []).filter(shouldUseTtsBag)
      .map(bag => [bag.Nickname || bag.Name, color(bag)]).filter(([, value]) => value))
  };
}

function restorePoolSourceMetadata(pool, rawJson) {
  const root = rawJson?.ObjectStates?.[0];
  if (!Array.isArray(root?.ContainedObjects)) return null;
  const objectKey = (type, item) => JSON.stringify([type, item]);
  const originals = new Set(root.ContainedObjects.filter(shouldUseTtsBag).flatMap(bag =>
    bag.ContainedObjects.map(item => objectKey(bag.Nickname || bag.Name, item))));
  // Only repair from a source containing the exact existing draftable objects.
  // This cannot replace their contents, IDs, order, or explicit linked parts.
  if (!pool.items.every(item => item.ttsObject && originals.has(objectKey(item.type, item.ttsObject)))) return null;
  const baseUnits = createBaseUnitIndex(root, pool.id);
  return { ...pool, exportBagColors: getExportBagColors(root), items: pool.items.map(item => ({
    ...item, linkedItems: appendBaseUnitLink(item.ttsObject, item.linkedItems || [], baseUnits)
  })) };
}

function shouldUseTtsBag(bag) {
  const name = bag.Nickname || bag.Name || "";

  return bag.Name === "Bag"
    && Array.isArray(bag.ContainedObjects)
    && bag.ContainedObjects.length > 0
    && !isNonDraftBagName(name)
    && !isBaseUnitBagName(name);
}

function parseTtsPool(rawJson, fallbackName) {
  const root = rawJson?.ObjectStates?.[0];

  if (!Array.isArray(root?.ContainedObjects)) {
    return null;
  }

  const poolName = root.Nickname || fallbackName;
  const poolId = slugify(poolName || fallbackName);
  const types = [];
  const items = [];
  const linkedItemIndex = createLinkedItemIndex(root, poolId);
  const baseUnits = createBaseUnitIndex(root, poolId);

  for (const bag of root.ContainedObjects.filter(shouldUseTtsBag)) {
    const type = bag.Nickname || bag.Name;

    if (isSpeakerOrderType(type)) {
      continue;
    }

    const parsedItems = bag.ContainedObjects
      .map((item, index) => {
        const parsed = extractTtsItem(item, type, poolId, index);

        if (!parsed) {
          return null;
        }

        return {
          ...parsed,
          linkedItems: appendBaseUnitLink(item, getLinkedItemsForTtsItem(item, linkedItemIndex), baseUnits)
        };
      })
      .filter(Boolean);

    if (parsedItems.length === 0) {
      continue;
    }

    types.push(type);
    items.push(...parsedItems);
  }

  if (types.length === 0 || items.length === 0) {
    return null;
  }

  const draftableNames = new Set(items.map(item => normalizeReferenceName(item.ttsObject.Nickname)));
  return {
    id: poolId,
    name: poolName,
    source: "tts",
    types,
    items,
    exportBagColors: getExportBagColors(root),
    unmatchedLinkedBags: [...linkedItemIndex].filter(([key]) => !draftableNames.has(key)).map(([, bag]) => bag.name)
  };
}

function normalizePoolTypes(types = []) {
  const contentTypes = [];

  for (const type of Array.isArray(types) ? types : []) {
    if (!type || isSpeakerOrderType(type) || contentTypes.includes(type)) {
      continue;
    }

    contentTypes.push(type);
  }

  return [...contentTypes, speakerOrderType];
}

function normalizePoolItem(item) {
  if (!item) {
    return item;
  }

  const imageSheet = getSystemTileImageSheet(item.type, item.ttsObject) || item.imageSheet || null;
  const linkedItems = Array.isArray(item.linkedItems)
    ? item.linkedItems.map(normalizePoolItem)
    : item.linkedItems;

  return {
    ...item,
    ...(item.ttsObject ? getBackImageData(item.type, item.ttsObject) : {
      imageSecondaryUrl: resolveAssetUrl(item.imageSecondaryUrl), imageSecondarySheet: item.imageSecondarySheet || null
    }),
    imageSheet,
    linkedItems,
    ...(item.containedItems?.length ? { containedItems: item.containedItems.map(normalizePoolItem) } : {})
  };
}

function normalizePoolItems(items = []) {
  return Array.isArray(items)
    ? items
      .filter((item) => item && !isSpeakerOrderType(item.type))
      .map(normalizePoolItem)
    : [];
}

function normalizePoolShape(pool) {
  return {
    ...pool,
    types: normalizePoolTypes(pool.types),
    items: normalizePoolItems(pool.items)
  };
}

function clonePoolWithId(pool, id) {
  if (pool.id === id) {
    return pool;
  }

  return {
    ...pool,
    id,
    items: pool.items.map((item) => ({
      ...item,
      id: item.id.startsWith(`${pool.id}-`)
        ? `${id}-${item.id.slice(pool.id.length + 1)}`
        : `${id}-${item.id}`
    }))
  };
}

function cleanPoolName(name, fallback) {
  const cleaned = String(name || "").trim().replace(/\s+/g, " ").slice(0, 80);
  return cleaned || fallback || "Untitled Pool";
}

function normalizeDefaultParameters(pool, parameters = {}) {
  const poolTypes = normalizePoolTypes(pool.types);
  const parsedMaxSeats = Number(parameters.maxSeats);
  const maxSeats = Number.isInteger(parsedMaxSeats)
    ? Math.min(Math.max(parsedMaxSeats, 1), 12)
    : 6;
  const parsedPicksPerBag = Number(parameters.picksPerBag);
  const picksPerBag = Number.isInteger(parsedPicksPerBag)
    ? Math.min(Math.max(parsedPicksPerBag, 1), 8)
    : 3;
  const auctionSpeakerMode = auctionSpeakerModes.has(parameters.auctionSpeakerMode)
    ? parameters.auctionSpeakerMode
    : defaultAuctionSpeakerMode;
  const requestedTypeOrder = Array.isArray(parameters.typeOrder)
    ? parameters.typeOrder.map((type) => (isSpeakerOrderType(type) ? speakerOrderType : type))
    : [];
  const typeOrder = [
    ...requestedTypeOrder.filter((type, index) => (
      poolTypes.includes(type) && requestedTypeOrder.indexOf(type) === index
    )),
    ...poolTypes.filter((type) => !requestedTypeOrder.includes(type))
  ];
  const sourceItemsPerType = parameters.itemsPerType || {};
  const itemsPerType = Object.fromEntries(poolTypes.map((type) => {
    const parsed = Number(sourceItemsPerType[type]);
    const maxValue = isSpeakerOrderType(type) ? 1 : 10;
    const value = Number.isInteger(parsed)
      ? Math.min(Math.max(parsed, 0), maxValue)
      : (isSpeakerOrderType(type) ? 1 : 2);

    return [type, value];
  }));

  return {
    maxSeats,
    picksPerBag,
    auctionSpeakerMode,
    typeOrder,
    itemsPerType
  };
}

function withPoolMetadata(pool, options = {}) {
  const normalizedPool = normalizePoolShape(pool);

  return {
    ...normalizedPool,
    name: cleanPoolName(options.name || normalizedPool.name, normalizedPool.name),
    public: options.public ?? Boolean(normalizedPool.public),
    defaultParameters: normalizeDefaultParameters(normalizedPool, options.defaultParameters || normalizedPool.defaultParameters)
  };
}

function serializePool(pool) {
  const normalizedPool = normalizePoolShape(pool);

  return {
    id: normalizedPool.id,
    name: normalizedPool.name,
    source: normalizedPool.source,
    updatedAt: normalizedPool.updatedAt || 0,
    public: Boolean(pool.public),
    types: normalizedPool.types,
    items: normalizedPool.items,
    ...(normalizedPool.exportBagColors ? { exportBagColors: cloneJson(normalizedPool.exportBagColors) } : {}),
    unmatchedLinkedBags: normalizedPool.unmatchedLinkedBags || [],
    defaultParameters: normalizeDefaultParameters(normalizedPool, pool.defaultParameters)
  };
}

const draftPools = new Map(initialPools.map((pool) => [pool.id,
  pool.items?.some((item) => item.imageSecondarySheet === undefined)
    ? { ...pool, items: normalizePoolItems(pool.items) } : pool
]));
const changes = new Map();
function persistPublicPools() { onChange([...draftPools.values()]); return true; }

function getPool(poolId) {
  return draftPools.get(poolId) || null;
}

function listPublicPools() {
  return [...draftPools.values()].filter((pool) => pool.public)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getDefaultPublicPool() {
  return listPublicPools()[0] || null;
}

function uniquePoolId(baseId) {
  const base = slugify(baseId) || "uploaded-pool";

  if (!draftPools.has(base)) {
    return base;
  }

  let suffix = 2;

  while (draftPools.has(`${base}-${suffix}`)) {
    suffix += 1;
  }

  return `${base}-${suffix}`;
}

function registerUploadedTtsPool(rawJson, fallbackName, options = {}) {
  const parsedPool = parseTtsPool(rawJson, fallbackName);

  if (!parsedPool) {
    return null;
  }

  const pool = {
    ...withPoolMetadata(clonePoolWithId(parsedPool, uniquePoolId(parsedPool.id)), {
      name: options.name,
      public: Boolean(options.public),
      defaultParameters: options.defaultParameters
    }),
    source: options.public ? "tts-saved" : "tts-upload",
    updatedAt: Date.now(),
    public: Boolean(options.public)
  };

  draftPools.set(pool.id, pool);
  changes.set(pool.id, pool);

  if (pool.public) {
    persistPublicPools();
  }

  return pool;
}

function replacePublicTtsPool(poolId, rawJson) {
  const previous = getPool(poolId);
  if (!previous?.public) return null;
  const parsed = parseTtsPool(rawJson, previous.name);
  if (!parsed) return null;
  const replacement = {
    ...withPoolMetadata(clonePoolWithId(parsed, previous.id), {
      name: previous.name,
      public: true,
      defaultParameters: previous.defaultParameters
    }),
    source: "tts-saved",
    updatedAt: Date.now()
  };
  draftPools.set(poolId, replacement);
  changes.set(poolId, replacement);
  persistPublicPools();
  return replacement;
}

function savePool(poolId, options = {}) {
  const existing = getPool(poolId);
  const sourceJson = options.sourceJson === undefined ? options.baseUnitSource : options.sourceJson;
  const pool = existing && sourceJson !== undefined
    ? restorePoolSourceMetadata(existing, sourceJson) : existing;

  if (!pool) {
    return null;
  }

  const savedPool = {
    ...withPoolMetadata(pool, {
      name: cleanPoolName(options.name, pool.name),
      defaultParameters: options.defaultParameters || pool.defaultParameters,
      public: true
    }),
    source: pool.source === "tts-upload" ? "tts-saved" : pool.source,
    updatedAt: Date.now(),
    public: true
  };

  draftPools.set(savedPool.id, savedPool);
  changes.set(savedPool.id, savedPool);
  persistPublicPools();
  return savedPool;
}

function updatePublicPool(poolId, options = {}) {
  const pool = getPool(poolId);

  if (!pool || !pool.public) {
    return null;
  }

  return savePool(poolId, {
    name: options.name === undefined ? pool.name : options.name,
    baseUnitSource: options.baseUnitSource,
    sourceJson: options.sourceJson,
    defaultParameters: options.defaultParameters || pool.defaultParameters
  });
}

function removePublicPool(poolId) {
  const pool = getPool(poolId);

  if (!pool || !pool.public) {
    return false;
  }

  draftPools.delete(pool.id);
  changes.set(pool.id, null);
  persistPublicPools();
  return true;
}

function getPoolSummary(pool) {
  if (pool.__summary) return pool.__summary;
  const defaultParameters = normalizeDefaultParameters(pool, pool.defaultParameters);

  return {
    id: pool.id,
    name: pool.name,
    source: pool.source || "generated",
    updatedAt: pool.updatedAt || 0,
    public: Boolean(pool.public),
    unmatchedLinkedBags: pool.unmatchedLinkedBags || [],
    itemTypes: defaultParameters.typeOrder.map((type) => ({
      type,
      itemCount: isSpeakerOrderType(type)
        ? (defaultParameters.itemsPerType[type] ? defaultParameters.maxSeats : 0)
        : pool.items.filter((item) => item.type === type).length,
      isMeta: isSpeakerOrderType(type),
      maxPerBag: isSpeakerOrderType(type) ? 1 : 10
    })),
    defaultParameters
  };
}

return {
  draftPools, changes, withPoolMetadata, serializePool,
  getDefaultPublicPool,
  getPool,
  getPoolSummary,
  isSpeakerOrderType,
  listPublicPools,
  normalizeDefaultParameters,
  parseTtsPool,
  registerUploadedTtsPool,
  replacePublicTtsPool,
  removePublicPool,
  savePool,
  speakerOrderType,
  updatePublicPool
};

}
module.exports = { createPoolRegistry };
