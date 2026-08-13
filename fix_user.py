import json

with open('base44/entities/User.jsonc', 'r') as file:
    content = json.load(file)

builtins = ['email', 'username', 'display_name', 'created_date', 'updated_date', 'id', 'full_name']
for f in builtins:
    content['properties'].pop(f, None)
    if f in content.get('required', []):
        content['required'].remove(f)

with open('base44/entities/User.jsonc', 'w') as file:
    json.dump(content, file, indent=2)
