const fs = require("node:fs");
const path = require("node:path");
const { createPoolRegistry } = require("./poolRegistry");
const poolStorePath = process.env.POOL_STORE_PATH || path.join(__dirname, "data", "public-pools.json");
const overridesDir = path.join(__dirname, "pools", "asset-overrides");
const assetOverrides = Object.assign({}, ...fs.readdirSync(overridesDir).filter(name => name.endsWith(".json")).map(name => JSON.parse(fs.readFileSync(path.join(overridesDir, name), "utf8"))));
const parser = createPoolRegistry({ assetOverrides });
let initialPools;
try {
  const stored = JSON.parse(fs.readFileSync(poolStorePath, "utf8"));
  initialPools = (Array.isArray(stored) ? stored : stored.pools).map(pool => parser.withPoolMetadata(pool, { public: true }));
} catch {
  const rawDir = path.join(__dirname, "pools", "raw");
  initialPools = fs.readdirSync(rawDir).filter(name => name.endsWith(".json")).map(name => parser.parseTtsPool(JSON.parse(fs.readFileSync(path.join(rawDir, name), "utf8")), path.basename(name, ".json"))).filter(Boolean).map(pool => parser.withPoolMetadata(pool, { public: true }));
}
module.exports = createPoolRegistry({ initialPools, assetOverrides, onChange(pools) {
  fs.mkdirSync(path.dirname(poolStorePath), { recursive: true });
  const temporary = `${poolStorePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), pools: pools.filter(pool => pool.public).map(parser.serializePool) }));
  fs.renameSync(temporary, poolStorePath);
} });
