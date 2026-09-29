import { describe, expect, it } from "vitest";
import {
  VectorClock,
  ORMap,
  ShiftCRDT,
  createSyncEngine,
} from "./crdtSync.js";

describe("ORMap.fromObject offline vector clock tracking", () => {
  it("links map.clock to supplied VectorClock and increments on each set", () => {
    const externalClock = new VectorClock();
    const map = ORMap.fromObject({ a: 1, b: 2 }, "n1", externalClock);

    expect(externalClock.clock).toEqual({ n1: 2 });
    expect(map.clock.clock).toEqual({ n1: 2 });
    expect(map.clock).toBe(externalClock);
  });

  it("toJSON serializes entries and clock together", () => {
    const clock = new VectorClock();
    const map = ORMap.fromObject({ x: 10, y: 20 }, "n1", clock);
    const json = map.toJSON();

    expect(json.entries).toEqual({
      x: { value: 10, __type: "LWWRegister", dot: "n1:1" },
      y: { value: 20, __type: "LWWRegister", dot: "n1:2" },
    });
    expect(json.clock).toEqual({ n1: 2 });
  });
});

describe("ORMap deltaSince causal behavior", () => {
  it("returns only entries not covered by peer clock", () => {
    const clock = new VectorClock();
    const map = ORMap.fromObject({ a: 1, b: 2, c: 3 }, "n1", clock);

    const peerClock = new VectorClock({ n1: 2 });
    const peerMap = new ORMap(new Map(), peerClock);

    const delta = map.deltaSince(peerMap);

    expect(delta.entries.size).toBe(1);
    expect(delta.entries.has("c")).toBe(true);
    expect(delta.entries.get("c").dot).toBe("n1:3");
    expect(delta.clock.toJSON()).toEqual({ n1: 3 });
  });
});

describe("CRDTSync persist/restore with in-memory storage adapter", () => {
  it("persists and restores entity state including clocks", async () => {
    const storage = new Map();
    const adapter = {
      async set(key, value) { storage.set(key, value); },
      async get(key) { return storage.get(key); },
    };

    const sync = createSyncEngine("node-A", adapter);
    const shift = ShiftCRDT.create({ shiftId: "s1", clerkId: "c1", propertyId: "p1" }, "node-A");
    sync.registerEntity("Shift", "s1", shift);

    await sync.persist();
    const snapshot = storage.get("crdt_state");
    expect(snapshot.entities.Shift.s1.map.clock).toEqual(shift.clock.toJSON());
    // Snapshots saved before the fix have an empty map clock.
    snapshot.entities.Shift.s1.map.clock = {};

    const sync2 = createSyncEngine("node-A", adapter);
    await sync2.restore();

    const restored = sync2.getEntity("Shift", "s1");
    expect(restored).toBeDefined();
    expect(restored.map.toObject()).toEqual(shift.map.toObject());
    expect(restored.clock.clock).toEqual(shift.clock.clock);
    expect(restored.map.clock.clock).toEqual(shift.clock.clock);
    expect(sync2.clock.clock).toEqual(sync.clock.clock);
  });
});
