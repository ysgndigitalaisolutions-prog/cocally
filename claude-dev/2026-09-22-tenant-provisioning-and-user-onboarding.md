# Tenant provisioning, user onboarding, phone login, mandatory TOTP, access log

**Date:** 2026-09-22
**Ask:** provision a tenant and onboard 4–5 users securely; login by phone number + password; TOTP is required; the tenant owner must be able to see all logins.

## What was built

### Data
- `User`: `phone` (E.164, unique per tenant, partial index), `email` now optional (partial unique index), `passwordHash` optional until the invite is accepted, `passwordSetAt`, `tokenVersion`, `lastLoginAt`, `lastLoginIp`.
- New `UserInvite` collection: `tokenHash` (SHA-256 of a 32-byte random token), `purpose` INVITE|RESET, `expiresAt` (48 h), `usedAt`, `createdBy`. The raw token is returned once and never stored.
- Migration note for existing databases: the old `tenantId_1_email_1` unique index must be dropped (done on local dev); fresh databases get the new partial indexes automatically.

### API
- `POST /auth/login` takes `identifier` (phone in any spelling, normalised with the leads phone util; email still accepted for legacy/demo accounts) + `password` + optional `totpCode`. Records `lastLoginAt/Ip`, audits `auth.login` and `auth.login_failed` (with reason and user agent, never distinguishing the reason to the caller). 10/min/IP throttle.
- `GET /auth/me` — profile incl. `twoFactorSetupRequired`.
- `GET /auth/invite/:token` (inspect) and `POST /auth/invite/accept` (public, throttled) — sets the password (≥12 chars, letters + numbers), marks the link used, bumps `tokenVersion`.
- `POST /auth/password` — self-service change; bumps `tokenVersion` (signs out other sessions) and returns a fresh token.
- `POST /auth/2fa/setup` / `confirm` unchanged in shape; keyed by phone; audited.
- `POST /users` now **invites**: creates the account without a password and returns `{ user, invite: { url, expiresAt } }`. `POST /users/:id/link` reissues (INVITE if no password yet, RESET otherwise). `POST /users/:id/2fa/reset` clears a lost authenticator. `PATCH /users/:id` deactivate/roles bumps `tokenVersion`; you cannot deactivate yourself or drop your own OWNER role; only an OWNER can grant OWNER.
- `GET /audit` now allows OWNER explicitly and takes `actions=a,b,c`.
- **`JwtAuthGuard`** verifies the JWT, then loads live user state through the new global `UserStateService` (10 s cache, invalidated on every access-changing write): inactive → 401, `tv` mismatch → 401 "Session has been signed out". Then enforces TOTP for OWNER/ADMIN/SUPERVISOR/QA: without enrolment every route is `403 { code: 'TWO_FACTOR_REQUIRED' }` except those marked `@AllowWithout2fa()` (`/auth/me`, `/auth/password`, `/auth/2fa/*`).
- `seeds/provision-tenant.ts` → `dist/seeds/provision-tenant.js`: creates tenant + AU pack + OWNER (no password) and prints a one-time invite link. Refuses duplicate slugs. Writes a `tenant.provision` audit row.
- Seed users now carry phones `+61400000001…006`.

### Web
- Login page: phone number + password, then authenticator code when required; routes to `/security` if setup is outstanding.
- `/invite/[token]` (public): shows who the link is for, sets the password, links to sign-in.
- `/security` (all roles): authenticator enrolment with QR (client-side `qrcode`, secret never leaves the API/browser) and change password. Privileged roles are pushed here by the API interceptor on `TWO_FACTOR_REQUIRED`.
- `/users` (Owner/Admin): invite form → one-time link shown once with copy; members table (phone, roles, status, 2FA, last sign-in + IP); new link / reset link, reset 2FA, deactivate/reactivate; **access log** table (auth.* and user.* audit events with IP and reason).
- Nav: "Users & access" (Owner/Admin), "My security" (everyone).

## Verified end to end against the dev API
1. Bad login → 401, audited `auth.login_failed bad_password` with IP.
2. Owner login as `0400 000 001` → token, `twoFactorSetupRequired: true`; `/campaigns` → 403 TWO_FACTOR_REQUIRED; `/auth/me` → 200.
3. Enrol: setup → secret; confirm with an otplib-generated code → enabled; `/campaigns` → 200 immediately (cache invalidated).
4. Login again → `requires2fa`; with code → token.
5. Invite agent (`0411 222 333`) → link; inspect → name/identifier; accept with a weak password → 400; accept → ok; reuse → "invalid or expired".
6. Agent login by phone → no 2FA required; `/workspace/me` → 200.
7. Deactivate → the agent's token is refused on the very next request (401 "Account is disabled"); login → 401.
8. Reactivate with role SUPERVISOR → next login reports `twoFactorSetupRequired: true`.
9. Owner password change → old token 401, new token 200.
10. Owner reads the access log: login, login_failed, invite_accepted, 2fa_enabled, user.create, user.deactivate, user.update with IPs.
11. `provision-tenant --name "Acme BPO" --slug acme-test --owner-phone "0499 000 111"` → tenant, owner, printed link.
12. `tsc` clean on api and web, `next build` compiles the three new routes, 33 unit tests pass.

Bug found and fixed on the way: `PATCH /users/:id` blanked required fields because class-transformer exposes absent DTO fields as `undefined`; the service now strips those before assigning. Also renamed the prod compose project to `cocally-prod` after the smoke test's `down -v` removed the dev Mongo container (same project name).

## Not done
- No email/SMS sending: links are shown to the admin to pass on by WhatsApp/SMS. An SMS provider can be added later behind the same invite service.
- Recovery codes for TOTP are not implemented; an admin resets a lost authenticator instead.
- Agents are not forced onto TOTP (by design for the pilot); one flag in `TWO_FACTOR_REQUIRED_ROLES` changes that.
- Session length is still the 8 h JWT; there is no idle timeout.

## Later the same day: deployment readied from one .env

- `deploy/gcp/.env.example` → `deploy/gcp/.env` (gitignored) holds every deployment input: target (`vm` default, `cloudrun` optional), project, VM size, optional domain, telephony, provider keys, DNCR, recording bucket, first tenant.
- `deploy/gcp/setup.sh` (idempotent) readies the project from that file: APIs, runtime + deployer service accounts, keyless GitHub auth via Workload Identity Federation, generated secrets kept in `deploy/gcp/.state/`. VM target: static IP, firewall (80/443 public, SSH via IAP only), Ubuntu VM with Docker from a startup script, `.env.prod` generated and copied with the Compose stack, backup cron. Cloud Run target: Artifact Registry + Secret Manager. Then sets the GitHub repository variables with `gh` if present, else prints them. `deploy/gcp/provision-tenant.sh` runs the tenant command on the VM.
- `deploy.yml` (VM) rewritten to deploy through IAP SSH with WIF, no SSH keys or GitHub secrets, gated on `DEPLOY_TARGET=vm`; `deploy-cloudrun.yml` gated on `DEPLOY_TARGET=cloudrun`. Both fire on push to `prod`.
- Cost note recorded in DEPLOY.md: Cloud Run with api + worker always on is ~USD 240/mo plus Atlas; a single e2-standard-2 VM is ~USD 55/mo with Mongo on the box. VM chosen for the pilot.
- Not yet run against the real project: the script needs an Owner login to `cocally-509318`.
