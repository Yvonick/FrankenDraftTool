import registryModule from "../backend/poolRegistry.js";
import raw from "../backend/pools/raw/Franken Y V69.json" with { type: "json" };
import assetOverrides from "../backend/pools/asset-overrides/franken-y-v6-9.json" with { type: "json" };
const parser = registryModule.createPoolRegistry({ assetOverrides });
export const builtinPool = parser.withPoolMetadata(parser.parseTtsPool(raw, "Franken Y V69"), { public: true });
export { assetOverrides };
