# Handoff: voice pipeline latency, 6 Oct 2026

For the next session. Read this first; the detail is in
`2026-09-30-session-log.md` (chronological) and
`2026-10-06-voice-stack-research.md` (state of the art, with sources).

## Goal

Customer's last word to the AI's first audio under 500 ms, measured at the
worker (turn end to first audio frame out). On the handset add the phone
leg, 100-250 ms each way, which nobody controls. Independent 2026 phone
measurements put every commercial platform above 1.2 s as heard by the
caller; our 30 Sep calls measured 1.0 s at the LiveKit recording.

## Where things stand

Production VM `cocally-app` (Sydney) runs commit `040fd15` from the `prod`
branch: livekit-agents 1.8.5, worker instrumentation, Cartesia sequential
reopen loop (slow). Branch `reconcile/voice-on-prod` is ahead with
`c78ab09` (parallel Cartesia open) and the uncommitted re-engineering
below. Nothing on the branch has been tested on a real call yet.

The Nithin test lead (`6ab5781e8d2c7cdf546e6524`) was reset to FRESH on
30 Sep; reset it again the same way if a call transfers immediately.

### What the three 1.8.5 test calls showed (6 Oct)

| Call (UTC) | What happened | Cause |
|---|---|---|
| 05:23 `6ac485bc` | VAD heard the customer three times, Flux returned nothing, stall guard asked to repeat | unknown; see below |
| 15:27 `6ac51361` | same | same; the "uninterruptible speech" silence-substitution path was ruled out by the stt-gate probe |
| 17:09 `6ac52b2e` | greeting 3.2 s late, customer said "Hello?" (transcribed fine in 0.1 s) and hung up | Cartesia gave three far sockets in a row; the sequential reopen loop waited for each; call answered in 1.7 s so no ringing time hid it. Fixed in `c78ab09` (parallel open, keep the fastest) |

So Flux on 1.8.5 is not permanently deaf: it worked on the third call,
where the customer spoke before the greeting. The two deaf calls had the
customer speak after a 10 s greeting. The full input instrumentation
(`pipeline:` line, `room audio:` tally, `flux stream:` tally, Deepgram
plugin DEBUG lines, `stt gate:` probe) is now on every call record
(`timings.workerLog`), so the next deaf call, if any, shows which link
stops: room -> session -> Flux -> events.

### Verified locally (laptop, India) under 1.8.5

`scratchpad/session185_test.py` runs a real AgentSession with the worker's
own STT/LLM/TTS/turn handling, a wav as the caller, no room, including the
uninterruptible disclosure + generate_reply opening. In both `vad` and `stt`
modes: transcripts stream, the turn commits, "using preemptive generation"
fires. Flux plugin alone: fine with the AU host, prod keyterms, 8/16/24/48
kHz, 12 s idle before speech (with and without silence frames). In `stt`
mode: commit -> first AI audio 0.52 s from India; Flux's eager signal led
the final by 30 ms on a short answer and 391 ms on a long one.

## The re-engineering (uncommitted on the branch, tested locally only)

Read against the current docs (LiveKit turn-handling reference, LiveKit
Deepgram Flux page, Deepgram Flux configuration and eager end-of-turn
pages):

1. **`STT_TURN` default `vad` -> `stt`.** The documented Flux setup is
   `turn_detection="stt"`: Flux decides the turn, its EagerEndOfTurn starts
   the draft reply, the bundled VAD handles interruptions only. In `vad`
   mode the turn cannot commit before Flux's final anyway, so the eager
   signal and preemptive generation bought nothing (30 Sep: the gap
   equalled the plain sum of the stages).
2. **`resume_false_interruption: False`.** The 28 Sep failure in stt mode
   (replies paused mid-word after Flux raised a StartOfTurn on line noise)
   is the framework pausing agent audio on start-of-speech while it waits
   for a transcript (`agent_activity.on_start_of_speech`, gated on
   `_pause_enabled()`). Off, a real interruption still stops the reply via
   the VAD (`min_duration` 0.5 s).
3. **Endpointing `min_delay` 0.0 in stt mode.** The reference says the
   delay is applied after the STT's own end-of-speech, so anything above
   zero is pure wait.
4. **Flux thresholds** `eager_eot_threshold` 0.5 -> 0.4 (Deepgram's
   low-latency profile), `eot_threshold` 0.7, `eot_timeout_ms` 1500 ->
   2000 (Deepgram uses 6000; 2 s caps a mid-sentence pause on a script).
5. Kept from earlier today: `discard_audio_if_uninterruptible: False`,
   VAD min silence 0.15, Opus DTX off on the agent track, Cartesia parallel
   open, `AUTO_GAIN_CONTROL` env knob (1.8 adds a gain stage; set 0 to A/B).
6. `setup.sh` and `.env.example` defaults moved to `stt`.

Expected at the worker from Sydney with Cerebras (350 ms first token):
Flux end of turn ~0.26 s after the last word + (0.35 minus the eager lead,
0-0.39 s) + Cartesia 0.07 s = roughly 0.45-0.6 s. Under 0.5 s reliably needs
the LLM in Sydney (Groq AU-1 Enterprise pinning, or self-hosted Qwen3.8-27B
/ gpt-oss-20b in australia-southeast1 at 28-130 ms); see the research doc.

## To deploy and test (one round)

1. Commit the branch, push to prod:
   `git push origin reconcile/voice-on-prod:prod`. The deploy workflow now
   prunes old images before pulling (the VM disk filled on 6 Oct).
2. **Once, on the VM, regenerate `.env.prod`**: `.env.prod` was written
   with `STT_TURN=vad` explicitly, so the new code default does not apply
   until `./deploy/gcp/setup.sh` is re-run (or `STT_TURN=stt` is set in
   `deploy/gcp/.env` first). Then restart the worker:
   `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d worker`.
   The `pipeline:` log line on the next call shows `turn=stt`.
3. One call to the Nithin lead: wait for the greeting, answer every
   question, interrupt once mid-sentence.
4. Read the call from Atlas (no ssh needed):
   ```
   cd apps/api && MONGODB_URI="$(grep '^MONGODB_URI=' ../../deploy/gcp/.env | cut -d= -f2- | tr -d "\"' \r")" node -e '
   const m=require("mongoose");(async()=>{await m.connect(process.env.MONGODB_URI);
   const d=(await m.connection.db.collection("calls").find({}).sort({createdAt:-1}).limit(1).toArray())[0];
   for(const t of d.timings.turns||[])console.log("turn",t.at,"eou",t.eou,"llm",t.llm,"tts",t.tts,"total",t.total);
   for(const t of d.transcript||[])console.log("T",t.startMs,t.speaker,JSON.stringify(t.text));
   for(const w of d.timings.workerLog||[])console.log("L",w.detail);
   await m.disconnect();})()'
   ```
   Recording: `gs://cocally-509318-recordings/<tenant>/<date>/<callId>.ogg`;
   measure the gap with nova-3 word timings (last customer word end to
   first AI word start), as in `scratchpad/call1056.json`.
5. What to look for in the log: `using preemptive generation` with
   `preemptive_lead_time`; `received user preflight transcript` before
   `received user transcript`; `tts_ttfb=0.0x`; `cartesia websocket open
   N ms (fastest of 4)`; no `turn stall guard`. If Flux goes deaf again:
   compare `room audio:` and `flux stream:` tallies and the Deepgram
   plugin lines.

## If it still fails

- Deaf STT with `room audio` peak > 0 and `flux stream` frames rising but
  no events: Flux-side; try `AUTO_GAIN_CONTROL=0` and `NOISE_CANCELLATION=0`
  (env only, no code), one at a time.
- Deaf STT with `flux stream` frames not rising: session path; the
  `stt gate` line and the Deepgram lines say why.
- Replies pausing or cutting: raise `interruption.min_duration`, keep
  `resume_false_interruption` off.
- Fallback that is known to work: `livekit-agents==1.6.6` pins in
  `agent-worker/requirements.txt` (plugins too), with `STT_TURN=vad`, plus
  the parallel Cartesia open and the log shipping; expect ~0.75 s.

## Open items beyond latency

Telvoq test call to an Australian number before go-live; pin the Telvoq
trunk to LiveKit region `aus`; key rotations (ElevenLabs, Cerebras, Atlas
`cocally_vm` password, the exposed Google key); llm:0 / eou:0 metric bugs;
`metrics_collected` deprecation (use `session_usage_updated` and
`ChatMessage.metrics` before 2.0); README account-name lines are in commit
`d3b34b0` on GitHub (Nithin declined removal for now).
