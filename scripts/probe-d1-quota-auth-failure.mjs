// scripts/probe-d1-quota-auth-failure.mjs
// Deterministic fault injection probe for D1 quota exhaustion during auth.
// Verifies:
// 1. Quota error during login returns HTTP 503 D1_SERVICE_QUOTA_EXHAUSTED.
// 2. No session cookie is issued.
// 3. User failed_login_count is NOT incremented (no false lockout).
// 4. Quota error during session authentication returns 503 service unavailable.
// 5. Security fails closed without authentication bypass.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handleAppAuthRequest, authenticateAppSession } from "../worker/app-auth.js";
import { createCredential } from "../worker/password-credential.js";
import { isD1QuotaError } from "../worker/db.js";

const SCHEMA_PATH = fileURLToPath(new URL("../worker/schema.sql", import.meta.url));

function createInMemoryD1(quotaFailureModes = {}) {
  const mem = new DatabaseSync(":memory:");
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  mem.exec(schema);

  const env = {
    PASSWORD_PEPPER_V1: "test-pepper-value-for-offline-testing-1234567890",
    SESSION_TTL_MS: 3600000,
    DB: {
      prepare(sql) {
        return {
          bind(...params) {
            const normalized = params.map((p) =>
              p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p
            );
            return {
              async first() {
                if (quotaFailureModes.read) {
                  throw new Error("D1_ERROR: daily row read limit reached for this account");
                }
                const row = mem.prepare(sql).get(...normalized);
                return row === undefined ? null : row;
              },
              async all() {
                if (quotaFailureModes.read) {
                  throw new Error("D1_ERROR: daily row read limit reached for this account");
                }
                const rows = mem.prepare(sql).all(...normalized);
                return { results: rows };
              },
              async run() {
                if (quotaFailureModes.write) {
                  throw new Error("D1_ERROR: daily row write limit exceeded (code 10042)");
                }
                const info = mem.prepare(sql).run(...normalized);
                return { meta: { changes: Number(info.changes) } };
              },
            };
          },
        };
      },
      async batch(statements) {
        if (quotaFailureModes.write || quotaFailureModes.batch) {
          throw new Error("D1_ERROR: daily row write limit exceeded");
        }
        mem.exec("BEGIN");
        try {
          const results = [];
          for (const stmt of statements) {
            const info = await stmt.run();
            results.push(info);
          }
          mem.exec("COMMIT");
          return results;
        } catch (err) {
          mem.exec("ROLLBACK");
          throw err;
        }
      },
    },
  };

  return { mem, env };
}

async function run() {
  console.log("Starting probe-d1-quota-auth-failure...");

  // 1. Verify isD1QuotaError classifier
  assert.equal(isD1QuotaError(new Error("D1_ERROR: daily row write limit exceeded")), true);
  assert.equal(isD1QuotaError(new Error("daily row read limit exceeded")), true);
  assert.equal(isD1QuotaError(new Error("D1 quota exceeded")), true);
  assert.equal(isD1QuotaError(new Error("UNIQUE constraint failed")), false);
  assert.equal(isD1QuotaError(null), false);
  console.log("✓ isD1QuotaError correctly identifies Cloudflare D1 quota errors");

  // 2. Test Login Under D1 Write Quota Exhaustion
  {
    const pepper = "test-pepper-value-for-offline-testing-1234567890";
    const testPassword = "ValidPassword123!";
    const cred = await createCredential(testPassword, pepper);
    const userId = "test_user_001";
    const now = new Date().toISOString();

    const seeded = createInMemoryD1({ batch: true, write: true });
    seeded.env.PASSWORD_PEPPER_V1 = pepper;
    seeded.mem.prepare("INSERT INTO account (id, name, created_date) VALUES ('default', 'Default', ?)").run(now);
    seeded.mem.prepare(`
      INSERT INTO user (
        id, account_id, username, display_name, email, role,
        property_access_mode, is_active, is_locked, password_hash,
        salt, failed_login_count, created_date, updated_date
      ) VALUES (?, 'default', 'owner', 'Owner User', 'owner@example.com', 'owner', 'all', 1, 0, ?, ?, 0, ?, ?)
    `).run(
      userId,
      cred.encoded,
      cred.salt,
      now,
      now
    );

    const loginReq = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify({ identifier: "owner@example.com", password: testPassword }),
    });

    const response = await handleAppAuthRequest(loginReq, seeded.env, "/api/auth/login");
    assert.equal(response.status, 503, `Expected status 503, got ${response.status}`);

    // Cookie must NOT be set
    const cookie = response.headers.get("Set-Cookie");
    assert.equal(cookie, null, "Set-Cookie must not be present on quota error");

    const body = await response.json();
    assert.equal(body.code, "D1_SERVICE_QUOTA_EXHAUSTED");
    assert.match(body.error, /server|database|capacity|reset/i);
    // Crucial: Must NOT state "invalid password" or "invalid email"
    assert.doesNotMatch(body.error, /invalid (?:email|password|credentials)/i);

    // Verify user failed_login_count did NOT increment
    const userRow = seeded.mem.prepare("SELECT failed_login_count, is_locked FROM user WHERE id=?").get(userId);
    assert.equal(userRow.failed_login_count, 0, "failed_login_count must NOT be incremented on quota error");
    assert.equal(userRow.is_locked, 0, "user must NOT be locked on quota error");
    console.log("✓ Login under write quota failure returns 503, no cookie, and does NOT increment failed logins");
  }

  // 3. Test Session Authentication Under D1 Read Quota Exhaustion
  {
    const { env: readQuotaEnv } = createInMemoryD1({ read: true });
    const req = new Request("http://localhost/api/business-sync/snapshot", {
      headers: {
        Cookie: "__Host-rri_session=valid-session-token-123",
      },
    });

    const authResult = await authenticateAppSession(req, readQuotaEnv);
    assert.equal(authResult.ok, false, "Auth must fail closed");
    assert.equal(authResult.serviceUnavailable, true, "Must flag serviceUnavailable on quota error");
    assert.equal(authResult.principal, undefined, "Principal must not be populated");
    console.log("✓ Session authentication under read quota failure returns serviceUnavailable and fails closed");
  }

  console.log("PASSED: probe-d1-quota-auth-failure passed all checks");
}

run().catch((err) => {
  console.error("FAILED: probe-d1-quota-auth-failure", err);
  process.exit(1);
});
