import os
import shutil

functions_to_rename = [
    'auth_login',
    'auth_logout',
    'auth_me',
    'auth_register',
    'auth_reset_password',
    'auth_reset_request',
    'user_admin'
]

base_dir = 'base44/functions'

for func in functions_to_rename:
    old_path = os.path.join(base_dir, func)
    new_path = os.path.join(base_dir, f'custom_{func}')
    if os.path.exists(old_path):
        os.rename(old_path, new_path)

# Now update base44Client.js
client_file = 'src/api/base44Client.js'
with open(client_file, 'r') as f:
    content = f.read()

for func in functions_to_rename:
    content = content.replace(f"'{func}'", f"'custom_{func}'")
    # Also replace in the hardcoded startswith check
content = content.replace("functionName.startsWith('auth_')", "functionName.startsWith('custom_auth_')")
content = content.replace("functionName === 'user_admin'", "functionName === 'custom_user_admin'")

with open(client_file, 'w') as f:
    f.write(content)
