# Verification of the 6 Oct handoff against sources, 6 Oct 2026

Each claim in `2026-10-06-handoff-voice-latency.md` checked against the
pinned livekit-agents 1.8.5 source (local venv), LiveKit docs, Deepgram
Flux docs, and the independent benchmarks it cites.

## Confirmed

- `turn_detection="stt"` is the documented Flux setup; the bundled VAD
  handles interruptions only. (LiveKit Deepgram STT page.)
- `min_delay` is applied after Flux's EndOfTurn. `audio_recognition.py`
  (1.8.5) handles STT END_OF_SPEECH by setting `_last_speaking_time` to the
  provider's `speech_end_time`, then `_run_eou_detection` sleeps
  `min_delay + (last_speaking_time - now)`. With 0.0 the sleep is never
  positive. Framework default is 0.5 s.
- The 28 Sep "paused mid-word" failure matches `on_start_of_speech`
  pausing audio output when `_pause_enabled()` is true, which requires
  `resume_false_interruption` (default True) and a `false_interruption_timeout`
  (default 2.0). Setting it False disables the pause path entirely. A real
  interruption still goes through `on_vad_inference_done` ->
  `_interrupt_by_audio_activity` once `min_duration` (0.5 s) is met.
- `discard_audio_if_uninterruptible` default True substitutes silence
  frames on the STT path while an uninterruptible speech plays
  (`agent_activity.push_audio`); VAD still gets real audio. Matches the
  handoff's description of the ruled-out deaf path.
- Flux plugin defaults (`stt_v2.py`): eager off, `eot_threshold` 0.7 when
  eager is set, `sample_rate` 16000, `linear16`; eager must be <= eot.
  `eot_timeout_ms` is only sent when given.
- Deepgram: `eot_threshold` default 0.7 (range 0.5-0.9 in plugin docs,
  0.5-1.0 in Deepgram's table), `eager_eot_threshold` range 0.3-0.9,
  low-latency profile eager 0.4 / eot 0.7 / timeout 6000. EagerEndOfTurn
  arrives 150-250 ms before EndOfTurn at 0.3-0.5, 50-70% more LLM calls.
- Groq has a 4.5 MW cluster at Equinix SY5 Sydney (Nov 2025). Cerebras
  has no announced Australian region (Europe is next, end 2026).
- openbenchmarks (Telnyx-funded, 2,078 turns, caller audio): Telnyx 1.30,
  ElevenLabs 1.42, Bland 1.52, Vapi 1.56, Retell 1.74 s p50; self-reported
  runs ~490 ms below measured. Numbers match the research doc.
- Branch state: the "uncommitted re-engineering" is committed as
  `f7e406f`; `c78ab09` + `f7e406f` are ahead of `origin/prod` (`040fd15`).
  Code, `.env.example` and `setup.sh` default to `stt`; `deploy/gcp/.env`
  has no `STT_TURN` line, so re-running setup produces `stt`.

## Corrections

- Deepgram's server default for `eot_timeout_ms` is 5000 (API reference),
  not 3000 as the LiveKit plugin docstring and the comment in
  `agent.py` (`_build_stt`, "Flux default 3 s") say. Harmless: we pass 2000.
- "Flux end of turn ~0.26 s after the last word" is our own 30 Sep
  measurement; Deepgram publishes no per-word EOT latency, only p90 1 s /
  p95 1.5 s for turn detection overall and the 150-250 ms eager lead.
- Cerebras "350 ms first token from Sydney" is our measurement; public
  benchmarks give 150-300 ms from the US, consistent with ~215 ms of
  round trip on top.
- The LiveKit turn-handling page now says AssemblyAI is the recommended
  STT for stt-mode endpointing; Flux is supported but not the headline.

## Not verifiable from docs

- That the two deaf calls were caused by something other than the
  silence-substitution path: only the new instrumentation on the next
  call can show it.
- Groq AU-1 region pinning being Enterprise-only: not stated on public
  pages found; confirm with Groq before planning around it.
