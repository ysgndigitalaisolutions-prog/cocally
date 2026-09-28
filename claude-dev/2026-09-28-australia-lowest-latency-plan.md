# Lowest latency for Australian calls: audio path, carrier, models

**Date:** 2026-09-28. **Audience:** Nithin and whoever operates the AU pilot; sections 2 and 3 are also the brief for the Telvoq conversation.

Companion notes: `2026-09-25-telvoq-trunk-findings.md` (carrier facts, trunk ids, how to switch),
`2026-09-28-ai-response-latency.md` (what the India demo calls measured and the Flux/LLM changes).

## 1. What "latency" is on a call, and the target

Two different delays add up to what a caller feels:

| Delay | What it is | Today (India demo, Twilio) | Target for AU |
|---|---|---|---|
| **Turn gap** | Person stops speaking → AI's first word. STT end-of-turn + LLM first token + TTS first byte. Measured per turn in `calls.timings.turns`. | ~1.25 s p50 | 0.7 to 0.9 s |
| **Audio path** | How far each packet of voice travels between the phone and the worker. Not measured anywhere; felt as "the AI talks over me" and as a lag on every word. | India → US (Twilio) → Sydney and back | Phone → carrier in Sydney → LiveKit Sydney → worker Sydney, ~20 to 40 ms one way |

"Ultra low latency" is both under control at the same time. Fixing the turn gap while the audio hairpins through London still feels slow.

## 2. The audio path is the AU problem. Carrier is fixed: Telvoq

Australia production runs on Telvoq; India runs on Twilio. That split is settled, so AU latency has to be solved within Telvoq and on our side. Facts, all in the Telvoq findings note:

- Telvoq's SIP point of presence is **`lon1.telvoq.com`, London**. No Sydney or Singapore POP yet; asked on 25 Sep, still pending.
- Telvoq authenticates by **IP allow-list only**, no username/password. LiveKit Cloud publishes fixed IP ranges only for Canada, EU, India, Japan and the US. **Not Australia.** So our Telvoq trunk is created with `destination_country=IN`: every call leaves LiveKit from its **India** servers, the nearest region with fixed IPs that Telvoq can whitelist.
- The worker runs on the VM in **Sydney** (`australia-southeast1-b`).

Put together, an AU call today travels, for every packet of audio in each direction:

```
AU phone  →  Telvoq London  →  LiveKit India (SIP egress)  →  LiveKit media  →  worker Sydney
```

Rough one-way figures: AU→London ~140 ms, London→India ~60 ms, India→Sydney ~75 ms. Around **250 to 300 ms one way, 500 to 600 ms round trip**, before any model does anything. That is the whole turn-gap budget again, spent on geography.

### The two levers Telvoq holds

| Ask | What it removes | Path after | One way, est. |
|---|---|---|---|
| **A. Sydney (or Singapore) POP** | The London leg | phone → Telvoq Sydney → LiveKit India → worker Sydney | ~150 ms (Sydney POP), ~120 ms (Singapore) |
| **B. Digest auth (username/password)** | The India detour: with no IP allow-list we can set `destination_country=AU` and originate from Sydney | phone → Telvoq POP → LiveKit Sydney → worker Sydney | ~30 ms with a Sydney POP |
| A + B | both | the shortest path possible | ~30 ms |

A alone is a real improvement (half the detour). B alone changes little while the POP is London. Both together is the target.

### The levers on our side, if Telvoq stays IP-only

- **Region pinning stays `IN` for now** (Nithin's decision, 28 Sep). `destination_country=JP` is a possible later test (Sydney→Tokyo is a shorter hop than Sydney→Mumbai, est. 30 to 60 ms one way) and is unblocked by the CIDR whitelisting, but it is parked until the Telvoq POP and auth questions are answered.
- **Ask LiveKit for fixed IPs in Australia.** They publish them per region on request; if AU gets ranges, `destination_country=AU` works with IP-only auth and B is no longer needed. One support ticket; no cost to try.
- **CIDR ranges: done.** Telvoq whitelisted `143.223.88.0/21`, `161.115.160.0/19`, `153.57.128.0/18` on 28 Sep. The intermittent-403 risk is closed and any of LiveKit's fixed-IP regions (IN, JP, US, EU, CA) can now be used.

### What to ask Telvoq, verbatim

1. Do you have, or plan, a Sydney or Singapore POP for our route? Which hostname, and when?
2. Can our account use digest authentication instead of IP allow-listing? If not, why not, and is there any alternative to fixed source IPs (for example a registered trunk)?

## 3. LiveKit region

LiveKit Cloud media servers pick the region nearest the participants automatically; the worker in Sydney and an AU phone through a Sydney carrier both land on the AU region (the inbound address `…aus.sip.livekit.cloud` shows it exists). Nothing to configure once the carrier path is Sydney. The only LiveKit setting that matters is `destination_country` on the outbound trunk: `AU` with a digest-auth carrier, `IN` only when forced by an IP allow-list.

## 4. Worker and VM

- Keep the worker in Sydney. For AU callers it's already the right region.
- Move the worker to **its own VM** (`n2-standard-4` or similar) before the pilot. Today it shares an `e2-standard-2` with the API, web app and Mongo. Voice activity detection and noise cancellation run on CPU; contention shows up as 50 to 150 ms jitter on the turn gap that no provider change fixes.
- Keep `NOISE_CANCELLATION=1` (Krisp). It costs a few ms and saves whole turns on a noisy line.

## 5. Model stack for the lowest turn gap from Sydney

Every hop to a US provider costs ~150 ms round trip from Sydney. The choice per stage is "does the provider's advantage outweigh the round trip".

| Stage | Choice | Where it runs | Why |
|---|---|---|---|
| **STT + end-of-turn** | **Deepgram Flux** (`flux-general-en`, eager end-of-turn 0.5, final 0.7, pause cap 1.5 s). Shipped 28 Sep as `STT_MODEL=flux`. | US | Only telephony STT that decides end-of-turn itself (~260 ms) and emits an early "probably done" the LLM can start on. Saves ~300 ms per turn over nova + local end-of-turn model. Worth the US round trip. No AU-region equivalent exists. Set `STT_KEYTERMS` to the retailer names the campaign uses. |
| **LLM** | **Qwen 3.8 27B, reasoning off, `max_tokens` 160.** Primary **Cerebras** for now. | US | Measured ~370 ms first token + RTT. Follows the 25-word rule, calls the transfer tool reliably. Smaller models drop the rules; larger ones add nothing audible. |
| LLM, next | **Gemini Flash-Lite on Vertex AI, region `australia-southeast1`.** | Sydney | Round trip ~20 ms instead of ~150. Not yet measured on this workload; A/B ten turns each against Cerebras using `timings.turns` before switching. Same GCP project, no new vendor. If it wins by 100 ms or more it becomes primary and Cerebras the fallback. |
| LLM, fallback | Cerebras (or Fireworks / SambaNova instead of the rate-limited Groq free tier). `FallbackAdapter(attempt_timeout=2.5, retry_interval=0.2)`. | US | A stalled primary costs ~3 s of dead air, not 6. |
| **TTS** | **ElevenLabs Flash v2.5**, per-tenant voice. | US | ~75 ms server-side; ~250 ms measured including RTT. Cartesia Sonic is equivalent. Google's Chirp/Gemini TTS runs in `australia-southeast1` and would cut ~130 ms, but AU-accent voice quality must be checked with the client first; switch only if they accept the voice. |
| **Turn handling** | LiveKit built-ins: preemptive generation + preemptive TTS on, adaptive interruption 0.3 s, VAD min silence 0.25 s. | worker | Already on. Don't hand-tune silence timers; Flux owns end-of-turn. |
| **Prompt** | "Already introduced, never repeat", "under 25 words: one acknowledgement, one question". | API brief | Perceived speed. Shipped 28 Sep in `engine.controller.ts brief()`. |

Expected turn gap with this stack from Sydney (audio path is on top of these, see §2):

| Stage | Cerebras today | With Vertex regional LLM |
|---|---|---|
| End-of-turn (Flux) | ~250 ms | ~250 ms |
| LLM first token incl. RTT | ~500 ms | ~300 ms |
| TTS first byte incl. RTT | ~250 ms | ~250 ms |
| **Total** | **~1.0 s** | **~0.8 s** |

The audio path adds to this: ~300 ms one way on Telvoq today, ~30 ms once Telvoq delivers a Sydney POP and digest auth. The turn gap is ours to fix this week; the audio path is theirs.

## 6. Not worth doing

- Tuning VAD/endpointing knobs further: Flux already decides end-of-turn.
- Changing TTS vendor among ElevenLabs/Cartesia/Deepgram: all ~75 to 100 ms server-side, RTT dominates.
- Speech-to-speech models (OpenAI Realtime, Gemini Live): ~500 ms, but no scripted disclosure, per-tenant voice or reliable transfer tool, and different cost. Post-pilot question.
- Filler words while the LLM thinks: sound robotic once the gap is under a second.

## 7. Order of work

| # | Step | Owner | Effect |
|---|---|---|---|
| 1 | Deploy the current branch (Flux + hotfix), one test call, confirm `stt` column in `timings.turns` drops to under 150 ms | Nithin deploys, Claude reads metrics | ~300 ms off the turn gap |
| 2 | Send Telvoq the two asks in §2 (POP, digest auth); open a LiveKit ticket for AU fixed IPs | Nithin | unblocks the audio-path fix |
| 3 | As each lands: re-provision the Telvoq trunk (`destination_country=AU` once digest auth or AU ranges exist; Sydney POP address), switch `.env`, one AU test call | Nithin runs provisioning, Claude wires config | up to ~500 ms off the audio round trip |
| 4 | Worker on its own VM | Nithin (infra) | removes jitter |
| 5 | Enable Vertex AI on the project; Claude adds Gemini Flash-Lite as a provider; A/B on test calls | both | ~200 ms off LLM if it wins |
| 6 | Optional: try Google TTS in Sydney with the client's ear on the voice | both | ~130 ms off TTS if the voice is accepted |

## 8. How to measure after each step

```
# per-turn metrics for the latest AI calls (read-only; script in the session scratchpad)
cd apps/api && NODE_PATH=$PWD/node_modules MONGODB_URI=... node <scratchpad>/latency-report.js
```

Watch `eou`, `llm`, `tts`, `total` per turn, and `providersUsed.stt/llm/tts` on the call to know which stack produced them. The audio path isn't in the metrics; judge it on a test call by whether the AI starts talking over you, and confirm the route by checking the trunk's `destination_country` and the carrier address in `.env`.

## 9. India: carrier and caller ID (added 28 Sep)

Twilio cannot provide an Indian caller ID: Indian rules don't allow foreign providers to originate calls with Indian numbers. For the demo, Twilio on the US number is acceptable (the client expects the call); upgrade the account from trial (removes the trial announcement and the verified-numbers-only restriction) and move the trunk to the Singapore edge for the audio path.

For a real India pilot to customers who aren't expecting the call, a licensed Indian carrier is needed, with DLT registration of the business and its numbers. Same integration shape as Telvoq (SIP trunk into LiveKit, region pinned to `IN`, which has fixed IPs): candidates Exotel, Knowlarity, Ozonetel, Tata Communications, or the client's existing telecom setup if they already hold numbers and DLT registration (fastest). This is a licensing/paperwork track measured in weeks; start it as soon as the pilot is agreed.
