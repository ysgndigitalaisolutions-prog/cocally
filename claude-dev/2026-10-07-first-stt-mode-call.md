# First call on stt-mode turn-taking, 6 Oct 2026 18:32 UTC

Call `6ac53eaf721a2f999f89f724` (YSGN tenant, Nithin lead), prod at
`f7e406f`, `STT_TURN=stt` set in `/opt/cocally/.env.prod` and worker
recreated. 11 AI turns, qualified and transferred (BRIDGED).
Recording: `gs://cocally-509318-recordings/6ab571987b852e406c4a9cdb/2026-10-06/6ac53eaf721a2f999f89f724.ogg`
(mixed into both channels; gaps measured with nova-3 diarized word timings,
script `scratchpad/gaps.py` of this session).

## Result

| Measure | 30 Sep (vad, 1.6.6) | This call |
|---|---|---|
| Gap at the LiveKit recording, median | 1.0 s | 0.72 s |
| Gap, best | | 0.40 s |
| Commit to first AI audio at the worker | | 0.42-0.45 s on 8 of 11 turns |

Worker per turn (typical): endpointing wait 0.00 s, Cerebras qwen-3.8-27b
first token 0.35-0.38 s, Cartesia first byte 0.07 s. Flux end of turn
lands ~0.3 s after the last word (0.72 s recording gap minus 0.43 s).

## What worked

- Every turn committed with `source: stt`, `eou_delay=0.00s`.
- No deaf STT, no stall guard. Room audio and Flux tallies rose together.
- Cartesia parallel open: 187 ms on the first open, 38-56 ms after.
- Eager end of turn and TurnResumed: "Not yet." drafted a reply, the
  customer carried on, the draft was dropped and the final answer used.
- "Yes. I am." then "Right now, I'm handling them.": the AI started a
  reply, stopped within 0.13 s when the customer kept talking, then
  answered the full sentence. No talk-over in the recording.
- No mid-word pauses (`resume_false_interruption` off).

## Problems

1. **One slow LLM turn**: "I think it's Origin." -> Cerebras first token
   2.17 s (gap 2.48 s). No error, so the fallback chain did not engage.
   Next turn 0.81 s. Cerebras-side variance.
2. **Preemptive lead is small**: eager signal arrived 30-50 ms before the
   final on most turns (0.25 s and 0.13 s on two). Flux's final already
   comes fast, so the LLM's 0.36 s is the floor. Under 0.5 s at the
   recording needs a faster or closer LLM, as the research doc says.
3. **Slow end of turn on hesitant answers**: "Maybe electricity." 1.20 s
   and "Not yet. Maybe I would like to." 0.94 s. Flux waited for more
   confidence; the worker side was still 0.43 s.
4. **Transcription errors from Flux**, against nova-3 on the recording:
   - "The price." heard as "That's right." The AI took it as an answer
     and moved on. Keyterms `price,service` may help.
   - "Sorry?" heard as "So". The AI happened to repeat the question.
   - "around seven hundred/thousand dollars": the two models disagree.
5. **Interruption not exercised**: no barge-in during AI speech appears
   in the log; the VAD interruption path is still untested in stt mode.
6. Event loop blocked 567 ms at session start (before the greeting,
   harmless).

## Language model in Sydney without Groq's paid tier (7 Oct)

- Groq's paid Developer tier is not available to us. The free tier routes by
  proximity (from India every request was served by `x-groq-region: bom`,
  ~150 ms for qwen3.8-27b) but its rate limits rule it out as the main model.
  From the Sydney VM the region is untested.
- Vertex returned `403 Lightning dunning decision is deny` for project
  1041761530506: a known Vertex-only block from Google's billing-risk system,
  not an unpaid bill. Cleared after the project owner checked the billing
  account and re-linked it.
- Vertex first token, measured from the India laptop, thinking off
  (`thoughtsTokenCount` 0), 19-token prompt:

  | Model | Endpoint | First token |
  |---|---|---|
  | gemini-3.5-flash | australia-southeast1 | 2.0-2.3 s |
  | gemini-2.5-flash, 1.8k-token prompt | australia-southeast1 | 1.85-2.04 s |
  | gemini-3.5-flash | global | 0.98-1.47 s |
  | gemini-3.5-flash-lite | global | 1.00-1.18 s |
  | gemini-2.5-flash-lite | global | 0.84-0.98 s |
  | Cerebras qwen-3.8-27b (baseline, same laptop) | US | 0.37-0.49 s |

  Not offered in australia-southeast1 (404): 2.5 Flash-Lite, 3.5 Flash-Lite,
  3.0 Flash. The worker's default `GEMINI_MODEL` (gemini-3.5-flash-lite)
  would fail with `LLM_PROVIDER=vertex` in Sydney.
- Conclusion: Gemini is 2-5x slower to first token than Cerebras whatever
  the region, so Vertex is out. Cerebras stays primary; Bedrock qwen3-32b
  (300 ms from the VM) remains the only measured Sydney alternative.

## Known-good tag, lead reset, first-token deadline (7 Oct)

- Tag `known-good-2026-10-07` on `f7e406f` (pushed): the tested stt-mode
  build. To fall back: `git push -f origin 'known-good-2026-10-07^{commit}':prod` (the `^{commit}` is required: the tag is annotated, and GitHub rejects a tag object on a branch), and
  keep `STT_TURN=stt` in `/opt/cocally/.env.prod`.
- Nithin lead `6ab5781e8d2c7cdf546e6524` reset: `state_` FRESH, attempts 0,
  score 0, `facts` {} (the brief spreads `lead.facts` into the call, so stale
  answers would skip questions), next attempt cleared, timeline entry added.
  Yesterday's test appointment `6ac53fc0721a2f999f89fa3b` set to CANCELLED.
  Calls, recordings, transfers and callbacks kept. Backup of both documents:
  session scratchpad `nithin-lead-backup-2026-10-07.json`.
- LLM first-token deadline 2.5 s -> 1.0 s (`LLM_FIRST_TOKEN_TIMEOUT_S`). In
  1.8.5 `attempt_timeout` becomes the attempt's HTTP read timeout, so it also
  caps gaps between chunks. Local test with fake servers
  (`scratchpad/fallback_test.py`): primary stalling 2 s -> backup's first
  token at 1.38 s; primary at 0.8 s -> kept (0.81 s). A timed-out entry is
  marked unavailable until a background retry succeeds; meanwhile turns go
  to the next entry (Cerebras gpt-oss-120b, ~390 ms).

## Noisy-environment calls, 7 Oct 04:30-04:37 UTC (prod `4eea1f1`)

Nova-3 on the recordings vs what the worker got:

| Call | On the recording | Worker |
|---|---|---|
| `6ac5cadc` | "Yes, ma'am." after the 2nd question, then "Hello?" twice | none of the three: no VAD start, no Flux event; caller hung up |
| `6ac5cb1a` | "Yes." right after the greeting | missed (AMD SILENCE at 16 s); 22 s later "No." was heard |
| `6ac5cb1c` | no answer | |
| `6ac5cc0c` | full call in noise | "It's AGL." -> "Italian."; two AI replies cut short: "Thanks." and "One more - do" |

1. **Caller speech lost before VAD/STT.** The recording (egress, raw track)
   has the words; VAD and Flux, which both sit after the room input's
   BVCTelephony noise cancellation and AGC, saw nothing. Suspect: BVC
   (background *voice* cancellation) classifying the caller as background
   in a noisy room. Unconfirmed; the room-audio tally samples 1 frame in 10,
   so its peak=0 is not proof. Test: `NOISE_CANCELLATION=0` (env only), then
   `AUTO_GAIN_CONTROL=0`, same place, one at a time. If BVC is the cause,
   plain `noise_cancellation.NC()` (removes noise, keeps voices) is the fix.
2. **Two replies truncated** with nobody talking over them. Both were the
   only turns served by a Cartesia socket where all four parallel opens were
   far ("778 ms (fastest of 4): all far back-end", ttfb 0.32-0.33 s vs 0.07);
   every turn on a near socket finished. Correlation, not proof: the log does
   not show the LLM's full text or why the TTS stream ended.
3. Barge-in works in stt mode: "Nothing yet." over the retailer list stopped
   the AI within 0.45 s.
4. No LLM fallback fired; first tokens 0.34-0.36 s except 0.64, 0.71, 1.06 s.

## Surya call 04:40 UTC, and the 1.0 s timeout regression

Call `6ac5cd58` to Surya: first reply cut to "Thanks!" on a *near* Cartesia
socket (ttfb 0.10 s), so the far-socket theory above does not hold. Also
"Sorry. Not getting." heard as "Start an architect." (the AI answered with a
wrong-number line), and a short "No." missed by Flux (VAD fired; stall guard
asked to repeat).

Three truncations today, none in yesterday's 11 turns; the only change was
the LLM attempt timeout 2.5 -> 1.0 s. Local test (`scratchpad/midstream_test.py`):
a stream that sends "Thanks!", pauses 1.5 s, then the rest is cut to
"Thanks!" at 1.0 s and complete at 2.5 s. It logs "failed after sending
chunk, skip retrying" locally; no such line reached the call logs, so prod
is not proven. Default reverted to 2.5 s in code; on the VM set
`LLM_FIRST_TOKEN_TIMEOUT_S=2.5` in `.env.prod` (worker reads it via env_file).
