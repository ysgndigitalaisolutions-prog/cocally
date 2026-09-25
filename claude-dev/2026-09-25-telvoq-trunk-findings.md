# Telvoq AU carrier trunk: findings, configuration, and how to switch

**Date:** 2026-09-25. **Audience:** whoever operates or debugs the Australian carrier trunk. Timeline detail is in the handoff (`2026-09-25-handoff-production-deploy-and-first-call.md` §13–16); this is the distilled state.

## 1. Result

**Telvoq works end to end.** 06:52:11 UTC, call to +61 408 988 859 (a real mobile) answered in 3.3 s, audio channel up, held 12 s, hung up cleanly. LiveKit call id `SCL_JzhUWprmXif5`. The carrier route, access list, dial format and codecs are all proven. Not yet exercised through the CoCally app itself (only raw LiveKit API calls), and not yet under load.

## 2. Carrier facts (from Telvoq, verified where noted)

| Item | Value | Verified |
|---|---|---|
| SIP domain / port / transport | `lon1.telvoq.com` : 5060 / UDP (resolves to 23.229.7.251) | yes |
| Authentication | **IP allow-list only.** Digest auth is not offered. | yes (their statement + behaviour) |
| Tech prefix | **`45`** (their first email said `1701`; changed the same day). Dial as `45` + country code + number, no `+`. Without the prefix their edge answers "auth required": the prefix is what identifies the account. | yes |
| Caller ID / DID | `61238196956` (+61 2 3819 6956). Accepted with or without `+`. | yes |
| Destinations | **Australia only** on this account. Indian numbers → `480 Temporarily Unavailable`. | yes |
| Codecs | They say PCMA, PCMU, G.722, G.729 with transcoding; they saw our PCMU offer. One earlier call (06:33 UTC) answered then failed "common audio codec not found"; not reproduced after that. | partly |
| POP | `lon1` = London. AU calls hairpin via London; asked for Sydney/Singapore POP, pending. | pending |
| Inbound | Telvoq routed the DID to `61238196956@5g5k1tqux4m.aus.sip.livekit.cloud` (12:41 IST 25 Sep). LiveKit inbound trunk `ST_MSSuMKe5VzqW` (number +61238196956, allow-list `23.229.7.251/32`, Krisp on) + dispatch rule `SDR_Zm3LFSQZJR2U` (individual rooms, prefix `inbound-`). Worker answers with its default greeting because inbound rooms carry no `callId` metadata. If Telvoq sends from another IP, widen `allowed_addresses` on the inbound trunk. | **proven 07:18 UTC 25 Sep**: Telvoq test calls from +1 702 309 3780 and +61 420 691 860 landed in `inbound-*` rooms, worker answered (source 23.229.7.251, so the /32 allow-list is right) |

## 3. The IP allow-list problem and how it is solved

- LiveKit Cloud publishes static source ranges only for Canada, EU, India, Japan, US: `143.223.88.0/21`, `161.115.160.0/19`, `153.57.128.0/18`. **Australia has none.**
- LiveKit outbound trunks have `destination_country`; "calls originate from a server within the specified country". Setting it to **`IN`** makes our calls leave from the India ranges. Verified by pointing a throwaway trunk at our own VM with a UDP listener on 5060: the INVITE arrived from **143.223.94.27** (inside 143.223.88.0/21).
- **Telvoq whitelisted only that single address, not the ranges.** It works today because LiveKit happens to use it. LiveKit may use any address in the ranges, so calls can start failing with `403 Forbidden` at any time. **Open request to Telvoq: enter the three ranges as CIDR.** If their platform cannot take CIDR, ask what it accepts.
- Failover caveat: if LiveKit's India region is unavailable, calls originate from a nearby region outside the ranges and will be refused.

## 4. How Telvoq's edge behaves (for debugging)

Their edge/SBC at 23.229.7.251 answers INVITEs itself; calls it rejects **never appear in their switch CDR**, which is why their team repeatedly "could not find" our attempts. Ask them to check the **edge** logs, not the CDR. Observed responses:

| Response | Meaning |
|---|---|
| `401 Account Suspended` in ~0.2 s | source IP unknown to them (seen from a laptop) |
| `403 Forbidden` in ~1 s | source IP known but not allowed (before whitelisting) |
| `407/401 "sip server required auth"` | INVITE without the `45` prefix |
| `480 Temporarily Unavailable` in ~1 s | destination not permitted (India) |
| `486 Busy Here` after 65–70 s | rang out unanswered (their test line 61 2 8018 5636 is unattended) |
| `408 sip request timed out` | no final response inside LiveKit's ring window |
| `412 common audio codec not found` | answered, SDP answer had no codec LiveKit supports (once) |

Our raw-probe scripts live in the session scratchpad only; the pattern is `CreateSIPParticipant(sip_trunk_id, sip_call_to="45<cc><number>", sip_number="61238196956", wait_until_answered=True)` against the prod LiveKit project.

## 5. LiveKit state (prod project `cocally-wn9jxt2x`)

| Trunk | Id | Notes |
|---|---|---|
| Twilio (pilot test) | `ST_Dy4tHDsvd6Y8` | **active** in `deploy/gcp/.env`; digest user `cocallyprod`; trial account, verified +91 numbers only |
| Telvoq AU | `ST_fGuwwzkowYPr` | `lon1.telvoq.com:5060`, UDP, number `+61238196956`, **no auth**, `destination_country=IN` |

Probe trunks were deleted. The temporary firewall rule `cocally-sip-probe` (UDP 5060 open to the world) must not exist; recreate only for a capture and delete right after.

## 6. Code changes made for Telvoq (uncommitted at the time of writing)

- `SIP_DIAL_PREFIX` (config → `livekit.service.ts dialOut`): prepended to the E.164 digits with the `+` stripped. Blank for Twilio, `45` for Telvoq.
- `SIP_DESTINATION_COUNTRY` (env → `provision-sip-trunk.ts --destination-country`): default `AU`; `IN` for IP-allow-list carriers. Username/password on the seed are now optional.
- `setup.sh` passes both; `.env.example` documents them.

## 7. Switching the platform from Twilio to Telvoq

Do this **after** the AI conversation is proven on Twilio (Telvoq cannot reach the +91 test phones).

1. In `deploy/gcp/.env`: `LIVEKIT_SIP_TRUNK_ID=ST_fGuwwzkowYPr`, `SIP_DIAL_PREFIX=45`, `SIP_TRUNK_ADDRESS=lon1.telvoq.com:5060`, `SIP_TRUNK_USERNAME=` and `SIP_TRUNK_PASSWORD=` blank, `SIP_TRUNK_NUMBERS=+61238196956`, `SIP_DESTINATION_COUNTRY=IN`.
2. `./deploy/gcp/setup.sh`, then on the VM `sudo docker compose --env-file .env.prod -f docker-compose.prod.yml up -d api worker`. No image rebuild needed once the prefix code is deployed.
3. First app-driven call: an AU lead on an AU-pack campaign (DNCR bypass is still on; see the pre-pilot checklist). Watch for `403` (address outside the single whitelisted IP) and for `480` (destination policy).
4. To go back to Twilio: trunk id `ST_Dy4tHDsvd6Y8`, prefix blank, restart.

## 8. Still open with Telvoq

1. CIDR ranges instead of the single IP (**risk of intermittent 403 until done**).
2. Sydney/Singapore POP (latency; London hairpin today).
3. DID inbound routing to the LiveKit AU SIP endpoint (needed for callbacks/inbound later).
4. Confirm the 06:33 codec failure is not reproducible on a real handset (one occurrence).
