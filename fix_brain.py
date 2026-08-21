import json

with open('BRAIN.md', 'r', encoding='utf-8') as f:
    text = f.read()

old_arch = '''`
USER'S BROWSER                          BASE44 CLOUD SERVER
+------------------------+             +------------------------+
|                        |             |                        |
|  React Frontend        |  <- HTTP -> |  19 Serverless         |
|  (src/)                |             |  Functions             |
|                        |             |  (base44/functions/)   |
|  +------------------+  |             |                        |
|  | 36 Pages         |  |             |  +------------------+  |
|  | 40+ Components   |  |             |  | 16 Database      |  |
|  | 90+ Libraries    |  |             |  | Tables           |  |
|  +------------------+  |             |  | (base44/         |  |
|                        |             |  |  entities/)      |  |
|  Local IndexedDB       |             |  +------------------+  |
|  (offline dev only)    |             |                        |
+------------------------+             |  Google Drive          |
                                       |  (backup connector)    |
                                       |                        |
                                       |  OpenWeather API       |
                                       |  (weather widget)      |
                                       +------------------------+
`'''

new_arch = '''`mermaid
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

text = text.replace(old_arch, new_arch)

old_rev = '''`
Path 1: CSV Import --> GrossRevenueDay table --> Sum of room_revenue
Path 2: CSV Import --> PaymentDay table --> Sum of all payment methods
Path 3: CSV Import --> OccupancyDay table --> rooms_sold x ADR

All three MUST match (within .01). If they don't --> ALERT!
`'''

new_rev = '''> [!WARNING]
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

text = text.replace(old_rev, new_rev)

old_auth = '''`
User enters email + password
  --> Rate limiter checks (5 attempts / 15 min per IP)
  --> scrypt hash verification (legacy PBKDF2 auto-upgrades to scrypt)
  --> If MFA enabled: TOTP verification (counter replay prevented via mfa_last_counter)
  --> Session created (SHA-256 token hash stored in Session entity)
  --> HTTP-only Secure cookie set (7-day expiry, 30-day absolute max)
  --> Audit log entry written (SHA-256 HMAC chained with AUDIT_CHAIN_SECRET)
`'''

new_auth = '''`mermaid
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

text = text.replace(old_auth, new_auth)

text = text.replace('### RED = Editing These Breaks EVERYTHING', '### 🔴 RED = Editing These Breaks EVERYTHING\\n> [!CAUTION]\\n> Touching these files without a perfect plan will take down the entire production app.')
text = text.replace('These files are **permanently locked**', '> [!IMPORTANT]\\n> These files are **permanently locked**')

workflow_old = '''### The 5-Step Workflow
`
1. SCAN    --> Read this BRAIN.md + relevant source files
2. PROVE   --> Write a test that shows the problem
3. FIX     --> Fix the root cause
4. VERIFY  --> Run the test to prove it is fixed
5. UPDATE  --> Update BRAIN.md to reflect what changed
`'''

workflow_new = '''### The 5-Step Workflow (Interactive Checklist)
- [ ] **1. SCAN:** Read this BRAIN.md + relevant source files
- [ ] **2. PROVE:** Write a test that shows the problem
- [ ] **3. FIX:** Fix the root cause
- [ ] **4. VERIFY:** Run the test to prove it is fixed
- [ ] **5. UPDATE:** Update BRAIN.md to reflect what changed'''

text = text.replace(workflow_old, workflow_new)

text = text.replace('| 18 | [Glossary](#18-glossary) | Every term explained simply |', '| 18 | [Glossary](#18-glossary) | Every term explained simply |\\n| 19 | [Emergency Playbook](#19-emergency-playbook) | What to do when things break |\\n| 20 | [Appendix: All 418 Files](#20-appendix-all-418-files) | Complete codebase index |')

section19 = '''

---

# 🚨 19. EMERGENCY PLAYBOOK

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
5. If they lost their MFA phone, click "Reset MFA".

### Scenario C: "The App is Super Slow or Freezing"
1. You likely have too many raw CSV previews stuck in your local browser cache.
2. Press Ctrl + Shift + R (Hard Refresh) to clear the IndexedDB cache and pull fresh data.

### Scenario D: "I Accidentally Imported the Wrong Date's Data"
1. Go to the Import page.
2. Find the bad import in the "Recent Imports" list.
3. Click the **Undo/Rollback** button. (The system treats imports as atomic ledgers, so clicking undo instantly wipes the data safely without leaving ghost records).
'''
text += section19

# Now build the all_files appendix
with open('all_files.txt', 'r', encoding='utf-8') as f:
    files = [line.strip() for line in f if line.strip()]

appendix = '''

---

# 🗃️ 20. APPENDIX: ALL 418 FILES

> [!NOTE]
> For complete reference, here is the exhaustive list of every single file in the project. Use this to verify existence before creating new files.

<details>
<summary><strong>Click to expand the full file catalog</strong></summary>

`	ext
'''
for file in sorted(files):
    appendix += file + '\\n'
appendix += '''`
</details>
'''

text += appendix

with open('BRAIN.md', 'w', encoding='utf-8') as f:
    f.write(text)

print("SUCCESS")
