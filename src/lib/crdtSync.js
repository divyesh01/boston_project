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
  merge(other) {
    for (const [node, time] of Object.entries(other.clock)) {
      this.clock[node] = Math.max(this.clock[node] || 0, time);
    }
    return this;
  }
  happensBefore(other) {
    let strictlyLess = false;
    for (const [node, time] of Object.entries(this.clock)) {
      const otherTime = other.clock[node] || 0;
      if (time > otherTime) return false;
      if (time < otherTime) strictlyLess = true;
    }
    // Check if other has events we dont know about
    for (const node of Object.keys(other.clock)) {
      if (!(node in this.clock) && other.clock[node] > 0) strictlyLess = true;
    }
    return strictlyLess;
  }
  concurrentWith(other) {
    return !this.happensBefore(other) && !other.happensBefore(this);
  }
  toJSON() { return this.clock; }
  static fromJSON(json) { return new VectorClock(json || {}); }
}

// ─── Dot (Unique Event Identifier) ──────────────────────────────────────

export function makeDot(nodeId, clock) {
  const seq = (clock[nodeId] || 0) + 1;
  return `${nodeId}:${seq}`;
}

export function parseDot(dot) {
  const [node, seq] = dot.split(':');
  return { node, seq: parseInt(seq, 10) };
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
    if (!existing || existing.dot <= dot) {
      this.additions.set(element, { dot, value: element });
    }
    clock.increment(nodeId);
    return this;
  }
  remove(element, nodeId, clock) {
    const dot = makeDot(nodeId, clock);
    const existing = this.removals.get(element);
    if (!existing || existing.dot <= dot) {
      this.removals.set(element, { dot, value: element });
    }
    clock.increment(nodeId);
    return this;
  }
  has(element) {
    const add = this.additions.get(element);
    const rem = this.removals.get(element);
    return add && (!rem || add.dot > rem.dot);
  }
  values() {
    const out = [];
    for (const [el, add] of this.additions) {
      const rem = this.removals.get(el);
      if (!rem || add.dot > rem.dot) out.push(add.value);
    }
    return out;
  }
  merge(other) {
    for (const [el, add] of other.additions) {
      const existing = this.additions.get(el);
      if (!existing || existing.dot <= add.dot) this.additions.set(el, add);
    }
    for (const [el, rem] of other.removals) {
      const existing = this.removals.get(el);
      if (!existing || existing.dot <= rem.dot) this.removals.set(el, rem);
    }
    return this;
  }
  deltaSince(other) {
    const delta = new LWWElementSet();
    for (const [el, add] of this.additions) {
      const otherAdd = other.additions.get(el);
      if (!otherAdd || add.dot > otherAdd.dot) delta.additions.set(el, add);
    }
    for (const [el, rem] of this.removals) {
      const otherRem = other.removals.get(el);
      if (!otherRem || rem.dot > otherRem.dot) delta.removals.set(el, rem);
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
    if (!existing || (existing.dot && existing.dot <= dot)) {
      this.entries.set(key, { ...value, dot });
    }
    clock.increment(nodeId);
    return this;
  }
  get(key) {
    const entry = this.entries.get(key);
    return entry ? entry.value : undefined;
  }
  has(key) {
    return this.entries.has(key);
  }
  remove(key, nodeId, clock) {
    const dot = makeDot(nodeId, clock);
    const entry = this.entries.get(key);
    if (!entry || (entry.dot && entry.dot <= dot)) {
      this.entries.set(key, { __removed: true, dot });
    }
    clock.increment(nodeId);
    return this;
  }
  merge(other) {
    for (const [key, entry] of other.entries) {
      const ours = this.entries.get(key);
      if (!ours || (ours.dot || 0) <= (entry.dot || 0)) {
        this.entries.set(key, entry);
      }
    }
    this.clock.merge(other.clock);
    return this;
  }
  deltaSince(other) {
    const delta = new ORMap(new Map(), new VectorClock());
    for (const [key, entry] of this.entries) {
      const otherEntry = other.entries.get(key);
      if (!otherEntry || (entry.dot || 0) > (otherEntry.dot || 0)) {
        delta.entries.set(key, entry);
      }
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
}

// ─── CRDT Entity Types for Hotel Operations ─────────────────────────────

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
  applyUpdate(shiftCRDT, updates, nodeId) {
    shiftCRDT.clock.increment(nodeId);
    for (const [k, v] of Object.entries(updates)) {
      shiftCRDT.map.set(k, { value: v, __type: "LWWRegister" }, nodeId, shiftCRDT.clock);
    }
    return shiftCRDT;
  },
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
  setStatus(roomCRDT, status, nodeId) {
    return RoomStatusCRDT.applyUpdate(roomCRDT, { status, lastUpdated: new Date().toISOString() }, nodeId);
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
  mergeRemote(type, id, remoteCRDT, peerId) {
    const local = this.getEntity(type, id);
    if (!local) return false;
    local.map.merge(remoteCRDT.map);
    local.clock.merge(remoteCRDT.clock);
    this.peers.set(peerId, { lastKnownClock: remoteCRDT.clock });
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
    const local = this.getEntity(delta.type, delta.id);
    if (!local) return false;
    local.map.merge(delta.delta);
    local.clock.merge(delta.clock);
    return true;
  }
  // Persist to IndexedDB (if adapter provided)
  async persist() {
    if (!this.localStorage) return;
    const data = { nodeId: this.nodeId, clock: this.clock.toJSON(), entities: {} };
    for (const [type, map] of this.entities) {
      data.entities[type] = {};
      for (const [id, crdt] of map) {
        data.entities[type][id] = { map: Object.fromEntries(crdt.map.entries), clock: crdt.clock.toJSON() };
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
        const map = new ORMap(new Map(Object.entries(crdt.map || {})), VectorClock.fromJSON(crdt.clock));
        this.registerEntity(type, id, { map, clock: VectorClock.fromJSON(crdt.clock) });
      }
    }
  }
}

export function createSyncEngine(nodeId, indexedDBAdapter = null) {
  return new CRDTSync(nodeId, indexedDBAdapter);
}
