const fs = require("node:fs");
const path = require("node:path");

const poolStorePath = process.env.POOL_STORE_PATH
  || path.join(__dirname, "data", "public-pools.json");

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function loadAssetOverrides() {
  const overridesDir = path.join(__dirname, "pools", "asset-overrides");

  if (!fs.existsSync(overridesDir)) {
    return {};
  }

  return fs.readdirSync(overridesDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .reduce((overrides, fileName) => {
      const filePath = path.join(overridesDir, fileName);
      return {
        ...overrides,
        ...JSON.parse(fs.readFileSync(filePath, "utf8"))
      };
    }, {});
}

const assetOverrides = loadAssetOverrides();
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

function shouldKeepSecondaryImage(type) {
  return !/(?:planet|anomaly|home\s*systems?)/i.test(type);
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
    imageSecondaryUrl: shouldKeepSecondaryImage(type) ? resolveAssetUrl(image.imageSecondaryUrl) : null,
    imageSheet: getSystemTileImageSheet(type, item) || image.imageSheet,
    sourceObjectType: item.Name || "Unknown",
    ttsObject: cloneJson(item)
  };
}

function parseLinkedItemReferences(description) {
  const references = [];
  const pattern = /(?:^|\n)\s*(Non-draft|Base Unit)\s*:\s*([^\n]+)/gi;
  let match;

  while ((match = pattern.exec(description || "")) !== null) {
    const kind = /^non/i.test(match[1]) ? "nonDraft" : "baseUnit";
    const names = match[2]
      .split(/[,;]/)
      .map((name) => name.trim())
      .filter(Boolean);

    for (const name of names) {
      references.push({ kind, name });
    }
  }

  return references;
}

function addLinkedItemToIndex(index, kind, poolId, item, counter) {
  const name = objectDisplayName(item);

  if (!name) {
    return counter;
  }

  const parsed = extractTtsItem(item, kind === "baseUnit" ? "Base Unit" : "Non-draft", poolId, counter, {
    allowMissingImage: true,
    idPrefix: kind === "baseUnit" ? "base-unit" : "non-draft"
  });

  if (!parsed) {
    return counter;
  }

  const key = normalizeReferenceName(name);

  if (!index[kind].has(key)) {
    index[kind].set(key, []);
  }

  index[kind].get(key).push(parsed);
  return counter + 1;
}

function collectLinkedItems(item, index, kind, poolId, counter) {
  let nextCounter = addLinkedItemToIndex(index, kind, poolId, item, counter);

  for (const child of item.ContainedObjects || []) {
    nextCounter = collectLinkedItems(child, index, kind, poolId, nextCounter);
  }

  return nextCounter;
}

function createLinkedItemIndex(root, poolId) {
  const index = {
    nonDraft: new Map(),
    baseUnit: new Map()
  };
  let counter = 1;

  for (const bag of root.ContainedObjects || []) {
    const name = bag.Nickname || bag.Name || "";
    const kind = isNonDraftBagName(name)
      ? "nonDraft"
      : (isBaseUnitBagName(name) ? "baseUnit" : null);

    if (!kind || bag.Name !== "Bag" || !Array.isArray(bag.ContainedObjects)) {
      continue;
    }

    for (const item of bag.ContainedObjects) {
      counter = collectLinkedItems(item, index, kind, poolId, counter);
    }
  }

  return index;
}

function getLinkedItemsForTtsItem(item, linkedItemIndex) {
  const linkedItems = [];
  const seenIds = new Set();

  for (const reference of parseLinkedItemReferences(item.Description || "")) {
    const matches = linkedItemIndex[reference.kind].get(normalizeReferenceName(reference.name)) || [];

    for (const match of matches) {
      if (seenIds.has(match.id)) {
        continue;
      }

      seenIds.add(match.id);
      linkedItems.push(match);
    }
  }

  return linkedItems;
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
  const root = rawJson.ObjectStates?.[0];

  if (!root?.ContainedObjects) {
    return null;
  }

  const poolName = root.Nickname || fallbackName;
  const poolId = slugify(poolName || fallbackName);
  const types = [];
  const items = [];
  const linkedItemIndex = createLinkedItemIndex(root, poolId);

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
          linkedItems: getLinkedItemsForTtsItem(item, linkedItemIndex)
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

  return {
    id: poolId,
    name: poolName,
    source: "tts",
    types,
    items
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
    imageSheet,
    linkedItems
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
    : 2;
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
      : 1;

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
    public: Boolean(pool.public),
    types: normalizedPool.types,
    items: normalizedPool.items,
    defaultParameters: normalizeDefaultParameters(normalizedPool, pool.defaultParameters)
  };
}

function loadStoredPublicPools() {
  if (!fs.existsSync(poolStorePath)) {
    return null;
  }

  try {
    const stored = JSON.parse(fs.readFileSync(poolStorePath, "utf8"));
    const storedPools = Array.isArray(stored) ? stored : stored.pools;

    if (!Array.isArray(storedPools)) {
      return null;
    }

    return storedPools
      .filter((pool) => pool?.id && Array.isArray(pool.types) && Array.isArray(pool.items))
      .map((pool) => withPoolMetadata(pool, {
        public: true,
        defaultParameters: pool.defaultParameters
      }));
  } catch (error) {
    console.warn(`Could not load public pool store at ${poolStorePath}: ${error.message}`);
    return null;
  }
}

function persistPublicPools() {
  const publicPools = listPublicPools().map(serializePool);
  const directory = path.dirname(poolStorePath);
  const temporaryPath = `${poolStorePath}.${process.pid}.tmp`;

  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporaryPath, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      pools: publicPools
    }, null, 2));
    fs.renameSync(temporaryPath, poolStorePath);
    return true;
  } catch (error) {
    console.warn(`Could not persist public pool store at ${poolStorePath}: ${error.message}`);
    return false;
  }
}

function loadTtsPools() {
  const rawPoolsDir = path.join(__dirname, "pools", "raw");

  if (!fs.existsSync(rawPoolsDir)) {
    return [];
  }

  return fs.readdirSync(rawPoolsDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const filePath = path.join(rawPoolsDir, fileName);
      const rawJson = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return parseTtsPool(rawJson, path.basename(fileName, ".json"));
    })
    .filter(Boolean);
}

const allPools = loadStoredPublicPools() || loadTtsPools().map((pool) => withPoolMetadata(pool, {
  public: true
}));

const draftPools = new Map(allPools.map((pool) => [pool.id, pool]));

function getPool(poolId) {
  return draftPools.get(poolId) || null;
}

function listPublicPools() {
  return [...draftPools.values()].filter((pool) => pool.public);
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
    public: Boolean(options.public)
  };

  draftPools.set(pool.id, pool);

  if (pool.public) {
    persistPublicPools();
  }

  return pool;
}

function savePool(poolId, options = {}) {
  const pool = getPool(poolId);

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
    public: true
  };

  draftPools.set(savedPool.id, savedPool);
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
    defaultParameters: options.defaultParameters || pool.defaultParameters
  });
}

function removePublicPool(poolId) {
  const pool = getPool(poolId);

  if (!pool || !pool.public) {
    return false;
  }

  draftPools.delete(pool.id);
  persistPublicPools();
  return true;
}

function getPoolSummary(pool) {
  const defaultParameters = normalizeDefaultParameters(pool, pool.defaultParameters);

  return {
    id: pool.id,
    name: pool.name,
    source: pool.source || "generated",
    public: Boolean(pool.public),
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

module.exports = {
  draftPools,
  getDefaultPublicPool,
  getPool,
  getPoolSummary,
  isSpeakerOrderType,
  listPublicPools,
  normalizeDefaultParameters,
  parseTtsPool,
  registerUploadedTtsPool,
  removePublicPool,
  savePool,
  speakerOrderType,
  updatePublicPool
};
