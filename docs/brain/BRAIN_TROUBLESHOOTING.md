# 14. THE 9 KNOWN PROBLEMS (Status Tracker)

| # | Problem | Severity | Status | Fix Location | Commit |
|---|---------|----------|--------|-------------|--------|
| 1 | Duplicate CSV column names cause data loss | HIGH | FIXED | `src/lib/csvParser.js` line 183 | c50435c |
| 2 | Password sent in plaintext in welcome email | CRITICAL | FIXED | `base44/functions/custom_auth_register/entry.js` lines 209-217 | f07245e |
| 3 | Money Kept shows $0 (typo: total_revenue should be room_revenue) | HIGH | FIXED | `src/lib/dailyAggregates.js` line 183 | See docs |
| 4 | CSRF cookie not secure (missing __Host- prefix + Secure flag) | CRITICAL | FIXED | `src/lib/securityUtils.js` line 267-268 | efc79d9 |
| 5 | Revenue paths don't match (no reconciliation system) | HIGH | FIXED | `src/lib/RevenueReconciliation.js` (NEW file) | See docs |
| 6 | Float math precision errors ($0.1+$0.2 != $0.3) | HIGH | PENDING | `src/lib/decimal.js` exists but not fully integrated everywhere | - |
| 7 | Wrong error message for disabled accounts ("revoked" vs "disabled") | MEDIUM | PENDING | `src/lib/AuthContext.jsx` + `custom_auth_me` | - |
| 8 | Session never times out (infinite session = security risk) | CRITICAL | PENDING | `src/api/base44Client.js` + `AuthContext.jsx` | - |
| 9 | Server-only code sits in frontend folder (config leak) | MEDIUM | PENDING | `base44/lib/corsConfig.js` + `securityHeaders.js` (already in backend) | - |

---


# 🚨 19. EMERGENCY PLAYBOOK (For Humans)
> [!TIP]
> **Hotel Owners & Managers:** If something goes wrong in real life, follow this guide before calling a developer.

### Scenario A: "The Dashboard Revenue Doesn't Match My Bank Account"
1. **Check the CSVs:** Did the front desk upload yesterday's HotelKey report? Go to `Import` and check the history.
2. **Check the "Drift":** Look at the **Money Kept** widget. If Path 1, 2, and 3 don't match, an employee might have manually altered a folio after the night audit.
3. **Look for Cash Variances:** Go to `Employees` -> `Clerk Audit Matrix`. Did a clerk have a large cash drop variance? 

### Scenario B: "An Employee is Locked Out"
1. **DO NOT delete their account.**
2. Go to `Users` (you must be an Owner/Admin).
3. Find their name and check if the **Lockout Flag** is triggered (happens automatically after 5 bad passwords).
4. Click "Unlock" or "Send Password Reset".
5. If they lost their MFA phone, click "Reset MFA".

### Scenario C: "The App is Super Slow or Freezing"
1. You likely have too many raw CSV previews stuck in your local browser cache.
2. Press `Ctrl + Shift + R` (Hard Refresh) to clear the IndexedDB cache and pull fresh data.

### Scenario D: "I Accidentally Imported the Wrong Date's Data"
1. Go to the `Import` page.
2. Find the bad import in the "Recent Imports" list.
3. Click the **Undo/Rollback** button. (The system treats imports as atomic ledgers, so clicking undo instantly wipes the data safely without leaving ghost records).
