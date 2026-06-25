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
  sections: [
    {
      title: "Setup",
      items: [
        "The host selects a pool and this draft method, players sit down until the room reaches the pool's player count, and the host starts the draft.",
        "Players are randomly arranged around the table.",
        "Each player is dealt one starting bag built from the pool's item-type counts."
      ]
    },
    {
      title: "Pick And Pass",
      items: [
        "Players privately view their current bag, select the required number of legal items, lock choices, and add those items to their drafted area.",
        "Remaining items in the bag pass clockwise to the back of the next player's queue.",
        "Each player repeatedly takes the first bag from their own queue until all bags are empty or discarded."
      ]
    },
    {
      title: "Legality",
      items: [
        "Players cannot draft more than the pool maximum for any item type.",
        "During the first rotation, a player cannot pick two items of the same type.",
        "If a player cannot make the usual number of picks, they may lock the maximum number of legal picks available, including zero."
      ]
    },
    {
      title: "Visibility And Finish",
      items: [
        "Current bags and drafted items are private to their owners during the draft, except for super spectators.",
        "Once all bags are empty, every player's drafted area is revealed and TTS export becomes available."
      ]
    }
  ],
  customNotes: "This is the method currently implemented by the live draft room."
};

const nominationAuctionMethod = {
  id: "nomination-auction",
  name: "Nomination Auction",
  engine: "auction",
  builtIn: true,
  playable: true,
  description: "Players spend credits through rotating item-type nominations, mulligans, bans, hidden bids, and public pick-order resolution.",
  playerOrder: "auction-nomination",
  itemPresentation: "auction-nominations",
  selectionTiming: "live-bidding",
  passing: "none",
  visibility: "live-public",
  completion: "all-items-claimed",
  supportsExport: true,
  bag: {
    usesRoomPicksPerBag: false,
    usesPoolTypeCounts: true,
    enforceTypeCaps: true,
    firstRotationUniqueType: false,
    discardAfterFullEmptyPass: false
  },
  auction: {
    startingBudget: 40,
    minimumBid: 0,
    bidVisibility: "sealed",
    nominationOrder: "table-order",
    tieBreaker: "random"
  },
  sections: [
    {
      title: "Setup",
      items: [
        "The room starts like a normal draft: the host selects a pool and method, the required number of players sit down, and the host starts the draft.",
        "Each player starts with 40 credits, 2 mulligan tokens, and 1 ban token.",
        "Players first bid on speaker order. The resulting order becomes the nomination order, and the first player becomes the first speaker."
      ]
    },
    {
      title: "Nomination Cycle",
      items: [
        "The current speaker nominates the next item type to bid on.",
        "An item type cannot be nominated once it has already been nominated the maximum number of times for that type.",
        "After each nomination resolves, speaker passes to the next player in speaker order, looping back to the first player after the last."
      ]
    },
    {
      title: "Draws, Mulligans, And Bans",
      items: [
        "When an item type is nominated, the draft randomly draws player count plus one items of that type from the pool.",
        "If the speaker has mulligan tokens, they may spend one to move the whole drawn set into a temporary bin and draw a fresh set of the same size. The speaker may mulligan again while they still have tokens.",
        "Players then get ban windows in speaker order. A player with a ban token chooses either one displayed item to ban or no ban. A banned item enters the temporary bin and is replaced by a fresh draw from the same type.",
        "Players can preset no-ban to speed up the ban phase, and they may change that preset at any time. The ban phase ends once every eligible player has declined to ban.",
        "Items in the temporary bin cannot be drawn again during the current nomination."
      ]
    },
    {
      title: "Hidden Bids",
      items: [
        "Each player privately enters a first-pick bid and a tie-breaker bid. With 5 or more players, each player also enters a second-pick bid.",
        "Players cannot bid more total credits than they have available.",
        "Once a player locks bids, those bid fields stay hidden until all players have locked."
      ]
    },
    {
      title: "Bid Resolution",
      items: [
        "All bids are revealed together. The highest first-pick bid gets first pick and spends that bid.",
        "With 5 or more players, the highest second-pick bid among players who did not get first pick gets second pick and spends that bid.",
        "All remaining players are ordered by tie-breaker bid and spend their tie-breaker bid.",
        "Any tied choice is resolved randomly. If the tie decides first or second pick, only the winner spends that pick bid and the losing tied bids for that pick are voided. If the tie is for tie-breaker ordering, every tied player spends their tie-breaker bid."
      ]
    },
    {
      title: "Picks, Bins, And Finish",
      items: [
        "After pick order is decided, players pick one item each from the nominated pool in that order.",
        "The one remaining displayed item goes to a permanent bin.",
        "Temporary-bin items from mulligans and bans are shuffled back into the pool after the nomination resolves.",
        "The draft ends once every item type has reached its maximum number of nominations. Export becomes available at that point, with each player exported as one TTS bag."
      ]
    },
    {
      title: "Visibility",
      items: [
        "Everything is public to players and spectators except each player's hidden bid fields before reveal.",
        "The draft view should show players, speaker, current pick order and revealed bids when relevant, the nominated items, temporary/permanent bin icons with hover lists, and each player's credits, tokens, picked items, and credit spent per pick."
      ]
    }
  ],
  customNotes: "Live auction engine."
};

const builtInMethods = [defaultMethod, nominationAuctionMethod];

function cleanName(value, fallback = "Untitled Method") {
  const cleaned = String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
  return cleaned || fallback;
}

function cleanText(value, fallback = "", limit = 1200) {
  const cleaned = String(value || "").trim().replace(/\r\n/g, "\n").slice(0, limit);
  return cleaned || fallback;
}

function cleanSections(value, fallback = []) {
  const sections = Array.isArray(value) ? value : (Array.isArray(fallback) ? fallback : []);

  return sections
    .map((section) => ({
      title: cleanText(section?.title, "", 80),
      items: Array.isArray(section?.items)
        ? section.items.map((item) => cleanText(item, "", 500)).filter(Boolean)
        : []
    }))
    .filter((section) => section.title && section.items.length > 0)
    .slice(0, 12);
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
    playable: Boolean(rawMethod.playable ?? existing.playable ?? engine === "bag-pass"),
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
    sections: cleanSections(rawMethod.sections, existing.sections),
    customNotes: cleanText(rawMethod.customNotes, existing.customNotes, 1500)
  };
}

const draftMethods = new Map([
  ...builtInMethods.map((method) => [method.id, normalizeMethod(method, {
    id: method.id,
    existing: method,
    builtIn: true
  })])
]);

function getDraftMethod(methodId) {
  return draftMethods.get(methodId) || null;
}

function getDefaultDraftMethod() {
  return getDraftMethod(defaultMethodId);
}

function listDraftMethods() {
  return builtInMethods
    .map((method) => getDraftMethod(method.id))
    .filter(Boolean);
}

function getDraftMethodSummary(method) {
  return normalizeMethod(method, {
    id: method.id,
    existing: method,
    builtIn: method.builtIn
  });
}

module.exports = {
  defaultMethodId,
  getDefaultDraftMethod,
  getDraftMethod,
  getDraftMethodSummary,
  listDraftMethods
};
