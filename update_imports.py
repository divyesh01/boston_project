import os
import glob

files = glob.glob('base44/functions/custom_*/entry.js')
for f in files:
    with open(f, 'r') as file:
        content = file.read()
    
    content = content.replace('from "@base44/sdk"', 'from "npm:@base44/sdk@^0.8.41"')
    
    with open(f, 'w') as file:
        file.write(content)
