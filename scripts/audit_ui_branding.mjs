import fs from 'fs';
import path from 'path';

const pagesDir = path.join(process.cwd(), 'src/pages');
const compDir = path.join(process.cwd(), 'src/components');

function scanUiText(dir) {
  const files = fs.readdirSync(dir, { recursive: true });
  const matches = [];
  for (const f of files) {
    const fullPath = path.join(dir, f);
    if (fs.statSync(fullPath).isDirectory()) continue;
    if (!/\.(jsx|js|tsx|ts|html)$/.test(f)) continue;
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      // Look for user-visible strings containing Base44 (excluding imports/comments)
      if (/base44/i.test(line) && !/import\s+|from\s+|console\.|@|\/\/|\/\*/.test(line)) {
        matches.push({ file: path.relative(process.cwd(), fullPath), line: idx + 1, text: line.trim() });
      }
    });
  }
  return matches;
}

const uiMatches = [...scanUiText(pagesDir), ...scanUiText(compDir)];
console.log(`UI User-Facing Base44 text matches found: ${uiMatches.length}`);
console.log(JSON.stringify(uiMatches, null, 2));
