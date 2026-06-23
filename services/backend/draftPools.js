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
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function createTestingItems(type) {
  const slug = slugify(type);

  return Array.from({ length: 50 }, (_, index) => {
    const number = index + 1;

    return {
      id: `${slug}-${String(number).padStart(2, "0")}`,
      name: `${type} Test Item ${number}`,
      content: `Testing ${type.toLowerCase()} draft content ${number}.`,
      type
    };
  });
}

const testingPool = {
  id: "testing",
  name: "Testing Pool",
  types: testingTypes,
  items: testingTypes.flatMap(createTestingItems)
};

const draftPools = new Map([
  [testingPool.id, testingPool]
]);

function getPoolSummary(pool) {
  return {
    id: pool.id,
    name: pool.name,
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
  getPoolSummary
};
