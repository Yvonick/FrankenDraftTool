const fs = require("node:fs");
const path = require("node:path");

const testingTypes = [
  "Faction",
  "Technology",
  "Unit",
  "Leader",
  "Planet",
  "Promissory",
  "Relic",
  "Agenda",
  "Objective",
  "Action Card"
];

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function createTestingItems(type) {
  const slug = slugify(type);

  return Array.from({ length: 50 }, (_, index) => {
    const number = index + 1;

    return {
      id: `${slug}-${String(number).padStart(2, "0")}`,
      name: `${type} Test Item ${number}`,
      content: `Testing ${type.toLowerCase()} draft content ${number}.`,
      type,
      imageUrl: null
    };
  });
}

const testingPool = {
  id: "testing",
  name: "Testing Pool",
  types: testingTypes,
  items: testingTypes.flatMap(createTestingItems)
};

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

function resolveAssetUrl(url) {
  if (!url) {
    return null;
  }

  return assetOverrides[url] || url;
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
    imageSecondaryUrl: resolveAssetUrl(image.imageSecondaryUrl),
    imageSheet: image.imageSheet,
    sourceObjectType: item.Name || "Unknown"
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

const allPools = [
  testingPool,
  ...loadTtsPools()
];

const draftPools = new Map(allPools.map((pool) => [pool.id, pool]));

function getPoolSummary(pool) {
  return {
    id: pool.id,
    name: pool.name,
    source: pool.source || "generated",
    itemTypes: pool.types.map((type) => ({
      type,
      itemCount: pool.items.filter((item) => item.type === type).length
    })),
    defaultParameters: {
      picksPerBag: 2,
      itemsPerType: Object.fromEntries(pool.types.map((type) => [type, 1]))
    }
  };
}

module.exports = {
  draftPools,
  getPoolSummary,
  parseTtsPool
};
