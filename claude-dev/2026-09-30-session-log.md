# Session log, 30 Sep 2026: lost answers, regional endpoints, latency plan

Production is Sydney only, via Telvoq. Calls to Indian numbers over Twilio are
test calls. Target: reply gap of 600-800 ms for an Australian customer.

## Decisions

| Decision | Reason |
|---|---|
| Worker stays in Sydney; no US or Mumbai worker | Production customers are Australian |
| Interruption mode `vad`, not `adaptive` | Adaptive lost answers given as the AI finished speaking |
| Deepgram on `api.au.deepgram.com` | About 30 ms from the VM against 207-285 ms on the US host |
| Keep Deepgram Flux for speech-to-text | Cartesia Ink-2 is uneven from Sydney (62-364 ms) |
| Cartesia Sonic-3.6 is the voice candidate | 78 ms first audio from Sydney against ElevenLabs 275 ms |
| LLM stays on Cerebras for now | Gemini is slower; Amazon Nova Micro not yet measured |
| India test calls are judged from ops metrics and the recording | The India phone leg adds delay production will not have |

## Changes

| Commit | Change |
|---|---|
| 8176126 | `INTERRUPTION_MODE` setting, default `vad` |
| e75bf33 | Cartesia option uses `sonic-3.6` (was `sonic-2`) |
| 04a6006 | `DEEPGRAM_HOST` setting for Deepgram's regional hosts |
| 1c8cacf, 4884047, 26e969c | Latency plan and benchmark notes |

Deployed to prod through 4884047. 04a6006 onwards waits for a push.

## Measurements

Full tables are in `2026-09-30-india-latency-plan.md` and
`2026-09-30-where-the-reply-gap-goes.md`. Summary from the Sydney VM:

| Stage | Today | Candidate | Measured |
|---|---|---|---|
| Speech-to-text round trip | 258-422 ms, Deepgram US | Deepgram Australia | about 30 ms |
| Language model first token | 0.39 s, Cerebras | Amazon Nova Micro | not measured; needs AWS credentials |
| Voice first audio | 275 ms, ElevenLabs | Cartesia Sonic-3.6 | 78 ms |

Gemini on the API key, from India: `gemini-3.5-flash-lite` 1.04 s,
`gemini-3.1-flash-lite` 4.4 s, `gemini-2.5-flash-lite` refused (not available
to new users), `gemini-3.8-flash` refused (no minimal thinking). Cerebras
qwen-3.8-27b 0.44 s from the same machine.

## Where things run

| Piece | Location |
|---|---|
| Worker, API, web | VM `cocally-app`, Google Cloud `australia-southeast1-b`, Docker |
| LiveKit | LiveKit Cloud, Australia region; 3-6 ms from the worker |
| Deepgram Australian host | AWS Sydney (`ap-southeast-2`) |
| ElevenLabs | Singapore (`x-region: asia-southeast1`) |
| Cerebras | US |

## Corrections to earlier statements

- "Deepgram has no Australian endpoint" was wrong. `api.au.deepgram.com` exists and works with the existing key.
- An India latency track (US or Mumbai worker, per-country routing) was planned from a misreading and is dropped.

## Open

- Test call on the Deepgram Australian host, then one on the Cartesia voice. One change per call.
- Amazon Nova Micro benchmark, once AWS credentials are in `deploy/gcp/.env`.
- `ENDPOINT_MIN_DELAY` (0.2 s) may now be the floor of the end-of-turn stage; lower it if the test call shows that.
- Test call over Telvoq to an Australian number before go-live.
- Key rotations still owed: ElevenLabs, Cerebras, Atlas `cocally_vm` password, the Google API key shown in a screenshot.
- Tools kept outside the repo: `~/llm_bench.py`, `~/stt_bench.py`, `~/tts_bench.py`; voice samples in `~/cocally-tts-samples/`.

## Amazon Bedrock (added later on 30 Sep)

- Nova models listed for the account in Sydney (`ap-southeast-2`): `amazon.nova-micro-v1:0`, `amazon.nova-lite-v1:0`, `amazon.nova-pro-v1:0` on demand in the region; `amazon.nova-2-lite-v1:0` only through the `global.` profile. `apac.` profiles can route to Tokyo, Seoul, Osaka, Mumbai or Singapore.
- Worker: `LLM_PROVIDER=bedrock`, `BEDROCK_MODEL` (default `amazon.nova-micro-v1:0`), `AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`. Bedrock goes first in the chain, Cerebras and Groq stay behind it as fallback. New dependency `livekit-plugins-aws==1.6.6`.
- Not yet callable: AWS answers "Your account is currently being verified" (HTTP 403) on `converse` and "Operation not allowed" (HTTP 400) on `converse-stream`. No Nova timing exists yet.
- `~/llm_bench.py` now times Bedrock models next to Cerebras.

## Deepgram Flux TTS and Bedrock status (30 Sep, later)

Deepgram Flux TTS (`wss://<host>/v2/speak`, model `flux-haley-en`, released
12 Aug 2026), time from sending text to first audio frame, warm socket:

| Host | From the Sydney VM | From India |
|---|---|---|
| `api.au.deepgram.com` | 96 ms | 378 ms |
| `api.deepgram.com` | 299 ms | 303 ms |

Against Cartesia Sonic-3.6 at 78 ms from Sydney. The installed LiveKit Deepgram
plugin (1.6.6) has no Flux TTS support, and Deepgram's launch notice limits
AU to 5 concurrent connections. Cartesia stays the voice candidate.

Bedrock after account verification: one `converse` call to
`amazon.nova-micro-v1:0` in `us-east-1` succeeded (server-side latency 573 ms
for a tiny reply). Every other call, including the same one repeated and all
calls in `ap-southeast-2`, returns HTTP 400 `ValidationException: Operation not
allowed`. The request format is therefore valid; the refusal is on the account.
No Nova timing from Sydney yet. Benchmark script: `~/fluxtts_bench.py`.

Text models the account lists as on demand with streaming in Sydney
(`ap-southeast-2`), relevant to calls: `amazon.nova-micro-v1:0`,
`amazon.nova-lite-v1:0`, `openai.gpt-oss-20b-1:0`, `openai.gpt-oss-120b-1:0`,
`qwen.qwen3-32b-v1:0`, `google.gemma-3-4b-it`, `google.gemma-3-12b-it`,
`google.gemma-3-27b-it`, `mistral.ministral-3-8b-instruct`. All return
`Operation not allowed` until the account block clears. `~/llm_bench.py` times
them in one run. Whether each supports tool calling is unverified.

## Bedrock resolved: OpenAI-compatible endpoint (30 Sep, later)

The Bedrock API key belongs to the newer `bedrock-mantle` endpoint,
`https://bedrock-mantle.ap-southeast-2.api.aws/v1` (OpenAI chat-completions
format). It lists 38 open models and no Amazon Nova. The older
`bedrock-runtime` Converse API keeps refusing the key. The worker's
`LLM_PROVIDER=bedrock` now uses this endpoint through the OpenAI plugin;
`livekit-plugins-aws` was removed again.

Time to first token, real call prompt with the transfer tool, from India
(laptop), warm, median of six:

| Model | Median | Range |
|---|---|---|
| Cerebras qwen-3.8-27b (current) | 392 ms | 373-1082 |
| Cerebras gpt-oss-120b | 424 ms | 378-535 |
| Bedrock mistral.ministral-3-8b-instruct | 557 ms | 523-1192 |
| Bedrock mistral.ministral-3-14b-instruct | 597 ms | 559-1159 |
| Bedrock zai.glm-4.7-flash | 598 ms | 490-1273 |
| Bedrock nvidia.nemotron-nano-3-30b | 604 ms | 448-1241 |
| Bedrock openai.gpt-oss-20b | 687 ms | 594-813 |
| Bedrock qwen.qwen3-32b | 881 ms | 581-1192 |
| Bedrock openai.gpt-oss-120b | 999 ms | 835-2495 |
| Bedrock google.gemma-3 (4b, 12b, 27b) | no tokens with the tool attached | |

India is about 285 ms round trip further from Sydney than the VM is, so the
Bedrock rows should drop by roughly that much from Sydney. Sydney run pending.

## Language model from the Sydney VM (30 Sep)

Time to first token, real call prompt with the transfer tool, warm, median of six:

| Model | Median | Range |
|---|---|---|
| Cerebras qwen-3.8-27b (current) | 349 ms | 330-753 |
| Cerebras gpt-oss-120b | 393 ms | 358-1790 |
| Bedrock nvidia.nemotron-nano-3-30b | 249 ms | 165-321 |
| Bedrock zai.glm-4.7-flash | 279 ms | 154-336 |
| Bedrock mistral.ministral-3-14b-instruct | 296 ms | 175-344 |
| Bedrock qwen.qwen3-32b | 300 ms | 271-334 |
| Bedrock mistral.ministral-3-8b-instruct | 302 ms | 167-359 |
| Bedrock openai.gpt-oss-20b | 390 ms | 300-431 |
| Bedrock openai.gpt-oss-120b | 713 ms | 498-1027 |
| Bedrock google.gemma-3 (all sizes) | no tokens with the tool attached | |

Bedrock in Sydney saves 50-100 ms on the median and has a tighter range than
Cerebras. Answer quality on calls is untested for every Bedrock model.

## Reply quality check across models (30 Sep)

Five call situations, benchmark prompt with the transfer tool, one reply per
model (`scratchpad/quality.py`). One sample each, not the production prompt.

| Situation | Cerebras qwen-3.8-27b | Bedrock qwen3-32b | Bedrock glm-4.7-flash | Bedrock nemotron-nano-30b | Bedrock ministral-14b |
|---|---|---|---|---|---|
| Hesitant answer | "Noted, electricity." (no question) | fine | leaked its thinking text and `</think>` into the reply | asked the customer to open their bill | fine |
| Objection | fine, 11 words | fine, 13 words | 35 words, over the 25-word rule | confused wording | markdown and "£££" |
| "Are you a robot?" | said it is a virtual assistant | did not answer the question | said "I'm not a robot" and that the number was bought from a list | said "I'm a real person" | did not answer the question |
| Ready to transfer | called the tool | called the tool | did not transfer, asked another question | called the tool | called the tool |
| Stop request | apologised, ended | apologised, ended | apologised, ended | apologised, ended | apologised, ended |

GLM and Nemotron denied being an AI, which breaks the disclosure rule. Only
the two Qwen models stayed within the rules in all five.

Deepgram Flux TTS: supported by `livekit-plugins-deepgram` 1.8.3 (`TTSv2`),
which requires `livekit-agents` 1.8.3. The worker is pinned to 1.6.6.

## Test calls on the Cartesia + Deepgram AU stack (30 Sep, afternoon)

Three calls to an Indian number over Twilio. 04:40 and 05:01 UTC: the AI's
first exchange worked, then the customer's audio arrived garbled at LiveKit
(−26 to −31 dB, unintelligible in the recording; zero `user listening ->
speaking` lines in the worker log). Degraded before the worker, not a provider.

05:26 UTC (`6abc9d84`): six clean turns, full script. Gap the customer would
hear, measured on the LiveKit recording with nova-3 word timings (customer's
last word ends -> AI's first word starts):

| Customer's last words | Gap | Worker stages (eou + llm + tts) |
|---|---|---|
| "Yes. Go on." | 2.46 s | 630 + 381 + 334 = 1345 (first turn; ~1.1 s unexplained) |
| "Yes. I do." | 0.96 s | 433 + 363 + 319 = 1115 |
| "...gas bill reviewed." | 0.96 s | 606 + 0 + 327 (llm:0 metric bug) |
| "...Simply Energy." | 1.16 s | 260 + 351 + 322 = 933 |
| "...by email only." | 0.96 s | 410 + 354 + 359 = 1123 |
| "...say, $500." | 1.52 s | 0 + 367 + 314 (eou:0 metric bug) |

Median 1.0 s at the recording. The 0.44 s on the 05:01 call was a single
lucky turn; this is the real figure and it agrees with the worker's own sums.
The three stages per turn: end of turn 0.26-0.63 s (VAD silence 0.25 + fixed
0.2 + Flux final), LLM 0.35-0.38 s (Cerebras, steady), TTS 0.31-0.36 s.

The TTS stage is the surprise. Cartesia's websocket path, benchmarked with the
plugin's exact packet (one sentence, `continue: true`,
`max_buffer_delay_ms: 0`, `add_timestamps`) on a reused connection, gives
first audio in 79-96 ms even from India (`scratchpad/ttsws_bench2.py`), and
the HTTP path 78 ms from Sydney earlier today. The worker reports 314-359 ms,
so about 230 ms per turn is inside the worker/plugin, not at Cartesia. The
framework's TTS metric starts when the first sentence is sent and ends at the
first audio frame; the metric also carries `connection_reused` and
`acquire_time`, which the worker now logs at INFO per turn
(`tts_ttfb=… acquire=… reused=…`). Next call's log tells whether the pooled
websocket is being reopened each turn.

Where the remaining time can come from, in order of certainty:
1. TTS stage 320 -> ~100 ms if the ~230 ms is connection setup or a plugin
   wait (pending the log line above). Saves ~0.2 s.
2. End of turn: `ENDPOINT_MIN_DELAY` 0.2 -> 0.05 and VAD min silence 0.25 ->
   0.2 saves up to 0.2 s, at the cost of cutting in on mid-sentence pauses.
3. LLM: Cerebras 350 ms is 215 ms of distance to the US plus generation;
   Bedrock Sydney qwen3-32b measured 300 ms, not enough to justify the switch.

With 1 and 2 the recording gap lands around 0.6-0.7 s, inside the target.

### 05:44 call: the TTS stage is per-connection

Call `6abca1a5` (customer audio garbled again: "Pressure is gone" for "Yes, go
on", confidence 0.8; "Hello?" at 0.97). The new log line showed two regimes on
one call: greeting and turn 1 on the prewarmed websocket, `tts_ttfb=0.33s
reused=True`; an interruption cancelled a synthesis, the pool dropped that
socket, and the replacement (33 ms to open) gave `tts_ttfb=0.08s` on every
later turn, reused or not. So Cartesia itself is ~80 ms from Sydney; some
websocket connections are ~320 ms on every request, and the 05:26 call spent
all six turns on one such connection. Idle time between uses is not the cause
(`ttsidle_bench.py`: 81-105 ms after 0-12 s idle). `api.cartesia.ai` is a
CloudFront distribution, so the likely split is which origin the edge proxies
a given websocket to. `ttsconn_bench.py` opens N fresh connections and prints
each one's first-audio and edge headers; from India (HYD57 edge) all six were
81-99 ms. Sydney run pending. If Sydney shows a slow/fast split, the fix is
to probe the socket after opening and reopen when slow (or open per turn: the
33 ms open overlaps the LLM wait and never sits on the critical path).

Sydney run of `ttsconn_bench.py` (06:07 UTC, all via edge SYD62): connections
0, 2, 4, 5, 7 opened in 18-60 ms and gave first audio in 66-95 ms; connections
1, 3, 6 opened in 770-1014 ms and gave 312-335 ms on every sentence. Fix in
the worker: `_CartesiaTTS` overrides the plugin's `_connect_ws` and reopens a
socket that took more than `CARTESIA_SLOW_CONNECT_MS` (300) to open, up to
`CARTESIA_CONNECT_TRIES` (4). Logs `cartesia websocket open N ms` per open.

06:06 call (`6abca6ce`): three turns, recording gaps 1.10 / 1.03 / 0.40 s;
the third reply ("Thanks. Got it, electricity it is.") stopped there and the
line was silent ~8 s until the customer hung up. Worker log for it pending.

### Worker log on the call record (30 Sep, afternoon)

Every test call needed a `gcloud compute ssh … logs` round trip before it could
be analysed. Now the worker copies its INFO+ log lines (its own and the
framework's warnings) onto the call as `timings.workerLog` (events endpoint,
kind `worker_log`; own array, last 500 lines), so Claude reads them from Atlas
with the turns, events, transcript and recording. Per-turn `eou_delay`,
`llm_ttft`, `tts_ttfb` (with websocket reuse), interruption metrics, final
transcripts, state transitions, Cartesia socket opens and stall guards are all
at INFO. Read with the usual mongoose one-liner:
`d.timings.workerLog.map(l => l.at.toISOString().slice(11,23)+" "+l.detail)`.

## 6 Oct: target moved to under 500 ms

New target from Nithin: customer's last word to AI's first audio under 0.5 s.
Budget on prod today (Sydney, after the Cartesia fix): end of turn 0.26-0.65
(median 0.43: VAD silence 0.25 + fixed 0.2 + Flux final), LLM first token
0.35-0.57 (Cerebras, US), TTS 0.07. Preemptive generation is on (Flux eager
end-of-turn -> PREFLIGHT_TRANSCRIPT -> draft reply), but the recording gaps
equal the plain sum of the stages, so the draft is either starting late or
being discarded. Changes in this commit:
- Shipped log lines carry the worker's own ms timestamp (server receipt time
  was useless: lines post one by one) and include the framework's DEBUG
  turn-timing lines ("using preemptive generation" with preemptive_lead_time,
  "received user transcript" with transcript_delay, "user turn committed").
- `VAD_MIN_SILENCE_S` 0.25 -> 0.15, `ENDPOINT_MIN_DELAY` 0.2 -> 0.05 (both
  env-overridable). Flux's final transcript (~0.3 s after the last word) is
  the gate the framework waits for anyway, so the waits above it were pure
  delay. Expected end of turn ~0.3 s. Watch for cutting in on pauses.
Expected gap after this: ~0.3 + (LLM remaining after the draft started) +
0.07. Under 0.5 s needs the draft to start at Flux's eager end-of-turn and an
LLM first token under ~0.3 s; the next call's log shows which of the two we
are missing. A separate research pass on current speech-to-speech models,
STT/LLM/TTS near Sydney and turn-taking techniques is running.
