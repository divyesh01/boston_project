import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const CWD = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rri-native-r2-"));
const LOG_FILE = path.join(RUNTIME_DIR, "wrangler-daemon.log");
const PORT = 8794;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sha256Hex(buf) {
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function isPortOpen() {
  return new Promise((resolve) => {
    const req = http.get(BASE, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function killProcessTree(pid) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {}
}

function rawRequest({ method = "GET", path = "/", headers = {}, body = null, timeout = 8000 }) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const req = http.request({
      hostname: "127.0.0.1",
      port: PORT,
      method,
      path,
      headers,
    }, (res) => {
      if (timer) clearTimeout(timer);
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch { json = data; }
        resolve({ status: res.statusCode, headers: res.headers, json, raw: data });
      });
    });
    req.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    if (timeout > 0) {
      timer = setTimeout(() => {
        req.destroy(new Error(`REQUEST_TIMEOUT after ${timeout}ms`));
      }, timeout);
    }

    if (body !== null && body !== undefined) {
      if (typeof body.pipe === "function") {
        body.pipe(req);
      } else {
        req.write(body);
        req.end();
      }
    } else {
      req.end();
    }
  });
}

async function inspectObject(key) {
  const res = await rawRequest({
    method: "GET",
    path: `/inspect-object?key=${encodeURIComponent(key)}`,
  });
  return res.json;
}

async function seedObject(key, content, customMetadata = {}) {
  const res = await rawRequest({
    method: "POST",
    path: "/seed-object",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, content, customMetadata }),
  });
  return res.json;
}

async function main() {
  assert(!(await isPortOpen()), `Refusing to reuse occupied localhost port ${PORT}`);
  const handlerPath = path.resolve(CWD, "../../../worker/bulk-import.js").replaceAll("\\", "/");
  const fixtureEntry = fs.readFileSync(path.join(CWD, "proof-worker.js"), "utf8");
  assert(fixtureEntry.includes('"../../../worker/bulk-import.js"'), "Expected fixture import must be present");
  fs.writeFileSync(path.join(RUNTIME_DIR, "proof-worker.js"), fixtureEntry.replace('"../../../worker/bulk-import.js"', JSON.stringify(handlerPath)));
  fs.copyFileSync(path.join(CWD, "wrangler.jsonc"), path.join(RUNTIME_DIR, "wrangler.jsonc"));
  const outFd = fs.openSync(LOG_FILE, "w");
  console.log(`[1/5] Starting local Wrangler native R2 daemon on port ${PORT}...`);

  const require = createRequire(import.meta.url);
  let wranglerPackage;
  try {
    wranglerPackage = require.resolve("wrangler/package.json");
  } catch {
    const npmRoot = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "--global"], { shell: process.platform === "win32", encoding: "utf8" });
    assert.equal(npmRoot.status, 0, "Install Wrangler locally or globally before running the native fixture");
    wranglerPackage = require.resolve("wrangler/package.json", { paths: [npmRoot.stdout.trim()] });
  }
  const wranglerBin = JSON.parse(fs.readFileSync(wranglerPackage, "utf8")).bin.wrangler;
  const wranglerCli = path.resolve(path.dirname(wranglerPackage), wranglerBin);
  const wrangler = spawn(process.execPath, [wranglerCli, "dev", "--local", "--cwd", RUNTIME_DIR, "--config", path.join(RUNTIME_DIR, "wrangler.jsonc"), "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", path.join(RUNTIME_DIR, "persist")], {
    cwd: RUNTIME_DIR,
    stdio: ["ignore", outFd, outFd],
    detached: process.platform !== "win32",
    shell: false,
  });

  const pid = wrangler.pid;
  console.log(`Wrangler spawned with PID: ${pid}`);

  let ready = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (await isPortOpen()) {
      ready = true;
      break;
    }
  }

  if (!ready) {
    killProcessTree(pid);
    const logs = fs.readFileSync(LOG_FILE, "utf8");
    console.error("Wrangler failed to start. Logs:\n" + logs);
    process.exit(1);
  }

  console.log(`[2/5] Wrangler ready on http://127.0.0.1:${PORT}. Running native failure and success proof...`);

  const results = {};

  try {
    // PROOF A: Native failure on generic TransformStream bounded.stream (simulated via helper)
    // NOTE: Accurately stated: /prove-old-failure duplicates the stream piping helper to prove
    // that workerd native R2 throws TypeError on unmeasured ReadableStream. Observed original
    // application failure was an unhandled 500 error in the browser upload handler.
    const oldRes = await fetch(`${BASE}/prove-old-failure`, {
      method: "PUT",
      body: "Test Payload Old",
    });
    const oldJson = await oldRes.json();
    results.oldFailure = {
      status: oldRes.status,
      json: oldJson,
    };
    console.log("Captured Native Old Failure Proof:", JSON.stringify(results.oldFailure, null, 2));
    assert.strictEqual(oldRes.status, 500);
    assert.strictEqual(oldJson.errorName, "TypeError");
    assert(oldJson.errorMessage.includes("must have a known length"), "Expected known length error");

    // PROOF B: Native success on bounded ArrayBuffer
    const bufRes = await fetch(`${BASE}/prove-arraybuffer-success`, {
      method: "PUT",
      body: "Test Payload ArrayBuffer",
      signal: AbortSignal.timeout(8000),
    });
    const bufJson = await bufRes.json();
    results.arrayBufferSuccess = {
      status: bufRes.status,
      json: bufJson,
    };
    console.log("Captured Native ArrayBuffer Success Proof:", JSON.stringify(results.arrayBufferSuccess, null, 2));
    assert.strictEqual(bufRes.status, 200);
    assert.strictEqual(bufJson.ok, true);

    // PROOF C: Native success on FixedLengthStream (stream-safe known length)
    const fixedData = "Test Payload FixedLength";
    const fixedRes = await fetch(`${BASE}/prove-fixedlength-success`, {
      method: "PUT",
      headers: { "Content-Length": String(Buffer.byteLength(fixedData)) },
      body: fixedData,
      signal: AbortSignal.timeout(8000),
    });
    const fixedJson = await fixedRes.json();
    results.fixedLengthSuccess = {
      status: fixedRes.status,
      json: fixedJson,
    };
    console.log("Captured Native FixedLengthStream Success Proof:", JSON.stringify(results.fixedLengthSuccess, null, 2));
    assert.strictEqual(fixedRes.status, 200);
    assert.strictEqual(fixedJson.ok, true);

    // PROOF D: Full candidate actual handleBulkImportRequest test cases against native R2
    console.log("[3/5] Testing candidate uploadRawArchive actual cases on native R2 bucket...");

    // Case 1: valid201
    const validBody = `Date,Occupancy\n2026-10-01,0.88\n# run_${Date.now()}\n`;
    const validHash = await sha256Hex(new TextEncoder().encode(validBody));
    const validKey = `rri-raw/acc-12345678901234567890123456789012/prop_test/${validHash}`;
    const res1 = await rawRequest({
      method: "PUT",
      path: "/api/bulk-import/raw-upload",
      headers: {
        "x-server-property-id": "prop_test",
        "x-report-type": "occupancy",
        "x-raw-hash": validHash,
        "x-archive-id": `raw_arch_${Date.now()}`,
        "content-type": "text/csv",
        "content-length": String(Buffer.byteLength(validBody)),
      },
      body: validBody,
    });
    results.valid201 = { status: res1.status, json: res1.json };
    console.log("PASS Case 1: valid201:", JSON.stringify(results.valid201, null, 2));
    assert.strictEqual(res1.status, 201);
    assert.strictEqual(res1.json.status, "archived");
    assert.strictEqual(res1.json.byte_length, Buffer.byteLength(validBody));
    const insp1 = await inspectObject(validKey);
    assert.strictEqual(insp1.exists, true);
    assert.strictEqual(insp1.size, Buffer.byteLength(validBody));

    // Case 2: idempotent200
    const res2 = await rawRequest({
      method: "PUT",
      path: "/api/bulk-import/raw-upload",
      headers: {
        "x-server-property-id": "prop_test",
        "x-report-type": "occupancy",
        "x-raw-hash": validHash,
        "x-archive-id": `raw_arch_${Date.now()}`,
        "content-type": "text/csv",
        "content-length": String(Buffer.byteLength(validBody)),
      },
      body: validBody,
    });
    results.idempotent200 = { status: res2.status, json: res2.json };
    console.log("PASS Case 2: idempotent200:", JSON.stringify(results.idempotent200, null, 2));
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.json.status, "already_archived");
    assert.strictEqual(res2.json.byte_length, Buffer.byteLength(validBody));

    // Case 3: badhash400 / noobject
    const badHash = "f".repeat(64);
    const badHashKey = `rri-raw/acc-12345678901234567890123456789012/prop_test/${badHash}`;
    const res3 = await rawRequest({
      method: "PUT",
      path: "/api/bulk-import/raw-upload",
      headers: {
        "x-server-property-id": "prop_test",
        "x-report-type": "occupancy",
        "x-raw-hash": badHash,
        "content-type": "text/csv",
        "content-length": String(Buffer.byteLength(validBody)),
      },
      body: validBody,
    });
    results.badhash400 = { status: res3.status, json: res3.json };
    console.log("PASS Case 3: badhash400/noobject:", JSON.stringify(results.badhash400, null, 2));
    assert.strictEqual(res3.status, 400);
    assert.strictEqual(res3.json.code, "RAW_HASH_MISMATCH");
    const insp3 = await inspectObject(badHashKey);
    assert.strictEqual(insp3.exists, false, "Object must not exist after badhash");

    // Case 4: empty400
    const res4 = await rawRequest({
      method: "PUT",
      path: "/api/bulk-import/raw-upload",
      headers: {
        "x-server-property-id": "prop_test",
        "x-report-type": "occupancy",
        "x-raw-hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "content-type": "text/csv",
        "content-length": "0",
      },
      body: "",
    });
    results.empty400 = { status: res4.status, json: res4.json };
    console.log("PASS Case 4: empty400:", JSON.stringify(results.empty400, null, 2));
    assert.strictEqual(res4.status, 400);
    assert.strictEqual(res4.json.code, "IMPORT_EMPTY_PAYLOAD");

    // Case 5: headeroversize413
    const overHash = "1".repeat(64);
    const res5 = await rawRequest({
      method: "GET",
      path: "/prove-header-oversize",
    });
    results.headeroversize413 = res5.json;
    console.log("PASS Case 5: headeroversize413:", JSON.stringify(results.headeroversize413, null, 2));
    assert.strictEqual(res5.json.status, 413);
    assert.strictEqual(res5.json.json.code, "PAYLOAD_TOO_LARGE");

    // Case 6: consumedoversize413 (streaming body exceeding 50 MB)
    const streamOverHash = "2".repeat(64);
    const streamOverKey = `rri-raw/acc-12345678901234567890123456789012/prop_test/${streamOverHash}`;
    const res6 = await rawRequest({
      method: "GET",
      path: "/prove-consumed-oversize",
    });
    results.consumedoversize413 = res6.json;
    console.log("PASS Case 6: consumedoversize413:", JSON.stringify(results.consumedoversize413, null, 2));
    assert([413, 400].includes(res6.json.status));
    const insp6 = await inspectObject(streamOverKey);
    assert.strictEqual(insp6.exists, false, "Object must not exist after consumed oversize abort");

    // Case 7: malformed / negative / fractional CL
    // 7a: malformed
    const res7a = await rawRequest({ method: "GET", path: "/prove-invalid-cl?val=not-a-number" });
    assert.strictEqual(res7a.json.status, 400);
    assert.strictEqual(res7a.json.json.code, "INVALID_CONTENT_LENGTH");

    // 7b: negative
    const res7b = await rawRequest({ method: "GET", path: "/prove-invalid-cl?val=-15" });
    assert.strictEqual(res7b.json.status, 400);
    assert.strictEqual(res7b.json.json.code, "INVALID_CONTENT_LENGTH");

    // 7c: fractional
    const res7c = await rawRequest({ method: "GET", path: "/prove-invalid-cl?val=12.34" });
    assert.strictEqual(res7c.json.status, 400);
    assert.strictEqual(res7c.json.json.code, "INVALID_CONTENT_LENGTH");

    results.malformedCL = {
      malformed: res7a.json,
      negative: res7b.json,
      fractional: res7c.json,
    };
    console.log("PASS Case 7: malformed/negative/fractional CL -> 400 INVALID_CONTENT_LENGTH");

    // Case 8: missingCL policy
    // 8a: Native missing length is rejected without persisting an object.
    const missingCLBody = `Date,Occupancy\n2026-10-01,0.91\n# missing_cl_${Date.now()}\n`;
    const missingCLHash = await sha256Hex(new TextEncoder().encode(missingCLBody));
    const missingCLKey = `rri-raw/acc-12345678901234567890123456789012/prop_test/${missingCLHash}`;
    const res8a = await rawRequest({
      method: "PUT",
      path: "/api/bulk-import/raw-upload",
      headers: {
        "x-server-property-id": "prop_test",
        "x-report-type": "occupancy",
        "x-raw-hash": missingCLHash,
        "x-archive-id": `raw_arch_missing_${Date.now()}`,
        "content-type": "text/csv",
      },
      body: missingCLBody,
    });
    results.missingCLSmall = { status: res8a.status, json: res8a.json };
    assert.strictEqual(res8a.status, 411);
    assert.strictEqual(res8a.json.code, "LENGTH_REQUIRED");
    const insp8a = await inspectObject(missingCLKey);
    assert.strictEqual(insp8a.exists, false, "Missing native length must not persist an object");
    console.log("PASS Case 8a: missing native Content-Length -> 411, no object");

    // 8b: Native missing length is rejected before consuming an oversized stream
    const res8b = await rawRequest({
      method: "GET",
      path: "/prove-missing-cl-oversize",
    });
    results.missingCLOversize = res8b.json;
    assert.strictEqual(res8b.json.status, 411);
    assert.strictEqual(res8b.json.json.code, "LENGTH_REQUIRED");
    console.log("PASS Case 8b: missing native length rejected before consuming oversized stream");

    // Case 9: shorter / longer declaredlength and client stream abort
    // 9a: shorter declared length (via proof worker)
    const shortKey = `rri-raw/acc-12345678901234567890123456789012/prop_test/${"5".repeat(64)}`;
    const res9a = await rawRequest({
      method: "GET",
      path: "/prove-stream-length-mismatch?mode=shorter",
    });
    assert.strictEqual(res9a.json.status, 400);
    assert.strictEqual(res9a.json.json.code, "STREAM_LENGTH_MISMATCH");
    const insp9a = await inspectObject(shortKey);
    assert.strictEqual(insp9a.exists, false, "Object must not exist after shorter declared length mismatch");

    // 9b: longer declared length (via proof worker)
    const longKey = `rri-raw/acc-12345678901234567890123456789012/prop_test/${"6".repeat(64)}`;
    const res9b = await rawRequest({
      method: "GET",
      path: "/prove-stream-length-mismatch?mode=longer",
    });
    assert.strictEqual(res9b.json.status, 400);
    assert.strictEqual(res9b.json.json.code, "STREAM_LENGTH_MISMATCH");
    const insp9b = await inspectObject(longKey);
    assert.strictEqual(insp9b.exists, false, "Object must not exist after longer declared length mismatch");

    // 9c: direct native HTTP short stream to /api/bulk-import/raw-upload (client sends 20 bytes for 50 declared)
    const directShortHash = "3".repeat(64);
    const directShortKey = `rri-raw/acc-12345678901234567890123456789012/prop_test/${directShortHash}`;
    let directTransportError;
    try {
      await rawRequest({
      method: "PUT",
      path: "/api/bulk-import/raw-upload",
      headers: {
        "x-server-property-id": "prop_test",
        "x-report-type": "occupancy",
        "x-raw-hash": directShortHash,
        "content-length": "50",
      },
      body: "short payload (20 B)",
      });
    } catch (error) {
      directTransportError = error;
    }
    assert(directTransportError, "Incomplete HTTP framing must not produce an accepted upload");
    assert.match(directTransportError.message, /REQUEST_TIMEOUT|socket hang up|ECONNRESET/);
    await sleep(200);
    const inspDirectShort = await inspectObject(directShortKey);
    assert.strictEqual(inspDirectShort.exists, false, "Object must not exist after direct short stream");

    // 9d: client abort mid-stream (AbortController lifecycle test)
    const abortHash = "9".repeat(64);
    const abortKey = `rri-raw/acc-12345678901234567890123456789012/prop_test/${abortHash}`;
    await new Promise((resolve) => {
      const abortReq = http.request({
        hostname: "127.0.0.1",
        port: PORT,
        method: "PUT",
        path: "/api/bulk-import/raw-upload",
        headers: {
          "x-server-property-id": "prop_test",
          "x-report-type": "occupancy",
          "x-raw-hash": abortHash,
          "content-length": "1048576", // 1 MB declared
        },
      }, (res) => {
        res.resume();
        resolve();
      });
      abortReq.on("error", () => resolve());
      abortReq.write("partial stream chunk of 40 bytes sent...");
      setTimeout(() => {
        abortReq.destroy(new Error("CLIENT_STREAM_ABORT"));
        resolve();
      }, 50);
    });
    await sleep(200);
    const inspAbort = await inspectObject(abortKey);
    assert.strictEqual(inspAbort.exists, false, "Object must not exist in R2 after client stream abort");

    results.declaredLengthMismatch = {
      shorter: res9a.json,
      longer: res9b.json,
      directShort: { transportError: directTransportError.message, objectExists: inspDirectShort.exists },
      clientAbort: { aborted: true, objectExists: inspAbort.exists },
    };
    console.log("PASS Case 9: shorter/longer declaredlength + direct short + client abort -> handled cleanly, object absent");

    // Case 10: completion/errors/no partial persisted object
    const keysToCheck = [badHashKey, streamOverKey, shortKey, longKey, directShortKey, abortKey];
    for (const key of keysToCheck) {
      const check = await inspectObject(key);
      assert.strictEqual(check.exists, false, `Key ${key} should NOT exist in R2`);
    }
    results.noPartialPersistedObject = { checkedKeys: keysToCheck, allAbsent: true };
    console.log("PASS Case 10: completion/errors/no partial persisted object verified in native R2");

    // Case 11: crossaccount/property/role denial
    // 11a: role denial (viewer)
    const res11a = await rawRequest({
      method: "PUT",
      path: "/api/bulk-import/raw-upload",
      headers: {
        "x-test-role": "viewer",
        "x-server-property-id": "prop_test",
        "x-report-type": "occupancy",
        "x-raw-hash": "7".repeat(64),
        "content-length": "10",
      },
      body: "0123456789",
    });
    assert.strictEqual(res11a.status, 403);
    assert.strictEqual(res11a.json.code, "IMPORT_ROLE_FORBIDDEN");

    // 11b: property denial (unauthorized property)
    const res11b = await rawRequest({
      method: "PUT",
      path: "/api/bulk-import/raw-upload",
      headers: {
        "x-server-property-id": "unauth_prop",
        "x-report-type": "occupancy",
        "x-raw-hash": "7".repeat(64),
        "content-length": "10",
      },
      body: "0123456789",
    });
    assert.strictEqual(res11b.status, 403);
    assert.strictEqual(res11b.json.code, "SCOPE_DENIED");

    // 11c: cross-account denial (account scope has no access to property)
    const res11c = await rawRequest({
      method: "PUT",
      path: "/api/bulk-import/raw-upload",
      headers: {
        "x-test-account-id": "acc-22222222222222222222222222222222",
        "x-test-property-ids": "prop_other",
        "x-server-property-id": "prop_test",
        "x-report-type": "occupancy",
        "x-raw-hash": "7".repeat(64),
        "content-length": "10",
      },
      body: "0123456789",
    });
    assert.strictEqual(res11c.status, 403);
    assert.strictEqual(res11c.json.code, "SCOPE_DENIED");
    results.denials = {
      roleDenial: res11a.json,
      propertyDenial: res11b.json,
      crossAccountDenial: res11c.json,
    };
    console.log("PASS Case 11: crossaccount/property/role denial -> 403 Forbidden");

    // Case 12: existing metadata conflict
    const conflictHash = "8".repeat(64);
    const conflictKey = `rri-raw/acc-12345678901234567890123456789012/prop_test/${conflictHash}`;
    await seedObject(conflictKey, "existing-content", {
      account_id: "acc-12345678901234567890123456789012",
      server_property_id: "prop_test",
      raw_hash: "different-stored-hash-000000000000000000000000000000000000000000000",
    });
    const res12 = await rawRequest({
      method: "PUT",
      path: "/api/bulk-import/raw-upload",
      headers: {
        "x-server-property-id": "prop_test",
        "x-report-type": "occupancy",
        "x-raw-hash": conflictHash,
        "content-length": "16",
      },
      body: "existing-content",
    });
    assert([403, 409].includes(res12.status));
    assert(["IMPORT_OBJECT_SCOPE_MISMATCH", "RAW_OBJECT_CONFLICT"].includes(res12.json.code));
    results.existingConflict = { status: res12.status, json: res12.json };
    console.log(`PASS Case 12: existing metadata conflict -> ${res12.status} ${res12.json.code}`);

    console.log("\n[4/5] ALL 12 BOUNDED NATIVE R2 TESTS SUCCEEDED AGAINST CANDIDATE PATCH!");

    // Save proof results to JSON file
    fs.writeFileSync(path.join(RUNTIME_DIR, "proof-results.json"), JSON.stringify(results, null, 2), "utf8");
    console.log(`Synthetic proof artifacts: ${RUNTIME_DIR}`);

  } finally {
    console.log(`[5/5] Terminating Wrangler daemon PID ${pid}...`);
    killProcessTree(pid);
    fs.closeSync(outFd);
    console.log("Wrangler daemon terminated cleanly.");
  }
}

main().catch(err => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
