# CoCally ops console

The ops console at **`/ops`** is where CoCally staff run the platform. Tenants, their users, billing and invoices, calls, voice, limits, provider costs and operator accounts are all managed there. Tenants use the normal app at `/login`. They never see the console, CoCally's costs, or draft invoices.

This replaces the short-lived in-app "Platform" screen and the `PLATFORM_ADMIN_EMAILS` allow-list. Both were removed.

**Terms used below:**
- **Tenant:** a client call centre (BPO) using CoCally. The **YSGN** tenant is CoCally's own test tenant; each client gets its own.
- **Operator:** a CoCally staff member with an ops console account.
- **Advance:** the monthly prepayment a tenant makes (₹50,000 in the pilot quote).
- **Ledger:** the running record of a tenant's advance: money in, money used.
- **Rate card:** what each provider charges CoCally, used to estimate our costs.
- **TOTP / authenticator:** the six-digit code from an authenticator app.

---

## 1. Getting in

### First operator (once, after the first deploy)

```bash
./deploy/gcp/create-operator.sh --email nithinyakateela@gmail.com --name "Nithin"
```

1. The script prints a one-time link, valid for 48 hours. It never prints a password.
2. Open the link and set a password: at least 12 characters, with letters and numbers.
3. Go to `https://app.co-cally.com/ops/login` and sign in with your email and password.
4. On the first sign-in, the console shows a QR code. Scan it with an authenticator app and enter the code.
5. From then on, every sign-in asks for email, password and the authenticator code.

Running the script again for an existing email issues a new link. Use it if the link expired or the password is lost.

### More operators

Go to **Settings → Operators → Add operator**. The console shows a one-time link. Send it to the new operator directly; it is shown only once.

### Sessions

- An ops session lasts 8 hours.
- These all sign the operator out everywhere immediately: **Settings → My account → Sign out everywhere**, changing your password, or another operator resetting your authenticator or deactivating you.

---

## 2. Security model

| Rule | How it is enforced |
|---|---|
| Operators are not tenant users | Separate `operators` collection. No tenant admin can see or change them. |
| Authenticator is mandatory for operators | Password alone only returns an enrolment step, never a session. The guard refuses any operator without TOTP. |
| Tenant and ops sessions can't cross | Ops tokens are signed with a key derived from `JWT_SECRET` (`OPS_JWT_SECRET` in `operator-auth.guard.ts`). Tenant tokens fail on `/api/v1/operator/*`, and ops tokens fail on tenant routes. |
| Every ops request is checked live | The operator is re-read on each request: active flag, token version, TOTP. There is no cache. |
| Deactivating a tenant locks it out | The tenant's sessions are invalidated, `/auth/login` refuses its users, `UserStateService` treats them as inactive, and the dialers already refuse inactive tenants. |
| Phone numbers are unique across tenants | Sign-in is by phone, so the console refuses a phone that already has a login. |
| The last owner is protected | You can't deactivate a tenant's last active owner or remove their owner role. |
| Personal data is redacted by default | Transcripts are redacted unless you choose **Show unredacted**, which is recorded in the audit log. Playing a recording is also recorded. |
| Rate limits | Sign-in, enrolment and invite routes allow 10 attempts per minute per IP. |

**Audit trail**
- Every operator action goes to `opsauditlogs`: sign-ins, failed attempts and every change.
- Actions that affect a tenant are also written to that tenant's own `auditlogs`, as `ops.<action>` by `<email> (CoCally)`. The tenant can see what CoCally changed on their account.

---

## 3. Screens

### Overview (`/ops`)

- **Period:** this month, last 30 days, last 7 days or today.
- **Totals:** dials, AI minutes, agent minutes (not billed), our usage cost, what we billed for usage, and margin after fixed costs.
- **Needs attention:**
  - overdue invoices;
  - paused or deactivated tenants;
  - tenants still on the pilot-quote defaults because their billing terms were never confirmed;
  - tenants whose usage this month is more than their advance left.
- **Tenant table:** status, users, this month's dials and AI minutes, cost, billed, margin, advance left and last call.

### Tenants (`/ops/tenants`)

The list shows status, region, users, this month's usage and bill, advance left, voice, whether billing terms are set, last call and sign-up date.

**New tenant** (`/ops/tenants/new`) needs:
- company name and short name (unique; a–z, 0–9 and hyphens);
- where the customers are (Australia or India);
- the first client or brand they call for;
- the Owner's name, mobile number and optional email;
- how long to keep recordings, and a daily dial limit.

It creates the tenant, the first client and the Owner, then shows the Owner's one-time link. The Owner signs in at `/login` with their phone and must enrol an authenticator.

### Tenant page (`/ops/tenants/:id`)

**Header actions**
- **Pause dialling / Resume dialling:** stops or restarts all calling for the tenant.
- **Deactivate / Reactivate:** asks for confirmation. Deactivating signs every user out, blocks sign-in and stops all calls. Data is kept.

**Tabs**

| Tab | What it does |
|---|---|
| Billing & invoices | The month's running bill, its invoice, the advance and credit, and billing terms. See §4. |
| Calls | This tenant's calls, with the filters in the next section. |
| Users | Every user with sign-in, roles, status, password and authenticator state, and last sign-in. Actions: resend invite or reset password (shows a one-time link), reset authenticator, change roles, deactivate or reactivate, add a user. |
| Campaigns | Read-only: status, country, voicemail setting, daily budget, and this month's dials, answers, transfers and AI minutes. Tenants build campaigns in their own app. |
| Settings | Name, daily dial limit, how long recordings and transcripts are kept, and AI voice. |
| Our cost | This month's cost by provider, cost per AI minute, and billed against cost. |
| Audit | CoCally's actions on this tenant. |

**Voice options** (on the Settings tab):
- ElevenLabs Flash (default), Cartesia Sonic, or Deepgram Aura, each with an optional voice id.
- Blank uses the server default (`TTS_PROVIDER` / `TTS_VOICE`).
- Changes apply from the next call.
- Cartesia also needs `CARTESIA_API_KEY` on the AI worker. Without it, the worker falls back to Deepgram.

### Calls (`/ops/calls`)

- **Covers:** every tenant, 50 calls per page.
- **Filters:** date range, outcome, what answered (person, voicemail, phone menu, silence), transferred only, and the last digits of the customer's phone.
- **Each row shows:** tenant, customer, campaign, type (AI, manual, predictive), outcome, ring time, AI time, agent time, score, **our cost** and **billed**.

**Call page** (`/ops/calls/:id`):
- **What happened:** outcome, what answered and how fast it was detected, end reason and phone-network (SIP) status, score, and disposition.
- **Timeline:** dialled, answered, AI joined, transferred, ended.
- **Money:** our cost by provider, and billed at the tenant's base rate.
- **Recording player:** a signed link valid for 15 minutes, audited.
- **Transcript:** redacted by default.
- **Compliance events.**

### Invoices (`/ops/invoices`)

- **Covers:** all tenants.
- **Filters:** all, overdue, due, paid, drafts, void.
- **Shows:** the total outstanding in the current view.
- **Invoice page:** printable. Use **Print → Save as PDF** to send it.

### Audit log (`/ops/audit`)

The latest 200 operator events: when, who, action, tenant, IP and details. Failed sign-ins are shown in red.

### Settings (`/ops/settings`)

- **Rate card:** what each provider costs us, in US dollars:
  - LiveKit AI agent, phone line and agent browser;
  - speech-to-text, language model, voice, recording and carrier;
  - fixed monthly cost;
  - the rupees-per-dollar rate.

  Every cost and margin figure uses these rates, so check them against the real invoices monthly.
- **Invoice sender details:** company name, GSTIN (optional), email, phone, address and payment details. Invoices say "TAX INVOICE" only when a GSTIN is set.
- **Operators:** add, send a new invite or reset link, reset authenticator, deactivate. You can't deactivate yourself, and at least one other active, enrolled operator must remain.
- **My account:** change password, and sign out everywhere.

---

## 4. Billing rules

### Rates

- Each tenant has **rate bands**. The defaults are the pilot quote:

  | Band | Starts at | ₹ per AI minute | ₹ per dial |
  |---|---|---|---|
  | Standard | 0 AI minutes a month | 8.50 | 0.80 |
  | Growth | 10,000 AI minutes a month | 8.00 | 0.70 |

- **Whole-volume pricing:** the month's total AI minutes pick the band, and that band's rates apply to **all** of the month's minutes and dials.
- **AI time is billed per second.** It is live AI-to-customer talk time: from answer until transfer or hang-up.
- **Not charged:** agent talk time after a transfer, and the carrier. The tenant pays their carrier directly.

### Advance and ledger

- The monthly advance is recorded on the tenant's Billing tab, before GST, with the date and UTR.
- The ledger never edits or deletes entries. The balance is the sum of:
  - **ADVANCE:** money received (+);
  - **USAGE:** advance used when an invoice is issued (−);
  - **EXPIRY:** unused advance lapsing under the monthly rule (−);
  - **ADJUSTMENT:** a manual correction, with a required reason shown to the tenant (±);
  - **REVERSAL:** advance returned when an invoice is voided (+).
- **Unused advance rule,** set per tenant:
  - **Carries forward** (default, as the quote's Terms section says);
  - **Lapses at month end:** whatever is left expires when that month's invoice is issued.

### Invoice lifecycle

1. **Draft:** created from the month's calls (months run on India time). It can be refreshed while more calls come in, and the tenant never sees it.
2. **Issued:** numbered `CC-YYYY-NNNN`. The advance is drawn down by up to the subtotal, using the balance at the moment of issue. The invoice is then frozen and the tenant can see and print it. If the advance covers everything, it is marked **Paid** straight away.
3. **Paid:** marked with a payment reference such as the UTR.
4. **Void:** needs a reason. Any advance the invoice used goes back to the balance, the number isn't reused, and a new draft can be built.

**Invoice arithmetic:** subtotal − paid from advance = taxable value; taxable value + GST (per-tenant %, default 18; set 0 if not GST-registered) = total due.

### Open questions (for the client or CA)

- The quote says two different things about the advance: Section 2 says "that month's usage", but the Terms say it "carries forward". Tell the client which rule applies.
- GST on advances: invoices apply GST only to the amount left after the advance, which assumes GST on the advance was billed when it was received. Confirm with the CA.

---

## 5. Cost model (what "our cost" means)

**Usage is measured from each call record:**
- **Ringing:** from dial to answer, capped at 60 s for unanswered calls.
- **AI time:** from answer to transfer or end. It is capped at the last transcript line + 30 s, or 2 min with no transcript, and at 30 min in total. This stops calls closed late by the hung-call cleanup from inventing cost.
- **Agent time:** from transfer to end, capped at 4 h.
- **Recorded time.**
- **Characters the AI spoke.**

**It is priced with the rate card:**

| Cost | Charged on |
|---|---|
| LiveKit AI agent | AI minutes |
| LiveKit phone line | Ring + AI + agent minutes |
| Agent browser | Agent minutes |
| Speech-to-text, language model | AI minutes |
| Voice | Characters ÷ 1,000 |
| Recording | Recorded minutes |
| Carrier | Connected minutes (0 by default, because the client pays the carrier) |

**Totals** are converted to rupees at the rate-card rate. The fixed monthly cost is spread over the selected period and subtracted only from the overall margin.

These are estimates. The real figures are on the LiveKit, ElevenLabs, Deepgram, Cerebras, Google Cloud and Atlas invoices.

---

## 6. Technical reference

**API** (`/api/v1/operator/*`, `apps/api/src/modules/operator/`)

| Area | Routes |
|---|---|
| Sign-in (public, rate-limited) | `POST auth/login`, `POST auth/enrol`, `GET auth/invite/:token`, `POST auth/invite/accept` |
| Session | `GET auth/me`, `POST auth/password`, `POST auth/sign-out-everywhere` |
| Overview | `GET overview?from&to` |
| Tenants | `GET/POST tenants`, `GET/PATCH tenants/:id`, `GET tenants/:id/campaigns`, `GET tenants/:id/audit` |
| Tenant users | `GET/POST tenants/:id/users`, `POST tenants/:id/users/:uid/{link,reset-2fa,active,roles}` |
| Billing | `GET tenants/:id/billing?month`, `POST tenants/:id/{advances,adjustments,invoices}` |
| Invoices | `GET invoices?status&tenantId&overdue`, `GET invoices/:id`, `POST invoices/:id/{issue,paid,void}` |
| Calls | `GET calls?tenantId&campaignId&from&to&outcome&amdClass&transferred&phone&page`, `GET calls/:id`, `GET calls/:id/unredacted`, `GET calls/:id/recording` |
| Settings | `GET/PUT rate-card`, `GET/PUT seller` |
| Operators | `GET/POST operators`, `POST operators/:id/{link,reset-2fa,active}` |
| Audit | `GET audit?tenantId&before` |

**Tenant-facing billing** (`/api/v1/billing/*`, Owner and Admin only): `summary?month`, `ledger`, `invoices`, `invoices/:id`. These never show drafts or CoCally costs. The tenant's screen for them is **Usage & billing** (`/usage`).

**Data**

| Collection | Holds |
|---|---|
| `operators` | Operator accounts |
| `opsauditlogs` | Operator actions |
| `creditentries` | The advance ledger |
| `invoices` | Invoices; one live invoice per tenant per month |
| `platformsettings` | Rate card, sender details and invoice counters |
| `tenants.voice`, `tenants.billing` | Per-tenant voice and billing terms |

**Code**
- **Shared services** (`apps/api/src/modules/platform/`): `UsageService` measures usage from calls; `BillingService` handles pricing, ledger and invoices; `PlatformService` handles the rate card, cost and overview.
- **Web** (`apps/web/src/app/ops/`):
  - separate token key (`cocally.ops.token`) and API client (`lib/ops-api.ts`);
  - shared billing components in `components/billing/`;
  - ops components in `components/ops/`.
- **First-operator script:** `apps/api/src/seeds/create-operator.ts`, run on the server through `deploy/gcp/create-operator.sh`.

**Verification (28 Sep)**
- A 48-step HTTP end-to-end test on an in-memory database passed. It covered:
  - invite, enrolment and sign-in;
  - session separation;
  - creating a tenant and its duplicate checks;
  - the tenant owner's own sign-in and billing view;
  - user actions and last-owner protection;
  - billing terms, advance, draft, issue and auto-paid;
  - the calls list, phone search, and redacted vs unredacted views;
  - deactivation killing sessions and blocking sign-in;
  - both audit trails;
  - operator management and sign-out everywhere.
- The API boots, the existing tests pass, and the web production build passes.
- The test script was not kept in the repo. Turning it into a permanent automated test is on the list.

---

## 7. Known gaps and next steps

In priority order:

1. **Phone line and caller numbers are shared by all tenants.** `LIVEKIT_SIP_TRUNK_ID` and `SIP_TRUNK_NUMBERS` are server-wide, so every tenant dials through the same trunk and caller IDs. Each tenant needs its own trunk (their carrier) and number pool, set from the console. **Do this before a second client goes live.**
2. **Recording playback needs one permission.** The bucket's service account can only write. To play recordings in the console, grant read access:
   ```bash
   gcloud storage buckets add-iam-policy-binding gs://cocally-509318-recordings \
     --member serviceAccount:cocally-recordings@cocally-509318.iam.gserviceaccount.com --role roles/storage.objectViewer
   ```
   The tenant's own Recordings page still reads the VM's local folder, not the bucket.
3. **Invites and invoices are sent by hand.** Links and PDFs are copied manually; email or WhatsApp sending is the next step.
4. **No "view as tenant" for support.** Add a read-only view of a tenant's app.
5. **No CSV export** of calls, invoices or the ledger, for accounts and disputes.
6. **Some settings are still server-wide:**
   - Do Not Call register (DNCR) credentials and the bypass flag;
   - recording on/off;
   - hold music;
   - calling-window overrides.

   These should become per-tenant settings on the console.
7. **No tenant-level alerts.** Add an email when the advance runs low, or an invoice is issued or overdue.
8. **The end-to-end test isn't in CI.** Turn the 48-step script into a permanent automated test.
9. **Opening line converted to speech on every call.** The fixed part of the AI's opening line could be converted to speech once per campaign and reused, saving about ₹0.90 per answered call. This is the next cost lever.
