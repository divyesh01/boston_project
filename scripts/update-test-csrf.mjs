import fs from 'fs';
import path from 'path';

const filesToUpdate = [
  'scripts/probe-auth-hardening.mjs',
  'scripts/probe-welcome-email.mjs',
  'scripts/probe-audit-chain.mjs'
];

for (const relPath of filesToUpdate) {
  const fullPath = path.join(process.cwd(), relPath);
  if (!fs.existsSync(fullPath)) continue;
  let content = fs.readFileSync(fullPath, 'utf8');
  const newContent = content.replace(/csrf_token=/g, '__Host-csrf_token=');
  if (content === newContent) {
    console.warn('No changes made to:', relPath);
  } else {
    fs.writeFileSync(fullPath, newContent, 'utf8');
    console.log('Updated:', relPath);
  }
}
