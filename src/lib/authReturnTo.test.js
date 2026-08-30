import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { safeReturnTo } from "@/lib/authReturnTo";

const originalLocation = window.location;
const locationStub = {
  origin: "https://app.example",
  pathname: "/login",
  search: "",
};

beforeEach(() => {
  locationStub.search = "";
  Object.defineProperty(window, "location", {
    value: locationStub,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    value: originalLocation,
    configurable: true,
  });
});

describe("safeReturnTo", () => {
  it("returns the registered Dashboard route when login has no returnTo", () => {
    expect(safeReturnTo()).toBe("/");
  });

  it("preserves a registered same-origin destination", () => {
    locationStub.search = "?returnTo=%2Ftransactions%3Fperiod%3Dmtd";
    expect(safeReturnTo()).toBe("/transactions?period=mtd");
  });
});
