# Pilot e2e delivery — what we need, and the carrier brief

**Date:** 2026-09-21
**Context:** decision to deliver CoCally as the full end-to-end call-centre platform for the pilot (human dialers + AI fronting, fronter→closer model as seen in the Wendy Anwar call). The telephony provider asked what we need from them. Two parts: (A) what the business must supply/decide, (B) the carrier brief (also published as a shareable page).

## A. What I need from the business

### Accounts and credentials (blocking — nothing live runs without these)
1. **Carrier SIP trunk** (answers to part B) — or Twilio Elastic SIP as the fallback we already dial through.
2. **LiveKit Cloud** production project, **Sydney region**, paid plan with SIP enabled. URL, API key, secret.
3. **ACMA Do Not Call Register** telemarketer subscription for the BPO/client: account id + passphrase for the real-time washing service, and which entity's subscription (the BPO or the end client) the wash runs under.
4. **AI keys** on paid tiers: Deepgram (STT + TTS), Groq or Anthropic for the conversation LLM, Anthropic for summary/scoring.
5. **SMS sender** for the consent link: Twilio (or carrier) messaging with an AU-registered sender ID or an AU mobile number, plus the public domain for the consent landing page.
6. **Cloud**: GCP project (recordings bucket in australia-southeast1, VM/Cloud Run for API + worker), a domain and TLS for `PUBLIC_BASE_URL`, MongoDB Atlas or self-hosted in the same region.

### Business content
7. Campaign scripts: the fronter question ladder per product (gas, electricity, NBN), the verbatim rate cards (e.g. Alinta supply/step rates), rebuttal library, and the disclosure wording the client's compliance lead signs off.
8. Lead lists (CSV) with state/timezone, and the client suppression lists.
9. Floor roster: agent names/emails, who is fronter vs closer, supervisors, QA. Target: 10 seats for pilot.
10. Hold music file, test mobile numbers (one per state ideally) for CLI presentation checks.

### Decisions
11. Hand-off model for the pilot: **callback to closer within 10 min** (as in the recording) vs live warm bridge. I will build both paths but default to callback, since it matches the floor's current process.
12. Predictive dialing on the live trunk in pilot: **no** (stays guarded off; manual + AI-fronted only) unless the client insists, in which case it is a separate two-week item with its own risk.
13. Recording retention period and who may access raw (unredacted) transcripts.

## B. Build plan to e2e (ordered)

| # | Item | Why | Est |
|---|---|---|---|
| 1 | Manual dial live test on the trunk: ordering, CLI presentation, phase events, hangup, DTMF | R1–R4 built, never tested on a real call | 2 d |
| 2 | Outcomes from SIP status (486/480/404/603) → retry matrix, CLI health | today agents hand-log no-answer/busy | 2 d |
| 3 | Carrier/LiveKit status callbacks + hung-call reconciliation | source of truth for what happened on the wire | 2 d |
| 4 | Recording via LiveKit egress → GCS, dual-leg, retention/legal hold | today a .txt transcript | 3 d |
| 5 | SMS consent step (tracked link, click webhook, compliance event, gate on transfer) | the recording shows this is how consent is captured | 3 d |
| 6 | "Consented → closer" lead state, closer worklist, 10-min SLA timer, callback dial | fronter→closer model | 3 d |
| 7 | Inbound: DIDs route to LiveKit inbound trunk → ring the owning agent, else a callback queue | customers ring back the CLI | 4 d |
| 8 | Transcript redaction for email + street address | PII in every energy call | 1 d |
| 9 | Supervisor listen / whisper / barge | BPO supervisors expect it | 4 d |
| 10 | DNCR real wash against production endpoint + scheduler soak | fail-closed today; must be proven | 2 d |
| 11 | Report export (CSV/XLSX) for client reporting | hard BPO requirement | 2 d |
| 12 | Deploy on GCP, TLS, backups, alerting; Redis for shared state if we go past one instance | pilot ops | 3 d |
| 13 | Load test 30 concurrent calls; test suite for dialer, transfers, consent | coverage is 2 files today | 3 d |

Roughly six to seven working weeks for one engineer; items 1–6 and 12 are the go-live minimum (about three weeks).

## C. Carrier brief (sent to the provider)

See the published page. Summary of the ask:

**Our side**: media and signalling terminate on LiveKit Cloud SIP (Sydney). We will provide LiveKit's SIP signalling/media IP ranges for the ACL, our expected volume, and our contact/escalation details.

**From the carrier**
1. Outbound trunk: SIP host/FQDN + port, transport (UDP/TCP/TLS), SRTP yes/no, auth (IP ACL preferred; else registration/digest realm+credentials), RTP media IPs and port range.
2. Codecs and DTMF: G.711 A-law (PCMA) first, PCMU, G.722/Opus if offered; DTMF RFC 4733 telephone-event with payload type.
3. Number formats: dialled-number format (E.164 `+61…` or national `0…`), From/P-Asserted-Identity format, and whether we may set CLI to any DID we hold on the account (required — we rotate geo-matched caller IDs). Confirm no CLI overstamping.
4. SIP response mapping: that 486 busy, 480/408 no answer, 404/484 invalid, 603 declined, and 503 congestion are passed through unaltered, and whether a Reason header or X-header carries carrier cause. We drive retries and caller-ID health from these.
5. Early media: 183 with ringback and 180 handling; answer supervision on 200 OK only (no false answer on voicemail/network announcements).
6. Capacity: concurrent channels and CPS for the pilot (ask 30 concurrent, 5 CPS) and the path to 60 concurrent; any burst policy.
7. Numbers: DIDs per geography (NSW 02, VIC 03, QLD 07, SA/WA/NT 08; and whether 04 mobile CLIs are available), lead time for more, porting, number-ownership letter for CLI legitimacy, any spam-reputation programme or carrier hints on reputation.
8. Inbound: route those DIDs to a SIP URI we give (LiveKit inbound trunk), IPs to whitelist for inbound INVITEs, and whether they can forward to a fallback number when we are down.
9. Timers: session timers (RFC 4028) values, max call duration, INVITE timeout.
10. Fraud and limits: destination whitelist (AU only), daily spend cap, alerting.
11. CDRs and events: CDR API/export, and real-time call status webhooks if available.
12. Commercials: per-second billing and rounding, AU mobile vs landline rates, DID monthly cost, minimum commit, contract term.
13. Support: NOC contact, SLA, escalation, status page, maintenance windows, and a test/sandbox trunk with test numbers.
14. Compliance: anything the carrier requires from a telemarketing customer (ACMA obligations, acceptable-use, calling-hours enforcement on their side).

## D. Update 2026-09-21 (later): carrier is IP-authenticated, not Twilio

**Finding (LiveKit docs, "Regions, regional endpoints, and static IPs"):** LiveKit Cloud has an Australian SIP region (`aus`, endpoint `{subdomain}.aus.sip.livekit.cloud`) but **static IP ranges exist only for Canada, EU, India, Japan and US** (`143.223.88.0/21`, `161.115.160.0/19`, `153.57.128.0/18`). The `aus` SIP gateway's addresses are not published and can change, so a carrier that authenticates by source IP cannot whitelist it reliably.

**Options, in order of preference**
1. **Digest/registration auth on the trunk** instead of IP ACL. LiveKit outbound trunks take `authUsername`/`authPassword`; inbound digest is supported if the carrier supports it. Zero code change on our side. Ask the carrier first.
2. **Ask LiveKit support** for `aus` static IPs (enterprise-only today) and for `allowed_addresses` to be enabled on our project for inbound.
3. **Pin SIP to `japan` or `india`** and give the carrier the three CIDRs above. Adds ~100–150 ms round trip and media leaves the country; check the carrier accepts non-AU media origin and the client's data-residency stance.
4. **Sydney SIP proxy we own**: Kamailio/OpenSIPS + RTPEngine on a GCP VM with a static IP. Carrier whitelists that IP; LiveKit talks to the proxy with digest auth. About a week of infra work and one more thing to run.
5. Self-host LiveKit server + SIP bridge in Sydney. Largest lift; only if 1–4 all fail.

**What the carrier needs from us (once auth is settled)**
- Our SIP endpoint for inbound: `<project-subdomain>.aus.sip.livekit.cloud` (subdomain = LiveKit project id without `p_`), transport UDP/TCP/TLS, port 5060/5061.
- If IP ACL is unavoidable: the CIDRs above (option 3) or our proxy IP (option 4).
- The DIDs they should route to that endpoint, and E.164 formatting.
- Expected volume: 30 concurrent, 5 CPS, AU only, calling hours per state.
- Technical contact and escalation.
- Our trunk auth credentials request (option 1) or confirmation of IP list.
