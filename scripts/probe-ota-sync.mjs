import { assert } from "console";
import { register } from "node:module";
register(new URL("./resolve-alias.mjs", import.meta.url));

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

// Now we can safely import our app modules
const { db } = await import("../src/api/base44Client.js");
const localDb = (await import("../src/api/localDb.js")).default;
// db.entities fails closed for an unauthenticated caller (blocker B3), so the
// probe has to sign in before it reads or writes a single row.
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");
await signInAsAllPropertyOwner();

const TEST_PROP = "prop-test-ota";
let pass = 0;
let failed = 0;

function record(condition) {
  if (condition) pass++;
  else failed++;
}

async function run() {
  console.log(`\n=== Testing OTA Sync for ${TEST_PROP} ===`);
  
  // 1. Connect
  await db.integrations.ChannelManager.Connect("Booking.com", {});
  await db.integrations.ChannelManager.Connect("Expedia", {});

  // 2. Pull Reservations
  const reservations = await db.integrations.ChannelManager.PullReservations(TEST_PROP);
  console.log(`Pulled ${reservations.length} reservations`);
   record(reservations.length === 2);
   assert(reservations.length === 2, "Expected 2 mock reservations");

  // 3. Write to DB
  for (const res of reservations) {
    await db.entities.Reservation.create({
      property_id: TEST_PROP,
      channel: res.channel,
      confirmation_num: res.confirmation_num,
      check_in: res.check_in,
      check_out: res.check_out,
      status: res.status,
      room_type_id: "Standard",
      created_date: new Date().toISOString()
    });
  }

  // 4. Verify in DB
  const stored = await localDb.Reservation.where({ property_id: TEST_PROP }).toArray();
  console.log(`Stored ${stored.length} reservations in localDb`);
   record(stored.length === 2);
   assert(stored.length === 2, "Reservations were not saved to DB correctly");

  const bookingCom = stored.find(r => r.channel === 'Booking.com');
  const expedia = stored.find(r => r.channel === 'Expedia');
  
   record(bookingCom);
   assert(bookingCom, "Booking.com reservation missing");
   record(expedia);
   assert(expedia, "Expedia reservation missing");

  // 5. Test Upsert/Idempotency
  console.log(`Testing Upsert Idempotency...`);
  for (const res of reservations) {
    const existing = await db.entities.Reservation.filter({ confirmation_num: res.confirmation_num, property_id: TEST_PROP });
    if (existing && existing.length > 0) {
      await db.entities.Reservation.update(existing[0].id, {
        check_in: res.check_in,
        check_out: res.check_out,
        status: res.status,
        room_type_id: "Standard"
      });
    } else {
      await db.entities.Reservation.create({
        property_id: TEST_PROP,
        channel: res.channel,
        confirmation_num: res.confirmation_num,
        check_in: res.check_in,
        check_out: res.check_out,
        status: res.status,
        room_type_id: "Standard",
        created_date: new Date().toISOString()
      });
    }
  }

  const storedAfter = await localDb.Reservation.where({ property_id: TEST_PROP }).toArray();
  console.log(`Stored ${storedAfter.length} reservations after second sync`);
   record(storedAfter.length === 2);
   assert(storedAfter.length === 2, "Upsert failed: duplicate reservations were created");

   console.log(`\n${failed === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${failed} failed`);
   // Guarded: console.assert does not stop the run, so a failed check reaches
   // this line. Unguarded it printed "PASS  OTA Sync logic successfully tested"
   // directly beneath "FAILED: 4 passed, 1 failed".
   if (failed === 0) console.log("\n  PASS  OTA Sync logic successfully tested\n");
   process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error("Test Failed:", e);
  // Reached only by a genuine exception (DB/auth), NOT by a failed check:
  // line 1 imports `assert` from "console", i.e. console.assert, which prints
  // "Assertion failed: ..." to stderr and returns. Before the pass/failed
  // counters existed, all 5 checks here were non-fatal and the file ended in an
  // unconditional process.exit(0) — a broken OTA sync printed
  // "PASS  OTA Sync logic successfully tested" and exited green. Measured after
  // the counters: flipping the first expectation to 99 yields
  // "FAILED: 4 passed, 1 failed" rc=1, and execution continues past the bad
  // check (which is why 4, not 0, still pass). This is the only file in the
  // repo that imports assert from "console".
  failed = failed > 0 ? failed : 1;
  console.error(`\n${failed === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${failed} failed`);
  process.exit(1);
});
