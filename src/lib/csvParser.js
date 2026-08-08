// Direct CSV parser — handles date formats like "1-Jan-26", currency "$1,337.80", negatives "($100.00)"

const MONTH_MAP = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

export function convertDate(s) {
  if (!s) return "";
  s = String(s).trim();
  // "1-Jan-26" or "01-Jan-2026"
  const m1 = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m1) {
    const day = m1[1].padStart(2, "0");
    const mon = MONTH_MAP[m1[2].toLowerCase()];
    let year = m1[3];
    if (year.length === 2) year = "20" + year;
    if (mon) return `${year}-${mon}-${day}`;
  }
  // ISO "2026-01-01"
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  // US "1/1/2026"
  const m3 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m3) {
    let year = m3[3];
    if (year.length === 2) year = "20" + year;
    return `${year}-${m3[1].padStart(2, "0")}-${m3[2].padStart(2, "0")}`;
  }
  // "Apr 01, 2026" / "Apr 1, 2026" / "Jul 01, 2026"
  const m4 = s.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
  if (m4) {
    const mon = MONTH_MAP[m4[1].toLowerCase()];
    if (mon) return `${m4[3]}-${mon}-${m4[2].padStart(2, "0")}`;
  }
  return s;
}

export function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}/.test(String(s || ""));
}

export function parseAmount(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (!s) return null;
  const isNegative = (s.startsWith("(") && s.endsWith(")")) || s.startsWith("-");
  let cleaned = s.replace(/[\$,\s()]/g, "");
  if (cleaned.startsWith("-")) cleaned = cleaned.slice(1);
  const n = parseFloat(cleaned);
  if (isNaN(n)) return null;
  return isNegative ? -n : n;
}

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (c === "," && !inQuote) {
      fields.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

export function parseCsvText(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (line.trim()) rows.push(parseCsvLine(line));
    else rows.push([]);
  }
  return rows;
}

export function rowsToObjects(rawRows) {
  if (rawRows.length < 2) return [];
  const headers = rawRows[0].map((h) => h.trim());
  return rawRows
    .slice(1)
    .filter((r) => r.length > 0 && r.some((c) => c !== ""))
    .map((row) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = row[i] || "";
      });
      return obj;
    });
}

// Detect stacked CSV sections by scanning for header rows
const SECTION_HEADERS = {
  payment_summary: ["payment type", "actual", "adjusted", "net today"],
  shift_log: ["username", "start time", "end time", "closed by"],
  employee_payments: ["username", "payment type", "amount"],
  expenses: ["expense type", "amount"],
  currency_conversion: ["type", "converted from", "conversion rate", "converted value"],
  deposit_drop: ["time", "username"],
};

function headerMatches(rowCells, headerKeywords) {
  const lower = rowCells.map((c) => c.toLowerCase().trim());
  return headerKeywords.every((kw) => lower.some((l) => l === kw || l.includes(kw)));
}

export function detectSections(rawRows) {
  const sections = [];
  let current = null;
  let currentRows = [];

  const flush = () => {
    if (current) {
      current.rows = currentRows;
      sections.push(current);
    }
    current = null;
    currentRows = [];
  };

  for (const row of rawRows) {
    const isEmpty = row.length === 0 || row.every((c) => c.trim() === "");

    if (isEmpty) {
      flush();
      continue;
    }

    // Check if this row matches a section header
    let matchedType = null;
    for (const [type, keywords] of Object.entries(SECTION_HEADERS)) {
      if (headerMatches(row, keywords)) {
        matchedType = type;
        break;
      }
    }

    if (matchedType) {
      flush();
      current = { type: matchedType, headerRow: row, detectedColumns: row };
      currentRows = [];
    } else {
      currentRows.push(row);
    }
  }

  flush();
  return sections;
}

export async function fetchCsvRows(fileUrl) {
  // Strip the hash fragment from the URL before fetching to prevent fetch errors with blob URLs in some environments
  const cleanUrl = fileUrl.split('#')[0];
  const res = await fetch(cleanUrl);
  if (!res.ok) throw new Error(`Failed to fetch CSV: ${res.statusText}`);
  const text = await res.text();
  return parseCsvText(text);
}

export function isCsvFile(fileUrl) {
  if (!fileUrl) return false;
  // Check both the URL path and the hash fragment (blob URLs encode filename in hash)
  return /\.csv(\?|#|$)/i.test(fileUrl) || /\.csv$/i.test(decodeURIComponent(fileUrl.split('#').pop() || ''));
}