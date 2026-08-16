import { register } from "node:module";
register(new URL("./resolve-base44.mjs", import.meta.url));

const auditListFn = (await import("../base44/functions/audit_list/entry.js")).default;
const sdk = await import("./stubs/base44-sdk.mjs");
import crypto from "node:crypto";

const token = "mock_session_token";
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

const db = sdk.__installBackend({
  users: [
    {
      id: "u_admin2",
      is_active: true,
      is_locked: false,
      role: "admin",
      property_access: ["prop_2"] // RESTRICTED ADMIN
    }
  ],
  sessions: [
    {
      user_id: "u_admin2",
      token_hash: tokenHash,
      is_revoked: false,
      expires_at: new Date(Date.now() + 10000).toISOString()
    }
  ]
});

console.log("=== 1. Non-object filter causes 500 ===");
try {
  const req1 = {
    headers: new Headers({ "cookie": `base44_session=${token}` }),
    json: async () => ({ filter: "not_an_object" })
  };
  
  let capturedFilter = null;
  db.AuditLog.filter = async (filterObj) => {
    capturedFilter = filterObj;
    if (typeof filterObj !== "object" || filterObj === null) {
      throw new Error("ORM 500: filter must be an object");
    }
    return [];
  };
  
  const res1 = await auditListFn(req1);
  const data1 = await res1.text();
  if (res1.status === 400) {
    console.log("PASS: 400 Bad Request returned for non-object filter.");
  } else {
    console.log("FAIL: Expected 400, got", res1.status, data1);
  }
} catch (e) {
  console.error("FAIL:", e.message);
}

console.log("\n=== 2. Admin restricted to prop_2 queries without filter ===");
try {
  let capturedFilter2 = null;
  db.AuditLog.filter = async (filterObj) => {
    capturedFilter2 = filterObj;
    return [];
  };

  const req2 = {
    headers: new Headers({ "cookie": `base44_session=${token}` }),
    json: async () => ({ filter: {} })
  };
  
  const res2 = await auditListFn(req2);
  const data2 = await res2.text();
  
  if (res2.status === 400) {
    console.log("PASS: 400 Bad Request returned for missing property_id.");
  } else {
    console.log("FAIL: Expected 400, got", res2.status, data2);
    if (!capturedFilter2.property_id || capturedFilter2.property_id !== "prop_2") {
      console.log("FAIL: Backend queried AuditLog without enforcing property_access!");
    }
  }
} catch (e) {
  console.error("Crash 2:", e.message);
}
