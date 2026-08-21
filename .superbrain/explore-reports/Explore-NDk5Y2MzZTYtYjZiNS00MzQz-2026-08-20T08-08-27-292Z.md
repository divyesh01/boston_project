# Sub-Agent Report Trace

- **Agent**: Explore
- **Session**: /NDk5Y2MzZTYtYjZiNS00MzQzLWJlNGItM2YyNjQzMmJmYzAx
- **Raw report chars**: 12701
- **Compressed (delivered to parent) chars**: 13516
- **Distinct files mentioned in raw report**: 43

## Spawn Prompt (what the parent asked)

Audit the CORE BUSINESS-LOGIC correctness of this hotel management app (React/JS, c:\Users\divye\OneDrive\Desktop\boston_project). Read fully and report concrete bugs with exact file:line:
- src/lib/hotel.js
- src/lib/pricingEngine.js, src/lib/pricingOverride.js, src/lib/pricingSettings.js, src/lib/usePricing.js
- src/lib/forecasting.js
- src/lib/housekeepingService.js, src/lib/housekeepingConfig.js
- src/lib/roomBoard.js
- src/lib/transactionNorm.js
- src/lib/anomalyDetector.js
- src/lib/alertEngine.js
- src/lib/auditLogger.js (check audit immutability)
- src/lib/reputationService.js
- src/lib/commissionRates.js
- src/lib/expenseCategories.js
- src/lib/RevenueReconciliation.js

Report: (1) Logic bugs: off-by-one date handling, wrong aggregation, incorrect pricing/discount/commission formulas. (2) Audit log immutability — can audit entries be altered/deleted? (3) Race conditions (check crdtSync.js, ySync.js, settingsBus.js, realtime.js). (4) Performance issues (O(n^2) loops over large arrays, full-table scans in src/api/localDb.js). (5) Unhandled error paths that silently swallow failures. Quote exact lines. Do NOT propose fixes — just document problems with evidence.

## Raw Report (what the sub-agent produced, pre-compression)

I'll start by enumerating the target scope and reading the files.Let me start reading the core files. I'll get skeletons first to gauge sizes, then read fully.The semantic index is offline, so I'll degrade to full-file reads via superbrain_readFiles. Reading the core pricing/business files now.Reading the remaining business-logic files plus the sync/perf targets.The large batches got truncated. Let me read the files that were cut off and the remaining targets individually.Let me read the truncated portions of anomalyDetector and crdtSync, plus the audit immutability core in securityUtils and the db layer.Now let me find the audit immutability core (createAuditEntry, db.audit) and the localDb implementation for full-table scans and audit mutation.Let me read the audit immutability implementation in securityUtils and the db guard + localDb.Let me confirm the immutable-table guard is actually invoked on write paths, and check the race-condition dot comparison context.I now have complete coverage of all requested files. Here is the audit.

## Exploration Report

**Confidence**: HIGH — index was offline, so every file was read in full via `superbrain_readFile`; all findings are direct from source with exact lines.
**Files Examined**: hotel.js, pricingEngine.js, pricingOverride.js, pricingSettings.js, usePricing.js, forecasting.js, housekeepingService.js, housekeepingConfig.js, roomBoard.js, transactionNorm.js, anomalyDetector.js (699 lines, read whole), alertEngine.js, auditLogger.js, reputationService.js, commissionRates.js, expenseCategories.js, RevenueReconciliation.js, crdtSync.js, ySync.js, settingsBus.js, realtime.js, securityUtils.js (audit section), base44Client.js (audit/immutability/list sections), localDb.js.
**Key Tool Path**: listDirectory → superbrain_readFile (full files, multiple batches) → targeted reads → grep.

### Findings

**(1) Logic bugs**

- `src/lib/pricingOverride.js:30-53` — **`applyDynamicRateOverride` never persists the new rate.** It builds `updatePayload` (L30-37) but the only side effect is the `db.functions.invoke('audit_log')` call (L41-48) and returning the payload. There is no `db.put/update` for `current_rate` anywhere. The operator sees "success" (audit row written) but the room rate in the store is never changed. Functional bug.

- `src/lib/pricingEngine.js:135-138` — `isWeekend` returns `true` for `day===0 || 5 || 6` (Sun, Fri, Sat), but `pricingSettings.js:33-34` documents the weekend uplift as "Weekend covers **Fri+Sat** night stays". A Sunday night stay therefore gets the 1.2× weekday/weekend seasonality uplift that the config's own comment says should not apply. Inconsistency between the engine and the documented intent.

- `src/lib/pricingEngine.js:185-189` — `computeOptimalElasticPrice` computes `multiplier = (targetOccupancy/currentOccupancy)^(-elasticity)`. The correct inverted demand relation is `(Q_target/Q_current)^(-1/ε)`. Using exponent `-ε` (e.g. −1.5) instead of `-1/ε` (≈−0.67) overstates the magnitude of the price move by a factor of ε for any given occupancy gap. Direction is right; magnitude is wrong.

- `src/lib/forecasting.js:5-10` — `predictDemand` maps `d.occupancy` (L6), i.e. it expects objects with an `.occupancy` field. If a caller passes an array of raw numbers (the shape `computeBookingPace` in pricingEngine.js:196-198 produces/consumes), `d.occupancy` is `undefined`, the sum becomes `NaN`, and `predictDemand` returns `NaN`. Also `trend = events.length ? 0.1 : 0` (L8) is a hardcoded constant applied whenever *any* event exists, regardless of event count/size — not a real demand signal.

- `src/lib/roomBoard.js:138` — **operator-precedence bug** in `roomTile`: `maintenance: room.maintenance || room.status === "out_of_service" ? room.status : "available"` parses as `(room.maintenance || (room.status==="out_of_service")) ? room.status : "available"`. Because `room.maintenance` is almost always a truthy string (e.g. `"available"` from `generateRoomRegister` L188-189), the ternary takes the `? room.status` branch and `maintenance` is set to `room.status` for every room, defeating the field entirely (an available room shows `maintenance: "available"`, but a dirty/occupied room also shows its own status, and `available` never appears here).

- `src/lib/hotel.js:206,209` — `inventoryInScope` sums `Number(p.rooms) || PROPERTY.rooms` per property. A property that legitimately has `rooms: 0` (or a null value) is silently counted as 100 rooms (the default), inflating total inventory for multi-property selections.

- `src/lib/pricingEngine.js:80-85` — `blendWithCompetitor` computes `(1-w)*rateCents + w*comp` in floating point over integer-cents inputs (L84), despite the module's stated integer-cents invariant; the result is `Math.round`ed so it is not a correctness error, only a style/consistency drift.

- `src/lib/roomBoard.js:283-285` (in `buildPricingForecast`, pricingEngine.js actually) — projected revenue splits inventory **equally** across room types (`typeRooms = Math.round(rooms.length / presentTypes.length)`) and applies every type's rate to that equal share, ignoring real per-type inventory. The aggregate room count is correct but revenue is weighted by an equal split rather than actual type mix. Approximation, not strictly wrong; flag as aggregation simplification.

**(2) Audit log immutability**

- The proxy guard is real: `base44Client.js:579-594` defines `PROTECTED_IMMUTABLE_TABLES = ['AuditLog']` and `throwIfProtected()`, which is invoked on update (L729), put (L753), add (L784), delete (L814), and bulk write (L847). `audit.clear` is refused at `base44Client.js:1648-1653`. So the **app's own write API** cannot mutate/delete audit rows.

- **But immutability is not actually enforced at rest:** rows live in IndexedDB (`localDb.js:95` `AuditLog`), which any page script can write to directly, bypassing the proxy. The local tamper-evidence uses a **public, non-secret HMAC salt** (`securityUtils.js:496` `AUDIT_CHAIN_SALT`), so anyone with browser console access can recompute valid hashes and rewrite/delete rows; `verifyAuditChain()` (`securityUtils.js:555-594`) only *reports* tampering, it cannot prevent it. The authoritative protection relies entirely on the server-side `audit_log`/`audit_verify` functions (`base44Client.js:1099-1143`) — in browser-only/local mode the chain conveys no real tamper evidence. Documented as intentional in `securityUtils.js:465-475`.

- **Race condition in chain linking:** `createAuditEntry` reads the chain tip with `orderBy('created_date').reverse().first()` (`securityUtils.js:543`) then hashes over that `previous_hash`. Two concurrent writers can both read the same last hash and produce two rows sharing one parent → a false chain break on verify. Acknowledged as residual risk in `LAUNCH_READINESS_CHECKLIST.md:280`. Additionally, multiple rows can share the same `created_date` millisecond (all use `new Date().toISOString()`), making the `created_date` ordering non-deterministic for the chain traversal.

**(3) Race conditions / CRDT correctness**

- `src/lib/crdtSync.js:50-58,75,84,93,99,106,110,118,122` and `151,167,176,187` — **critical LWW-ordering bug: dots are compared as strings.** `makeDot` returns `` `${nodeId}:${seq}` `` and every LWW/ORMap add/remove/merge/deltaSince uses `existing.dot <= dot` (string compare). Lexicographically `"node:10" < "node:2"` (because `'1' < '2'`), so once a node produces its 10th event, seq-10 is treated as *older* than seq-2. A later write with a lower tens-digit seq will override a higher one, corrupting last-writer-wins resolution across concurrent replicas. `parseDot` (L55-58) parses correctly but the numeric result is never used for comparison.

- `src/lib/crdtSync.js:283-290` — `mergeRemote` returns `false` and silently **drops** a remote delta when the local entity does not yet exist (no auto-create). An entity created concurrently on another peer is lost, not merged.

- `src/lib/crdtSync.js:221-227` — `ShiftCRDT.applyUpdate` calls `clock.increment(nodeId)` (L222) *before* the per-field `map.set(..., nodeId, clock)` loop (L224). Because each `set` calls `makeDot(nodeId, clock)` then increments again, every field in one update gets a different seq but the pre-increment is redundant/wrong relative to the single-dot-per-update intent — combined with the string-compare bug this further scrambles ordering.

- `src/lib/realtime.js:129-134` — the polling invalidator runs every `pollMs` (2500ms default) in *every* enabled tab even when nothing changed, triggering `invalidateQueries` churn across all open tabs. Not data-corrupting, but a constant background refetch load; also the `localStorage` fallback (`publishChange` L49-53) is last-writer-wins, so a tab can miss an intermediate update (masked by the poll).

- `settingsBus.js` — no race: single-threaded version bump + listener Set with per-listener try/catch (L19-28). No issue.

- `ySync.js:19-23` — `set` persists the whole map on every change (L22); no batching/atomicity, so concurrent writers can overwrite each other's full-map snapshots. Minor, unthrottled.

**(4) Performance**

- `src/api/localDb.js` itself is **schema-only** (no query code), so it is not the scan source. The full-table `toArray()` scans live in `base44Client.js`: unscoped list/query fallback `L647/658/684/861` (`toArray()` over the whole table when no index plan matches), `handleLocalAuditList` `L1642-1645` (`AuditLog.toArray()` then in-memory filter + slice), `L934/2077` (full `User.toArray()`), `L1322` (`Staff.filter(...).toArray()`), `L1328` (`PayrollRun.filter(...).toArray()`), `L1333` (full `TimecardPunch.toArray()`).
- `src/lib/securityUtils.js:560` — `verifyAuditChain` does `AuditLog.orderBy('created_date').toArray()` (whole table) then an HMAC over every row; this is O(n) but loads all rows into memory and is run on the audit page.
- `src/lib/usePricing.js:38,41-52` — `getPricingConfig()` returns a fresh object every render, and `config` is a `useMemo` dependency, so the forecast recomputes on *every* render even when `rooms/reservations` are unchanged.
- `src/lib/roomBoard.js:106-110` — `roomBoardStats` runs `roomList.some(...)` inside the `dayStays` loop → O(stays × rooms); small but avoidable.
- `src/lib/anomalyDetector.js:556-662` `buildClerkRiskScores` is O(flags+adjustments+refunds), fine; no O(n²) in the anomaly engine.

**(5) Silently swallowed failures**

- `src/lib/auditLogger.js:34-36` and `src/lib/base44Client.js:1115-1117` — both `audit.log` wrappers wrap the entire write in `try { ... } catch { console.error(...) }` and **return normally on failure**. A privileged change (rate override, user action, deletion) that fails to write its audit row proceeds unrecorded; nothing tells the caller the audit trail was not updated. This is the audit-integrity counterpart to immutability: deletion is blocked, but *omission* is silently accepted.
- `src/lib/pricingOverride.js:49-51` — the audit write failure is only `console.warn`'d and the override "succeeds" regardless (compounds finding 1: neither the rate nor a reliable audit record is guaranteed).
- `src/lib/pricingSettings.js:58`, `housekeepingConfig.js` — `localStorage.setItem` in bare `try {} catch {}` (L58) swallows quota/security errors silently (config changes appear saved when they are not).

### Recommendation

Prioritize: (1) `pricingOverride.applyDynamicRateOverride` not persisting the rate; (2) `crdtSync` string dot comparison and `mergeRemote` dropping unknown-entity deltas; (3) audit write failures swallowed in `auditLogger`/`base44Client.audit.log`; (4) `roomBoard.roomTile` operator-precedence bug; (5) `computeOptimalElasticPrice` exponent error. The audit-immutability finding is partially by-design (public-salt local chain, server authoritative) but the swallowed-write path and the `created_date`-tip race are genuine gaps worth surfacing.

### Not covered / Uncertain

- `decimal.js` (the money arithmetic helpers) was referenced but not audited — formulas were assessed at call sites only.
- The server-side functions `base44/functions/audit_log/entry.js`, `audit_verify/entry.js`, and `audit_clear/entry.js` were not fully read; immutability conclusions there are based on the client comment blocks (`base44Client.js:1125-1144`) and the checklist, not the server source.
- I did not verify every caller of `predictDemand` to confirm the `NaN` case is actually reachable in production (the object-vs-number shape is inferred from the function body and `computeBookingPace`).
- The anomaly/clerk-audit path beyond `detectClerkAnomalies` (scanAdjustmentsRefunds in reportParsers.js) was not opened; rule logic inside anomalyDetector.js was fully read.

## Compressed Report (what the parent actually received)

<HYDRATION_REPORT>
I'll start by enumerating the target scope and reading the files.Let me start reading the core files. I'll get skeletons first to gauge sizes, then read fully.The semantic index is offline, so I'll degrade to full-file reads via superbrain_readFiles. Reading the core pricing/business files now.Reading the remaining business-logic files plus the sync/perf targets.The large batches got truncated. Let me read the files that were cut off and the remaining targets individually.Let me read the truncated portions of anomalyDetector and crdtSync, plus the audit immutability core in securityUtils and the db layer.Now let me find the audit immutability core (createAuditEntry, db.audit) and the localDb implementation for full-table scans and audit mutation.Let me read the audit immutability implementation in securityUtils and the db guard + localDb.Let me confirm the immutable-table guard is actually invoked on write paths, and check the race-condition dot comparison context.I now have complete coverage of all requested files. Here is the audit.

## Exploration Report

**Confidence**: HIGH — index was offline, so every file was read in full via `superbrain_readFile`; all findings are direct from source with exact lines.
**Files Examined**: hotel.js, pricingEngine.js, pricingOverride.js, pricingSettings.js, usePricing.js, forecasting.js, housekeepingService.js, housekeepingConfig.js, roomBoard.js, transactionNorm.js, anomalyDetector.js (699 lines, read whole), alertEngine.js, auditLogger.js, reputationService.js, commissionRates.js, expenseCategories.js, RevenueReconciliation.js, crdtSync.js, ySync.js, settingsBus.js, realtime.js, securityUtils.js (audit section), base44Client.js (audit/immutability/list sections), localDb.js.
**Key Tool Path**: listDirectory → superbrain_readFile (full files, multiple batches) → targeted reads → grep.

### Findings

**(1) Logic bugs**

- `src/lib/pricingOverride.js:30-53` — **`applyDynamicRateOverride` never persists the new rate.** It builds `updatePayload` (L30-37) but the only side effect is the `db.functions.invoke('audit_log')` call (L41-48) and returning the payload. There is no `db.put/update` for `current_rate` anywhere. The operator sees "success" (audit row written) but the room rate in the store is never changed. Functional bug.

- `src/lib/pricingEngine.js:135-138` — `isWeekend` returns `true` for `day===0 || 5 || 6` (Sun, Fri, Sat), but `pricingSettings.js:33-34` documents the weekend uplift as "Weekend covers **Fri+Sat** night stays". A Sunday night stay therefore gets the 1.2× weekday/weekend seasonality uplift that the config's own comment says should not apply. Inconsistency between the engine and the documented intent.

- `src/lib/pricingEngine.js:185-189` — `computeOptimalElasticPrice` computes `multiplier = (targetOccupancy/currentOccupancy)^(-elasticity)`. The correct inverted demand relation is `(Q_target/Q_current)^(-1/ε)`. Using exponent `-ε` (e.g. −1.5) instead of `-1/ε` (≈−0.67) overstates the magnitude of the price move by a factor of ε for any given occupancy gap. Direction is right; magnitude is wrong.

- `src/lib/forecasting.js:5-10` — `predictDemand` maps `d.occupancy` (L6), i.e. it expects objects with an `.occupancy` field. If a caller passes an array of raw numbers (the shape `computeBookingPace` in pricingEngine.js:196-198 produces/consumes), `d.occupancy` is `undefined`, the sum becomes `NaN`, and `predictDemand` returns `NaN`. Also `trend = events.length ? 0.1 : 0` (L8) is a hardcoded constant applied whenever *any* event exists, regardless of event count/size — not a real demand signal.

- `src/lib/roomBoard.js:138` — **operator-precedence bug** in `roomTile`: `maintenance: room.maintenance || room.status === "out_of_service" ? room.status : "available"` parses as `(room.maintenance || (room.status==="out_of_service")) ? room.status : "available"`. Because `room.maintenance` is almost always a truthy string (e.g. `"available"` from `generateRoomRegister` L188-189), the ternary takes the `? room.status` branch and `maintenance` is set to `room.status` for every room, defeating the field entirely (an available room shows `maintenance: "available"`, but a dirty/occupied room also shows its own status, and `available` never appears here).

- `src/lib/hotel.js:206,209` — `inventoryInScope` sums `Number(p.rooms) || PROPERTY.rooms` per property. A property that legitimately has `rooms: 0` (or a null value) is silently counted as 100 rooms (the default), inflating total inventory for multi-property selections.

- `src/lib/pricingEngine.js:80-85` — `blendWithCompetitor` computes `(1-w)*rateCents + w*comp` in floating point over integer-cents inputs (L84), despite the module's stated integer-cents invariant; the result is `Math.round`ed so it is not a correctness error, only a style/consistency drift.

- `src/lib/roomBoard.js:283-285` (in `buildPricingForecast`, pricingEngine.js actually) — projected revenue splits inventory **equally** across room types (`typeRooms = Math.round(rooms.length / presentTypes.length)`) and applies every type's rate to that equal share, ignoring real per-type inventory. The aggregate room count is correct but revenue is weighted by an equal split rather than actual type mix. Approximation, not strictly wrong; flag as aggregation simplification.

**(2) Audit log immutability**

- The proxy guard is real: `base44Client.js:579-594` defines `PROTECTED_IMMUTABLE_TABLES = ['AuditLog']` and `throwIfProtected()`, which is invoked on update (L729), put (L753), add (L784), delete (L814), and bulk write (L847). `audit.clear` is refused at `base44Client.js:1648-1653`. So the **app's own write API** cannot mutate/delete audit rows.

- **But immutability is not actually enforced at rest:** rows live in IndexedDB (`localDb.js:95` `AuditLog`), which any page script can write to directly, bypassing the proxy. The local tamper-evidence uses a **public, non-secret HMAC salt** (`securityUtils.js:496` `AUDIT_CHAIN_SALT`), so anyone with browser console access can recompute valid hashes and rewrite/delete rows; `verifyAuditChain()` (`securityUtils.js:555-594`) only *reports* tampering, it cannot prevent it. The authoritative protection relies entirely on the server-side `audit_log`/`audit_verify` functions (`base44Client.js:1099-1143`) — in browser-only/local mode the chain conveys no real tamper evidence. Documented as intentional in `securityUtils.js:465-475`.

- **Race condition in chain linking:** `createAuditEntry` reads the chain tip with `orderBy('created_date').reverse().first()` (`securityUtils.js:543`) then hashes over that `previous_hash`. Two concurrent writers can both read the same last hash and produce two rows sharing one parent → a false chain break on verify. Acknowledged as residual risk in `LAUNCH_READINESS_CHECKLIST.md:280`. Additionally, multiple rows can share the same `created_date` millisecond (all use `new Date().toISOString()`), making the `created_date` ordering non-deterministic for the chain traversal.

**(3) Race conditions / CRDT correctness**

- `src/lib/crdtSync.js:50-58,75,84,93,99,106,110,118,122` and `151,167,176,187` — **critical LWW-ordering bug: dots are compared as strings.** `makeDot` returns `` `${nodeId}:${seq}` `` and every LWW/ORMap add/remove/merge/deltaSince uses `existing.dot <= dot` (string compare). Lexicographically `"node:10" < "node:2"` (because `'1' < '2'`), so once a node produces its 10th event, seq-10 is treated as *older* than seq-2. A later write with a lower tens-digit seq will override a higher one, corrupting last-writer-wins resolution across concurrent replicas. `parseDot` (L55-58) parses correctly but the numeric result is never used for comparison.

- `src/lib/crdtSync.js:283-290` — `mergeRemote` returns `false` and silently **drops** a remote delta when the local entity does not yet exist (no auto-create). An entity created concurrently on another peer is lost, not merged.

- `src/lib/crdtSync.js:221-227` — `ShiftCRDT.applyUpdate` calls `clock.increment(nodeId)` (L222) *before* the per-field `map.set(..., nodeId, clock)` loop (L224). Because each `set` calls `makeDot(nodeId, clock)` then increments again, every field in one update gets a different seq but the pre-increment is redundant/wrong relative to the single-dot-per-update intent — combined with the string-compare bug this further scrambles ordering.

- `src/lib/realtime.js:129-134` — the polling invalidator runs every `pollMs` (2500ms default) in *every* enabled tab even when nothing changed, triggering `invalidateQueries` churn across all open tabs. Not data-corrupting, but a constant background refetch load; also the `localStorage` fallback (`publishChange` L49-53) is last-writer-wins, so a tab can miss an intermediate update (masked by the poll).

- `settingsBus.js` — no race: single-threaded version bump + listener Set with per-listener try/catch (L19-28). No issue.

- `ySync.js:19-23` — `set` persists the whole map on every change (L22); no batching/atomicity, so concurrent writers can overwrite each other's full-map snapshots. Minor, unthrottled.

**(4) Performance**

- `src/api/localDb.js` itself is **schema-only** (no query code), so it is not the scan source. The full-table `toArray()` scans live in `base44Client.js`: unscoped list/query fallback `L647/658/684/861` (`toArray()` over the whole table when no index plan matches), `handleLocalAuditList` `L1642-1645` (`AuditLog.toArray()` then in-memory filter + slice), `L934/2077` (full `User.toArray()`), `L1322` (`Staff.filter(...).toArray()`), `L1328` (`PayrollRun.filter(...).toArray()`), `L1333` (full `TimecardPunch.toArray()`).
- `src/lib/securityUtils.js:560` — `verifyAuditChain` does `AuditLog.orderBy('created_date').toArray()` (whole table) then an HMAC over every row; this is O(n) but loads all rows into memory and is run on the audit page.
- `src/lib/usePricing.js:38,41-52` — `getPricingConfig()` returns a fresh object every render, and `config` is a `useMemo` dependency, so the forecast recomputes on *every* render even when `rooms/reservations` are unchanged.
- `src/lib/roomBoard.js:106-110` — `roomBoardStats` runs `roomList.some(...)` inside the `dayStays` loop → O(stays × rooms); small but avoidable.
- `src/lib/anomalyDetector.js:556-662` `buildClerkRiskScores` is O(flags+adjustments+refunds), fine; no O(n²) in the anomaly engine.

**(5) Silently swallowed failures**

- `src/lib/auditLogger.js:34-36` and `src/lib/base44Client.js:1115-1117` — both `audit.log` wrappers wrap the entire write in `try { ... } catch { console.error(...) }` and **return normally on failure**. A privileged change (rate override, user action, deletion) that fails to write its audit row proceeds unrecorded; nothing tells the caller the audit trail was not updated. This is the audit-integrity counterpart to immutability: deletion is blocked, but *omission* is silently accepted.
- `src/lib/pricingOverride.js:49-51` — the audit write failure is only `console.warn`'d and the override "succeeds" regardless (compounds finding 1: neither the rate nor a reliable audit record is guaranteed).
- `src/lib/pricingSettings.js:58`, `housekeepingConfig.js` — `localStorage.setItem` in bare `try {} catch {}` (L58) swallows quota/security errors silently (config changes appear saved when they are not).

### Recommendation

Prioritize: (1) `pricingOverride.applyDynamicRateOverride` not persisting the rate; (2) `crdtSync` string dot comparison and `mergeRemote` dropping unknown-entity deltas; (3) audit write failures swallowed in `auditLogger`/`base44Client.audit.log`; (4) `roomBoard.roomTile` operator-precedence bug; (5) `computeOptimalElasticPrice` exponent error. The audit-immutability finding is partially by-design (public-salt local chain, server authoritative) but the swallowed-write path and the `created_date`-tip race are genuine gaps worth surfacing.

### Not covered / Uncertain

- `decimal.js` (the money arithmetic helpers) was referenced but not audited — formulas were assessed at call sites only.
- The server-side functions `base44/functions/audit_log/entry.js`, `audit_verify/entry.js`, and `audit_clear/entry.js` were not fully read; immutability conclusions there are based on the client comment blocks (`base44Client.js:1125-1144`) and the checklist, not the server source.
- I did not verify every caller of `predictDemand` to confirm the `NaN` case is actually reachable in production (the object-vs-number shape is inferred from the function body and `computeBookingPace`).
- The anomaly/clerk-audit path beyond `detectClerkAnomalies` (scanAdjustmentsRefunds in reportParsers.js) was not opened; rule logic inside anomalyDetector.js was fully read.

---
[Exploration: Explore (deepseek-v4-flash) | 126606ms | 11 turns | 25 tools | 84242in/12795out tokens | status: completed]
</HYDRATION_REPORT>

CRITICAL: Write your final answer DIRECTLY from the findings above. Do NOT re-page files the sub-agent already covered (no whole-file skeleton/symbols/read on those paths). To confirm one specific cited line, a narrow sb_read_code range (<=40 lines) is allowed. Files the report did NOT cover stay fully readable — locate them with superbrain_listDirectory / superbrain_search instead of guessing.

---
**Explore coverage (harness):** opened 1 file(s) over 11 turn(s). listed but not opened: src/lib. Treat any subsystem this report does not explicitly cover as UNVERIFIED, not absent - confirm with a direct read or say what you could not verify.
