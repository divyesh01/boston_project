// One-shot generator that rewrote BRAIN.md when it was a single monolithic file.
//
// HAZARD — do NOT run this against the current BRAIN.md. BRAIN.md is now a
// 45-line hub that routes to docs/brain/BRAIN_*.md; none of the regexes below
// match it any more, so every replace() is a no-op and the script would simply
// append a second "19. EMERGENCY PLAYBOOK" to the hub. It is kept only as the
// record of how the old sections were generated.
//
// Repaired 2026-08-19: every backtick in this file had been eaten by the
// PowerShell heredoc that produced it (backtick is PowerShell's own escape
// character), so `\`\`\`mermaid` fences arrived as `\\\mermaid` and the opening
// delimiter of each template literal vanished entirely — the file could not be
// parsed at all. The strings are restored; no logic was changed. `require` also
// became an ESM import, because package.json declares "type": "module".
import fs from 'node:fs';
let content = fs.readFileSync('BRAIN.md', 'utf8');

// 1. Upgrade Section 2: Architecture Diagram
content = content.replace(
/`[\s\S]*?USER'S BROWSER[\s\S]*?OpenWeather API[\s\S]*?`/,
`\`\`\`mermaid
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
\`\`\``
);

// 2. Upgrade Section 2: Revenue Paths Diagram
content = content.replace(
/`[\s\S]*?Path 1: CSV Import[\s\S]*?ALERT![\s\S]*?`/,
`> [!WARNING]
> **The Golden Rule of this App:** These three paths must always match within .01.

\`\`\`mermaid
flowchart LR
    CSV[📄 Hotel CSV Import] --> Path1 & Path2 & Path3
    Path1[Path 1: GrossRevenueDay] -->|Sum of Room Rev| Match{Do they match?}
    Path2[Path 2: PaymentDay] -->|Sum of Payments| Match
    Path3[Path 3: OccupancyDay] -->|Sold x ADR| Match
    Match -->|Yes| OK[✅ Financials Verified]
    Match -->|No| Alert[🚨 Drift Alert!]
\`\`\``
);

// 3. Upgrade Section 13: Auth Flow Diagram
content = content.replace(
/`[\s\S]*?User enters email \+ password[\s\S]*?AUDIT_CHAIN_SECRET\)[\s\S]*?`/,
`\`\`\`mermaid
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
\`\`\``
);

// 4. Enhance Dependency Warnings (GitHub Alerts)
content = content.replace(
/### RED = Editing These Breaks EVERYTHING/g,
`### 🔴 RED = Editing These Breaks EVERYTHING\n> [!CAUTION]\n> Touching these files without a perfect plan will take down the entire production app.`
);

// 5. Enhance Protected Files Warnings
content = content.replace(
/These files are \*\*permanently locked\*\*/g,
`> [!IMPORTANT]\n> These files are **permanently locked**`
);

// 6. Convert Workflow to Interactive Checklist
content = content.replace(
/### The 5-Step Workflow\r?\n`[\s\S]*?5\. UPDATE[\s\S]*?`/,
`### The 5-Step Workflow (Interactive Checklist)
- [ ] **1. SCAN:** Read this BRAIN.md + relevant source files
- [ ] **2. PROVE:** Write a test that shows the problem
- [ ] **3. FIX:** Fix the root cause
- [ ] **4. VERIFY:** Run the test to prove it is fixed
- [ ] **5. UPDATE:** Update BRAIN.md to reflect what changed`
);

// 7. Update Table of Contents
content = content.replace(
/\| 18 \| \[Glossary\]\(#18-glossary\) \| Every term explained simply \|/,
`| 18 | [Glossary](#18-glossary) | Every term explained simply |\n| 19 | [Emergency Playbook](#19-emergency-playbook-for-humans) | What to do when things break |`
);

// 8. Append the brand new Emergency Playbook
const section19 = `

---

# 🚨 19. EMERGENCY PLAYBOOK (For Humans)

> [!TIP]
> **Hotel Owners & Managers:** If something goes wrong in real life, follow this guide before calling a developer.

### Scenario A: "The Dashboard Revenue Doesn't Match My Bank Account"
1. **Check the CSVs:** Did the front desk upload yesterday's HotelKey report? Go to \`Import\` and check the history.
2. **Check the "Drift":** Look at the **Money Kept** widget. If Path 1, 2, and 3 don't match, an employee might have manually altered a folio after the night audit.
3. **Look for Cash Variances:** Go to \`Employees\` -> \`Clerk Audit Matrix\`. Did a clerk have a large cash drop variance?

### Scenario B: "An Employee is Locked Out"
1. **DO NOT delete their account.**
2. Go to \`Users\` (you must be an Owner/Admin).
3. Find their name and check if the **Lockout Flag** is triggered (happens automatically after 5 bad passwords).
4. Click "Unlock" or "Send Password Reset".
5. If they lost their MFA phone, click "Reset MFA" (this requires your step-up password).

### Scenario C: "The App is Super Slow or Freezing"
1. You likely have too many raw CSV previews stuck in your local browser cache.
2. The \`uploadRetention.js\` script usually clears this, but you can force it.
3. Press \`Ctrl + Shift + R\` (Hard Refresh) to clear the IndexedDB cache and pull fresh data from the Base44 Cloud.

### Scenario D: "I Accidentally Imported the Wrong Date's Data"
1. Go to the \`Import\` page.
2. Find the bad import in the "Recent Imports" list.
3. Click the **Undo/Rollback** button. (The system treats imports as atomic ledgers, so clicking undo instantly wipes the data safely across all 5 tables without leaving ghost records).
`;

content += section19;

fs.writeFileSync('BRAIN.md', content, 'utf8');
console.log('Successfully upgraded BRAIN.md with Visuals, Alerts, and Playbooks!');
