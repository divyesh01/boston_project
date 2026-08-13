import os
import re

files_to_patch = [
    ('base44/functions/user_admin/index.js', r'    if \(!actor\) \{\n      return Response\.json\(\{ error: "Unauthorized" \}, \{ status: 401 \}\);\n    \}'),
    ('base44/functions/autoPayroll/entry.ts', r'      if \(user\.is_active === false\) \{\n        return Response\.json\(\{ error: "Forbidden: Account is suspended" \}, \{ status: 403 \}\);\n      \}'),
    ('base44/functions/backupToDrive/entry.ts', r'    if \(!user \|\| !user\.is_active \|\| user\.is_locked\) return Response\.json\(\{ error: "Unauthorized" \}, \{ status: 401 \}\);'),
    ('base44/functions/importDriveFile/entry.ts', r'    if \(!user \|\| !user\.is_active \|\| user\.is_locked\) return Response\.json\(\{ error: "Unauthorized" \}, \{ status: 401 \}\);'),
    ('base44/functions/auth_logout/index.js', r'    if \(token\) \{'),
    ('base44/functions/auth_register/index.js', r'export default async function \(req\) \{\n  try \{'),
    ('base44/functions/auth_reset_password/index.js', r'export default async function \(req\) \{\n  try \{'),
    ('base44/functions/auth_reset_request/index.js', r'export default async function \(req\) \{\n  try \{'),
]

csrf_snippet = """
    const _csrfHeader = req.headers.get('x-csrf-token');
    const _cookieHeader = req.headers.get('cookie') || '';
    const _csrfCookieMatch = _cookieHeader.match(/csrf_token=([^;]+)/);
    const _csrfCookie = _csrfCookieMatch ? _csrfCookieMatch[1] : null;
    if (!_csrfHeader || !_csrfCookie || _csrfHeader !== _csrfCookie) {
      return Response.json({ error: "Invalid CSRF token" }, { status: 403 });
    }
"""

csrf_snippet_indent_2 = """
  const _csrfHeader = req.headers.get('x-csrf-token');
  const _cookieHeader = req.headers.get('cookie') || '';
  const _csrfCookieMatch = _cookieHeader.match(/csrf_token=([^;]+)/);
  const _csrfCookie = _csrfCookieMatch ? _csrfCookieMatch[1] : null;
  if (!_csrfHeader || !_csrfCookie || _csrfHeader !== _csrfCookie) {
    return Response.json({ error: "Invalid CSRF token" }, { status: 403 });
  }
"""

for filepath, anchor in files_to_patch:
    if not os.path.exists(filepath):
        print(f"Skipping {filepath} (does not exist)")
        continue
    
    with open(filepath, 'r') as f:
        content = f.read()
    
    if '_csrfHeader' in content:
        print(f"Already patched {filepath}")
        continue
    
    match = re.search(anchor, content)
    if not match:
        print(f"Could not find anchor in {filepath}")
        continue
    
    snippet = csrf_snippet
    if 'auth_register' in filepath or 'auth_reset' in filepath:
        snippet = csrf_snippet_indent_2
        
    if 'autoPayroll' in filepath:
        # inside an if block, needs more indent
        snippet = snippet.replace('\n    ', '\n      ')
        
    new_content = content[:match.end()] + snippet + content[match.end():]
    
    with open(filepath, 'w') as f:
        f.write(new_content)
        
    print(f"Patched {filepath}")

