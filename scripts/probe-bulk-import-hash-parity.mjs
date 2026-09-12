// scripts/probe-bulk-import-hash-parity.mjs
// Verifies bit-for-bit SHA-256 parity between original uploaded source and downloaded original archive
// across CSV, XLSX, and XLS file formats.

import {
  assert,
  assertEqual,
  makeDb,
  makeInstrumentedEnv,
  makeRunner,
  seedUser,
  scopeAll,
} from "./_worker-testkit.mjs";
import { handleBulkImportRequest, clearMockStore } from "../worker/bulk-import.js";
import { sha256Hex } from "../src/lib/bulkImportPipeline.js";

const run = makeRunner("probe-bulk-import-hash-parity");

function setupWorker() {
  clearMockStore();
  const db = makeDb();
  db.prepare("INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?, ?, ?)").run("A_1", "Parity Account", "2026-01-01");
  seedUser(db, { id: "user_owner", email: "owner@parity.local", role: "owner", mode: "all", accountId: "A_1" });
  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_A", "A_1", "RRI-PARITY", "Red Roof Inn Parity", 100, "123 Main St", "Boston", "MA", "617-555-0100", 1, "2026-01-01");
  db.prepare("INSERT OR IGNORE INTO business_sync_state (account_id, revision) VALUES (?, ?)").run("A_1", 0);

  const { env, stats } = makeInstrumentedEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });
  const owner = scopeAll(["P_A"]);
  owner.accountId = "A_1";
  owner.user.id = "user_owner";
  owner.user.account_id = "A_1";
  return { db, env, stats, owner };
}

await run.check("Bit-for-bit SHA-256 and byte parity on CSV, XLSX, and XLS downloads", async () => {
  const { env, owner } = setupWorker();
  const propertyId = "P_A";

  const fixtures = [
    {
      format: "CSV",
      fileName: "Daily_Occupancy_2025_08.csv",
      mimeType: "text/csv",
      // Text with CRLF, UTF-8 unicode characters, and currency symbols
      bytes: new TextEncoder().encode(
        "Date,Room_Type,Rate_Code,Amount,Notes\r\n" +
        "2025-08-01,King,BAR,$129.99,Standard Check-in — Café\r\n" +
        "2025-08-02,Double Queen,CORP,$145.50,Corporate booking © 2025\r\n" +
        "2025-08-03,Suite,PROMO,$199.00,Special summer promo 🎉\r\n"
      ),
    },
    {
      format: "XLSX",
      fileName: "Manager_Flash_Report.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      // Simulated XLSX / ZIP binary file with standard PK magic bytes [0x50, 0x4B, 0x03, 0x04]
      bytes: new Uint8Array([
        0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00,
        0x08, 0x00, 0x00, 0x00, 0x21, 0x00, 0x11, 0x22,
        ...Array.from({ length: 1024 }, (_, i) => (i * 17 + 3) % 256),
      ]),
    },
    {
      format: "XLS",
      fileName: "Legacy_HotelKey_Export.xls",
      mimeType: "application/vnd.ms-excel",
      // Simulated legacy XLS / OLE compound document magic bytes [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]
      bytes: new Uint8Array([
        0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ...Array.from({ length: 2048 }, (_, i) => (i * 31 + 7) % 256),
      ]),
    },
  ];

  for (const item of fixtures) {
    const rawHash = await sha256Hex(item.bytes);
    const archiveId = `arch_${item.format.toLowerCase()}`;

    // 1. Upload raw original to R2
    const uploadReq = new Request("http://localhost/api/bulk-import/raw-upload", {
      method: "PUT",
      headers: {
        "x-server-property-id": propertyId,
        "x-report-type": "occupancy",
        "x-raw-hash": rawHash,
        "x-archive-id": archiveId,
        "x-file-name": item.fileName,
        "content-type": item.mimeType,
      },
      body: item.bytes,
    });
    const uploadRes = await handleBulkImportRequest(uploadReq, env, owner, new URL(uploadReq.url), ["api", "bulk-import", "raw-upload"]);
    assertEqual(uploadRes.status, 201, `${item.format} upload returns 201`);
    const uploadData = await uploadRes.json();
    assertEqual(uploadData.raw_hash, rawHash);

    // 2. Record in D1 manifest
    const recordReq = new Request("http://localhost/api/bulk-import/raw-archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: `bundle_${item.format.toLowerCase()}`,
        raw_archive_id: archiveId,
        server_property_id: propertyId,
        report_type: "occupancy",
        raw_file_hash: rawHash,
        raw_object_key: uploadData.raw_object_key,
        original_file_name: item.fileName,
        file_size: item.bytes.byteLength,
        mime_type: item.mimeType,
      }),
    });
    const recordRes = await handleBulkImportRequest(recordReq, env, owner, new URL(recordReq.url), ["api", "bulk-import", "raw-archive"]);
    assertEqual(recordRes.status, 201);

    // 3. Download original bytes via /api/bulk-import/raw/:id
    const downloadReq = new Request(`http://localhost/api/bulk-import/raw/${archiveId}`);
    const downloadRes = await handleBulkImportRequest(downloadReq, env, owner, new URL(downloadReq.url), ["api", "bulk-import", "raw", archiveId]);
    assertEqual(downloadRes.status, 200, `${item.format} download returns 200`);
    assertEqual(downloadRes.headers.get("x-raw-hash"), rawHash, `${item.format} header carries exact raw hash`);
    assertEqual(downloadRes.headers.get("Content-Type"), item.mimeType, `${item.format} content-type matches`);

    const downloadedBuffer = await downloadRes.arrayBuffer();
    const downloadedBytes = new Uint8Array(downloadedBuffer);

    // 4. Assert bit-for-bit parity
    assertEqual(downloadedBytes.byteLength, item.bytes.byteLength, `${item.format} byte length matches`);
    const downloadedHash = await sha256Hex(downloadedBytes);
    assertEqual(downloadedHash, rawHash, `${item.format} computed SHA-256 matches original hash`);

    for (let i = 0; i < item.bytes.byteLength; i++) {
      if (downloadedBytes[i] !== item.bytes[i]) {
        throw new Error(`Byte mismatch at index ${i} for format ${item.format}`);
      }
    }
  }
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: probe-bulk-import-hash-parity completed.");
process.exit(0);
