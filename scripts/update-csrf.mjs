import fs from 'fs';
import path from 'path';

const filesToUpdate = [
  'base44/functions/audit_log/entry.js',
  'base44/functions/autoPayroll/entry.ts',
  'base44/functions/backupToDrive/entry.ts',
  'base44/functions/custom_auth_logout/entry.js',
  'base44/functions/custom_auth_register/entry.js',
  'base44/functions/custom_auth_reset_password/entry.js',
  'base44/functions/custom_auth_reset_request/entry.js',
  'base44/functions/custom_user_admin/entry.js',
  'base44/functions/deleteAccount/entry.ts',
  'base44/functions/importDriveFile/entry.ts'
];

for (const relPath of filesToUpdate) {
  const fullPath = path.join(process.cwd(), relPath);
  let content = fs.readFileSync(fullPath, 'utf8');
  const newContent = content.replace(/\/csrf_token=\(\[\^;\]\+\)\//g, '/__Host-csrf_token=([^;]+)/');
  if (content === newContent) {
    console.warn('No changes made to:', relPath);
  } else {
    fs.writeFileSync(fullPath, newContent, 'utf8');
    console.log('Updated:', relPath);
  }
}
