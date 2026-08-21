/**
 * CRDT Sync Engine (Step 7 — 100× Unified Engine)
 *
 * State-based CRDTs for offline-first multi-property hotel operations.
 * Implements:
 *  - LWW-Element-Set (Last-Writer-Wins Element Set)
 *  - OR-Map (Observed-Remove Map) for nested structures
 *  - Delta-state mesh replication via WebSocket/WebRTC
 *  - Deterministic merge using vector clocks / dot-based versioning
 */

// ─── Vector Clock (Dot) Versioning ──────────────────────────────────────

export class VectorClock {
  constructor(clock = {}) {
    this.clock = { ...clock };
  }
  increment(nodeId) {
    this.clock[nodeId] = (this.clock[nodeId] || 0) + 1;
    return this;
  }
  // Accepts a VectorClock, a raw { node: seq } object, or a VectorClock that has
  // been through JSON.stringify. Every one of these arrives in practice: deltas
  // cross the wire as plain JSON, and `other.clock` on a plain object is
  // undefined, which used to throw here and abort the whole merge.
  merge(other) {
    for (const [node, time] of Object.entries(clockObject(other))) {
      const t = Number(time);
      if (!Number.isFinite(t)) continue;
      this.clock[node] = Math.max(this.clock[node] || 0, t);
    }
    return this;
  }
  happensBefore(other) {
    const theirs = clockObject(other);
    let strictlyLess = false;
    for (const [node, time] of Object.entries(this.clock)) {
      const otherTime = theirs[node] || 0;
      if (time > otherTime) return false;
      if (time < otherTime) strictlyLess = true;
    }
    // Check if other has events we dont know about
    for (const node of Object.keys(theirs)) {
      if (!(node in this.clock) && theirs[node] > 0) strictlyLess = true;
    }
    return strictlyLess;
  }
  concurrentWith(other) {
    const theirs = VectorClock.from(other);
    return !this.happensBefore(theirs) && !theirs.happensBefore(this);
  }
  // Copy, so a persisted snapshot cannot be mutated through the live clock.
  toJSON() { return { ...this.clock }; }
  static fromJSON(json) { return new VectorClock(clockObject(json)); }
  static from(source) {
    return source instanceof VectorClock ? source : new VectorClock(clockObject(source));
  }
}

// Read the { node: seq } counters out of whatever shape a clock arrived in.
//
// The disambiguation is sound rather than a guess: node ids map to NUMBERS, so a
// nested `clock` whose own value is an OBJECT can only be the wrapper written by
// JSON.stringify(new VectorClock()) — a node genuinely named "clock" would hold a
// number and fall through to the raw-object branch.
function clockObject(clock) {
  if (!clock || typeof clock !== "object") return {};
  if (clock instanceof VectorClock) return clock.clock || {};
  if (clock.clock && typeof clock.clock === "object") return clock.clock;
  return clock;
}

// ─── Dot (Unique Event Identifier) ──────────────────────────────────────
//
// A dot is "<nodeId>:<seq>" and is the ONLY thing that orders events in this
// engine, so two properties have to hold: it must be unique per event, and
// comparing two of them must be numeric.
//
// BOTH WERE BROKEN (launch item #3).
//
// 1. makeDot read `clock[nodeId]`, but every caller passes a VectorClock, whose
//    counters live at `clock.clock[nodeId]`. So the lookup was always undefined
//    and seq was always 1: every event on a node minted the SAME dot forever.
//    Dots identified nothing, and `existing.dot <= dot` was comparing a string to
//    itself, which is why the damage stayed invisible.
//
// 2. Comparison was lexicographic on the whole string. Once seq reached double
//    digits, "n1:9" <= "n1:10" is FALSE, so the guards rejected the newer value
//    and the write was dropped in silence. Across nodes it ranked by node id, so
//    a single write from "z-tablet" outranked a hundred later writes from
//    "a-desk" permanently.
//
// WHY compareDots IS A TOTAL ORDER. Dots carry no wall clock, so "last writer
// wins" cannot mean real time here — it can only mean an order every replica
// computes identically. Higher seq wins; an equal seq is broken by node id. That
// makes merge commutative, associative and idempotent (asserted in
// scripts/probe-crdt-convergence.mjs), which is what convergence requires. A
// missing or unparseable dot sorts oldest so it loses instead of throwing.

export function makeDot(nodeId, clock) {
  const seq = (clockObject(clock)[nodeId] || 0) + 1;
  return `${nodeId}:${seq}`;
}

// Split on the LAST colon: node ids are allowed to contain them (a WebSocket
// origin such as "wss://desk-1" is a natural node id, and splitting on the first
// colon parsed its seq as NaN, which made every comparison against it false).
export function parseDot(dot) {
  const s = typeof dot === "string" ? dot : "";
  const i = s.lastIndexOf(":");
  if (i < 0) return { node: s, seq: 0 };
  const seq = Number.parseInt(s.slice(i + 1), 10);
  return { node: s.slice(0, i), seq: Number.isInteger(seq) && seq > 0 ? seq : 0 };
}

/**
 * Total order over dots. Negative if `a` is older, positive if newer, 0 if equal.
 * Use this for EVERY dot comparison — a bare `<=` on the strings is the defect.
 */
export function compareDots(a, b) {
  const A = parseDot(a);
  const B = parseDot(b);
  if (A.seq !== B.seq) return A.seq < B.seq ? -1 : 1;
  if (A.node === B.node) return 0;
  return A.node < B.node ? -1 : 1;
}

// ─── LWW-Element-Set (Last-Writer-Wins Element Set) ─────────────────────

export class LWWElementSet {
  constructor(additions = new Map(), removals = new Map()) {
    this.additions = new Map(additions); // element -> { dot, value }
    this.removals = new Map(removals);   // element -> { dot, value }
  }
  static fromElements(elements, nodeId, clock) {
    const set = new LWWElementSet();
    for (const el of elements) set.add(el, nodeId, clock);
    return set;
  }
  add(element, nodeId, clock) {
    const dot = makeDot(nodeId, clock);
    const existing = this.additions.get(element);
    if (!existing || compareDots(existing.dot, dot) <= 0) {
      this.additions.set(element, { dot, value: element });
    }
    clock.increment(nodeId);
    return this;
  }
  remove(element, nodeId, clock) {
    const dot = makeDot(nodeId, clock);
    const existing = this.removals.get(element);
    if (!existing || compareDots(existing.dot, dot) <= 0) {
      this.removals.set(element, { dot, value: element });
    }
    clock.increment(nodeId);
    return this;
  }
  has(element) {
    const add = this.additions.get(element);
    const rem = this.removals.get(element);
    return Boolean(add) && (!rem || compareDots(add.dot, rem.dot) > 0);
  }
  values() {
    const out = [];
    for (const [el, add] of this.additions) {
      const rem = this.removals.get(el);
      if (!rem || compareDots(add.dot, rem.dot) > 0) out.push(add.value);
    }
    return out;
  }
  merge(other) {
    for (const [el, add] of other.additions) {
      const existing = this.additions.get(el);
      if (!existing || compareDots(existing.dot, add.dot) <= 0) this.additions.set(el, add);
    }
    for (const [el, rem] of other.removals) {
      const existing = this.removals.get(el);
      if (!existing || compareDots(existing.dot, rem.dot) <= 0) this.removals.set(el, rem);
    }
    return this;
  }
  deltaSince(other) {
    const delta = new LWWElementSet();
    for (const [el, add] of this.additions) {
      const otherAdd = other.additions.get(el);
      if (!otherAdd || compareDots(add.dot, otherAdd.dot) > 0) delta.additions.set(el, add);
    }
    for (const [el, rem] of this.removals) {
      const otherRem = other.removals.get(el);
      if (!otherRem || compareDots(rem.dot, otherRem.dot) > 0) delta.removals.set(el, rem);
    }
    return delta;
  }
}

// ─── OR-Map (Observed-Remove Map) ───────────────────────────────────────

export class ORMap {
  constructor(entries = new Map(), clock = new VectorClock()) {
    this.entries = new Map(entries); // key -> { value, dot, type: "LWW"|"ORMap"|"LWWRegister" }
    this.clock = clock;
  }
  static fromObject(obj, nodeId, clock) {
    const map = new ORMap();
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && typeof v === "object" && v.__type === "LWWRegister") {
        map.set(k, v, nodeId, clock);
      } else if (v && typeof v === "object" && v.__type === "ORMap") {
        map.set(k, v, nodeId, clock);
      } else {
        map.set(k, { value: v, __type: "LWWRegister" }, nodeId, clock);
      }
    }
    return map;
  }
  set(key, value, nodeId, clock) {
    const dot = makeDot(nodeId, clock);
    const existing = this.entries.get(key);
    // No `existing.dot &&` guard: an entry that somehow has no dot must be
    // BEATABLE. Requiring a truthy dot made such an entry permanently unwritable.
    if (!existing || compareDots(existing.dot, dot) <= 0) {
      this.entries.set(key, { ...value, dot });
    }
    clock.increment(nodeId);
    return this;
  }
  get(key) {
    const entry = this.entries.get(key);
    return entry && !entry.__removed ? entry.value : undefined;
  }
  has(key) {
    const entry = this.entries.get(key);
    return Boolean(entry) && !entry.__removed;
  }
  remove(key, nodeId, clock) {
    const dot = makeDot(nodeId, clock);
    const entry = this.entries.get(key);
    if (!entry || compareDots(entry.dot, dot) <= 0) {
      this.entries.set(key, { __removed: true, dot });
    }
    clock.increment(nodeId);
    return this;
  }
  merge(other) {
    const source = ORMap.fromState(other);
    for (const [key, entry] of source.entries) {
      const ours = this.entries.get(key);
      if (!ours || compareDots(ours.dot, entry.dot) <= 0) {
        this.entries.set(key, entry);
      }
    }
    this.clock.merge(source.clock);
    return this;
  }
  /**
   * Entries `other` does not have, or has an older version of.
   *
   * Also skips any entry whose dot the peer's CLOCK already covers. Without that
   * check `CRDTSync.createDelta` — which passes an entry-less ORMap carrying the
   * peer's clock — matched nothing and shipped the entire entity on every sync,
   * so "delta-state replication" was a full-state broadcast.
   */
  deltaSince(other) {
    const source = ORMap.fromState(other);
    const theirClock = source.clock.clock;
    const delta = new ORMap(new Map(), new VectorClock(this.clock.clock));
    for (const [key, entry] of this.entries) {
      const theirs = source.entries.get(key);
      if (theirs) {
        if (compareDots(entry.dot, theirs.dot) > 0) delta.entries.set(key, entry);
        continue;
      }
      const { node, seq } = parseDot(entry.dot);
      if (seq > 0 && (theirClock[node] || 0) >= seq) continue; // peer saw this event
      delta.entries.set(key, entry);
    }
    return delta;
  }
  toObject() {
    const obj = {};
    for (const [key, entry] of this.entries) {
      if (!entry.__removed) obj[key] = entry.value;
    }
    return obj;
  }
  /**
   * Wire/storage form. A Map does NOT survive JSON.stringify — it serializes to
   * `{}` — so anything that crossed the wire arrived with its entries wiped and
   * `merge` threw "other.entries is not iterable". Entries become a plain object
   * here so a delta can actually be sent.
   */
  toJSON() {
    return { entries: Object.fromEntries(this.entries), clock: this.clock.toJSON() };
  }
  /**
   * Coerce any received state into an ORMap: an ORMap, a bare Map of entries, or
   * the JSON form above. Distinct from `fromObject`, which takes raw VALUES and
   * mints new dots for them; this one preserves the dots it is given.
   */
  static fromState(source) {
    if (source instanceof ORMap) return source;
    const clock = VectorClock.fromJSON(source && source.clock);
    const raw = source instanceof Map ? source : source && source.entries;
    let entries;
    if (raw instanceof Map) entries = new Map(raw);
    else if (raw && typeof raw === "object") entries = new Map(Object.entries(raw));
    else entries = new Map();
    return new ORMap(entries, clock);
  }
  static fromJSON(json) { return ORMap.fromState(json); }
}

// ─── CRDT Entity Types for Hotel Operations ─────────────────────────────

/**
 * Apply a field patch to any entity CRDT.
 *
 * Shared by all three entity types because it was previously defined only on
 * ShiftCRDT, while `RoomStatusCRDT.setStatus` called `RoomStatusCRDT.applyUpdate`
 * — which did not exist. Every room status change threw
 * "RoomStatusCRDT.applyUpdate is not a function", and TransactionCRDT had no way
 * to be updated at all (a posted transaction could never be voided).
 *
 * The old ShiftCRDT version also incremented the clock once up front and then
 * again inside every `map.set`, burning a sequence number per update for no
 * reason. `set` owns the increment; this does not touch the clock itself.
 *
 * @param {{ map: ORMap, clock: VectorClock }} crdt
 * @param {Record<string, any>} updates
 * @param {string} nodeId
 */
export function applyUpdate(crdt, updates, nodeId) {
  for (const [k, v] of Object.entries(updates || {})) {
    crdt.map.set(k, { value: v, __type: "LWWRegister" }, nodeId, crdt.clock);
  }
  return crdt;
}

export const ShiftCRDT = {
  create(shiftData, nodeId) {
    const clock = new VectorClock();
    const map = ORMap.fromObject({
      shiftId: shiftData.shiftId,
      clerkId: shiftData.clerkId,
      propertyId: shiftData.propertyId,
      date: shiftData.date,
      cashCollected: shiftData.cashCollected || 0,
      cashDropped: shiftData.cashDropped || 0,
      creditProcessed: shiftData.creditProcessed || 0,
      voidCount: shiftData.voidCount || 0,
      adjustments: shiftData.adjustments || 0,
      status: shiftData.status || "open",
    }, nodeId, clock);
    return { map, clock };
  },
  applyUpdate,
};

export const RoomStatusCRDT = {
  create(roomData, nodeId) {
    const clock = new VectorClock();
    const map = ORMap.fromObject({
      roomNumber: roomData.roomNumber,
      propertyId: roomData.propertyId,
      status: roomData.status || "clean", // clean, dirty, occupied, maintenance, ooo
      lastUpdated: roomData.lastUpdated || new Date().toISOString(),
      housekeeperId: roomData.housekeeperId || null,
      guestId: roomData.guestId || null,
    }, nodeId, clock);
    return { map, clock };
  },
  applyUpdate,
  setStatus(roomCRDT, status, nodeId) {
    return applyUpdate(roomCRDT, { status, lastUpdated: new Date().toISOString() }, nodeId);
  },
};

export const TransactionCRDT = {
  create(txData, nodeId) {
    const clock = new VectorClock();
    const map = ORMap.fromObject({
      txId: txData.txId,
      propertyId: txData.propertyId,
      date: txData.date,
      amountCents: txData.amountCents,
      type: txData.type, // charge, payment, adjustment, refund
      clerkId: txData.clerkId,
      channel: txData.channel || "desk",
      status: txData.status || "posted",
    }, nodeId, clock);
    return { map, clock };
  },
  applyUpdate,
};

// ─── Sync Protocol (Delta-State Mesh) ───────────────────────────────────

export class CRDTSync {
  constructor(nodeId, localStorage = null) {
    this.nodeId = nodeId;
    this.clock = new VectorClock();
    this.entities = new Map(); // entityType -> Map<id, { map: ORMap, clock: VectorClock }>
    this.peers = new Map(); // peerId -> { lastKnownClock: VectorClock }
    this.localStorage = localStorage; // optional IndexedDB adapter
  }
  registerEntity(type, id, crdt) {
    if (!this.entities.has(type)) this.entities.set(type, new Map());
    this.entities.get(type).set(id, crdt);
    return crdt;
  }
  getEntity(type, id) {
    return this.entities.get(type)?.get(id);
  }
  // An entity this node has never seen before. Returning false and dropping the
  // payload — the old behaviour of mergeRemote and applyDelta — meant an entity
  // CREATED on another node could never reach this one: a room put out of order
  // on a housekeeping tablet simply never appeared at the front desk. Adopting an
  // empty entity and merging into it is the whole point of a state-based CRDT.
  adopt(type, id) {
    return this.registerEntity(type, id, { map: new ORMap(), clock: new VectorClock() });
  }
  // Track what a peer has seen. MERGED, never replaced: messages can arrive out
  // of order, and overwriting with an older clock would make us believe the peer
  // knows less than it does and resend state forever.
  notePeerClock(peerId, clock) {
    if (peerId === undefined || peerId === null) return;
    const known = this.peers.get(peerId)?.lastKnownClock || new VectorClock();
    known.merge(clock);
    this.peers.set(peerId, { lastKnownClock: known });
  }
  mergeRemote(type, id, remoteCRDT, peerId) {
    if (!remoteCRDT || !remoteCRDT.map) return false;
    const local = this.getEntity(type, id) || this.adopt(type, id);
    local.map.merge(remoteCRDT.map);
    local.clock.merge(remoteCRDT.clock);
    this.clock.merge(remoteCRDT.clock);
    this.notePeerClock(peerId, remoteCRDT.clock);
    return true;
  }
  createDelta(type, id, peerId) {
    const local = this.getEntity(type, id);
    if (!local) return null;
    const peer = this.peers.get(peerId) || { lastKnownClock: new VectorClock() };
    const delta = local.map.deltaSince(new ORMap(new Map(), peer.lastKnownClock));
    return { type, id, delta, clock: local.clock };
  }
  applyDelta(delta) {
    if (!delta || !delta.type || delta.id === undefined || delta.id === null) return false;
    const local = this.getEntity(delta.type, delta.id) || this.adopt(delta.type, delta.id);
    local.map.merge(delta.delta);
    local.clock.merge(delta.clock);
    this.clock.merge(delta.clock);
    return true;
  }
  // Persist to IndexedDB (if adapter provided)
  async persist() {
    if (!this.localStorage) return;
    const data = { nodeId: this.nodeId, clock: this.clock.toJSON(), entities: {} };
    for (const [type, map] of this.entities) {
      data.entities[type] = {};
      for (const [id, crdt] of map) {
        data.entities[type][id] = { map: crdt.map.toJSON(), clock: crdt.clock.toJSON() };
      }
    }
    await this.localStorage.set("crdt_state", data);
  }
  // Restore from IndexedDB
  async restore() {
    if (!this.localStorage) return;
    const data = await this.localStorage.get("crdt_state");
    if (!data) return;
    this.nodeId = data.nodeId;
    this.clock = VectorClock.fromJSON(data.clock);
    for (const [type, objs] of Object.entries(data.entities || {})) {
      for (const [id, crdt] of Object.entries(objs)) {
        // `crdt.map` is ORMap.toJSON() — `{ entries, clock }`. Snapshots written
        // before toJSON existed stored the bare entries bag instead, so accept
        // both rather than silently restoring an empty entity.
        const state = crdt.map && crdt.map.entries ? crdt.map : { entries: crdt.map };
        const map = ORMap.fromState({ entries: state.entries, clock: crdt.clock });
        this.registerEntity(type, id, { map, clock: VectorClock.fromJSON(crdt.clock) });
      }
    }
  }
}

export function createSyncEngine(nodeId, indexedDBAdapter = null) {
  return new CRDTSync(nodeId, indexedDBAdapter);
}
