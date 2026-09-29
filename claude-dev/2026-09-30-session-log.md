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
