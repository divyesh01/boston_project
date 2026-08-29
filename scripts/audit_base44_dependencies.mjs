import fs from 'fs';
import path from 'path';

const rootDir = process.cwd();

// Helper to scan directory recursively
function getAllFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (file === 'node_modules' || file === '.git' || file === 'dist' || file === '.system_generated') continue;
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      getAllFiles(filePath, fileList);
    } else {
      fileList.push(filePath);
    }
  }
  return fileList;
}

const allFiles = getAllFiles(rootDir);

console.log(`Scanning ${allFiles.length} project files for Base44 references across 20 risk areas...`);

const results = {
  totalOccurrences: 0,
  filesWithOccurrences: new Set(),
  areaFindings: Array.from({ length: 20 }, () => []),
  classifications: {
    'BRANDING ONLY': [],
    'SAFE TO RENAME': [],
    'SAFE TO REMOVE': [],
    'INTERNAL WRAPPER NAME ONLY': [],
    'RUNTIME DEPENDENCY': [],
    'BUILD DEPENDENCY': [],
    'AUTH DEPENDENCY': [],
    'DATABASE DEPENDENCY': [],
    'REMOTE SERVICE DEPENDENCY': [],
    'UNKNOWN / NEEDS PROOF': [],
  },
  importCallers: [],
  dynamicImportCallers: [],
  envVars: new Set(),
  hardcodedAppIds: [],
  base44Functions: [],
  base44Entities: [],
};

const base44Regex = /base44/i;

for (const filePath of allFiles) {
  const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    continue;
  }

  const lines = content.split('\n');
  let fileHasMatch = false;

  lines.forEach((line, idx) => {
    if (base44Regex.test(line)) {
      results.totalOccurrences++;
      fileHasMatch = true;

      // Extract specific patterns
      if (/import\s+.*from\s+['"].*base44Client.*['"]/.test(line)) {
        results.importCallers.push({ file: relPath, line: idx + 1, text: line.trim() });
      }
      if (/import\(['"].*base44Client.*['"]\)/.test(line)) {
        results.dynamicImportCallers.push({ file: relPath, line: idx + 1, text: line.trim() });
      }
      const envMatches = line.match(/(?:VITE_)?BASE44_[A-Z0-9_]+/g);
      if (envMatches) {
        envMatches.forEach((v) => results.envVars.add(v));
      }
      if (/6a7d6856ee1cc714b1803c0e/.test(line)) {
        results.hardcodedAppIds.push({ file: relPath, line: idx + 1, text: line.trim() });
      }
    }
  });

  if (fileHasMatch) {
    results.filesWithOccurrences.add(relPath);
  }
}

// Inspect base44/ directory entities & functions
if (fs.existsSync(path.join(rootDir, 'base44/entities'))) {
  results.base44Entities = fs.readdirSync(path.join(rootDir, 'base44/entities')).map(f => f.replace('.jsonc', ''));
}
if (fs.existsSync(path.join(rootDir, 'base44/functions'))) {
  results.base44Functions = fs.readdirSync(path.join(rootDir, 'base44/functions'));
}

console.log(`\n=== SUMMARY METRICS ===`);
console.log(`Total files with 'base44' references: ${results.filesWithOccurrences.size}`);
console.log(`Static import callers of base44Client: ${results.importCallers.length}`);
console.log(`Dynamic import callers of base44Client: ${results.dynamicImportCallers.length}`);
console.log(`Environment variables found:`, Array.from(results.envVars));
console.log(`Hardcoded production App ID sites: ${results.hardcodedAppIds.length}`);
console.log(`Base44 Entity schemas defined: ${results.base44Entities.length} (${results.base44Entities.join(', ')})`);
console.log(`Base44 Serverless functions defined: ${results.base44Functions.length} (${results.base44Functions.join(', ')})`);

// Output callers by directory
const callersByDir = {};
[...results.importCallers, ...results.dynamicImportCallers].forEach((c) => {
  const dir = path.dirname(c.file);
  callersByDir[dir] = (callersByDir[dir] || 0) + 1;
});
console.log('\n=== CALLERS BY DIRECTORY ===');
console.log(JSON.stringify(callersByDir, null, 2));

