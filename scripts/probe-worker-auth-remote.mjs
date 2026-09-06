// Real Cloudflare-runtime regression for the Worker credential boundary.
// Creates an isolated temporary D1, uses remote preview (not production), and
// removes every temporary Cloudflare/local resource in a finally block.

import { randomBytes } from "node:crypto";
import { writeSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCredential } from "../worker/password-credential.js";
import { isTransientD1ProvisioningOutage } from "./_cloudflare-transient.mjs";
import { REPO_ROOT } from "./_repo-root.mjs";

const npxCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
const suffix = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const database = `rri-auth-regression-${suffix}`;
const work = await mkdtemp(path.join(tmpdir(), "rri-auth-remote-"));
const config = path.join(work, "wrangler.jsonc");
const envFile = path.join(work, ".env");
const seedFile = path.join(work, "seed.sql");
const pepper = randomBytes(48).toString("base64url");
const password = `Remote-${randomBytes(24).toString("base64url")}!9aA`;
let databaseId = "";
let dev = null;
let serverOutput = "";
const checks = [];

function safeSql(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function check(name, condition, detail = "") {
  checks.push({ name, pass: !!condition, detail });
  if (!condition) throw new Error(`${name} failed${detail ? ` (${detail})` : ""}`);
}
function wrangler(args, options = {}) {
  const result = spawnSync(process.execPath, [npxCli, "wrangler", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) throw new Error(`Wrangler failed (${result.status}): ${String(result.stderr || result.stdout).slice(-1200)}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}
async function waitForReady() {
  const deadline = Date.now() + 90_000;
  while (!/Ready on http:\/\/127\.0\.0\.1:8793/.test(serverOutput)) {
    if (dev?.exitCode !== null) throw new Error(`Remote preview exited early: ${serverOutput.slice(-1200)}`);
    if (Date.now() > deadline) throw new Error(`Timed out waiting for remote preview: ${serverOutput.slice(-1200)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
async function request(body) {
  const response = await fetch("http://127.0.0.1:8793/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, cookie: response.headers.get("set-cookie") || "", body: await response.text() };
}

try {
  // F-076: only the pre-assertion provisioning call may SKIP. A transient
  // Cloudflare control-plane refusal (`Authentication error [code: 10000]`
  // on a valid token) means no auth assertion ran, so it prints one SKIP
  // line and exits 0. Every other wrangler failure rethrows and fails.
  // process.exit bypasses the outer finally, so the (still empty) work dir
  // is removed here; databaseId is "" so there is nothing remote to delete.
  let created;
  try {
    created = wrangler(["d1", "create", database, "--location", "enam"]);
  } catch (error) {
    if (!isTransientD1ProvisioningOutage(error)) throw error;
    // Synchronous write: process.exit below can truncate a pipe-buffered
    // console.log, and this line is the whole verdict the runner classifies.
    writeSync(1, "SKIP: Cloudflare control plane transiently refused the temporary D1 provisioning (Authentication error [code: 10000]); no Worker auth assertion ran. Re-run to retry.\n");
    await rm(work, { recursive: true, force: true });
    process.exit(0);
  }
  databaseId = created.match(/"database_id":\s*"([0-9a-f-]+)"/i)?.[1] || "";
  if (!databaseId) throw new Error("Could not resolve temporary D1 id.");
  await writeFile(config, JSON.stringify({
    name: database,
    main: path.join(REPO_ROOT, "worker", "index.js").replaceAll("\\", "/"),
    compatibility_date: "2026-08-31",
    preview_urls: false,
    d1_databases: [{ binding: "DB", database_name: database, database_id: databaseId }],
    vars: { ENVIRONMENT: "regression", ENABLE_D1_DATA_API: "false" },
    secrets: { required: ["PASSWORD_PEPPER_V1"] },
    observability: { enabled: true, head_sampling_rate: 1, logs: { enabled: true, head_sampling_rate: 1 } },
  }, null, 2), { mode: 0o600 });
  await writeFile(envFile, `PASSWORD_PEPPER_V1=${pepper}\n`, { mode: 0o600 });
  wrangler(["d1", "execute", database, "--remote", "--config", config, "--file", path.join(REPO_ROOT, "worker", "schema.sql")]);

  const valid = await createCredential(password, pepper);
  const unsupported = valid.encoded.replace("$v=1$", "$v=99$");
  const statements = [
    `INSERT INTO account (id,name,created_date) VALUES ('REMOTE_ACCOUNT','Remote regression',datetime('now'));`,
    `INSERT INTO user (id,account_id,username,display_name,email,role,property_access_mode,permissions,is_active,is_locked,must_change_password,mfa_enabled,email_confirmed,password_hash,salt,mfa_last_counter,failed_login_count,created_date,updated_date) VALUES ('REMOTE_VALID','REMOTE_ACCOUNT','remote-valid','Remote valid','remote-valid@example.invalid','owner','all','{}',1,0,0,0,1,${safeSql(valid.encoded)},${safeSql(valid.salt)},-1,0,datetime('now'),datetime('now'));`,
    `INSERT INTO user (id,account_id,username,display_name,email,role,property_access_mode,permissions,is_active,is_locked,must_change_password,mfa_enabled,email_confirmed,password_hash,salt,mfa_last_counter,failed_login_count,created_date,updated_date) VALUES ('REMOTE_UNSUPPORTED','REMOTE_ACCOUNT','remote-unsupported','Remote unsupported','remote-unsupported@example.invalid','owner','all','{}',1,0,0,0,1,${safeSql(unsupported)},${safeSql(valid.salt)},-1,0,datetime('now'),datetime('now'));`,
    `INSERT INTO user (id,account_id,username,display_name,email,role,property_access_mode,permissions,is_active,is_locked,must_change_password,mfa_enabled,email_confirmed,password_hash,salt,mfa_last_counter,failed_login_count,created_date,updated_date) VALUES ('REMOTE_LEGACY','REMOTE_ACCOUNT','remote-legacy','Remote legacy','remote-legacy@example.invalid','owner','all','{}',1,0,0,0,1,'$pbkdf2$legacy','legacy-salt',-1,0,datetime('now'),datetime('now'));`,
  ].join("\n");
  check("plaintext absent from D1 seed", !statements.includes(password));
  await writeFile(seedFile, statements, { mode: 0o600 });
  wrangler(["d1", "execute", database, "--remote", "--config", config, "--file", seedFile]);

  dev = spawn(process.execPath, [npxCli, "wrangler", "dev", "--remote", "--config", config, "--env-file", envFile, "--port", "8793", "--ip", "127.0.0.1", "--show-interactive-dev-session", "false"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  for (const stream of [dev.stdout, dev.stderr]) stream.on("data", (chunk) => { serverOutput += chunk.toString(); });
  await waitForReady();

  const malformed = await request("{");
  check("malformed input is controlled 4xx", malformed.status === 400, `status=${malformed.status}`);
  const nonexistent = await request(JSON.stringify({ identifier: "nobody@example.invalid", password }));
  check("nonexistent user rejects without 500", nonexistent.status === 401, `status=${nonexistent.status}`);
  const wrong = await request(JSON.stringify({ identifier: "remote-valid", password: `${password}-wrong` }));
  check("wrong password rejects without 500", wrong.status === 401, `status=${wrong.status}`);
  const accepted = await request(JSON.stringify({ identifier: "remote-valid", password }));
  check("valid password creates a session", accepted.status === 200 && /__Host-rri_session=/.test(accepted.cookie), `status=${accepted.status}`);
  const legacy = await request(JSON.stringify({ identifier: "remote-legacy", password }));
  check("legacy format fails closed", legacy.status === 401, `status=${legacy.status}`);
  const unknown = await request(JSON.stringify({ identifier: "remote-unsupported", password }));
  check("unsupported version fails closed", unknown.status === 401, `status=${unknown.status}`);
  check("remote runtime logged no auth 500", !/POST \/api\/auth\/login 500/.test(serverOutput));
} finally {
  if (dev && dev.exitCode === null) {
    if (process.platform === "win32") {
      spawnSync("C:\\Windows\\System32\\taskkill.exe", ["/pid", String(dev.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    } else {
      dev.kill("SIGTERM");
    }
    await Promise.race([new Promise((resolve) => dev.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
  if (databaseId) {
    try { wrangler(["d1", "delete", database, "--skip-confirmation"]); } catch (error) { checks.push({ name: "temporary D1 cleanup", pass: false, detail: String(error.message).slice(0, 300) }); }
  }
  await rm(work, { recursive: true, force: true });
}

for (const item of checks) console.log(`${item.pass ? "PASS" : "FAIL"} ${item.name}${item.detail ? ` (${item.detail})` : ""}`);
const failures = checks.filter((item) => !item.pass);
console.log(`${failures.length ? "FAILED" : "PASSED"}: probe-worker-auth-remote: ${checks.length - failures.length} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
