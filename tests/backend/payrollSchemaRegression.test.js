// tests/backend/payrollSchemaRegression.test.js
// Regression test: autoPayroll must write an allowed payroll_status according to PayrollRun.jsonc.
//
// Root cause: base44/functions/autoPayroll/entry.ts previously wrote payroll_status: "pending".
// However, base44/entities/PayrollRun.jsonc only allows the enum values:
//   ["draft", "pending_review", "approved", "paid"]
//
// Auto-generated payroll runs require human approval, so the correct schema enum value
// is "pending_review". Writing "pending" broke schema validation, failed to match
// UI <Select> options on the Payroll page, and rendered a fallback question-mark badge.

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Mock Base44 SDK and environment before importing autoPayroll
const createdPayrollRuns = [];
let auditLogs = [];

vi.mock("npm:@base44/sdk@^0.8.41", () => ({
  createClientFromRequest: () => ({
    asServiceRole: {
      entities: {
        Session: {
          filter: async () => [{ user_id: "user-owner-1", is_revoked: false, expires_at: "2099-01-01T00:00:00.000Z" }],
        },
        User: {
          get: async () => ({ id: "user-owner-1", username: "owner_test", role: "owner", is_active: true }),
        },
        Staff: {
          filter: async () => [
            {
              id: "staff-1",
              employee_name: "Alice Smith",
              employee_id: "EMP001",
              active: true,
              pay_type: "hourly",
              base_rate: 25,
              hours: 40,
              overtime_hours: 0,
              overtime_rate: 37.5,
              bonus: 0,
              deductions: 0,
              property_id: "P1",
              property_name: "Hotel Boston",
            },
          ],
        },
        TimecardPunch: {
          filter: async () => [],
        },
        PayrollRun: {
          filter: async () => [],
          create: async (record) => {
            createdPayrollRuns.push(record);
            return { id: `pr-${createdPayrollRuns.length}`, ...record };
          },
        },
        AuditLog: {
          filter: async () => [],
          create: async (log) => {
            auditLogs.push(log);
            return { id: `audit-${auditLogs.length}`, ...log };
          },
        },
      },
    },
  }),
}));

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    createHash: () => ({
      update: () => ({ digest: () => "mocked-hash" }),
    }),
  };
});

vi.mock("base44:runtime", () => ({
  secrets: { get: () => "mocked-secret" },
}));

import autoPayroll from "../../base44/functions/autoPayroll/entry.ts";

describe("PayrollRun schema and autoPayroll status regression", () => {
  const schemaPath = path.resolve(import.meta.dirname, "../../base44/entities/PayrollRun.jsonc");
  const entryPath = path.resolve(import.meta.dirname, "../../base44/functions/autoPayroll/entry.ts");

  beforeEach(() => {
    createdPayrollRuns.length = 0;
    auditLogs = [];
  });

  it("PayrollRun entity schema defines payroll_status with allowed enum values", () => {
    const rawSchema = fs.readFileSync(schemaPath, "utf8");
    const cleanJson = rawSchema.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const schema = JSON.parse(cleanJson);

    const statusProperty = schema.properties?.payroll_status;
    expect(statusProperty).toBeDefined();
    expect(statusProperty.type).toBe("string");
    expect(statusProperty.enum).toEqual(["draft", "pending_review", "approved", "paid"]);
    expect(statusProperty.enum).not.toContain("pending");
  });

  it("base44/functions/autoPayroll/entry.ts does not write invalid 'pending' status", () => {
    const entrySource = fs.readFileSync(entryPath, "utf8");
    expect(entrySource).not.toMatch(/payroll_status\s*:\s*["']pending["']/);
    expect(entrySource).toMatch(/payroll_status\s*:\s*["']pending_review["']/);
  });

  it("autoPayroll execution creates PayrollRun records with schema-compliant 'pending_review' status", async () => {
    const csrfToken = "valid-csrf-token-123";
    const headers = {
      get: (header) => {
        const lower = header.toLowerCase();
        if (lower === "cookie") return `base44_session=test-token; __Host-csrf_token=${csrfToken}`;
        if (lower === "x-csrf-token") return csrfToken;
        return "";
      },
    };
    const req = {
      headers,
      url: "http://localhost/api/autoPayroll",
      json: async () => ({
        year: 2026,
        month: 2,
        force: true,
        propertyId: "P1",
      }),
    };

    const response = await autoPayroll(req);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe("ok");
    expect(data.createdCount).toBe(1);

    expect(createdPayrollRuns).toHaveLength(1);
    const created = createdPayrollRuns[0];

    // Read entity schema enum
    const rawSchema = fs.readFileSync(schemaPath, "utf8");
    const schema = JSON.parse(rawSchema.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""));
    const allowedStatuses = schema.properties.payroll_status.enum;

    // Verify written status matches the correct allowed enum
    expect(created.payroll_status).toBe("pending_review");
    expect(allowedStatuses).toContain(created.payroll_status);
    expect(created.payroll_status).not.toBe("pending");
  });

  it("validates that a schema validator rejects 'pending' and accepts 'pending_review'", () => {
    const rawSchema = fs.readFileSync(schemaPath, "utf8");
    const schema = JSON.parse(rawSchema.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""));
    const allowed = new Set(schema.properties.payroll_status.enum);

    function validatePayrollRun(record) {
      if (!record.employee_name) throw new Error("Missing required field employee_name");
      if (record.payroll_status && !allowed.has(record.payroll_status)) {
        throw new Error(`Invalid payroll_status: "${record.payroll_status}". Allowed: ${[...allowed].join(", ")}`);
      }
      return true;
    }

    // Valid statuses
    expect(validatePayrollRun({ employee_name: "Alice", payroll_status: "draft" })).toBe(true);
    expect(validatePayrollRun({ employee_name: "Alice", payroll_status: "pending_review" })).toBe(true);
    expect(validatePayrollRun({ employee_name: "Alice", payroll_status: "approved" })).toBe(true);
    expect(validatePayrollRun({ employee_name: "Alice", payroll_status: "paid" })).toBe(true);

    // Invalid status "pending" must be rejected
    expect(() => validatePayrollRun({ employee_name: "Alice", payroll_status: "pending" })).toThrow(
      /Invalid payroll_status: "pending"/
    );
  });
});
