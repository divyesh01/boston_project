const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('1. Setting up directories...');
if (!fs.existsSync('docs/brain')) fs.mkdirSync('docs/brain', { recursive: true });
if (!fs.existsSync('scripts')) fs.mkdirSync('scripts', { recursive: true });

console.log('2. Parsing and splitting BRAIN.md...');
const content = fs.readFileSync('BRAIN.md', 'utf8');
const sections = content.split(/^# /m).map(s => s.trim()).filter(Boolean);

// ── SAFETY GUARD added 2026-08-19 (known problem #13) ─────────────────────────
// This is a NON-IDEMPOTENT one-shot. It rewrites BRAIN.md, all docs/brain spokes,
// scripts/generate-brain-map.mjs, scripts/verify-brain.mjs, the pre-commit hook
// AND package.json. When it was re-run against an already-migrated repo, every
// getSec() below matched nothing and each spoke was overwritten with whitespace:
// 940 lines / ~47KB of documentation destroyed. Abort before the first write.
const REQUIRED_SECTIONS = [
    /12\. THE MONEY MATH/i,
    /13\. SECURITY ARCHITECTURE/i,
    /7\. ALL 16 DATABASE TABLES/i,
];
const missingSections = REQUIRED_SECTIONS.filter(re => !sections.some(s => re.test(s)));
if (missingSections.length) {
    console.error('\nABORTED: BRAIN.md is not the pre-migration monolith.');
    console.error('  missing expected section(s): ' + missingSections.join(', '));
    console.error('  This repo already uses the hub + docs/brain/ spokes, so every');
    console.error('  section extraction would return empty and overwrite a real');
    console.error('  document with whitespace. NOTHING WAS WRITTEN.');
    console.error('  See docs/brain/BRAIN_TROUBLESHOOTING.md section 20.\n');
    process.exit(1);
}

function getSec(regex) {
    const s = sections.find(x => regex.test(x));
    if (!s) {
        throw new Error('getSec: nothing matched ' + regex +
            ' -- refusing to write an empty spoke over a real document');
    }
    return '# ' + s;
}

const finance = getSec(/12\. THE MONEY MATH/i);
fs.writeFileSync('docs/brain/BRAIN_FINANCE.md', finance);

const security = getSec(/13\. SECURITY ARCHITECTURE/i) + '\n\n' + getSec(/15\. PROTECTED FILES/i);
fs.writeFileSync('docs/brain/BRAIN_SECURITY.md', security);

const frontend = getSec(/4\. ALL 36 PAGES/i) + '\n\n' + getSec(/5\. ALL 90\+ LIBRARIES/i) + '\n\n' + getSec(/6\. ALL 40\+ COMPONENTS/i);
fs.writeFileSync('docs/brain/BRAIN_FRONTEND.md', frontend);

const backend = getSec(/7\. ALL 16 DATABASE TABLES/i) + '\n\n' + getSec(/8\. ALL 19 BACKEND FUNCTIONS/i) + '\n\n' + getSec(/9\. ALL CONFIG FILES/i) + '\n\n' + getSec(/10\. ALL TEST SCRIPTS/i);
fs.writeFileSync('docs/brain/BRAIN_BACKEND.md', backend);

const playbookText = `
# 🚨 19. EMERGENCY PLAYBOOK (For Humans)
> [!TIP]
> **Hotel Owners & Managers:** If something goes wrong in real life, follow this guide before calling a developer.

### Scenario A: "The Dashboard Revenue Doesn't Match My Bank Account"
1. **Check the CSVs:** Did the front desk upload yesterday's HotelKey report? Go to \`Import\` and check the history.
2. **Check the "Drift":** Look at the **Money Kept** widget. If Path 1, 2, and 3 don't match, an employee might have manually altered a folio after the night audit.
3. **Look for Cash Variances:** Go to \`Employees\` -> \`Clerk Audit Matrix\`. Did a clerk have a large cash drop variance? 

### Scenario B: "An Employee is Locked Out"
1. **DO NOT delete their account.**
2. Go to \`Users\` (you must be an Owner/Admin).
3. Find their name and check if the **Lockout Flag** is triggered (happens automatically after 5 bad passwords).
4. Click "Unlock" or "Send Password Reset".
5. If they lost their MFA phone, click "Reset MFA".

### Scenario C: "The App is Super Slow or Freezing"
1. You likely have too many raw CSV previews stuck in your local browser cache.
2. Press \`Ctrl + Shift + R\` (Hard Refresh) to clear the IndexedDB cache and pull fresh data.

### Scenario D: "I Accidentally Imported the Wrong Date's Data"
1. Go to the \`Import\` page.
2. Find the bad import in the "Recent Imports" list.
3. Click the **Undo/Rollback** button. (The system treats imports as atomic ledgers, so clicking undo instantly wipes the data safely without leaving ghost records).
`;
const trouble = getSec(/14\. THE 9 KNOWN PROBLEMS/i) + '\n\n' + playbookText;
fs.writeFileSync('docs/brain/BRAIN_TROUBLESHOOTING.md', trouble);

console.log('3. Creating the new HUB (BRAIN.md)...');
const hub = `# 🧠 RED ROOF INTELLIGENCE - MASTER BRAIN (HUB)

> [!IMPORTANT]
> **AI AGENTS:** You are currently in the HUB. To save tokens and maximize context window efficiency, this file only contains routing.
> Read the specific Spoke files below based on your exact task. NEVER scan the entire project.

## 🔀 THE SPOKES (Context Segmentation)
| Domain | File | Use When... |
|--------|------|-------------|
| 💰 **Finance** | \`docs/brain/BRAIN_FINANCE.md\` | Math, formulas, CSV parsers, or reconciliation. |
| 🔒 **Security** | \`docs/brain/BRAIN_SECURITY.md\` | Auth, MFA, sessions, or audit logs. |
| 💻 **Frontend** | \`docs/brain/BRAIN_FRONTEND.md\` | React UI, pages, components, or hooks. |
| ☁️ **Backend** | \`docs/brain/BRAIN_BACKEND.md\` | Base44 entities, serverless functions, configs. |
| 🚨 **Fixes** | \`docs/brain/BRAIN_TROUBLESHOOTING.md\` | Diagnosing known problems or emergency playbook. |
| 💥 **Danger Map**| \`docs/brain/BRAIN_DEPENDENCIES.md\`| See what breaks if you edit a file (Auto-Generated). |

## 🏗️ SYSTEM ARCHITECTURE
\`\`\`mermaid
graph TD
    subgraph Browser [User's Browser]
        UI[💻 React Frontend<br/>(36 Pages, 40+ Components)]
        DB_Local[(🗄️ Local IndexedDB<br/>Offline Cache)]
        UI <--> DB_Local
    end
    subgraph Cloud [Base44 Cloud Server]
        API[⚡ 19 Serverless Functions]
        DB_Cloud[(🗃️ 16 Database Entities)]
        API <--> DB_Cloud
    end
    subgraph External [Integrations]
        Drive[📁 Google Drive Backups]
        Weather[🌤️ OpenWeather API]
    end
    UI <-->|HTTPS / WSS| API
    API <-->|OAuth| Drive
    API <-->|REST| Weather
\`\`\`

## 🤖 AI RULES (The 5-Step Workflow)
- [ ] 1. SCAN: Read this Hub, then read the relevant Spoke.
- [ ] 2. PROVE: Write a test.
- [ ] 3. FIX: Fix the core.
- [ ] 4. VERIFY: Run the test.
- [ ] 5. UPDATE: Update the relevant BRAIN_*.md file! (Enforced by Git Hook)
`;
fs.writeFileSync('BRAIN.md', hub);

console.log('4. Building Auto-Dependency Generator...');
const generatorCode = `
import fs from 'fs';
import path from 'path';

function walk(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const stat = fs.statSync(path.join(dir, file));
        if (stat.isDirectory()) {
            walk(path.join(dir, file), fileList);
        } else if (file.endsWith('.js') || file.endsWith('.jsx')) {
            fileList.push(path.join(dir, file));
        }
    }
    return fileList;
}

const files = walk('src');
const importCounts = {};

files.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    const matches = [...content.matchAll(/from\\s+['"](.+?)['"]/g)];
    matches.forEach(m => {
        const imp = m[1];
        if (imp.startsWith('.') || imp.startsWith('@/')) {
            const baseName = imp.split('/').pop().replace(/\\.[^/.]+$/, "");
            importCounts[baseName] = (importCounts[baseName] || 0) + 1;
        }
    });
});

const sorted = Object.entries(importCounts).sort((a,b) => b[1] - a[1]).slice(0, 20);

let md = '# 💥 LIVE DEPENDENCY DANGER MAP\\n\\n';
md += '> [!CAUTION]\\n> **AUTO-GENERATED FILE.** Do not edit manually. Run \`npm run brain:map\` to regenerate.\\n\\n';
md += 'These files are imported the most across the codebase. Editing them has a massive blast radius.\\n\\n';

md += '\`\`\`mermaid\\ngraph TD\\n';
sorted.forEach(([name, count]) => {
    if (count > 5) {
        md += \`  \${name.replace(/[^a-zA-Z0-9_]/g, '')}[\${name}<br/>(\${count} imports)]\\n\`;
    }
});
md += '\`\`\`\\n\\n';

md += '### Top Danger Zones\\n| File Base Name | Import Count | Danger Level |\\n|----------------|--------------|--------------|\\n';
sorted.forEach(([name, count]) => {
    let danger = count > 15 ? '🔴 CRITICAL' : (count > 5 ? '🟡 HIGH' : '🟢 MODERATE');
    md += \`| \${name} | \${count} | \${danger} |\\n\`;
});

fs.writeFileSync('docs/brain/BRAIN_DEPENDENCIES.md', md);
console.log('✅ Generated Live Danger Map at docs/brain/BRAIN_DEPENDENCIES.md');
`;
fs.writeFileSync('scripts/generate-brain-map.mjs', generatorCode.trim());

console.log('5. Building Anti-Rot Pre-Commit Hook...');
const verifyCode = `
import { execSync } from 'child_process';

try {
    const diff = execSync('git diff --cached --name-only').toString().trim().split('\\n');
    
    const codeChanged = diff.some(f => f.startsWith('src/') || f.startsWith('base44/') || f.startsWith('scripts/'));
    const brainChanged = diff.some(f => f.includes('BRAIN') || f.includes('docs/brain/'));

    if (codeChanged && !brainChanged) {
        console.error('\\n🚨 [ANTI-ROT ENFORCEMENT] ERROR: You modified source code but did not update the Brain.');
        console.error('To keep documentation 100% accurate, you MUST update a BRAIN_*.md file in docs/brain/, or BRAIN.md.');
        console.error('Commit aborted.\\n');
        process.exit(1);
    }
} catch (err) {
    // Ignore if not a git repo or no staged files
}
`;
fs.writeFileSync('scripts/verify-brain.mjs', verifyCode.trim());

const hookDir = '.git/hooks';
if (fs.existsSync(hookDir)) {
    const hookPath = path.join(hookDir, 'pre-commit');
    const hookCode = "#!/bin/sh\nnode scripts/verify-brain.mjs\n";
    fs.writeFileSync(hookPath, hookCode);
}

console.log('6. Updating package.json...');
try {
    const pkgPath = 'package.json';
    if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (!pkg.scripts) pkg.scripts = {};
        pkg.scripts['brain:map'] = 'node scripts/generate-brain-map.mjs';
        pkg.scripts['brain:verify'] = 'node scripts/verify-brain.mjs';
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    }
} catch(e) {}

console.log('7. Running the Auto-Generator for the first time...');
try {
    execSync('node scripts/generate-brain-map.mjs', { stdio: 'inherit' });
} catch (e) {
    console.error('Failed to run generator:', e);
}

console.log('🚀 SYSTEM UPGRADE COMPLETE!');
