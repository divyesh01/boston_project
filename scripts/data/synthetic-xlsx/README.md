# Synthetic XLSX parser fixtures

These files contain no guest or property data. `normal.xlsx` and
`multiple-sheets.xlsx` were generated with the former `xlsx@0.18.5` package;
the remaining files are controlled mutations. Their bytes are checked in so
the parser sees identical input before and after a dependency upgrade.

`baseline.json` records the real `scanReport('occupancy', ...)` output from
0.18.5. `probe-xlsx-security.mjs` compares later parser output with it and
checks malformed, multi-sheet, compressed, and hostile-shape inputs. The
generation script is retained as provenance; rerunning it is not part of the
release test.
