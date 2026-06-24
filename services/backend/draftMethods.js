const fs = require("node:fs");
const path = require("node:path");

const methodStorePath = process.env.DRAFT_METHOD_STORE_PATH
  || path.join(__dirname, "data", "draft-methods.json");

const defaultMethodId = "bag-passing-default";

const methodEngines = new Set([
  "bag-pass",
  "auction",
  "snake",
  "open-pick",
  "custom"
]);

const optionSets = {
  playerOrder: new Set(["random-table", "seated-order", "manual", "auction-nomination", "custom"]),
  itemPresentation: new Set(["starting-bags", "shared-market", "auction-nominations", "open-packs", "custom"]),
  selectionTiming: new Set(["simultaneous", "turn-order", "live-bidding", "asynchronous", "custom"]),
  passing: new Set(["clockwise-queue", "counterclockwise-queue", "snake", "none", "custom"]),
  visibility: new Set(["private-until-complete", "live-public", "host-only", "custom"]),
  completion: new Set(["all-bags-empty", "fixed-rounds", "budget-spent", "all-items-claimed", "custom"]),
  bidVisibility: new Set(["open", "sealed", "ascending", "custom"]),
  nominationOrder: new Set(["random", "table-order", "snake", "host", "custom"]),
  tieBreaker: new Set(["seat-order", "random", "host", "custom"])
};

const defaultMethod = {
  id: defaultMethodId,
  name: "Bag Passing",
  engine: "bag-pass",
  builtIn: true,
  playable: true,
  description: "Randomized table seats, one starting bag per player, simultaneous hidden picks, bags passed clockwise through player queues, private drafted areas until reveal.",
  playerOrder: "random-table",
  itemPresentation: "starting-bags",
  selectionTiming: "simultaneous",
  passing: "clockwise-queue",
  visibility: "private-until-complete",
  completion: "all-bags-empty",
  supportsExport: true,
  bag: {
    usesRoomPicksPerBag: true,
    usesPoolTypeCounts: true,
    enforceTypeCaps: true,
    firstRotationUniqueType: true,
    discardAfterFullEmptyPass: true
  },
  auction: {
    startingBudget: 0,
    minimumBid: 1,
    bidVisibility: "open",
    nominationOrder: "table-order",
    tieBreaker: "seat-order"
  },
  customNotes: "This is the method currently implemented by the live draft room."
};

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function cleanName(value, fallback = "Untitled Method") {
  const cleaned = String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
  return cleaned || fallback;
}

function cleanText(value, fallback = "", limit = 1200) {
  const cleaned = String(value || "").trim().replace(/\r\n/g, "\n").slice(0, limit);
  return cleaned || fallback;
}

function cleanEnum(value, allowedValues, fallback) {
  return allowedValues.has(value) ? value : fallback;
}

function cleanNonnegativeInteger(value, fallback, max = 9999) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, 0), max);
}

function normalizeMethod(rawMethod = {}, options = {}) {
  const existing = options.existing || {};
  const engine = cleanEnum(rawMethod.engine, methodEngines, existing.engine || "custom");

  return {
    id: options.id || rawMethod.id || existing.id,
    name: cleanName(rawMethod.name, existing.name),
    engine,
    builtIn: Boolean(options.builtIn ?? existing.builtIn),
    playable: engine === "bag-pass",
    description: cleanText(rawMethod.description, existing.description, 1500),
    playerOrder: cleanEnum(rawMethod.playerOrder, optionSets.playerOrder, existing.playerOrder || "custom"),
    itemPresentation: cleanEnum(rawMethod.itemPresentation, optionSets.itemPresentation, existing.itemPresentation || "custom"),
    selectionTiming: cleanEnum(rawMethod.selectionTiming, optionSets.selectionTiming, existing.selectionTiming || "custom"),
    passing: cleanEnum(rawMethod.passing, optionSets.passing, existing.passing || "custom"),
    visibility: cleanEnum(rawMethod.visibility, optionSets.visibility, existing.visibility || "custom"),
    completion: cleanEnum(rawMethod.completion, optionSets.completion, existing.completion || "custom"),
    supportsExport: Boolean(rawMethod.supportsExport ?? existing.supportsExport),
    bag: {
      usesRoomPicksPerBag: Boolean(rawMethod.bag?.usesRoomPicksPerBag ?? existing.bag?.usesRoomPicksPerBag),
      usesPoolTypeCounts: Boolean(rawMethod.bag?.usesPoolTypeCounts ?? existing.bag?.usesPoolTypeCounts),
      enforceTypeCaps: Boolean(rawMethod.bag?.enforceTypeCaps ?? existing.bag?.enforceTypeCaps),
      firstRotationUniqueType: Boolean(rawMethod.bag?.firstRotationUniqueType ?? existing.bag?.firstRotationUniqueType),
      discardAfterFullEmptyPass: Boolean(rawMethod.bag?.discardAfterFullEmptyPass ?? existing.bag?.discardAfterFullEmptyPass)
    },
    auction: {
      startingBudget: cleanNonnegativeInteger(rawMethod.auction?.startingBudget, existing.auction?.startingBudget || 0),
      minimumBid: cleanNonnegativeInteger(rawMethod.auction?.minimumBid, existing.auction?.minimumBid || 1),
      bidVisibility: cleanEnum(rawMethod.auction?.bidVisibility, optionSets.bidVisibility, existing.auction?.bidVisibility || "open"),
      nominationOrder: cleanEnum(rawMethod.auction?.nominationOrder, optionSets.nominationOrder, existing.auction?.nominationOrder || "table-order"),
      tieBreaker: cleanEnum(rawMethod.auction?.tieBreaker, optionSets.tieBreaker, existing.auction?.tieBreaker || "seat-order")
    },
    customNotes: cleanText(rawMethod.customNotes, existing.customNotes, 1500)
  };
}

function serializeMethod(method) {
  return normalizeMethod(method, {
    id: method.id,
    existing: method,
    builtIn: false
  });
}

function loadStoredMethods() {
  if (!fs.existsSync(methodStorePath)) {
    return [];
  }

  try {
    const stored = JSON.parse(fs.readFileSync(methodStorePath, "utf8"));
    const storedMethods = Array.isArray(stored) ? stored : stored.methods;

    if (!Array.isArray(storedMethods)) {
      return [];
    }

    return storedMethods
      .filter((method) => method?.id && method.id !== defaultMethodId)
      .map((method) => normalizeMethod(method, {
        id: method.id,
        existing: defaultMethod,
        builtIn: false
      }));
  } catch (error) {
    console.warn(`Could not load draft method store at ${methodStorePath}: ${error.message}`);
    return [];
  }
}

const draftMethods = new Map([
  [defaultMethod.id, normalizeMethod(defaultMethod, {
    id: defaultMethod.id,
    existing: defaultMethod,
    builtIn: true
  })],
  ...loadStoredMethods().map((method) => [method.id, method])
]);

function listCustomMethods() {
  return [...draftMethods.values()].filter((method) => !method.builtIn);
}

function persistDraftMethods() {
  const directory = path.dirname(methodStorePath);
  const temporaryPath = `${methodStorePath}.${process.pid}.tmp`;

  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporaryPath, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      methods: listCustomMethods().map(serializeMethod)
    }, null, 2));
    fs.renameSync(temporaryPath, methodStorePath);
    return true;
  } catch (error) {
    console.warn(`Could not persist draft method store at ${methodStorePath}: ${error.message}`);
    return false;
  }
}

function uniqueMethodId(name) {
  const base = slugify(name) || "draft-method";

  if (!draftMethods.has(base)) {
    return base;
  }

  let suffix = 2;

  while (draftMethods.has(`${base}-${suffix}`)) {
    suffix += 1;
  }

  return `${base}-${suffix}`;
}

function getDraftMethod(methodId) {
  return draftMethods.get(methodId) || null;
}

function getDefaultDraftMethod() {
  return getDraftMethod(defaultMethodId);
}

function listDraftMethods() {
  return [
    getDefaultDraftMethod(),
    ...listCustomMethods().sort((left, right) => left.name.localeCompare(right.name))
  ].filter(Boolean);
}

function getDraftMethodSummary(method) {
  return normalizeMethod(method, {
    id: method.id,
    existing: method,
    builtIn: method.builtIn
  });
}

function normalizeDraftMethodPreview(method = {}) {
  return normalizeMethod(method, {
    id: method.id || "generated-method",
    existing: defaultMethod,
    builtIn: false
  });
}

function createDraftMethod(input = {}) {
  const id = uniqueMethodId(input.name || "Draft Method");
  const method = normalizeMethod(input, {
    id,
    existing: defaultMethod,
    builtIn: false
  });

  draftMethods.set(method.id, method);
  persistDraftMethods();
  return method;
}

function updateDraftMethod(methodId, input = {}) {
  const existing = getDraftMethod(methodId);

  if (!existing || existing.builtIn) {
    return null;
  }

  const method = normalizeMethod(input, {
    id: existing.id,
    existing,
    builtIn: false
  });

  draftMethods.set(method.id, method);
  persistDraftMethods();
  return method;
}

function removeDraftMethod(methodId) {
  const method = getDraftMethod(methodId);

  if (!method || method.builtIn) {
    return false;
  }

  draftMethods.delete(method.id);
  persistDraftMethods();
  return true;
}

module.exports = {
  createDraftMethod,
  defaultMethodId,
  getDefaultDraftMethod,
  getDraftMethod,
  getDraftMethodSummary,
  listDraftMethods,
  normalizeDraftMethodPreview,
  removeDraftMethod,
  updateDraftMethod
};
