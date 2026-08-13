# 🔒 PROTECTED FILES — DO NOT MODIFY

> **This file is a MANDATORY directive for ALL AI coding agents** (Gemini, Antigravity, Claude, OpenCode, Cursor, Copilot, or any other AI-powered tool).
> 
> **NO AI AGENT may create, modify, delete, rename, move, or overwrite any file listed below** without **explicit written authorization from the repository owner (Divyesh)**.

---

## Protected File List

The following files are **permanently locked from AI modification**:

### Core Authentication & Security
| # | File | Reason |
|---|------|--------|
| 1 | `src/api/base44Client.js` | Core SDK client — auth, entities, data access, rate limiting |
| 2 | `src/lib/AuthContext.jsx` | Authentication provider, session management, cross-tab revocation |
| 3 | `src/lib/security.js` | Password hashing (PBKDF2), TOTP/MFA, crypto primitives |
| 4 | `src/lib/securityUtils.js` | CSRF tokens, rate limiting, audit entries, input sanitization |
| 5 | `src/lib/permissions.js` | Role-based access control, route permission mappings |
| 6 | `src/lib/validator.js` | Email/input validation rules |

### Auth Pages
| # | File | Reason |
|---|------|--------|
| 7 | `src/pages/Login.jsx` | Login page with MFA flow |
| 8 | `src/pages/Setup.jsx` | Owner account creation (first-run) |
| 9 | `src/pages/ForgotPassword.jsx` | Password reset request flow |
| 10 | `src/pages/ResetPassword.jsx` | Password reset execution |

### AI Agent Rules (Self-Protection)
| # | File | Reason |
|---|------|--------|
| 11 | `AGENTS.md` | AI agent operating rules (Gemini/Antigravity) |
| 12 | `CLAUDE.md` | AI agent operating rules (Claude/OpenCode) |
| 13 | `PROTECTED_FILES.md` | This protection list itself |
| 14 | `.agents/rules/no-modify-protected.md` | Gemini protection rule |

---

## Rules

1. **Read-only access**: AI agents MAY read these files for context. They MUST NOT write to them.
2. **No workarounds**: Copying a protected file to a new name, creating a "v2" replacement, or inserting code that overrides protected logic is also prohibited.
3. **No indirect modification**: Creating wrapper files, monkey-patches, or runtime overrides that change the behavior of protected files is prohibited.
4. **Owner authorization required**: Only the repository owner (Divyesh) can grant a one-time exception. The AI must ask and receive explicit confirmation before touching any protected file.
5. **Violation reporting**: If an AI agent is instructed to modify a protected file, it MUST refuse and explain why, citing this document.

---

## Why These Files Are Protected

These files form the **security core** of the application:
- **Authentication**: Login, session management, password hashing, MFA
- **Authorization**: Role-based permissions, property isolation, route access
- **Data integrity**: CSRF protection, rate limiting, audit trail, input sanitization
- **AI governance**: Agent rules that prevent destructive changes

Uncontrolled AI modifications to these files could:
- Break login entirely (as happened with the merge conflicts)
- Create security vulnerabilities (weak hashing, bypassed auth)
- Expose user data across property boundaries
- Corrupt the audit trail
- Remove the AI protection rules themselves

---

**Last updated**: 2026-08-13  
**Authorized by**: Repository Owner (Divyesh)
