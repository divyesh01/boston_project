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
    const matches = [...content.matchAll(/from\s+['"](.+?)['"]/g)];
    matches.forEach(m => {
        const imp = m[1];
        if (imp.startsWith('.') || imp.startsWith('@/')) {
            const baseName = imp.split('/').pop().replace(/\.[^/.]+$/, "");
            importCounts[baseName] = (importCounts[baseName] || 0) + 1;
        }
    });
});

const sorted = Object.entries(importCounts).sort((a,b) => b[1] - a[1]).slice(0, 20);

let md = '# 💥 LIVE DEPENDENCY DANGER MAP\n\n';
md += '> [!CAUTION]\n> **AUTO-GENERATED FILE.** Do not edit manually. Run `npm run brain:map` to regenerate.\n\n';
md += 'These files are imported the most across the codebase. Editing them has a massive blast radius.\n\n';

md += '```mermaid\ngraph TD\n';
sorted.forEach(([name, count]) => {
    if (count > 5) {
        md += `  ${name.replace(/[^a-zA-Z0-9_]/g, '')}[${name}<br/>(${count} imports)]\n`;
    }
});
md += '```\n\n';

md += '### Top Danger Zones\n| File Base Name | Import Count | Danger Level |\n|----------------|--------------|--------------|\n';
sorted.forEach(([name, count]) => {
    let danger = count > 15 ? '🔴 CRITICAL' : (count > 5 ? '🟡 HIGH' : '🟢 MODERATE');
    md += `| ${name} | ${count} | ${danger} |\n`;
});

fs.writeFileSync('docs/brain/BRAIN_DEPENDENCIES.md', md);
console.log('✅ Generated Live Danger Map at docs/brain/BRAIN_DEPENDENCIES.md');