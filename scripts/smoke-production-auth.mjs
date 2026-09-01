// Interactive, fail-closed smoke test for the live production authentication surface.
// The owner password remains memory-only. A disposable non-owner user copies the
// existing verifier server-side for destructive MFA/lockout tests and is deleted
// (with its sessions/challenges) in finally.

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { REPO_ROOT } from "./_repo-root.mjs";

const base = "https://boston-project.divyesh-boston.workers.dev";
const database = "boston-project-production-auth";
const config = path.join(REPO_ROOT, "wrangler.jsonc");
const npxCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
const nonce = randomUUID().replaceAll("-", "");
const tempId = `SMOKE_${nonce}`;
const tempUsername = `codex-smoke-${nonce}`;
const tempEmail = `${tempUsername}@example.invalid`;
const checks = [];
let password = "";
let ownerId = "";

function sql(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function wrangler(args) {
  const result = spawnSync(process.execPath, [npxCli, "wrangler", ...args], {
    cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Wrangler ended by signal ${result.signal}.`);
  if (result.status !== 0) throw new Error(`Wrangler failed (${result.status}): ${String(result.stderr || result.stdout).slice(-800)}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}
function rows(command) {
  const parsed = JSON.parse(wrangler(["d1", "execute", database, "--remote", "--config", config, "--command", command, "--json"]).trim());
  return parsed?.[0]?.results || [];
}
function execute(command) { rows(command); }
function check(name, pass, detail = "") {
  checks.push({ name, pass: !!pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}
function askHidden(label) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error("A real interactive terminal is required.");
  process.stdout.write(label);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      error ? reject(error) : resolve(value);
    };
    const onKey = (character, key) => {
      if (key?.ctrl && key.name === "c") return finish(new Error("Cancelled."));
      if (key?.name === "return" || key?.name === "enter") return finish();
      if (key?.name === "backspace") { value = value.slice(0, -1); return; }
      if (character && !key?.ctrl && !key?.meta) value += character;
    };
    process.stdin.on("keypress", onKey);
  });
}
function cookie(header, name) {
  return String(header || "").split(/,(?=\s*__Host-)/).map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.split(";")[0] || "";
}
function digestToken(cookiePair) {
  const token = cookiePair.slice(cookiePair.indexOf("=") + 1);
  return createHash("sha256").update(token).digest("hex");
}
async function post(pathname, body, cookiePair = "", includeMutationHeader = true) {
  const headers = { "content-type": "application/json", origin: base };
  if (includeMutationHeader) headers["x-requested-with"] = "XMLHttpRequest";
  if (cookiePair) headers.cookie = cookiePair;
  const response = await fetch(`${base}${pathname}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})), setCookie: response.headers.get("set-cookie") || "" };
}
async function login(identifier, candidate, extra = {}, cookiePair = "") {
  return post("/api/auth/login", { identifier, password: candidate, ...extra }, cookiePair);
}
async function session(cookiePair) {
  const response = await fetch(`${base}/api/session`, { headers: cookiePair ? { cookie: cookiePair } : {} });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
function base32(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}
function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)?.map((part) => Number.parseInt(part, 2)) || []);
  const counter = Math.floor(Date.now() / 30000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}

try {
  const owners = rows("SELECT id,username,email,account_id FROM user WHERE lower(role)='owner' ORDER BY id;");
  if (owners.length !== 1) throw new Error(`Expected one owner, found ${owners.length}.`);
  const owner = owners[0];
  ownerId = String(owner.id);
  const beforeSessions = Number(rows("SELECT COUNT(*) count FROM app_session;")?.[0]?.count || 0);
  const beforeChallenges = Number(rows("SELECT COUNT(*) count FROM app_mfa_challenge;")?.[0]?.count || 0);
  if (beforeSessions !== 0 || beforeChallenges !== 0) throw new Error(`Expected clean auth state; sessions=${beforeSessions}, challenges=${beforeChallenges}.`);

  password = await askHidden("Existing production owner password for live smoke tests (input hidden): ");

  const csrf = await post("/api/auth/login", { identifier: owner.username, password }, "", false);
  check("CSRF mutation without required header is rejected", csrf.status === 403, `status=${csrf.status}`);
  const malformed = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { origin: base, "x-requested-with": "XMLHttpRequest", "content-type": "application/json" }, body: "{" });
  check("malformed request is controlled 4xx", malformed.status === 400, `status=${malformed.status}`);
  const nonexistent = await login("codex-smoke-nobody@example.invalid", "DeliberatelyWrong!2026");
  check("nonexistent user is controlled rejection", nonexistent.status === 401, `status=${nonexistent.status}`);

  const browserA = await login(owner.username, password);
  const cookieA = cookie(browserA.setCookie, "__Host-rri_session");
  check("valid owner login", browserA.status === 200 && !!cookieA, `status=${browserA.status}`);
  const browserB = await login(owner.email, password);
  const cookieB = cookie(browserB.setCookie, "__Host-rri_session");
  check("same owner logs in independently in browser B", browserB.status === 200 && !!cookieB, `status=${browserB.status}`);
  check("browser sessions are independent", !!cookieA && !!cookieB && cookieA !== cookieB);
  check("both sessions resolve", (await session(cookieA)).status === 200 && (await session(cookieB)).status === 200);

  const logoutA = await post("/api/auth/logout", {}, cookieA);
  check("browser A logout succeeds", logoutA.status === 200, `status=${logoutA.status}`);
  check("browser A is revoked after logout", (await session(cookieA)).status === 401);
  check("browser B remains authenticated after A logout", (await session(cookieB)).status === 200);

  execute(`DELETE FROM app_session WHERE token_hash=${sql(digestToken(cookieB))};`);
  check("server-side session revocation is enforced", (await session(cookieB)).status === 401);

  const browserC = await login(owner.username, password);
  const cookieC = cookie(browserC.setCookie, "__Host-rri_session");
  execute(`UPDATE app_session SET expires_at=datetime('now','-1 second') WHERE token_hash=${sql(digestToken(cookieC))};`);
  check("expired session is rejected", (await session(cookieC)).status === 401);

  execute(`INSERT INTO user (id,account_id,username,display_name,email,role,property_access_mode,permissions,is_active,is_locked,must_change_password,mfa_enabled,email_confirmed,password_hash,salt,mfa_last_counter,failed_login_count,created_date,updated_date) SELECT ${sql(tempId)},account_id,${sql(tempUsername)},'Authentication smoke user',${sql(tempEmail)},'manager','all','{}',1,0,0,0,1,password_hash,salt,-1,0,datetime('now'),datetime('now') FROM user WHERE id=${sql(ownerId)};`);
  const wrong = await login(tempUsername, `${password}x`);
  check("wrong password is controlled rejection", wrong.status === 401, `status=${wrong.status}`);

  const secret = base32(randomBytes(20));
  execute(`UPDATE user SET failed_login_count=0,locked_until=NULL,mfa_enabled=1,mfa_secret=${sql(secret)},mfa_last_counter=-1 WHERE id=${sql(tempId)};`);
  const firstFactor = await login(tempUsername, password);
  const mfaCookie = cookie(firstFactor.setCookie, "__Host-rri_mfa");
  check("MFA challenge is issued", firstFactor.status === 200 && firstFactor.body?.require_mfa === true && !!mfaCookie);
  const code = totp(secret);
  const mfaAccepted = await login(tempUsername, "", { totpToken: code }, mfaCookie);
  check("MFA challenge accepts one valid code", mfaAccepted.status === 200 && !!cookie(mfaAccepted.setCookie, "__Host-rri_session"), `status=${mfaAccepted.status}`);
  const mfaReplay = await login(tempUsername, "", { totpToken: code }, mfaCookie);
  check("MFA challenge/code replay is rejected", mfaReplay.status === 401, `status=${mfaReplay.status}`);

  execute(`DELETE FROM app_session WHERE user_id=${sql(tempId)};`);
  execute(`DELETE FROM app_mfa_challenge WHERE user_id=${sql(tempId)};`);
  execute(`UPDATE user SET mfa_enabled=0,mfa_secret=NULL,mfa_last_counter=-1,failed_login_count=0,locked_until=NULL WHERE id=${sql(tempId)};`);
  for (let i = 0; i < 5; i += 1) await login(tempUsername, `${password}-wrong-${i}`);
  const lock = rows(`SELECT failed_login_count,locked_until FROM user WHERE id=${sql(tempId)};`)?.[0];
  check("five wrong passwords lock the disposable account", Number(lock?.failed_login_count) >= 5 && !!lock?.locked_until);
  check("correct password cannot bypass active lockout", (await login(tempUsername, password)).status === 401);
  execute(`UPDATE user SET locked_until=datetime('now','-1 second') WHERE id=${sql(tempId)};`);
  const recovered = await login(tempUsername, password);
  check("expired lockout recovers with the valid password", recovered.status === 200, `status=${recovered.status}`);

  const invalidAppSession = await fetch(`${base}/api/session`, { headers: { cookie: "__Host-rri_session=invalid-smoke-token" } });
  check("invalid app session cannot fall back to Access", invalidAppSession.status === 401, `status=${invalidAppSession.status}`);
  const recoveredCookie = cookie(recovered.setCookie, "__Host-rri_session");
  const businessData = await fetch(`${base}/api/properties`, { headers: { cookie: recoveredCookie } });
  check("D1 business-data API remains disabled", businessData.status === 404, `status=${businessData.status}`);
} finally {
  password = "";
  try { if (ownerId) execute(`DELETE FROM app_session WHERE user_id=${sql(ownerId)};`); } catch { /* final verification catches residue */ }
  try { execute(`DELETE FROM user WHERE id=${sql(tempId)};`); } catch { /* final verification catches residue */ }
  const final = rows("SELECT (SELECT COUNT(*) FROM user WHERE lower(role)='owner') owner_records,(SELECT SUM(CASE WHEN instr(password_hash,'pbkdf2-sha256')>0 THEN 1 ELSE 0 END) FROM user WHERE lower(role)='owner') versioned_credentials,(SELECT SUM(CASE WHEN instr(password_hash,'pbkdf2')>0 AND instr(password_hash,'pbkdf2-sha256')=0 THEN 1 ELSE 0 END) FROM user WHERE lower(role)='owner') legacy_credentials,(SELECT COUNT(*) FROM app_session) sessions,(SELECT COUNT(*) FROM app_mfa_challenge) challenges,(SELECT COUNT(*) FROM user WHERE id LIKE 'SMOKE_%') smoke_users;")?.[0] || {};
  check("smoke cleanup leaves one versioned owner and no auth residue", Number(final.owner_records) === 1 && Number(final.versioned_credentials) === 1 && Number(final.legacy_credentials) === 0 && Number(final.sessions) === 0 && Number(final.challenges) === 0 && Number(final.smoke_users) === 0, JSON.stringify(final));
}

const failed = checks.filter((item) => !item.pass);
console.log(`${failed.length ? "FAILED" : "PASSED"}: production authentication smoke: ${checks.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
