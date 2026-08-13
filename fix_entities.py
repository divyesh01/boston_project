import json
import glob

files = glob.glob('base44/entities/*.jsonc')

for f in files:
    with open(f, 'r') as file:
        content = file.read()
    
    content = content.replace('"": [', '\"$and\": [', 2) # first two are $and
    content = content.replace('"": [', '\"$or\": [') # subsequent ones are $or
    content = content.replace('"": "{{user.property_access}}"', '\"$in\": \"{{user.property_access}}\"')
    
    with open(f, 'w') as file:
        file.write(content)
