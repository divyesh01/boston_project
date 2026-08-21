// Probe: the CRDT engine must converge, and must never silently discard a write.
//
// THE DEFECTS (launch item #3). src/lib/crdtSync.js ordered events by comparing
// dot STRINGS ("nodeId:seq") with <= and >. Lexicographic order is not numeric
// order, so:
//
//   "n1:9" <= "n1:10"  ->  false      ('9' > '1' at index 3)
//
// Every guard in the file read `existing.dot <= dot`, so from the tenth write to
// any key onward the guard is false and the new value is DROPPED. A shift's
// cashCollected froze permanently after nine edits, with no error. Across nodes
// the comparison ranked by node id, so one write from "z-tablet" beat a hundred
// later writes from "a-desk" forever.
//
// Four more faults found while reading (not in the original report):
//   - RoomStatusCRDT.setStatus called RoomStatusCRDT.applyUpdate, which did not
//     exist -> TypeError on every room status change.
//   - mergeRemote/applyDelta returned false and DROPPED the payload when the
//     entity was unknown locally, so an entity created on another node was lost.
//   - VectorClock.merge assumed `other.clock`, so a clock that had been through
//     JSON.stringify (i.e. anything off the wire) threw.
//   - createDelta passed an entry-less ORMap to deltaSince, so the "delta" was
//     always the entire entity state.
//
// WHAT CONVERGENCE MEANS HERE. Dots carry no wall clock, so "last writer wins"
// can only mean a deterministic TOTAL ORDER that every replica computes the same
// way: higher seq wins, node id breaks ties. This probe asserts the CRDT laws
// (commutative, idempotent, associative, monotonic) AND the value, because the
// string compare satisfied the laws perfectly while converging on the wrong
// number — the laws alone would not have caught it.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-crdt-convergence.mjs

const {
  VectorClock, ORMap, LWWElementSet,
  makeDot, parseDot, compareDots,
  ShiftCRDT, RoomStatusCRDT, TransactionCRDT,
  createSyncEngine,
} = await import("@/lib/crdtSync");

let pass = 0;
let fail = 0;
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};
const eq = (actual, expected, label) =>
  ok(actual === expected, label, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

const reg = (v) => ({ value: v, __type: "LWWRegister" });
const cloneMap = (m) => new ORMap(new Map(m.entries), new VectorClock(m.clock.clock));
const writeN = (nodeId, n, key = "cash") => {
  const clock = new VectorClock();
  const map = new ORMap();
  for (let i = 1; i <= n; i++) map.set(key, reg(i), nodeId, clock);
  return { map, clock };
};

// ── 1. Dot ordering is numeric, with a deterministic tiebreak ──────────────
console.log("\n[1] compareDots — numeric seq, node id tiebreak, total order");
ok(compareDots("n1:10", "n1:9") > 0, "seq 10 is newer than seq 9 (the string bug)",
  `lexicographic said ${"n1:10" > "n1:9" ? "newer" : "OLDER"}`);
ok(compareDots("n1:9", "n1:10") < 0, "seq 9 is older than seq 10");
ok(compareDots("n1:2", "n1:100") < 0, "seq 2 is older than seq 100");
eq(compareDots("n1:7", "n1:7"), 0, "identical dots compare equal");
ok(compareDots("a-desk:5", "z-tablet:1") > 0, "higher seq beats an alphabetically later node");
ok(compareDots("z:3", "a:3") > 0, "equal seq falls back to node id");
ok(compareDots("a:3", "z:3") < 0, "the node id tiebreak is antisymmetric");
// A total order is what makes merge deterministic on every replica.
ok(compareDots(undefined, "n1:1") < 0, "a missing dot is the oldest possible");
ok(compareDots("n1:1", undefined) > 0, "and loses to nothing");
eq(compareDots(undefined, null), 0, "two missing dots are equal, not NaN");
ok(compareDots("garbage", "n1:1") < 0, "an unparseable dot sorts oldest instead of throwing");

console.log("\n[1b] parseDot survives a node id containing a colon");
eq(parseDot("wss://desk-1:7").seq, 7, "seq is read after the LAST colon");
eq(parseDot("wss://desk-1:7").node, "wss://desk-1", "node keeps its colons");
eq(parseDot("n1:3").seq, 3, "the ordinary form still parses");
eq(parseDot("").seq, 0, "empty dot is seq 0, not NaN");

// ── 2. THE DEFECT: writes past the ninth were discarded ────────────────────
console.log("\n[2] ORMap keeps the newest value past seq 9");
const twelve = writeN("n1", 12);
eq(twelve.map.get("cash"), 12, "the 12th write to a key is the value that sticks");
eq(parseDot(twelve.map.entries.get("cash").dot).seq, 12, "and it carries the 12th dot");
const hundred = writeN("n1", 100);
eq(hundred.map.get("cash"), 100, "still correct after 100 writes");

console.log("\n[2b] LWWElementSet ordering past seq 9");
const clockS = new VectorClock();
const set = new LWWElementSet();
for (let i = 0; i < 9; i++) set.add(`filler${i}`, "n1", clockS); // burn seq 1..9
set.add("room101", "n1", clockS);   // seq 10
set.remove("room101", "n1", clockS); // seq 11 — must win
ok(!set.has("room101"), "a remove at seq 11 beats an add at seq 10");
ok(!set.values().includes("room101"), "and values() agrees with has()");
set.add("room101", "n1", clockS);   // seq 12 — must win again
ok(set.has("room101"), "a re-add at seq 12 beats the remove at seq 11");
ok(set.values().includes("room101"), "values() agrees again");

// ── 3. Cross-node: the higher seq wins, both directions ────────────────────
console.log("\n[3] cross-node convergence on the same value");
const A = writeN("a-desk", 5, "status");
const Z = writeN("z-tablet", 1, "status");
const a2z = cloneMap(A.map).merge(cloneMap(Z.map));
const z2a = cloneMap(Z.map).merge(cloneMap(A.map));
eq(a2z.get("status"), 5, "a-desk's 5 writes beat z-tablet's 1 (merge A<-Z)");
eq(z2a.get("status"), 5, "same winner in the other direction (merge Z<-A)");
eq(a2z.get("status"), z2a.get("status"), "COMMUTATIVE: merge order does not change the result");

console.log("\n[3b] CRDT laws");
const idem = cloneMap(A.map).merge(cloneMap(Z.map)).merge(cloneMap(Z.map));
eq(idem.get("status"), a2z.get("status"), "IDEMPOTENT: merging the same state twice changes nothing");
const B3 = writeN("m-mid", 3, "status");
const left = cloneMap(A.map).merge(cloneMap(Z.map)).merge(cloneMap(B3.map));
const right = cloneMap(A.map).merge(cloneMap(cloneMap(Z.map).merge(cloneMap(B3.map))));
eq(left.get("status"), right.get("status"), "ASSOCIATIVE: grouping does not change the result");
// MONOTONIC: a merge must never move a key backwards in the dot order.
const before = twelve.map.entries.get("cash").dot;
const older = writeN("n1", 3);
const after = cloneMap(twelve.map).merge(cloneMap(older.map)).entries.get("cash").dot;
ok(compareDots(after, before) >= 0, "MONOTONIC: merging older state never regresses a key",
  `${before} -> ${after}`);
eq(cloneMap(twelve.map).merge(cloneMap(older.map)).get("cash"), 12,
  "an older replica cannot overwrite a newer value");

console.log("\n[3c] equal-seq tie resolves identically on both replicas");
const T1 = writeN("node-a", 4, "status");
const T2 = writeN("node-b", 4, "status");
const t12 = cloneMap(T1.map).merge(cloneMap(T2.map)).get("status");
const t21 = cloneMap(T2.map).merge(cloneMap(T1.map)).get("status");
eq(t12, t21, "a tie converges to the same side regardless of merge direction");

// ── 4. Removals converge too ───────────────────────────────────────────────
console.log("\n[4] ORMap.remove participates in the same order");
const rc = new VectorClock();
const rm = new ORMap();
for (let i = 1; i <= 10; i++) rm.set("guestId", reg(`g${i}`), "n1", rc); // seq 1..10
rm.remove("guestId", "n1", rc); // seq 11
eq(rm.get("guestId"), undefined, "a remove at seq 11 clears a value written at seq 10");
ok(!rm.has("guestId"), "has() reports false for a tombstone (it used to say true)");
ok(!("guestId" in rm.toObject()), "toObject() omits the tombstone");
rm.set("guestId", reg("g-new"), "n1", rc); // seq 12
eq(rm.get("guestId"), "g-new", "a write after the tombstone resurrects the key");
ok("guestId" in rm.toObject(), "and toObject() shows it again");

// ── 5. RoomStatusCRDT.setStatus must not throw ─────────────────────────────
console.log("\n[5] the entity helpers actually run");
let threw = null;
let room = null;
try {
  room = RoomStatusCRDT.create({ roomNumber: "101", propertyId: "p1", status: "dirty" }, "n1");
  RoomStatusCRDT.setStatus(room, "clean", "n1");
} catch (e) { threw = e; }
ok(threw === null, "RoomStatusCRDT.setStatus does not throw", threw ? threw.message : "no throw");
eq(room && room.map.get("status"), "clean", "and the status actually changed");

const shift = ShiftCRDT.create({ shiftId: "s1", propertyId: "p1", cashCollected: 0 }, "n1");
for (let i = 1; i <= 12; i++) ShiftCRDT.applyUpdate(shift, { cashCollected: i * 100 }, "n1");
eq(shift.map.get("cashCollected"), 1200, "12 shift updates land on the 12th value");
const tx = TransactionCRDT.create({ txId: "t1", propertyId: "p1", amountCents: 5000, type: "charge" }, "n1");
TransactionCRDT.applyUpdate(tx, { status: "voided" }, "n1");
eq(tx.map.get("status"), "voided", "TransactionCRDT can be updated at all");
eq(tx.map.get("amountCents"), 5000, "and an unrelated field is untouched");

// ── 6. NEGATIVE: an unknown entity must be adopted, never dropped ──────────
console.log("\n[6] mergeRemote / applyDelta adopt an entity they have never seen");
const desk = createSyncEngine("desk");
const tablet = createSyncEngine("tablet");
const remoteRoom = RoomStatusCRDT.create({ roomNumber: "202", propertyId: "p1", status: "ooo" }, "tablet");
tablet.registerEntity("RoomStatus", "202", remoteRoom);
const adopted = desk.mergeRemote("RoomStatus", "202", remoteRoom, "tablet");
ok(adopted === true, "mergeRemote reports success for a new entity");
ok(desk.getEntity("RoomStatus", "202") !== undefined, "the entity now exists locally (was silently dropped)");
eq(desk.getEntity("RoomStatus", "202")?.map.get("status"), "ooo", "with the remote value intact");
ok(desk.getEntity("RoomStatus", "202") !== remoteRoom,
  "and it is a COPY — mutating the local one must not reach into the peer's state");
desk.mergeRemote("RoomStatus", "202", remoteRoom, "tablet");
eq(desk.getEntity("RoomStatus", "202")?.map.get("status"), "ooo", "re-merging is idempotent");

const d = tablet.createDelta("RoomStatus", "202", "desk");
const desk2 = createSyncEngine("desk2");
ok(desk2.applyDelta(d) === true, "applyDelta adopts an unknown entity too");
eq(desk2.getEntity("RoomStatus", "202")?.map.get("status"), "ooo", "with the value intact");

// ── 7. Wire format: a payload that went through JSON must still merge ──────
console.log("\n[7] a JSON round-tripped delta still applies");
RoomStatusCRDT.setStatus(remoteRoom, "clean", "tablet");
const wire = JSON.parse(JSON.stringify(tablet.createDelta("RoomStatus", "202", "desk")));
let wireThrew = null;
try { desk.applyDelta(wire); } catch (e) { wireThrew = e; }
ok(wireThrew === null, "applyDelta survives a plain-object payload", wireThrew ? wireThrew.message : "no throw");
eq(desk.getEntity("RoomStatus", "202")?.map.get("status"), "clean", "and the newer status arrived");
let clockThrew = null;
try { new VectorClock({ n1: 2 }).merge({ clock: { n1: 5 } }); new VectorClock({ n1: 2 }).merge({ n1: 5 }); }
catch (e) { clockThrew = e; }
ok(clockThrew === null, "VectorClock.merge accepts a VectorClock or a raw clock object",
  clockThrew ? clockThrew.message : "no throw");
eq(new VectorClock({ n1: 2 }).merge({ n1: 5 }).clock.n1, 5, "a raw clock object merges by value");

// ── 8. A delta is actually a delta ─────────────────────────────────────────
console.log("\n[8] createDelta sends changes, not the whole entity");
const src = createSyncEngine("src");
const shift2 = ShiftCRDT.create({ shiftId: "s9", propertyId: "p1", cashCollected: 0 }, "src");
src.registerEntity("Shift", "s9", shift2);
const first = src.createDelta("Shift", "s9", "peer1");
ok(first.delta.entries.size > 0, "the first delta carries the full state", `${first.delta.entries.size} keys`);
// Peer acknowledges by telling us its clock, exactly as mergeRemote would.
src.peers.set("peer1", { lastKnownClock: new VectorClock(shift2.clock.clock) });
const second = src.createDelta("Shift", "s9", "peer1");
eq(second.delta.entries.size, 0, "a fully synced peer gets an EMPTY delta");
ShiftCRDT.applyUpdate(shift2, { cashCollected: 250 }, "src");
const third = src.createDelta("Shift", "s9", "peer1");
eq(third.delta.entries.size, 1, "after one field changes, the delta carries exactly one key");
eq(third.delta.get("cashCollected"), 250, "and it is the field that changed");

console.log("\n[8b] a peer clock never moves backwards");
const eng = createSyncEngine("eng");
const e1 = ShiftCRDT.create({ shiftId: "s1", propertyId: "p1" }, "far");
for (let i = 0; i < 5; i++) ShiftCRDT.applyUpdate(e1, { cashCollected: i }, "far");
eng.registerEntity("Shift", "s1", e1);
eng.mergeRemote("Shift", "s1", e1, "far");
const high = eng.peers.get("far").lastKnownClock.clock.far;
eng.mergeRemote("Shift", "s1", ShiftCRDT.create({ shiftId: "s1", propertyId: "p1" }, "far"), "far");
ok(eng.peers.get("far").lastKnownClock.clock.far >= high,
  "an out-of-order message cannot regress what we think a peer knows",
  `${high} -> ${eng.peers.get("far").lastKnownClock.clock.far}`);

// ── 9. Vector clock causality ──────────────────────────────────────────────
console.log("\n[9] VectorClock causality");
const c1 = new VectorClock({ n1: 1 });
const c2 = new VectorClock({ n1: 2 });
ok(c1.happensBefore(c2), "n1:1 happens before n1:2");
ok(!c2.happensBefore(c1), "and not the other way round");
ok(!c1.happensBefore(c1), "a clock does not happen before itself");
ok(new VectorClock({ n1: 1 }).concurrentWith(new VectorClock({ n2: 1 })),
  "disjoint clocks are concurrent");
ok(!c1.concurrentWith(c2), "causally ordered clocks are not concurrent");
eq(new VectorClock({ n1: 3 }).merge(new VectorClock({ n1: 1, n2: 5 })).clock.n1, 3,
  "merge keeps our higher entry");
eq(new VectorClock({ n1: 3 }).merge(new VectorClock({ n1: 1, n2: 5 })).clock.n2, 5,
  "and adopts the peer's");

// ── 10. persist / restore keeps the values and the order ───────────────────
console.log("\n[10] persist -> restore round trip");
const store = new Map();
const adapter = { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); } };
const live = createSyncEngine("desk", adapter);
const s = ShiftCRDT.create({ shiftId: "s1", propertyId: "p1", cashCollected: 0 }, "desk");
for (let i = 1; i <= 11; i++) ShiftCRDT.applyUpdate(s, { cashCollected: i * 10 }, "desk");
live.registerEntity("Shift", "s1", s);
await live.persist();
const revived = createSyncEngine("tmp", adapter);
await revived.restore();
eq(revived.getEntity("Shift", "s1")?.map.get("cashCollected"), 110, "the 11th value survived the round trip");
eq(revived.nodeId, "desk", "the node id survived");
// The restored replica must still order correctly against the live one.
ShiftCRDT.applyUpdate(s, { cashCollected: 999 }, "desk");
revived.mergeRemote("Shift", "s1", s, "desk");
eq(revived.getEntity("Shift", "s1")?.map.get("cashCollected"), 999,
  "a restored replica accepts a newer write from the live one");

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
