# SheetJS CE workbook parser

`xlsx-0.20.3.tgz` is the SheetJS Community Edition package used by the HotelKey
XLS/XLSX import path. The package is vendored so `npm ci` does not depend on the
availability of SheetJS's CDN during a release.

- Official source: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
- Installation instructions: https://docs.sheetjs.com/docs/getting-started/installation/frameworks/
- SHA-256: `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`
- The `package-lock.json` SHA-512 integrity entry matches the vendored bytes.

The previous npm-registry version, 0.18.5, falls within the affected ranges
for [CVE-2023-30533](https://cdn.sheetjs.com/advisories/CVE-2023-30533)
(`<0.19.3`) and [CVE-2024-22363](https://cdn.sheetjs.com/advisories/CVE-2024-22363)
(`<0.20.2`). The cited advisories and SheetJS's current installation docs
identify this official 0.20.3 artifact as beyond both affected ranges.
