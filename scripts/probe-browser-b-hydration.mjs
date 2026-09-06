import 'fake-indexeddb/auto';
import {
  assertEqual,
  assert,
  makeDb,
  makeEnv,
  makeRunner,
  seedUser,
  scopeAll,
} from "./_worker-testkit.mjs";
import { handleBusinessSyncRequest } from "../worker/business-sync.js";
import localDb from "../src/api/localDb.js";
import {
  createBusinessSyncClient,
  BUSINESS_ENTITIES,
  inspectLocalBusinessData,
} from "../src/api/businessSync.js";

const run = makeRunner("probe-browser-b-hydration");

const db = makeDb();
db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_1", "Test Account", "2026-01-01");
seedUser(db, { id: "owner", email: "owner@test.local", role: "owner", mode: "all" });
const env = makeEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });
const ownerScope = scopeAll([]);
ownerScope.user.id = "owner";

// Fetch bridge simulating /api/business-sync requests
async function makeRequest(path, options = {}) {
  const url = new URL(`https://boston-project.test/api/${path}`);
  const request = new Request(url, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      ...(options.headers || {}),
    },
    body: options.body,
  });
  const parts = url.pathname.split("/").filter(Boolean);
  const response = await handleBusinessSyncRequest(request, env, ownerScope, url, parts);
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error(json?.error || `Request failed (${response.status})`);
    err.status = response.status;
    err.body = json;
    throw err;
  }
  return json;
}

await run.check("What happens when runInTransaction is called with no active dataset in D1?", async () => {
  const client = createBusinessSyncClient({ request: makeRequest });
  const wrappedOccupancy = client.wrapEntity('OccupancyDay', {
    create: async (data) => data,
    get: async (id) => null,
  });

  let error = null;
  try {
    await client.api.runTransaction(async () => {
      await wrappedOccupancy.create({ id: 101, property_id: 1, date: "2026-03-01", total_revenue: 100 });
    });
  } catch (err) {
    error = err;
  }

  console.log("Result of runTransaction on empty D1:", error ? `Error: ${error.message} (status ${error.status})` : "Success");
  assert(error, "runTransaction should fail when D1 has no active dataset");
  assertEqual(error.status, 409);
  assertEqual(error.message, "no active business dataset");
});

run.done();
if (process.exitCode) process.exit(1);
process.exit(0);
