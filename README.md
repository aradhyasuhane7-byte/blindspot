# Blindspot

**Logistics & Supply Chain Management SaaS** — *See every delay. Control every stage.*

Blindspot tracks packages through four operational stages — **Confirmation → Packaging → Documentation/Dispatch → Delivery → Delivered** — shows bottlenecks, manages employee responsibilities, records delays, and analyzes supply-chain performance on a public operations dashboard.

A **Node.js** web application (no Java):

| Area | Technology |
|---|---|
| Backend | Node.js (18+) + Express 4 |
| Rendering | Server-side EJS templates + vanilla JS |
| Authentication | Firebase Authentication (email + password) |
| Database | Cloud Firestore via Firebase Admin SDK |
| Security | helmet, express-session (server sessions), CSRF double-submit, role-based middleware |
| Charts | Chart.js |
| Exports | CSV (weekly / monthly / custom range) |
| Tests | `node test/workflow-rules.test.js` (pure rule engine) |

---

## 1. Current status of YOUR setup (important)

Your Firebase web configuration (`blindspot-1bcc5`) is already wired into `.env`):

- ✅ `FB_WEB_API_KEY`, `FB_WEB_AUTH_DOMAIN`, `FB_WEB_PROJECT_ID`, `FB_WEB_APP_ID` — the login page now speaks to your Firebase project and **email/password sign-in works**.
- ⚠️ The **backend** still needs one more file: the **service-account JSON** (Firebase Admin SDK). Without it, pages load but data endpoints answer *"Firebase is not configured"*.

**To finish the setup (5 minutes):**

1. Firebase console → your project **blindspot-1bcc5** → ⚙️ *Project settings*.
2. Open the **Service accounts** tab.
3. Click **Generate new private key** → confirm → a JSON file downloads.
4. Save it as: `D:\BlindSpot\secrets\blindspot-service-account.json` (the `secrets/` folder is gitignored).
5. Restart the server (`npm start`). You should see:

```
[blindspot] Firestore connection verified. Data endpoints are live.
```

6. In the Firebase console also make sure **Firestore Database** exists
   (*Firestore Database → Create database* — production or pinned location of your choice)
   and **Email/Password** sign-in provider is enabled
   (*Authentication → Sign-in method → Email/Password → Enable*).
7. Publish `firestore.rules` (Firebase console → Firestore → Rules → paste file contents).
   They deny ALL direct client access — everything flows through this backend,
   which enforces its own authorization because **the Admin SDK bypasses Firestore rules**.
8. **Demo mode is ON** in this project (`BLINDSPOT_AUTO_SEED_DEMO=true` in `.env`):
   the moment the server makes its first successful Firestore connection it seeds
   **5 demo employees + 16 demo packages** (skipping what already exists), so every
   page and report has data instantly. See section 3.

---

## 2. Quick start

```powershell
cd D:\BlindSpot
Copy-Item .env.example .env    # then edit values (already done for this machine)
npm install
npm start
# open http://localhost:8080
```

`npm run dev` — same, with auto-restart on change (`node --watch`).

Run the rule-engine tests any time (no Firebase needed):

```powershell
npm test
```

---

## 3. Demo everything — log in instantly with demo accounts

Demo mode seeds everything automatically on first successful start
(`BLINDSPOT_AUTO_SEED_DEMO=true`). You can also run it manually:

```powershell
npm run seed:demo          # create what's missing, keep existing
npm run seed:demo -- --force   # also overwrite the 16 demo packages, fresh dates
```

**Five demo employees — password for all: `demo1234`**
(the login page has click-to-fill buttons for these exact accounts):

| Role | Email | Lands on | Can do |
|---|---|---|---|
| ADMIN | `admin@blindspot.demo` | `/admin` | Everything: employees, all stages, reports |
| CONFIRM | `confirm@blindspot.demo` | `/confirm` | Register packages, start/complete confirmation |
| PACK | `pack@blindspot.demo` | `/pack` | Start/complete packaging, record delays/issues |
| DOC | `doc@blindspot.demo` | `/doc` | Invoices, verify docs, transporter + dispatch |
| DEL | `del@blindspot.demo` | `/del` | Transit, delivery attempts, mark delivered |

**16 demo packages `PKG-1001` … `PKG-1016` cover every scenario:**

- every stage Pending / In-Progress (fresh orders and mid-flow ones),
- delayed variants (manually recorded reasons on confirmation/packaging/delivery),
- a dispatch-ready package awaiting handover, a delivery attempt returned to sender,
- overdue items (expected-delivery in the past) and two fully **delivered** ones,
- coherent timestamps across all stages + full audit history per package,
- some with public customer approved, some hidden — see the privacy toggle on `/`.

Then create your REAL staff accounts in `/admin → Create Employee`
(each one gets a real Firebase Auth account + Firestore profile).

## 4. First administrator + employees (real accounts)

1. In the Firebase console create your account:
   *Authentication → Users → Add user* → e.g. `admin@yourcompany.com` + a password (≥6 chars).
2. Copy the generated **UID**.
3. In `.env` set:
   ```
   BLINDSPOT_SETUP_ADMIN_UID=<the-uid>
   ```
4. `npm start` → the app creates `employees/{uid}` with **role ADMIN, enabled** and logs a confirmation.
5. **Remove** `BLINDSPOT_SETUP_ADMIN_UID` from `.env` (it is a one-time bootstrap).
6. Log in at `/login` → you land on `/admin`.
7. Use **Admin Panel → Create Employee** to add staff
   (name, email, temporary password ≥6 chars, role). Each employee gets a real
   Firebase Auth account + Firestore profile. Share the temporary password privately.
   (Employees can change their own password in Firebase console or via your support process.)

Alternative bootstrap: set `BLINDSPOT_SETUP_ADMIN_EMAIL` instead and the app looks the user up by email.

> Roles: `ADMIN` (everything) · `CONFIRM` · `PACK` · `DOC` · `DEL` (one workflow each).
> The last active administrator can never be demoted or disabled; disabling asks for confirmation.

## 5. Routes

| Route | Access | Purpose |
|---|---|---|
| `/` | **public** | Main dashboard: live summary, package table, search/filters/sort |
| `/login` | public | Employee login (Firebase email/password) |
| `/admin` | ADMIN | Overview, workflow shortcuts, employee management |
| `/confirm` | ADMIN, CONFIRM | Register & confirm packages |
| `/pack` | ADMIN, PACK | Packaging preparation & completion |
| `/doc` | ADMIN, DOC | Documentation, verification & dispatch/handover |
| `/del` | ADMIN, DEL | Final delivery, attempts, completion |
| `/reports` | ADMIN | Weekly/monthly analytics, bottleneck analysis, CSV export |

API endpoints (role-checked twice — middleware **and** service logic):

```
GET  /api/public/summary                     public summary cards
GET  /api/public/packages?q&stage&status&from&to&sort&dir   public-safe rows
POST /auth/session-login {idToken}           exchange Firebase ID token -> session
POST /auth/logout                            destroy session

GET  /api/confirm/packages?view&q            stage views (pending/active/completed/delayed)
GET  /api/confirm/packages/:code             detail + history
POST /api/confirm/packages                   create package
POST /api/confirm/packages/:code/actions     start | complete | missing-info | delay | record-issue | remarks
     (+ /api/pack /api/doc /api/del equivalents)

GET   /admin/api/summary                     admin dashboard numbers
GET   /admin/api/employees?q&role&status     employee list
POST  /admin/api/employees                   create employee (Auth + Firestore)
POST  /admin/api/employees/:uid              change role / enable-disable

GET  /api/reports/data?range=...             analytics JSON (this-week | last-week | this-month | last-month | custom)
GET  /api/reports/export?range=...&from&to   CSV download
```

## 6. Workflow rules (enforced server-side in transactions)

1. New packages start in **Confirmation** with status **Pending**.
2. Packaging cannot start before Confirmation is **completed**.
3. Documentation/Dispatch cannot start before Packaging is **completed**.
4. Delivery cannot start before **dispatch/handover is completed** — and no package
   can be marked *Delivered* without transporter + tracking + dispatch date recorded.
5. Stages cannot be skipped; a `CONFIRM` employee gets HTTP 403 when calling `/api/pack/...` directly.
6. Completing a stage auto-advances the package to the next stage as **Pending**
   (progress bar: 25 / 50 / 75 / 90 / 100 %), and every change appends an audit
   event in `packages/{packageId}/history/{eventId}` (stage, previous → new status,
   acting employee, **server timestamp**, remarks, delay reason).
7. *Delayed* = explicitly recorded reason **or** the overall expected-delivery date
   passing — never merely "stage in progress".

## 7. Data model (Cloud Firestore)

```
employees/{uid}                     name, email, role, enabled, createdAt
packages/{packageId}                packageCode, projectName, customerName, publicCustomer,
   (doc id = packageCode)           orderReference, orderDetails, currentStage, status,
                                    confirmationDetails{status,confirmDate,startedAt,completedAt,
                                     remarks,missingInfo,issues[]},
                                    packagingDetails{status,startedAt,completedAt,remarks,delayReason,issues[]},
                                    documentationDetails{status,invoiceNumber,shippingDocRef,
                                     verificationStatus,verifiedAt,remarks,issues[]},
                                    dispatchDetails{status,transporter,trackingNumber,dispatchDate,
                                     completedAt,delayReason,remarks},
                                    deliveryDetails{status,startedAt,expectedDelivery,actualDelivery,
                                     attempts,delayReason,remarks,issues[]},
                                    expectedDelivery, actualDelivery, delayReason, createdAt, updatedAt
packages/{packageId}/history/{id}   stage, previousStatus, newStatus, updatedBy, updatedById,
                                    timestamp, remarks, action, reason
```

Uniqueness of package IDs comes from the document ID (create fails on duplicates).
Concurrency safety comes from Firestore **transactions** on every transition.

## 8. Public dashboard privacy

`/api/public/*` whitelists **only**: package code, project name, stage, progress %,
status label, expected delivery, delay indicator, and the customer name **only when
`publicCustomer` was approved** during package creation. Internal remarks, issues,
order details, employee emails and auth data are never sent. Firestore rules deny
all direct client access; strangers also cannot create/edit/delete anything — those
endpoints require a server session with the right role.

## 9. Security notes

- Firebase ID tokens are verified with `verifyIdToken(token, true)` (revocation-checked).
- `employees.enabled` and `role` are **re-read from Firestore on every protected request**,
  so disabling an account takes effect immediately on its next API call.
- Sessions: httpOnly cookie, SameSite=Lax, fixation-safe regeneration at login;
  CSRF via double-submit cookie (browser JS sends `X-XSRF-TOKEN` automatically).
- Set `SESSION_SECURE=true` behind HTTPS and keep `SESSION_SECRET` long + unique in production.
- Never commit `.env`, `secrets/*.json`, or any downloaded service-account key.
- The **Admin SDK bypasses Firestore Security Rules** — authorization is enforced in
  this app's code (`middleware/auth.js` + service checks), and `firestore.rules` keeps
  browsers away from Firebase directly.

## 10. Testing checklist (section-by-section)

Run the automated rule tests:

```powershell
npm test        # 15 tests: transitions, cross-stage rules, delay logic, CSV escaping
```

Manual procedure (with the server running and an admin + one employee per role):

1. **Public dashboard without login** — open `/` in a private window: summary + table render, no redirect.
2. **Invalid login** — wrong password on `/login` → "Invalid email or password."
3. **Valid login** — correct credentials → redirected to the role's home page, sidebar chip shows name/role.
4. **Disabled employee** — deactivate someone in `/admin` (feels fast: confirmation dialog) →
   their next action returns 403 / login page says *disabled*.
5. **Cross-workflow attempt** — log in as `DEL` employee, open `/admin` or `/pack` →
   redirected to own workflow with "permission" banner.
6. **Create package** (`/confirm`) → appears in *Pending Confirmation*, on the public dashboard with 25% progress.
7. **Invalid transitions** — try *Mark packaging completed* before confirming → 409 message.
8. **Full happy path** — confirm → pack → doc (save + verify docs, save transporter/tracking/date, complete) →
   del (start transit, attempt, mark delivered) → package turns *Delivered*.
9. **History** — open any package: *Recent history* shows stage changes with employee + timestamps.
10. **Delay flow** — record a delay on packaging → badge turns red with reason; resume clears it.
11. **Overdue** — create a package with `expectedDelivery` in the past → public table shows "N days past expected delivery" without manual action.
12. **Reports** — `/reports`: switch This Week / This Month / Custom; verify metrics are numbers from real data (insufficient-data messages appear for empty periods).
13. **CSV exports** — Weekly/Monthly/Custom buttons download files with stage timestamps and delay reasons.
14. **Employee management** — create (with temp password), change role, disable/enable; try demoting the last admin → blocked.
15. **Direct API bypass** — as a CONFIRM employee call `POST /api/pack/packages/{code}/actions` with curl/Postman → 403; without any session → 401.

## 11. Production deployment

1. Provision a Linux VM / Cloud Run / Railway with Node ≥ 18. `npm ci && npm start`.
2. Put the app behind **HTTPS** (Caddy/nginx + Let's Encrypt or the platform's TLS).
3. Environment: `SESSION_SECURE=true`, `TRUST_PROXY=true`, strong `SESSION_SECRET`,
   `BLINDSPOT_FIREBASE_CREDENTIALS=/run/secrets/blindspot-service-account.json`
   (use the platform's secret manager — never bake secrets into the image).
4. Consider a persistent session store (e.g. `connect-redis`) instead of the default
   in-memory store when running multiple instances.
5. Replace the memory-session note: with one instance the built-in store is fine.
6. Keep `firestore.rules` published as deny-all, and watch logs: the app logs
   connectivity problems at startup with actionable messages.
7. Remove all `BLINDSPOT_SETUP_ADMIN_*` variables after the first admin exists.
8. Set `BLINDSPOT_AUTO_SEED_DEMO=false` — demo accounts and demo packages
   should never be created in a production database.

## 12. Project structure

```
D:\BlindSpot\
├── package.json / package-lock.json
├── .env.example            # template (the real .env is local only)
├── .env                    # your actual secrets/config (gitignored)
├── .gitignore
├── firestore.rules         # deny-all client access (backend-only architecture)
├── server.js               # entry point (dotenv + firebase init + listen)
├── server/
│   ├── app.js              # Express app, sessions, CSRF, helmet, error pages
│   ├── config/firebase.js  # Admin SDK init + honest readiness probe
│   ├── middleware/auth.js  # requireAuth / requireRole (roles re-read from Firestore)
│   ├── middleware/csrf.js  # double-submit CSRF
│   ├── lib/stages.js       # the tested stage machine + delay evaluator
│   ├── lib/dates.js / csv.js
│   ├── services/employees.js    # Auth account + profile, role change, last-admin guard
│   ├── services/packages.js     # lifecycle transactions, history, public mapping
│   ├── services/reports.js      # analytics + CSV
│   ├── services/seed.js         # demo data seeder (5 employees + 16 packages)
│   └── routes/                  # public, auth, admin, workflows pages, workflow-api, reports
├── tools/seed-demo.js       # CLI: npm run seed:demo
├── views/ (EJS)            # dashboard, login, admin, workflow, reports, error + partials
├── public/
│   ├── css/styles.css      # full Blindspot design system (palette tokens)
│   └── js/                 # firebase-auth.js, dashboard.js, workflow.js, reports.js
└── test/workflow-rules.test.js
```

## 13. Design system

The UI uses the exact Blindspot palette — Electric Blue `#175CD3` (primary actions,
progress), Midnight Navy `#101828` (sidebar/headers), Supply Teal `#0E9384`
(completed stages), Cloud White `#F8FAFC` (page), Pure White cards, Amber `#F79009`
(pending/attention), Alert Red `#D92D20` (overdue/critical), Green `#12B76A`
(success/delivered), Gray `#667085` (neutral). All tokens live in
`public/css/styles.css` under `:root`. Layout is responsive (360 → 1440 px),
keyboard accessible with visible focus, and never communicates status by color alone.
