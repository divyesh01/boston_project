import re

with open('BRAIN.md', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Upgrade Architecture Diagram
arch_replacement = '''`mermaid
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
`'''
content = re.sub(r'`.*?USER\'S BROWSER.*?OpenWeather API.*?`', arch_replacement, content, flags=re.DOTALL)

# 2. Upgrade Revenue Paths Diagram
rev_replacement = '''> [!WARNING]
> **The Golden Rule of this App:** These three paths must always match within .01.

`mermaid
flowchart LR
    CSV[📄 Hotel CSV Import] --> Path1 & Path2 & Path3
    Path1[Path 1: GrossRevenueDay] -->|Sum of Room Rev| Match{Do they match?}
    Path2[Path 2: PaymentDay] -->|Sum of Payments| Match
    Path3[Path 3: OccupancyDay] -->|Sold x ADR| Match
    Match -->|Yes| OK[✅ Financials Verified]
    Match -->|No| Alert[🚨 Drift Alert!]
`'''
content = re.sub(r'`.*?Path 1: CSV Import.*?ALERT!.*?`', rev_replacement, content, flags=re.DOTALL)

# 3. Upgrade Auth Flow Diagram
auth_replacement = '''`mermaid
sequenceDiagram
    actor User
    participant UI as Frontend
    participant API as Base44 Login Auth
    participant DB as Entity / Audit
    
    User->>UI: Enter Email & Password
    UI->>API: POST /login
    API->>API: Rate Limiter (Max 5/15m)
    API->>DB: Verify scrypt hash
    API->>User: Request TOTP Code
    User->>API: Submit 6-digit code
    API->>API: Check Replay (mfa_last_counter)
    API->>DB: Save Session (SHA-256 Token)
    API->>DB: Write Audit Log (HMAC Chain)
    API->>UI: Set HTTP-Only Secure Cookie
`'''
content = re.sub(r'`.*?User enters email \+ password.*?AUDIT_CHAIN_SECRET\).*?`', auth_replacement, content, flags=re.DOTALL)

# 4. Enhance Dependency Warnings
content = content.replace('### RED = Editing These Breaks EVERYTHING', '### 🔴 RED = Editing These Breaks EVERYTHING\\n> [!CAUTION]\\n> Touching these files without a perfect plan will take down the entire production app.')

# 5. Enhance Protected Files Warnings
content = content.replace('These files are **permanently locked**', '> [!IMPORTANT]\\n> These files are **permanently locked**')

# 6. Convert Workflow to Checklist
workflow_replacement = '''### The 5-Step Workflow (Interactive Checklist)
- [ ] **1. SCAN:** Read this BRAIN.md + relevant source files
- [ ] **2. PROVE:** Write a test that shows the problem
- [ ] **3. FIX:** Fix the root cause
- [ ] **4. VERIFY:** Run the test to prove it is fixed
- [ ] **5. UPDATE:** Update BRAIN.md to reflect what changed'''
content = re.sub(r'### The 5-Step Workflow.*?`.*?5\. UPDATE.*?`', workflow_replacement, content, flags=re.DOTALL)

# 7. Update Table of Contents
content = content.replace('| 18 | [Glossary](#18-glossary) | Every term explained simply |', '| 18 | [Glossary](#18-glossary) | Every term explained simply |\\n| 19 | [Emergency Playbook](#19-emergency-playbook-for-humans) | What to do when things break |')

# 8. Append Emergency Playbook
section19 = '''

---

# 🚨 19. EMERGENCY PLAYBOOK (For Humans)

> [!TIP]
> **Hotel Owners & Managers:** If something goes wrong in real life, follow this guide before calling a developer.

### Scenario A: "The Dashboard Revenue Doesn't Match My Bank Account"
1. **Check the CSVs:** Did the front desk upload yesterday's HotelKey report? Go to Import and check the history.
2. **Check the "Drift":** Look at the **Money Kept** widget. If Path 1, 2, and 3 don't match, an employee might have manually altered a folio after the night audit.
3. **Look for Cash Variances:** Go to Employees -> Clerk Audit Matrix. Did a clerk have a large cash drop variance? 

### Scenario B: "An Employee is Locked Out"
1. **DO NOT delete their account.**
2. Go to Users (you must be an Owner/Admin).
3. Find their name and check if the **Lockout Flag** is triggered (happens automatically after 5 bad passwords).
4. Click "Unlock" or "Send Password Reset".
5. If they lost their MFA phone, click "Reset MFA" (this requires your step-up password).

### Scenario C: "The App is Super Slow or Freezing"
1. You likely have too many raw CSV previews stuck in your local browser cache.
2. The uploadRetention.js script usually clears this, but you can force it.
3. Press Ctrl + Shift + R (Hard Refresh) to clear the IndexedDB cache and pull fresh data from the Base44 Cloud.

### Scenario D: "I Accidentally Imported the Wrong Date's Data"
1. Go to the Import page.
2. Find the bad import in the "Recent Imports" list.
3. Click the **Undo/Rollback** button. (The system treats imports as atomic ledgers, so clicking undo instantly wipes the data safely across all 5 tables without leaving ghost records).
'''
content += section19

with open('BRAIN.md', 'w', encoding='utf-8') as f:
    f.write(content)

print("SUCCESS")
