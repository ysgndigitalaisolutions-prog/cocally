# 25 Oct 2026 — Verbatim script, DNC gaps, voicemail, LLM switch

Branch `fix/au-script-compliance` (from `reconcile/voice-on-prod` 8754777).
Goal: a calling agent that follows the Australian Deal script exactly, with
compliant DNC handling, before today's test calls.

## What changed

| Area | Change | Files |
|---|---|---|
| Script wording | Every script and Q&A line is tagged (`[S1]`–`[S4]`, `[E1]`, `[Q1]`–`[Q7]`). The brief sends `scriptLines` (tag to exact text). The model outputs the tag and the worker's `llm_node` swaps in the exact line before TTS. | `seed-test-campaign.ts`, `engine.controller.ts` (brief), `agent.py` (`_expand_tag_stream`) |
| One question per reply | A reply ends at the first script step, at a tagged question, or at the first `?` in the model's own words. Anything after it is dropped, never spoken. Unknown `[...]` stage directions are dropped. | `agent.py` |
| DNC | One shared `OPT_OUT_PATTERN` in `lines.ts` for the live and simulation paths. It adds "DNC", "Do Not Call Register", complaint, report, ACMA and ombudsman. New `opt_out` tool backed by `POST /engine/calls/:id/opt-out`, so a reworded request still suppresses the number. Before this, the playbook's DNC answer ended with `end_call`, which wrote no suppression. | `lines.ts`, `engine.controller.ts`, `flow-executor.service.ts`, `agent.py`, seed |
| Voicemail | The worker now acts on `/amd`'s `hangup` (campaign voicemail policy). Before this, the reply was thrown away. SILENCE only hangs up if the VAD never heard speech (29 Sep false SILENCE). | `agent.py` |
| Callbacks | `schedule_callback` refuses unless the customer's last turn names a time. The brief gives the explicit UTC offset; the model had booked Melbourne at +10:30. The callback question tag is blocked once a callback is booked. | `agent.py`, `engine.controller.ts` |
| STT | nova-3 gets `language=en-AU` for +61 leads (`en` otherwise; `STT_LANGUAGE` overrides). Campaign `sttKeywords` (via the brief) are merged with `STT_KEYTERMS`. | `agent.py`, brief |
| Interruptions | `min_words: 1`. An overlap with no transcribed word (cough, line noise) no longer stops the AI. Kept at 1 because the framework drops overlapping turns shorter than `min_words`. | `agent.py` |
| LLM | Default `openai/gpt-oss-120b` on Cerebras (qwen is the fallback). See the eval below. | `agent.py`, `setup.sh`, `deploy/gcp/.env` |
| Logs | Worker log lines go in one POST per second as a batch (`lines[]`), not one POST per line. | `agent.py`, `engine.controller.ts` |
| Env | `deploy/gcp/.env` (not in git): `LLM_MODEL=openai/gpt-oss-120b`, `STT_MODEL=nova` (it still said flux), keyterms without "Wendy", plus retailers. | local only |

## Eval (text-only, real Cerebras, real prompt and tools)

The harness is in the session scratchpad, `script_eval.py`. It builds the brief's instructions from the seed and plays 8 scenarios: happy path, not the account holder, DNC Register, a reworded DNC, busy then callback, questions, not interested, and off-topic.

| Setup | Result |
|---|---|
| Old prompt + qwen-3.8-27b (what prod ran) | Hung up on "Okay." and "I'm fine.". Opted a customer out on "Hi.". DNC Register went to `end_call` with no suppression. One 3.4 s turn. |
| New prompt + qwen | Missed the transfer in both runs. |
| Old prompt + gpt-oss-120b | Every path right. |
| New prompt + gpt-oss-120b (final code) | Every path right, including busy → asks for a time → books it → ends the call. Median turn 0.41–0.42 s, p95 0.86 s. |

Bedrock Sydney: the key in `.env` now returns `401 invalid_api_key`. Its script quality is still untested. Sydney first-token times from 30 Sep: qwen3-32b 300 ms, ministral-14b 296 ms, gpt-oss-120b 713 ms (slower than Cerebras).

Tests:
- `apps/api` vitest 37/37 (new: `engine/__tests__/opt-out-pattern.test.ts`).
- `agent-worker/tests/test_script_tags.py`, 15 cases, all pass.
- API `tsc` clean.

## Deploy

1. `deploy/gcp/setup.sh` from the main checkout. It writes `.env.prod` to the VM, with no restart.
2. Push to `prod`. The workflow pulls and runs `up -d` with the new env.
3. `deploy/gcp/seed-test-campaign.sh`. It publishes the tagged flow version and updates the campaign playbook. Until this runs, the brief has no `scriptLines` and the model speaks freely, as before.

## Open

- The AU network path is still caller → Telvoq London → LiveKit SIP in India → Sydney (~0.5–0.6 s round trip, estimated). Ask Telvoq for an APAC POP and digest auth so the trunk can use `destination_country=AU`.
- There is no AU campaign. The seed is the India test campaign on the IN pack. A real AU call needs a +61 lead on an AU-pack campaign, with the Telvoq trunk (`LIVEKIT_SIP_TRUNK_ID=ST_fGuwwzkowYPr`, `SIP_DIAL_PREFIX=45`).
- First real calls on nova-3 + `min_words` + gpt-oss: check `timings.workerLog` for "script lines:", "stt nova language=" and any `AMD ... hanging up`.
- To test Bedrock models: get a new Bedrock key, then rerun the eval on qwen3-32b and ministral-14b.
