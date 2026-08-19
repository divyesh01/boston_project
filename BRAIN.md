# 🧠 RED ROOF INTELLIGENCE - MASTER BRAIN (HUB)

> [!IMPORTANT]
> **AI AGENTS:** You are currently in the HUB. To save tokens and maximize context window efficiency, this file only contains routing.
> Read the specific Spoke files below based on your exact task. NEVER scan the entire project.

## 🔀 THE SPOKES (Context Segmentation)
| Domain | File | Use When... |
|--------|------|-------------|
| 💰 **Finance** | `docs/brain/BRAIN_FINANCE.md` | Math, formulas, CSV parsers, or reconciliation. |
| 🔒 **Security** | `docs/brain/BRAIN_SECURITY.md` | Auth, MFA, sessions, or audit logs. |
| 💻 **Frontend** | `docs/brain/BRAIN_FRONTEND.md` | React UI, pages, components, or hooks. |
| ☁️ **Backend** | `docs/brain/BRAIN_BACKEND.md` | Base44 entities, serverless functions, configs. |
| 🚨 **Fixes** | `docs/brain/BRAIN_TROUBLESHOOTING.md` | Diagnosing known problems or emergency playbook. |
| 💥 **Danger Map**| `docs/brain/BRAIN_DEPENDENCIES.md`| See what breaks if you edit a file (Auto-Generated). |

## 🏗️ SYSTEM ARCHITECTURE
```mermaid
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
```

## 🤖 AI RULES (The 5-Step Workflow)
- [ ] 1. SCAN: Read this Hub, then read the relevant Spoke.
- [ ] 2. PROVE: Write a test.
- [ ] 3. FIX: Fix the core.
- [ ] 4. VERIFY: Run the test.
- [ ] 5. UPDATE: Update the relevant BRAIN_*.md file! (Enforced by Git Hook)
