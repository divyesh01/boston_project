// Probe: Financial Completeness & Uncertainty Propagation for Money Kept
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-money-kept-tax-completeness.mjs
// Exercises calculateTaxLiability -> calculateMoneyKept -> moneyKeptModel -> ownerPacketExport
// Proves that when taxes are incomplete or unconfigured, the downstream estimate
// does not falsely present as complete.

import fs from "node:fs";
import { CalculationService } from "../src/lib/calculationService.js";
import { buildMoneyKeptBaseData, buildMoneyKeptPresentation } from "../src/lib/moneyKeptModel.js";
import { buildOwnerPerformancePacketWorkbook } from "../src/lib/ownerPacketExport.js";
import { setTaxConfig } from "../src/lib/taxConfig.js";
import { saveTaxSettings } from "../src/lib/taxSettings.js";
import { savePropertyProfile } from "../src/lib/enterpriseConfigEngine.js";
import { toCents, fromCents } from "../src/lib/decimal.js";

// Provide localStorage for node environment
if (!globalThis.localStorage) {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };
}

let pass = 0, fail = 0;
const failures = [];
function T(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    const msg = `FAIL  ${name}${detail ? `\n          ${detail}` : ""}`;
    failures.push(msg);
    console.log(`  ${msg}`);
  }
}

console.log("=== SCENARIO 1: All Complete Taxes (Normal Estimate) ===");
{
  globalThis.localStorage.clear();
  setTaxConfig({ taxRate: 0.10, taxEnabled: true }, "prop-complete");
  saveTaxSettings([
    { property_id: "prop-complete", state_rate: 0.06, city_rate: 0.04, other_rate: 0.0, effective_start: "2026-01-01" },
  ], "prop-complete");

  const src = [
    { property_id: "prop-complete", date: "2026-06-01", source: "EXPEDIA HOTEL COLLECT", net_revenue: 1000 },
  ];
  const gross = [
    { property_id: "prop-complete", date: "2026-06-01", room_rent: 1000 },
  ];
  const occ = [
    { property_id: "prop-complete", date: "2026-06-01", room_revenue: 1000, rooms_sold: 10, total_rooms: 20 },
  ];

  const taxLiab = CalculationService.calculateTaxLiability(src, gross, "prop-complete", { from: "2026-06-01", to: "2026-06-01" }, occ, true);
  T("complete tax liability is not incomplete", taxLiab.incomplete === false, `taxLiab.incomplete=${taxLiab.incomplete}`);
  T("complete tax estimated is exact $100.00", taxLiab.estimated === 100, `estimated=${taxLiab.estimated}`);

  const mk = CalculationService.calculateMoneyKept(occ, src, gross, [], [], [], { from: "2026-06-01", to: "2026-06-01" }, "prop-complete");
  T("complete money kept has taxIncomplete false", mk.taxIncomplete === false, `mk.taxIncomplete=${mk.taxIncomplete}`);
  T("complete money kept has isPartial false", mk.isPartial === false, `mk.isPartial=${mk.isPartial}`);
  T("complete money kept deducted $100 tax", mk.estimatedTaxes === 100, `estimatedTaxes=${mk.estimatedTaxes}`);
  T("complete money kept is $750.00 ($1000 gross - $150 commission - $100 tax)", mk.kept === 750, `kept=${mk.kept}`);

  const baseData = buildMoneyKeptBaseData({
    occRows: occ, srcRows: src, grossRows: gross, payRecords: [], expenses: [], payroll: [],
    from: "2026-06-01", to: "2026-06-01"
  });
  T("baseData isTaxIncomplete is false", baseData.isTaxIncomplete === false, `baseData.isTaxIncomplete=${baseData.isTaxIncomplete}`);

  const pres = buildMoneyKeptPresentation(baseData);
  const keptPie = pres.pieData.find((p) => p.name.includes("Estimated Money Kept"));
  T("presentation pieData keeps normal label", keptPie?.name === "Estimated Money Kept", `pie name=${keptPie?.name}`);
}

console.log("\n=== SCENARIO 2: Partial Incomplete Tax (Enterprise Flat Fee Missing Occupied Nights) ===");
{
  globalThis.localStorage.clear();
  // Set up enterprise config with percentage + flat per night jurisdiction
  savePropertyProfile("prop-partial", {
    periods: [{
      effective_start: "2026-01-01",
      effective_end: "2026-12-31",
      tax_jurisdictions: [
        { id: "state-tax", kind: "state", type: "percentage", rate: 0.05, reviewed: true },
        { id: "city-flat", kind: "city", type: "flat_per_night", rate: 2.50, reviewed: true },
      ],
    }],
  });
  setTaxConfig({ taxRate: 0.05, taxEnabled: true }, "prop-partial");

  const src = [
    { property_id: "prop-partial", date: "2026-06-01", source: "EXPEDIA HOTEL COLLECT", net_revenue: 1000 },
  ];
  const gross = [
    { property_id: "prop-partial", date: "2026-06-01", room_rent: 1000 },
  ];
  // Note: occupancy row is MISSING rooms_sold (unknown room-nights for flat fee)
  const occMissingNights = [
    { property_id: "prop-partial", date: "2026-06-01", room_revenue: 1000, rooms_sold: null, total_rooms: 20 },
  ];

  const taxLiab = CalculationService.calculateTaxLiability(src, gross, "prop-partial", { from: "2026-06-01", to: "2026-06-01" }, occMissingNights, true);
  T("tax liability detects incomplete enterprise estimate", taxLiab.incomplete === true, `taxLiab.incomplete=${taxLiab.incomplete}`);
  T("known percentage tax ($50) is preserved", taxLiab.estimated === 50, `estimated=${taxLiab.estimated}`);

  const mk = CalculationService.calculateMoneyKept(occMissingNights, src, gross, [], [], [], { from: "2026-06-01", to: "2026-06-01" }, "prop-partial");
  T("money kept signals taxIncomplete true on partial tax", mk.taxIncomplete === true, `mk.taxIncomplete=${mk.taxIncomplete}`);
  T("money kept signals isPartial true", mk.isPartial === true, `mk.isPartial=${mk.isPartial}`);
  T("known deductions ($150 comm + $50 tax) preserved in partial kept total ($800)", mk.kept === 800, `kept=${mk.kept}`);

  const baseData = buildMoneyKeptBaseData({
    occRows: occMissingNights, srcRows: src, grossRows: gross, payRecords: [], expenses: [], payroll: [],
    from: "2026-06-01", to: "2026-06-01"
  });
  T("baseData marks isTaxIncomplete true", baseData.isTaxIncomplete === true, `baseData.isTaxIncomplete=${baseData.isTaxIncomplete}`);
  T("baseData marks isPartial true", baseData.isPartial === true, `baseData.isPartial=${baseData.isPartial}`);
  const taxItem = baseData.items.find(i => i.key === "taxes");
  T("tax line item explicitly labeled partial", taxItem?.label.toLowerCase().includes("partial") === true, `taxItem label=${taxItem?.label}`);

  const pres = buildMoneyKeptPresentation(baseData);
  const keptPie = pres.pieData.find((p) => p.name.includes("Money Kept"));
  T("pieData qualifies money kept as partial", keptPie?.name.includes("partial") === true, `pie name=${keptPie?.name}`);
  const keptBar = pres.barData.find((b) => b.name.includes("Money Kept"));
  T("barData qualifies money kept as partial", keptBar?.name.includes("partial") === true, `bar name=${keptBar?.name}`);
}

console.log("\n=== SCENARIO 3: Portfolio with One Incomplete Property ===");
{
  globalThis.localStorage.clear();
  // Prop A is complete
  setTaxConfig({ taxRate: 0.10, taxEnabled: true }, "PropA");
  saveTaxSettings([
    { property_id: "PropA", state_rate: 0.06, city_rate: 0.04, other_rate: 0.0, effective_start: "2026-01-01" },
  ], "PropA");

  // Prop B has unconfigured rates (no tax config and no settings saved for PropB)


  const srcA = [{ property_id: "PropA", date: "2026-06-01", source: "EXPEDIA HOTEL COLLECT", net_revenue: 1000 }];
  const grossA = [{ property_id: "PropA", date: "2026-06-01", room_rent: 1000 }];
  const occA = [{ property_id: "PropA", date: "2026-06-01", room_revenue: 1000, rooms_sold: 10, total_rooms: 20 }];

  const srcB = [{ property_id: "PropB", date: "2026-06-01", source: "WALK IN", net_revenue: 800 }];
  const grossB = [{ property_id: "PropB", date: "2026-06-01", room_rent: 800 }];
  const occB = [{ property_id: "PropB", date: "2026-06-01", room_revenue: 800, rooms_sold: 8, total_rooms: 20 }];

  const allSrc = [...srcA, ...srcB];
  const allGross = [...grossA, ...grossB];
  const allOcc = [...occA, ...occB];

  const taxLiab = CalculationService.calculateTaxLiability(allSrc, allGross, null, { from: "2026-06-01", to: "2026-06-01" }, allOcc, true);
  T("portfolio tax liability is marked incomplete when one property is unconfigured", taxLiab.incomplete === true, `taxLiab.incomplete=${taxLiab.incomplete}`);
  T("portfolio known tax from PropA ($100) is preserved", taxLiab.estimated === 100, `estimated=${taxLiab.estimated}`);

  const mk = CalculationService.calculateMoneyKept(allOcc, allSrc, allGross, [], [], [], { from: "2026-06-01", to: "2026-06-01" }, null);
  T("portfolio money kept is marked taxIncomplete true", mk.taxIncomplete === true, `mk.taxIncomplete=${mk.taxIncomplete}`);
  T("portfolio money kept is marked isPartial true", mk.isPartial === true, `mk.isPartial=${mk.isPartial}`);
  T("portfolio kept preserves known deductions: $1800 gross - $150 comm - $100 tax = $1550", mk.kept === 1550, `kept=${mk.kept}`);

  const baseData = buildMoneyKeptBaseData({
    occRows: allOcc, srcRows: allSrc, grossRows: allGross, payRecords: [], expenses: [], payroll: [],
    from: "2026-06-01", to: "2026-06-01"
  });
  T("portfolio baseData marks isTaxIncomplete true", baseData.isTaxIncomplete === true, `baseData.isTaxIncomplete=${baseData.isTaxIncomplete}`);
  T("portfolio baseData marks isPartial true", baseData.isPartial === true, `baseData.isPartial=${baseData.isPartial}`);
}

console.log("\n=== SCENARIO 4: Zero Known Tax vs Unknown Tax Distinction ===");
{
  globalThis.localStorage.clear();
  // 4a: Explicit known 0% tax rate
  setTaxConfig({ taxRate: 0.0, taxEnabled: true }, "prop-zero");
  saveTaxSettings([
    { property_id: "prop-zero", state_rate: 0.0, city_rate: 0.0, other_rate: 0.0, effective_start: "2026-01-01" },
  ], "prop-zero");

  const srcZero = [{ property_id: "prop-zero", date: "2026-06-01", source: "EXPEDIA HOTEL COLLECT", net_revenue: 1000 }];
  const grossZero = [{ property_id: "prop-zero", date: "2026-06-01", room_rent: 1000 }];
  const occZero = [{ property_id: "prop-zero", date: "2026-06-01", room_revenue: 1000, rooms_sold: 10, total_rooms: 20 }];

  const taxZero = CalculationService.calculateTaxLiability(srcZero, grossZero, "prop-zero", { from: "2026-06-01", to: "2026-06-01" }, occZero, true);
  T("configured 0% tax is complete (not incomplete)", taxZero.incomplete === false, `taxZero.incomplete=${taxZero.incomplete}`);
  const mkZero = CalculationService.calculateMoneyKept(occZero, srcZero, grossZero, [], [], [], { from: "2026-06-01", to: "2026-06-01" }, "prop-zero");
  T("configured 0% tax money kept is not incomplete", mkZero.taxIncomplete === false, `mkZero.taxIncomplete=${mkZero.taxIncomplete}`);

  // 4b: Unknown/unconfigured tax (no tax settings saved at all for a specific property)
  globalThis.localStorage.clear();
  const srcUnknown = [{ property_id: "prop-unknown", date: "2026-06-01", source: "EXPEDIA HOTEL COLLECT", net_revenue: 1000 }];
  const grossUnknown = [{ property_id: "prop-unknown", date: "2026-06-01", room_rent: 1000 }];
  const occUnknown = [{ property_id: "prop-unknown", date: "2026-06-01", room_revenue: 1000, rooms_sold: 10, total_rooms: 20 }];

  const taxUnknown = CalculationService.calculateTaxLiability(srcUnknown, grossUnknown, "prop-unknown", { from: "2026-06-01", to: "2026-06-01" }, occUnknown, true);
  T("unconfigured tax is marked incomplete", taxUnknown.incomplete === true, `taxUnknown.incomplete=${taxUnknown.incomplete}`);
  const mkUnknown = CalculationService.calculateMoneyKept(occUnknown, srcUnknown, grossUnknown, [], [], [], { from: "2026-06-01", to: "2026-06-01" }, "prop-unknown");
  T("unconfigured tax money kept is marked taxIncomplete true", mkUnknown.taxIncomplete === true, `mkUnknown.taxIncomplete=${mkUnknown.taxIncomplete}`);
  T("unconfigured tax basis indicates unconfigured or incomplete", mkUnknown.basis.tax === 'unconfigured' || mkUnknown.taxIncomplete === true);
}

console.log("\n=== SCENARIO 5: Owner Packet XLSX Export Completeness ===");
{
  // Test owner packet export when kpis.taxIncomplete / isPartial is true vs false
  const wbComplete = buildOwnerPerformancePacketWorkbook({
    kpis: { revenue: 1000, netKept: 900, taxIncomplete: false, isPartial: false },
    properties: [{ id: "P1", name: "Prop 1" }],
  });
  const sheet1Complete = wbComplete.Sheets["Executive Summary"];
  const sheet1CompleteText = JSON.stringify(sheet1Complete);
  T("complete packet export does not label Net Kept as partial", !sheet1CompleteText.includes("Partial"), "contains Partial");

  const wbPartial = buildOwnerPerformancePacketWorkbook({
    kpis: { revenue: 1000, netKept: 900, taxIncomplete: true, isPartial: true },
    properties: [{ id: "P1", name: "Prop 1" }],
  });
  const sheet1Partial = wbPartial.Sheets["Executive Summary"];
  const sheet1PartialText = JSON.stringify(sheet1Partial);
  T("partial packet export explicitly labels Net Kept as partial in Executive Summary", sheet1PartialText.includes("Partial"), "missing Partial label in Sheet 1");

  const sheet5Partial = wbPartial.Sheets["Data Provenance"];
  const sheet5PartialText = JSON.stringify(sheet5Partial);
  T("partial packet export flags Data Provenance with PARTIAL / TAX INCOMPLETE", sheet5PartialText.includes("PARTIAL") || sheet5PartialText.includes("TAX INCOMPLETE") || sheet5PartialText.includes("Partial"), "missing partial note in Sheet 5");
}

console.log("\n=== SCENARIO 6: Narrow Financial Corrections Contract (Integer-cents & Direct Strings) ===");
{
  const modelSrc = fs.readFileSync("src/lib/moneyKeptModel.js", "utf8");
  T("moneyKeptModel uses fromCents(toCents(estimatedTaxesTotal)) for tax item amount", modelSrc.includes("fromCents(toCents(estimatedTaxesTotal))"));
  T("moneyKeptModel does not use Math.round on estimatedTaxesTotal", !modelSrc.includes("Math.round(estimatedTaxesTotal"));

  const jsxSrc = fs.readFileSync("src/components/dashboard/MoneyKept.jsx", "utf8");
  T("MoneyKept.jsx displays Unknown (tax inputs incomplete)", jsxSrc.includes("Unknown (tax inputs incomplete)"));
  T("MoneyKept.jsx does not display Unknown (rates unconfigured)", !jsxSrc.includes("Unknown (rates unconfigured)"));
  T("MoneyKept.jsx qualifies trend title with partial", jsxSrc.includes('partial ? "Estimated Money Kept Trend (Partial)" : "Estimated Money Kept Trend"'));
  T("MoneyKept.jsx qualifies trend tooltip with partial", jsxSrc.includes('partial ? "Estimated Money Kept (Partial)" : "Estimated Money Kept"'));
}

console.log("\n=== SCENARIO 7: Flat-Per-Night Configured Jurisdiction with Missing Occupied Room Nights ===");
{
  globalThis.localStorage.clear();
  // Property profile has ONLY configured reviewed flat_per_night city jurisdiction rate 2.50, valid period
  savePropertyProfile("prop-flat-only", {
    periods: [{
      effective_start: "2026-01-01",
      effective_end: "2026-12-31",
      tax_jurisdictions: [
        { id: "city-flat", kind: "city", type: "flat_per_night", rate: 2.50, reviewed: true },
      ],
    }],
  });
  setTaxConfig({ taxRate: 0.0, taxEnabled: true }, "prop-flat-only");

  const src = [
    { property_id: "prop-flat-only", date: "2026-06-01", source: "EXPEDIA HOTEL COLLECT", net_revenue: 1000 },
  ];
  const gross = [
    { property_id: "prop-flat-only", date: "2026-06-01", room_rent: 1000 },
  ];
  // Occupancy rooms_sold: null, nonzero room revenue
  const occ = [
    { property_id: "prop-flat-only", date: "2026-06-01", room_revenue: 1000, rooms_sold: null, total_rooms: 20 },
  ];

  const taxLiab = CalculationService.calculateTaxLiability(src, gross, "prop-flat-only", { from: "2026-06-01", to: "2026-06-01" }, occ, true);
  T("flat-only missing nights tax liability is incomplete", taxLiab.incomplete === true, `taxLiab.incomplete=${taxLiab.incomplete}`);
  T("known estimatedTax 0 is retained", taxLiab.estimated === 0, `taxLiab.estimated=${taxLiab.estimated}`);

  const mk = CalculationService.calculateMoneyKept(occ, src, gross, [], [], [], { from: "2026-06-01", to: "2026-06-01" }, "prop-flat-only");
  T("money kept taxIncomplete is true", mk.taxIncomplete === true, `mk.taxIncomplete=${mk.taxIncomplete}`);
  T("money kept basis.tax is 'partial estimate' (not unconfigured)", mk.basis.tax === "partial estimate", `mk.basis.tax=${mk.basis.tax}`);

  const baseData = buildMoneyKeptBaseData({
    occRows: occ, srcRows: src, grossRows: gross, payRecords: [], expenses: [], payroll: [],
    from: "2026-06-01", to: "2026-06-01"
  });
  T("baseData marks isTaxIncomplete true", baseData.isTaxIncomplete === true, `baseData.isTaxIncomplete=${baseData.isTaxIncomplete}`);
  const taxItem = baseData.items.find(i => i.key === "taxes");
  T("tax item exists for flat-only incomplete tax", Boolean(taxItem));
  T("tax item label says incomplete/unknown", taxItem?.label.includes("incomplete") || taxItem?.label.includes("unknown"), `taxItem label=${taxItem?.label}`);
  T("tax item label DOES NOT imply unconfigured", !taxItem?.label.toLowerCase().includes("unconfigured"), `taxItem label=${taxItem?.label}`);
  T("tax item does not carry unproven unconfigured flag", taxItem?.unconfigured !== true, `taxItem.unconfigured=${taxItem?.unconfigured}`);
}

console.log(`${fail > 0 ? "FAILED" : "PASSED"}: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
