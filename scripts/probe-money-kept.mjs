import { register } from "node:module";
register(new URL("./resolve-alias.mjs", import.meta.url));

const { CalculationService } = await import("../src/lib/calculationService.js");

function run() {
  console.log("=== PROBE: MONEY KEPT (FLOAT PRECISION LOSS) ===");

  const occRows = [{ total_revenue: 2.05 }]; // $2.05 as float
  const expenses = [{
    category: 'maintenance',
    expense_date: '2026-08-01',
    amount: 2.01
  }];
  const dateRange = { from: '2026-08-01', to: '2026-08-31' };
  
  const result = CalculationService.calculateMoneyKept(
    occRows,
    [], // srcRows
    [], // grossRows
    [], // payRows
    expenses,
    [], // payroll
    dateRange
  );
  
  console.log(`Gross Revenue: $${result.gross}`);
  console.log(`Operating Expenses: $${result.operatingExpenses}`);
  console.log(`Total Deductions: $${result.totalDeductions}`);
  console.log(`Kept (Gross - Deductions): $${result.kept}`);
  
  if (result.kept !== 0.04) {
    console.log(`\nPRECISION LOSS DETECTED! Expected $0.04, got $${result.kept}`);
  } else {
    console.log(`\nNo precision loss detected in this specific case.`);
  }
}

run();
