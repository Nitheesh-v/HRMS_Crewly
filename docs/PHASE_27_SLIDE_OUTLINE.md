# Phase 27 — One-Page Slide Outline  
## Crewly HRMS · Enterprise RMS + ATS

---

### Slide 1 — Title
**Phase 27 Complete: Enterprise Recruitment (RMS + ATS)**  
Crewly multi-tenant HRMS · Branch `arena/01a0398f-hrms-crewly`  
Through secure hire handoff into existing Employee Onboarding

---

### Slide 2 — Problem → Outcome
| Before | After Phase 27 |
|---|---|
| Fragmented / incomplete hiring flow | Full lifecycle in one product |
| Risk of temp passwords / weak portals | Hashed tokens, private docs, secure setup |
| No unified HR view | Command Center: funnel, KPIs, work queues |
| Hard to trace hire origin | JR → JOB → CAN → OFF → EMP fully linked |

---

### Slide 3 — End-to-End Lifecycle (demo story)
```text
Requisition → HR Approval → Job → Career Apply
→ Parse → ATS (assistive) → Pipeline
→ Interviews → Human Select → Offer (PDF + portal)
→ Pre-Onboarding docs → BGV (optional, human)
→ READY_TO_JOIN → Convert → Account setup
→ EmployeeLifecycle onboarding
```

---

### Slide 4 — What shipped by sub-phase
| Phase | Capability |
|---|---|
| **27.1–27.3** | Requisition → approval → job opening |
| **27.4–27.5** | Public career portal + apply + resume |
| **27.6–27.7** | Resume parse + explainable ATS |
| **27.8–27.10** | Pipeline, interviews, human final decision |
| **27.11** | Enterprise offers + secure candidate portal |
| **27.12** | Pre-onboarding documents + HR verify → Ready to Join |
| **27.13** | Secure Candidate → Employee (no temp password) |
| **27.14** | Recruitment Command Center + analytics |
| **27.15** | Background verification (internal, human-controlled) |
| **27.16** | Security hardening, tests, documentation |

---

### Slide 5 — Security & compliance talking points
- **Tenant isolation** on every recruitment query  
- **Backend is authority** (no trust of frontend company/stage flags)  
- **Tokens:** random, hashed, scoped, expiring (offer / pre-onboarding / setup)  
- **GET portals never finalize** accept/reject  
- **Private files** (resumes, offer PDFs, joining docs)  
- **Human gates:** ATS / BGV never auto-reject or auto-select  
- **One employee per candidate** (idempotent conversion)  
- Legacy temp-password convert **retired**

---

### Slide 6 — Branch delivery metrics (27.12–27.16)
| | |
|---|---|
| Files changed | **91** |
| New files | **65** |
| Updated files | **26** |
| Lines added | **~15k** |
| Backend tests | **127 passed** |
| Frontend build | **Passed** |
| Permission version | **9 → 13** |

---

### Slide 7 — Who uses what
| Role | Access (default) |
|---|---|
| Company Admin / HR Manager | Full operational recruitment + BGV + convert + analytics |
| Manager / Team Lead | Requisitions / assigned interviews as permitted — not private BGV/offers by default |
| Employee | No recruitment management |
| Public candidate | Career apply + token portals only |

---

### Slide 8 — What’s next (explicitly not in 27)
| Phase 28+ | |
|---|---|
| Redis + BullMQ | Async parse, email, BGV vendor poll, reminders |
| Third-party BGV plugins | SpringVerify / OnGrid-style adapters on existing registry |
| HR_HEAD / role redesign | Separate initiative — not mixed into Phase 27 |

---

### Slide 9 — Demo path (5 minutes)
1. **Command Center** — KPIs + funnel  
2. Candidate: Offer accepted → Pre-onboarding ready  
3. Optional **BGV** start → discrepancy does not reject  
4. **Convert to employee** → setup link → password → login  
5. Show **Employees / Lifecycle** + candidate history still intact  

---

### Slide 10 — Close
**Phase 27 = production-oriented hiring system inside Crewly**  
Traceable · multi-tenant · permissioned · secure handoff to HRMS core  

**Branch:** `arena/01a0398f-hrms-crewly` @ `8ce1cbe`  
**Doc:** `docs/PHASE_27_RMS_ATS.md`
