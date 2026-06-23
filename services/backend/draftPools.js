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
  return item.Name === "Custom_Model" && /(?:planet|anomaly|home\s*systems?)/i.test(type);
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

function extractTtsItem(item, type, poolId, index) {
  const image = getImageData(item);

  if (!image.imageUrl) {
    return null;
  }

  const typeSlug = slugify(type);
  const name = item.Nickname || item.Description || `${type} ${index + 1}`;

  return {
    id: `${poolId}-${typeSlug}-${String(index + 1).padStart(3, "0")}`,
    name,
    content: item.Description || "",
    type,
    imageUrl: resolveAssetUrl(image.imageUrl),
    imageSecondaryUrl: shouldKeepSecondaryImage(type) ? resolveAssetUrl(image.imageSecondaryUrl) : null,
    imageSheet: shouldCropSystemTileTexture(type, item)
      ? { columns: 2, rows: 1, index: 0 }
      : image.imageSheet,
    sourceObjectType: item.Name || "Unknown",
    ttsObject: cloneJson(item)
  };
}

function shouldUseTtsBag(bag) {
  const name = bag.Nickname || bag.Name || "";

  return bag.Name === "Bag"
    && Array.isArray(bag.ContainedObjects)
    && bag.ContainedObjects.length > 0
    && !/non\s*draft/i.test(name);
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

  for (const bag of root.ContainedObjects.filter(shouldUseTtsBag)) {
    const type = bag.Nickname || bag.Name;
    const parsedItems = bag.ContainedObjects
      .map((item, index) => extractTtsItem(item, type, poolId, index))
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
  const parsedPicksPerBag = Number(parameters.picksPerBag);
  const picksPerBag = Number.isInteger(parsedPicksPerBag)
    ? Math.min(Math.max(parsedPicksPerBag, 1), 8)
    : 2;
  const sourceItemsPerType = parameters.itemsPerType || {};
  const itemsPerType = Object.fromEntries(pool.types.map((type) => {
    const parsed = Number(sourceItemsPerType[type]);
    const value = Number.isInteger(parsed)
      ? Math.min(Math.max(parsed, 0), 10)
      : 1;

    return [type, value];
  }));

  return {
    picksPerBag,
    itemsPerType
  };
}

function withPoolMetadata(pool, options = {}) {
  return {
    ...pool,
    name: cleanPoolName(options.name || pool.name, pool.name),
    public: options.public ?? Boolean(pool.public),
    defaultParameters: normalizeDefaultParameters(pool, options.defaultParameters || pool.defaultParameters)
  };
}

function serializePool(pool) {
  return {
    id: pool.id,
    name: pool.name,
    source: pool.source,
    public: Boolean(pool.public),
    types: pool.types,
    items: pool.items,
    defaultParameters: normalizeDefaultParameters(pool, pool.defaultParameters)
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
    itemTypes: pool.types.map((type) => ({
      type,
      itemCount: pool.items.filter((item) => item.type === type).length
    })),
    defaultParameters
  };
}

module.exports = {
  draftPools,
  getDefaultPublicPool,
  getPool,
  getPoolSummary,
  listPublicPools,
  normalizeDefaultParameters,
  parseTtsPool,
  registerUploadedTtsPool,
  removePublicPool,
  savePool,
  updatePublicPool
};
