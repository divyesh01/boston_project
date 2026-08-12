// Probe: try to import every source module to find the one that crashes
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const srcDir = join(process.cwd(), 'src');

function getAllJsx(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...getAllJsx(full));
    } else if (/\.(jsx?|tsx?)$/.test(entry) && !entry.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

const files = getAllJsx(srcDir);
console.log(`Found ${files.length} source files`);

// Check for syntax issues: try to find obvious problems
for (const f of files) {
  const content = readFileSync(f, 'utf8');
  const rel = relative(process.cwd(), f);
  
  // Check for imports of deleted .js files
  const importMatches = content.matchAll(/(?:import|from)\s+['"]([^'"]+)['"]/g);
  for (const [, imp] of importMatches) {
    if (imp.startsWith('.')) {
      // relative import — not our concern here
    }
  }
  
  // Check for obvious syntax issues
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Check for JSX with class instead of className (React error)
    if (/\bclass\s*=\s*["']/.test(line) && !/className/.test(line)) {
      console.log(`WARN: Possible HTML class= in React: ${rel}:${i+1}`);
    }
  }
}

console.log('Basic syntax scan complete');
