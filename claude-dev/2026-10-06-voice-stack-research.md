# Voice stack research: state of the art, 6 Oct 2026

Target set by Nithin on 6 Oct: customer's last word to the AI's first audio
under 500 ms. Worker in Sydney (GCP australia-southeast1), LiveKit Agents
1.6.6, Deepgram Flux on api.au.deepgram.com, Cerebras qwen-3.8-27b (350 ms
first token from Sydney, served in the US), Cartesia sonic-3.6 (70 ms first
audio from Sydney). Measured gap on prod today 0.75-1.0 s.

M = measured (by us or an independent benchmark). V = vendor claim.
NP = not published. Sydney round trips: Singapore ~94 ms, Tokyo ~109 ms,
US west ~140-150 ms.

## 1. Speech-to-speech models (replace STT -> LLM -> TTS)

| Model | Latency | Nearest region to Sydney | Tools | Phone audio | LiveKit plugin | Price | Notes |
|---|---|---|---|---|---|---|---|
| OpenAI gpt-realtime-2.1 / mini (Jul 2026) | V: no absolute figure; third-party 1.5-2 s end to end | US / EU only; SIP endpoints US and EU | yes | G.711 8 kHz, SIP | `openai.realtime` | $0.019/min in, $0.077/min out | most expensive; instruction leakage on mini |
| OpenAI GPT-Live-1 (full duplex, Jul 2026) | NP | US; signup only | implied | NP | LiveKit 1.8.1 `DuplexModel` | NP | not GA |
| Google Gemini 3.8 Live (GA Sep 2026) | V: 240 ms average voice response (unverified) | Gemini API global routing; Vertex Live in australia-southeast1 not confirmed | yes, async | 16 kHz in / 24 kHz out, no SIP | `google.beta.realtime`; 1.8.5 adds 3.8 Live | $0.005/min in, $0.018/min out | only S2S that could plausibly beat the pipeline; region unverified |
| Amazon Nova 2.5 Sonic (Oct 2026) | V: lower, no numbers | Tokyo nearest; not in Sydney | yes | 8 kHz turn-taking improved | `aws.realtime` | ~$0.015/min | +109 ms each way from Sydney |
| xAI Grok Voice | V: 0.70 s to first audio | US | yes | mu-law; no SIP | plugin exists | $0.08/min | too slow alone |
| Kyutai Moshi / Unmute | M: 200 ms / 400-750 ms | self-host | none / via LLM | self-host | none | GPU cost | task adherence poor |
| NVIDIA PersonaPlex (open, Jan 2026) | V: 205 ms | self-host | NP | NP | listed | free | unverified |
| Ultravox v0.7 | V: 150-220 ms text out, still needs TTS | US | yes | SIP | `ultravox` | $0.05/min | no 2026 updates |

No speech-to-speech model is served from Australia. Each pays 100-150 ms
each way plus its own first-audio time, so from Sydney they land at
500-900 ms, with weaker instruction following and higher cost than the
pipeline. Not the route.

## 2. Streaming speech-to-text with turn detection

| Model | End of turn / final | Nearest region | Accent accuracy | Plugin | Price |
|---|---|---|---|---|---|
| Deepgram Flux (current) | V: ~260 ms end of turn, p90 ~1 s; eager end of turn 150-250 ms earlier. M (Artificial Analysis, Jun 2026): final 0.02 s after end of speech, WER 7.4% | api.au.deepgram.com, AWS Sydney, GA | 9.6-10% WER Indian-accented English; Australian NP | `deepgram.STTv2` | $0.0065/min |
| Cartesia Ink-2 (Jul 2026) | M: final 0.09-0.21 s, WER 3.6% (best streaming WER) | global + EU; no APAC | 8% on 14-accent call set | `cartesia.STT` | credits |
| AssemblyAI Universal-3.6 Pro | V: turn p50 568 ms | global routed | 5.5% Indian-accented | `assemblyai.STT` | NP |
| ElevenLabs Scribe v2 Realtime | M: final 0.14 s, WER 3.6% | South-East Asia cluster | 12% on accents | `elevenlabs.STT` | $0.39/h |
| Speechmatics | V: partials <500 ms, finals up to 2 s | au.rt.speechmatics.com (Australia) | NP | `speechmatics.STT` | NP |
| Soniox v4 | M: 0.05 s | Australia "coming soon" | weaker entities | community | NP |
| Gladia Solaria-1 | V: 270 ms final | US / EU | NP | `gladia.STT` | NP |

Flux on the AU host is the only speech-to-text with its own end of turn
physically in Sydney. Keep it. The gain inside STT is Flux's
EagerEndOfTurn feeding preemptive generation, not a vendor change.

## 3. Language model first token

| Provider | First token | Region | Notes |
|---|---|---|---|
| Cerebras qwen-3.8-27b (current) | M: 350 ms from Sydney (215 ms of it is the US round trip) | US only; Australia "in discussions" | not fixable without a regional point of presence |
| Groq AU-1 (Equinix SY5 Sydney, live Nov 2025) | V: 80-120 ms in US tests; from Sydney NP | Sydney, but region pinning is Enterprise-only; free/developer tiers use global endpoints | gpt-oss-120b production; qwen3.8-27b preview; Nvidia bought Groq's inference unit Dec 2025, GroqCloud continues |
| AWS Bedrock ap-southeast-2 | M (us, 30 Sep): qwen3-32b 300, nemotron-nano 249, glm-4.7-flash 279, gpt-oss-20b 390 | Sydney | Converse API blocked on our account; bedrock-mantle works; quality: only qwen stayed within the script rules |
| Google Vertex australia-southeast1 | NP; LiveKit measured Gemini Flash 0.9-1.1 s in the US | Sydney | Flash-Lite may be better; measure |
| Azure Australia East | NP | Sydney (Regional Provisioned only) | gpt-5-mini / gpt-4.1-mini regional |
| LiveKit Inference Gemma 4 31B | V: 192 ms; M (community): 390-500 ms floor via gateway | US only | worse than Cerebras from Sydney |
| Self-hosted Qwen3.8-27B / Gemma 4 31B / gpt-oss-20b on vLLM in australia-southeast1 | M (community): 28 ms warm, 130 ms on a fresh 1k prompt for Gemma 4 31B | our VPC | the only path to a reliable <100 ms first token today; we run the GPU |

The LLM hop is geography, not model speed. Three ways to remove it: Groq
AU-1 with Enterprise pinning (measure), Bedrock/Vertex/Azure in Sydney
(our Bedrock numbers: ~250-300 ms, not enough), or self-hosting a 20-30B
model on a GPU in australia-southeast1 (28-130 ms).

## 4. Streaming text-to-speech

| Model | First audio | Nearest region | Quality (Artificial Analysis Elo) | Plugin |
|---|---|---|---|---|
| Cartesia Sonic 3.6 (current) | M (us): 70 ms from Sydney on a good websocket; V: <90 ms | some websockets route to a far back-end (320 ms); worker reopens those | 1,273-1,283, top 3 | `cartesia.TTS` |
| ElevenLabs Eleven v4 Turbo (Sep 2026) | V: ~150 ms; M (Coval): 203 ms | South-East Asia cluster | 1,334, #1 | `elevenlabs.TTS` (1.8.4) |
| Deepgram Flux TTS (Aug 2026) | V: 80 ms; M (us, 30 Sep): 96 ms on the AU host | api.au.deepgram.com | NP | `deepgram.TTSv2` (needs agents 1.8.3) |
| Inworld TTS-2 Flash | V: <25 ms p99 | US | 1,208 | `inworld.TTS` |
| Rime Coda | V: <100 ms | US | NP | `rime.TTS` |
| Google Chirp 3 HD | V: ~200 ms | australia-southeast1 | 1,048 | `google.TTS` |

At 70 ms we are at the floor. With `preemptive_tts` the voice stage is
hidden entirely. Flux TTS on the AU host is the only option that removes an
offshore hop, at an unknown naturalness cost.

## 5. Turn-taking: what moved in LiveKit Agents 1.6.6 -> 1.8.5

Releases in 2026: 1.7.0 (20 Aug), 1.7.1, 1.8.0 (5 Sep), 1.8.1, 1.8.2,
1.8.3 (26 Sep), 1.8.4 (1 Oct), 1.8.5 (6 Oct).

- `turn_handling=TurnHandlingOptions(...)` (since 1.5): endpointing
  `fixed | dynamic` (dynamic = moving average of the caller's pauses),
  `preemptive_generation` (enabled by default; `preemptive_tts` off by
  default, "set True for the lowest possible latency"), interruption
  `adaptive` with `false_interruption_timeout` and resume.
- 1.8.3 fixed the dict form `preemptive_generation={"enabled": ...}` being
  ignored. We pass the dict form on 1.6.6: check whether our settings are
  even applied.
- Audio turn detector v1 / v1-mini (>= 1.6.1): takes precedence over Flux
  if both are configured; do not add it.
- 1.8.1 `DuplexModel` (GPT-Live); 1.8.2 prefork (-800 ms start) and
  event-loop stall detection; 1.8.5 sticky LLM fallback, ElevenLabs
  websocket prewarm, Gemini 3.8 Live, Nova Sonic 2.5.
- Deepgram's guidance: EagerEndOfTurn 150-250 ms before EndOfTurn at
  threshold 0.3-0.5, 50-70% more LLM calls, trims the last 100-200 ms.
- Pipecat: `EagerUserTurnStopStrategy` does the same; Cartesia reports
  Ink's eager end "cuts roughly half a second".

Calibration: independent phone-call measurement (openbenchmarks.com /
Telnyx, 2026, 2,078 turns, measured from the caller's recorded audio):
Telnyx 1.30 s p50, ElevenLabs 1.42, Bland 1.52, Vapi 1.56, Retell 1.74.
Self-reported latency ran ~490 ms below what the caller heard. Vapi claims
"sub-500 ms", Bland "sub-400 ms". Our 0.75-1.0 s measured on the LiveKit
recording is already below every commercial platform's independent figure.
Under 500 ms is realistic at the worker (turn end to first audio frame out);
as heard on the handset add the phone leg, ~100-250 ms each way.

## 6. Transport

- LiveKit Cloud has an `aus` region for realtime and SIP; pin the Telvoq
  trunk to it (`<subdomain>.aus.sip.livekit.cloud`) so media ingress is in
  Sydney next to the worker. Check our trunk's region.
- Keep PCMU on the carrier leg; the room side is always Opus.
- Community measurement (Feb 2026): `AudioSource(queue_size_ms=1000)`
  default gave 803 ms round trip in-region, 10 ms gave 392; disabling Opus
  DTX kept the jitter buffer converged (435 -> 245 ms). Our recording gaps
  match the stage sums, so our output buffering is not adding much, but
  verify the agent's published track settings.

## Recommendation

Budget, worker side (last word -> first audio frame out):

| Stage | Today | Proposed | Basis |
|---|---|---|---|
| End of turn | 0.43 s median (VAD 0.25 + fixed 0.2 + Flux final) | Flux eager end of turn ~100-150 ms after the last word; commit at Flux final ~0.3 s | Deepgram; our 30 Sep Flux bench |
| LLM first token | 0.35 s, not overlapped in practice | started at eager end of turn: residual ~150 ms with Cerebras, ~0 with a Sydney LLM | LiveKit preemptive generation |
| TTS | 0.07 s | hidden by `preemptive_tts` | LiveKit |
| Total | 0.75-1.0 s | ~0.3-0.4 s with Cerebras; ~0.25-0.3 s with a Sydney LLM | arithmetic |

Steps, in order:
1. Make preemptive generation actually work (instrumented in d11fc82;
   one call shows whether the draft starts at eager end of turn and
   survives). This alone is the difference between 0.75 and ~0.45 s.
2. Upgrade livekit-agents 1.6.6 -> 1.8.5: dict-form preemptive settings
   bug fixed, sticky fallback, Flux TTS, Eleven v4, prefork. Retry
   `STT_TURN=stt` on the new version (the 28 Sep paused-reply bug may be
   gone) with `endpointing` dynamic, min 0.3.
3. LLM into Sydney, measured before chosen: Groq AU-1 (needs Enterprise
   pinning; ask Groq), then self-hosting Qwen3.8-27B or gpt-oss-20b on an
   L4/H100 in australia-southeast1 (28-130 ms). Keep Cerebras as fallback.
4. Keep Flux AU and Cartesia. Pin the Telvoq trunk to LiveKit `aus`.

Unverified, to measure: Groq AU-1 first token from our VM and whether our
tier lands in Sydney; Vertex Flash-Lite in Sydney; Flux eager timing on
8 kHz Australian audio; Gemini 3.8 Live from Sydney; our agent track's
output buffering; caller-heard latency over Telvoq.

Sources: Deepgram eager EOT docs (developers.deepgram.com/docs/flux/voice-agent-eager-eot),
Deepgram AU endpoint GA post, LiveKit releases (github.com/livekit/agents/releases),
LiveKit turn-handling reference (docs.livekit.io/reference/agents/turn-handling-options),
LiveKit regions and SIP pinning docs, Artificial Analysis AA-WER Streaming (Jun 2026),
Coval benchmarks (Oct 2026), openbenchmarks.com voice-agent latency, Austrade on Groq
Sydney, Groq community FAQ on regional endpoints, LiveKit community thread on SIP
pipeline latency, Cartesia Ink-2 post, AssemblyAI benchmarks (Sep 2026), OpenAI
realtime SIP docs, Google Gemini pricing, AWS Nova release notes.
