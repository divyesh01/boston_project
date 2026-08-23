import { rowsToObjects } from '../src/lib/csvParser.js';

console.log("Running Phase 5 Correctness Probe...");

let pass = 0;
let failed = 0;
let test1Passed = false;
try {
  const input1 = [
    ["name", "amount", "name"],
    ["Smith", "100", "John"]
  ];
  const res1 = rowsToObjects(input1);
  if (Object.keys(res1[0]).length === 3) {
    test1Passed = true;
    pass++;
  } else {
    failed++;
    console.error("FAIL: Duplicate headers resulted in data loss (overwritten).");
  }
} catch (e) {
  console.log("Test 1 threw validation error, which is an acceptable fix.");
  test1Passed = true; 
  pass++;
}

let test2Passed = false;
try {
  const input2 = [
    ["col1", "col2"],
    ["val1", "val2", "val3", "val4"]
  ];
  const res2 = rowsToObjects(input2);
  if (Object.keys(res2[0]).length >= 4) {
    test2Passed = true;
    pass++;
  } else {
    failed++;
    console.error("FAIL: Row with extra cells resulted in data loss (dropped cells).");
  }
} catch (e) {
  console.log("Test 2 threw validation error, which is an acceptable fix.");
  test2Passed = true;
  pass++;
}

console.log(`\n${failed === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${failed} failed`);
if (!test1Passed || !test2Passed) {
  process.exit(failed > 0 ? 1 : 0);
}
console.log('✓ Probe PASSED: Correct behavior verified (no data loss)');
process.exit(failed > 0 ? 1 : 0);
