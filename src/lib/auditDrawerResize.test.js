import { describe, expect, it } from "vitest";
import { clampAuditDrawerWidth, MIN_AUDIT_DRAWER_WIDTH } from "./auditDrawerResize";

describe("audit drawer resizing", () => {
  it("keeps the drawer within its desktop minimum and viewport maximum", () => {
    expect(clampAuditDrawerWidth(300, 1600)).toBe(MIN_AUDIT_DRAWER_WIDTH);
    expect(clampAuditDrawerWidth(2000, 1600)).toBe(1584);
  });

  it("allows a narrow viewport without overflowing it", () => {
    expect(clampAuditDrawerWidth(768, 500)).toBe(484);
  });
});
