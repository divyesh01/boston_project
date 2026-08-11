// Probe for hotel stats functions using real Dexie DB

// fake-indexeddb must be installed before anything imports Dexie.
await import("fake-indexeddb/auto");
globalThis.crypto ??= (await import("node:crypto")).webcrypto;

const __store = new Map();
const __storage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(k, String(v)),
  removeItem: (k) => __store.delete(k),
  clear: () => __store.clear(),
};
globalThis.localStorage = __storage;
globalThis.sessionStorage = __storage;
globalThis.window = globalThis;
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "harness", language: "en-US" }, configurable: true });
}

const { occupancyStats, capacityRoomNights, perPropertyStats } = await import("../src/lib/hotel.js");
const localDb = (await import("../src/api/localDb.js")).default;

async function main() {
  try {
    const occ = await localDb.OccupancyDay.toArray();
    const props = await localDb.Property.toArray();
    
    console.log(`Loaded ${occ.length} occupancy rows and ${props.length} properties`);
    
    console.log("Calling occupancyStats...");
    const stats = occupancyStats(occ, props);
    console.log(stats);
    
    console.log("Calling capacityRoomNights...");
    const cap = capacityRoomNights(occ, props);
    console.log(cap);
    
  } catch (e) {
    console.error("Error:", e);
  }
}
main();
