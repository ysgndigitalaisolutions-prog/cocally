"""
CoCally — LiveKit Agents voice worker.

Holds a real spoken conversation in a LiveKit room (streaming STT -> LLM -> TTS
with barge-in). Providers match the CoCally stack: Deepgram (STT + Aura TTS) and
Groq (LLM). No ElevenLabs / OpenAI needed.

Two ways it runs:
  • Demo (no phone): talk to it from https://agents-playground.livekit.io.
  • Real call: the CoCally API dials a lead via LiveKit SIP + Twilio and passes
    the call id in the room metadata; the worker fetches the authoritative brief
    (prompt + disclosure + rebuttals) from the API so conversation content lives
    in one place. See claude-dev/2026-07-19-live-call-build-plan.md.

Run:
    pip install -r requirements.txt
    cp .env.example .env    # fill LiveKit + DEEPGRAM_API_KEY + GROQ_API_KEY
    python agent.py dev

Everything this worker sends to the API is best-effort: a failed HTTP call is
logged and swallowed, never allowed to end a live call. The one asymmetry is
the opt-out rail — see `Qualifier.close_for_opt_out` — where the *server* has
already recorded the suppression before we hear about it, so even a worker that
crashes on the response cannot un-suppress the customer.
"""
from __future__ import annotations

import array
import asyncio
import json
import logging
import math
import os
import re
import time
from typing import AsyncIterator

import aiohttp
from dotenv import load_dotenv
from livekit import agents, rtc
from livekit.agents import Agent, AgentSession, RoomInputOptions, function_tool
from livekit.plugins import deepgram, openai, silero

load_dotenv()
logger = logging.getLogger("cocally-agent")

ENGINE_BASE_URL = os.getenv("ENGINE_BASE_URL")
ENGINE_SERVICE_TOKEN = os.getenv("ENGINE_SERVICE_TOKEN")

# Same variable the API reads (`config.floor.holdMusicUrl`). Set it in BOTH
# environments: the API hands it to the agent's browser for hold, this worker
# publishes it during the transfer hand-off.
HOLD_MUSIC_URL = os.getenv("HOLD_MUSIC_URL")

# ── Timings ────────────────────────────────────────────────────────────────
#
# AMD_SILENCE_TIMEOUT_S: nothing said within this long of live audio is
# reported as SILENCE. Six seconds is past the point where a human would have
# said *something* — a genuinely silent answer is a dead line, a mailbox that
# beeped before we were listening, or a screening device.
AMD_SILENCE_TIMEOUT_S = 6.0
# How long to keep comfort audio running while waiting for the human agent's
# WebRTC leg. The API's own accept window is `AGENT_TRANSFER_ACCEPT_SECONDS`
# (default 20s) but `_do_transfer` only returns BRIDGED *after* someone
# accepted, so what remains is browser token fetch + WebRTC handshake + mic
# permission. 15s covers a cold first-ever join with margin.
AGENT_AUDIO_TIMEOUT_S = 15.0
# Fallback if the session doesn't expose its output sample rate; matches
# livekit-agents' RoomOutputOptions default.
DEFAULT_OUTPUT_SAMPLE_RATE = 24000

# Fallback instructions for the no-phone playground demo (real calls override
# these with the API brief). Grounded in the seeded solar qualification flow.
DEFAULT_INSTRUCTIONS = """You are a warm, natural outbound assistant for Aurora \
Solar, qualifying homeowners for a free solar assessment.

- Your FIRST turn must disclose, in one friendly sentence, that you are an AI \
assistant and the call may be recorded for quality — then ask if now is a good \
moment.
- Qualify one question at a time, conversationally: home ownership, existing \
panels, rough quarterly electricity bill, house vs apartment, and interest in a \
free no-obligation assessment.
- Be brief and human, never pushy. Acknowledge objections and offer the free \
assessment; do not argue.
- When they clearly qualify and want to proceed, call the request_transfer tool \
to bring in a human specialist.
- If they ask to stop or say do-not-call, apologise, confirm removal, and end."""


# ── Answering-machine detection, from the first STT partial ────────────────
#
# WHY NOT A CARRIER AMD CLASSIFIER: the usual approach (Twilio AMD, or LiveKit
# waiting on beep detection) listens to 2–4 seconds of the answered call before
# it will commit to human-or-machine, and the dialer stays silent for that whole
# window because speaking early would talk over a greeting it hasn't classified
# yet. On a real outbound floor that is the single most expensive mistake
# available: a human who says "Hello?" into two seconds of nothing has already
# decided this is a robocall, and a meaningful share of them hang up before the
# agent's first word. We would be buying a slightly better voicemail-detection
# rate with the answers we actually wanted.
#
# So this classifies from the FIRST transcript the STT gives us — interim
# partials included, typically ~300-500ms after the person starts talking — and
# reports it. The classification is deliberately advisory: `POST /engine/calls/
# :id/amd` only records `amdClass`/`amdLatencyMs` on the Call, it does not
# advance or terminate anything. Voicemail policy (drop a message, hang up)
# belongs to whoever owns the flow, and the CLI-health heuristics finally get
# real data about *what* answered instead of inferring it from answer rates.
#
# FAX is in the shared AMD_CLASSES enum but is not reachable from here: a fax
# tone produces no transcript, so a fax answer lands in SILENCE. Detecting it
# properly needs tone analysis on the raw audio frames — out of scope, and rare
# enough on mobile-heavy AU lists to not be worth the false positives.
_VOICEMAIL_PATTERNS = re.compile(
    r"you'?ve reached"
    r"|you have reached"
    r"|is not available"
    r"|isn'?t available"
    r"|not available (right now|at the moment|to take)"
    r"|unable to take your call"
    r"|can'?t take your call"
    r"|leave (a|your) (message|name)"
    r"|after the (tone|beep)"
    r"|at the (tone|beep)"
    r"|please record"
    r"|record your message"
    r"|voice ?mail"
    r"|message bank",
    re.I,
)
_IVR_PATTERNS = re.compile(
    r"press (one|two|three|four|five|six|seven|eight|nine|zero|[0-9*#])"
    r"|for (sales|service|support|accounts|billing|enquiries|reception)"
    r"|your call is important"
    r"|please (listen carefully|hold|stay on the line|select)"
    r"|main menu"
    r"|all of our operators"
    r"|calls may be (monitored|recorded) for",
    re.I,
)


def _classify_amd(text: str) -> str:
    """First-transcript → AMD class. Order matters: a voicemail greeting can
    contain menu-ish words ("press 1 to leave a message"), so voicemail is
    tested first."""
    if _VOICEMAIL_PATTERNS.search(text):
        return "VOICEMAIL"
    if _IVR_PATTERNS.search(text):
        return "IVR"
    # Anything else that a person actually said. A short greeting ("hello",
    # "yeah", "Sarah speaking", "who's this") is the canonical case; a longer
    # first utterance that matched neither machine pattern is still far more
    # likely a talkative human than an undetected machine, and HUMAN is the
    # safe default here because nothing downstream acts on this value — a wrong
    # HUMAN costs a mislabelled report row, a wrong VOICEMAIL would teach the
    # CLI-health model that a good number is producing machines.
    return "HUMAN"


class Qualifier(Agent):
    def __init__(self, instructions: str, call_id: str | None, job_ctx: agents.JobContext) -> None:
        super().__init__(instructions=instructions)
        self._call_id = call_id
        self._ctx = job_ctx
        # Set once session.start() returns; lets the score-triggered auto-transfer
        # (not an LLM tool call) actually speak its handoff line.
        self.session_ref: AgentSession | None = None
        self._transfer_triggered = False
        # True from the moment a server-side opt-out rail fires. Latched, never
        # cleared: it blocks transfers, further engine round-trips and any
        # second closing line for the rest of the call.
        self._closing = False
        # Wall-clock (monotonic) instant the customer's audio actually started
        # flowing — the zero point for AMD latency.
        self.audio_live_at: float | None = None
        self._amd_reported = False
        # Decoded hold music, if `HOLD_MUSIC_URL` was fetchable. Prefetched at
        # startup so the transfer hand-off never pays for the download. Decoded
        # AT `output_sample_rate` — the two must stay in step or the music plays
        # back at the wrong pitch.
        self.hold_music_pcm: bytes | None = None
        self.output_sample_rate: int = DEFAULT_OUTPUT_SAMPLE_RATE
        # Background tasks we only hold to keep them from being garbage
        # collected mid-flight (asyncio keeps only weak references).
        self._bg_tasks: set[asyncio.Task] = set()

    @property
    def closing(self) -> bool:
        """True once an opt-out rail has fired — no more turns, no transfers."""
        return self._closing

    def spawn(self, coro) -> asyncio.Task:  # noqa: ANN001 — any coroutine
        task = asyncio.create_task(coro)
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)
        return task

    # ── Transfer ───────────────────────────────────────────────────────────

    @function_tool
    async def request_transfer(self, reason: str) -> str:
        """Bring a human specialist onto the call once the lead is qualified.

        Args:
            reason: one short line on why they qualify (for the agent's card).
        """
        return await self._do_transfer(reason)

    async def maybe_auto_transfer(self, reason: str) -> None:
        """Called when the engine's real campaign-weighted score crosses the
        transfer threshold — see engine.controller.ts `scoreAction(...) ===
        'TRANSFER'`. The AI must not decide "this lead qualifies" purely on
        its own judgment; this is the authoritative, score-gated path (same
        rule the simulation path enforces), independent of whether the LLM
        itself ever decides to call request_transfer.
        """
        if self._transfer_triggered or self._closing:
            return
        logger.info("auto-transfer triggered (call=%s): %s", self._call_id, reason)
        text = await self._do_transfer(reason)
        if self.session_ref is not None:
            await self.session_ref.say(text)

    async def _do_transfer(self, reason: str) -> str:
        # The opt-out latch wins over everything. A customer who has asked to be
        # removed is never handed to a human specialist, no matter what the LLM
        # decided in the same breath or what the score says — and the server has
        # already suppressed them by the time we get here.
        if self._closing:
            return "Of course — I'll take care of that."
        if self._transfer_triggered:
            return "One moment, please."
        self._transfer_triggered = True
        logger.info("request_transfer(call=%s): %s", self._call_id, reason)
        if not self._call_id:
            return "Give me just a moment."

        result = await _post_transfer(self._call_id, reason)
        if result == "BRIDGED":
            # The human's browser is about to join this same room and take
            # over the mic; the AI leg ends so there's only one voice. Kept
            # deliberately vague ("give me a moment", not "connecting you to
            # a specialist") — the handoff itself should feel invisible.
            self.spawn(
                _handoff(self._ctx, self.session_ref, self.hold_music_pcm, self.output_sample_rate)
            )
            return "Great, give me just one moment."
        # NO_AGENT or FAILED: no one is free — be honest and close warmly
        # instead of leaving the lead on hold indefinitely.
        self.spawn(_no_agent_close(self._ctx))
        return (
            "I'm sorry, everyone's a little busy right now — "
            "I'll have someone call you back shortly. Thanks for your time today."
        )

    # ── Opt-out rail ───────────────────────────────────────────────────────

    async def close_for_opt_out(self, closing_line: str | None) -> None:
        """Honour a server-side opt-out.

        `POST /engine/calls/:id/transcript` and `POST /engine/calls/:id/dtmf`
        both return `{optOut, closingLine}`, and both have ALREADY written the
        suppression, stamped the compliance event and set `outcome = OPT_OUT`
        before responding. Nothing here can undo that — this method's only job
        is the part the customer experiences: say the line the server chose,
        verbatim, and stop.

        Until this existed, the live path's entire do-not-call handling was one
        sentence in the LLM's prompt asking it politely to end the call. That is
        not a compliance control; a model deciding to qualify one more lead is
        exactly the failure mode the ACMA cares about. The rail is now: server
        detects → server suppresses → worker speaks and hangs up, with the model
        never consulted.
        """
        if self._closing:
            return
        self._closing = True
        # Belt and braces: also latch the transfer flag so an in-flight tool
        # call that lands a millisecond later finds the door shut.
        self._transfer_triggered = True
        line = (closing_line or "").strip() or (
            "Understood — I have removed you from our list. "
            "Sorry to have bothered you. Goodbye."
        )
        logger.warning("opt-out rail fired (call=%s) — closing the call", self._call_id)

        session = self.session_ref
        if session is not None:
            try:
                # Cut whatever the LLM was part-way through saying. Without this
                # the closing line queues behind a half-finished sales question,
                # which is the worst possible sound on an opt-out. `force=True`
                # because the thing in the way may be the transfer hand-off's
                # deliberately uninterruptible comfort audio — an opt-out that
                # arrives mid-transfer still has to win.
                session.interrupt(force=True)
            except Exception as e:  # noqa: BLE001 — nothing here may block the close
                logger.debug("interrupt before opt-out close failed: %s", e)
            try:
                # Verbatim, and uninterruptible — this is the wording the server
                # chose and the transcript will show it was actually spoken.
                # Bounded: the hangup below must happen even if the speech
                # scheduler never gets to us. A customer who is told nothing and
                # then hung up on is bad; a customer who is never hung up on
                # after asking to be removed is worse.
                await asyncio.wait_for(
                    session.say(line, allow_interruptions=False), timeout=15.0
                )
            except Exception as e:  # noqa: BLE001
                logger.warning("failed to speak the opt-out closing line: %s", e)

        # End the customer's leg, not just ours. Dropping only the AI leaves the
        # customer holding a silent line until LiveKit's 10-minute empty-room
        # timeout, immediately after being told goodbye.
        await _drop_customer_leg(self._ctx, self._call_id)
        self._ctx.shutdown(reason="customer opted out")  # sync — not awaitable

    async def handle_engine_response(self, body: dict | None) -> None:
        """Single place that interprets the `{shouldTransfer, optOut, closingLine}`
        envelope both engine rails return, so the transcript path and the DTMF
        path cannot drift into treating an opt-out differently."""
        if not body or self._closing:
            return
        if body.get("optOut"):
            await self.close_for_opt_out(body.get("closingLine"))
            return
        if body.get("shouldTransfer"):
            await self.maybe_auto_transfer(
                "qualification score crossed the campaign's transfer threshold"
            )

    # ── AMD ────────────────────────────────────────────────────────────────

    def report_amd(self, text: str | None) -> None:
        """Classify and report, exactly once per call, fire-and-forget."""
        if self._amd_reported or not self._call_id:
            return
        self._amd_reported = True
        amd_class = _classify_amd(text) if text else "SILENCE"
        started = self.audio_live_at
        latency_ms = int(max(0.0, (time.monotonic() - started)) * 1000) if started else None
        # The API caps latencyMs at 60s; a longer measurement means our zero
        # point was wrong, so send the class alone rather than a 422.
        if latency_ms is not None and latency_ms > 60_000:
            latency_ms = None
        logger.info(
            "AMD %s in %sms (call=%s) first-transcript=%r",
            amd_class, latency_ms if latency_ms is not None else "?", self._call_id, (text or "")[:80],
        )
        self.spawn(_post_amd(self._call_id, amd_class, latency_ms))

    async def amd_silence_watchdog(self) -> None:
        """No transcript at all within `AMD_SILENCE_TIMEOUT_S` of live audio."""
        try:
            await asyncio.sleep(AMD_SILENCE_TIMEOUT_S)
        except asyncio.CancelledError:
            return
        self.report_amd(None)


# ── Engine HTTP ────────────────────────────────────────────────────────────
#
# Every one of these follows the same contract: bounded timeout, `r.ok` (not
# `r.status == 200` — Nest answers POSTs with 201), warn-and-return-None on any
# failure. A worker that raises here would take a live call down with it.


async def _fetch_brief(call_id: str) -> dict | None:
    if not (ENGINE_BASE_URL and ENGINE_SERVICE_TOKEN):
        return None
    url = f"{ENGINE_BASE_URL}/engine/calls/{call_id}/brief"
    headers = {"Authorization": f"Bearer {ENGINE_SERVICE_TOKEN}"}
    try:
        async with aiohttp.ClientSession() as s, s.get(url, headers=headers, timeout=10) as r:
            if r.status == 200:
                return await r.json()
            logger.warning("brief fetch %s -> HTTP %s", call_id, r.status)
    except Exception as e:  # noqa: BLE001 — never let a brief failure kill the call
        logger.warning("brief fetch failed: %s", e)
    return None


async def _post_transcript(call_id: str, speaker: str, text: str) -> dict | None:
    if not (ENGINE_BASE_URL and ENGINE_SERVICE_TOKEN and text.strip()):
        return None
    url = f"{ENGINE_BASE_URL}/engine/calls/{call_id}/transcript"
    headers = {"Authorization": f"Bearer {ENGINE_SERVICE_TOKEN}"}
    try:
        async with aiohttp.ClientSession() as s, s.post(url, headers=headers, json={"speaker": speaker, "text": text}, timeout=10) as r:
            # Nest's default success code for POST is 201, not 200 — checking
            # only for 200 silently discarded every successful response
            # (including a true shouldTransfer=true, and now a true optOut=true)
            # as if it had failed.
            if r.ok:
                return await r.json()
            logger.warning("transcript post %s -> HTTP %s", call_id, r.status)
    except Exception as e:  # noqa: BLE001 — the live summary is a nice-to-have, never worth killing the call
        logger.warning("transcript post failed: %s", e)
    return None


async def _post_dtmf(call_id: str, digit: str) -> dict | None:
    """Forward one keypad symbol. Response shape is `{ok, optOut, closingLine}`
    — identical handling to the spoken rail."""
    if not (ENGINE_BASE_URL and ENGINE_SERVICE_TOKEN):
        return None
    url = f"{ENGINE_BASE_URL}/engine/calls/{call_id}/dtmf"
    headers = {"Authorization": f"Bearer {ENGINE_SERVICE_TOKEN}"}
    try:
        async with aiohttp.ClientSession() as s, s.post(url, headers=headers, json={"digit": digit}, timeout=10) as r:
            if r.ok:
                return await r.json()
            logger.warning("dtmf post %s (%r) -> HTTP %s", call_id, digit, r.status)
    except Exception as e:  # noqa: BLE001
        logger.warning("dtmf post failed: %s", e)
    return None


async def _post_amd(call_id: str, amd_class: str, latency_ms: int | None) -> None:
    if not (ENGINE_BASE_URL and ENGINE_SERVICE_TOKEN):
        return
    url = f"{ENGINE_BASE_URL}/engine/calls/{call_id}/amd"
    headers = {"Authorization": f"Bearer {ENGINE_SERVICE_TOKEN}"}
    payload: dict = {"amdClass": amd_class}
    if latency_ms is not None:
        payload["latencyMs"] = latency_ms
    try:
        async with aiohttp.ClientSession() as s, s.post(url, headers=headers, json=payload, timeout=10) as r:
            if not r.ok:
                logger.warning("amd post %s -> HTTP %s", call_id, r.status)
    except Exception as e:  # noqa: BLE001 — reporting is telemetry; a live call outranks it
        logger.warning("amd post failed: %s", e)


async def _post_transfer(call_id: str, reason: str) -> str:
    if not (ENGINE_BASE_URL and ENGINE_SERVICE_TOKEN):
        return "FAILED"
    url = f"{ENGINE_BASE_URL}/engine/calls/{call_id}/transfer"
    headers = {"Authorization": f"Bearer {ENGINE_SERVICE_TOKEN}"}
    try:
        async with aiohttp.ClientSession() as s, s.post(url, headers=headers, json={"reason": reason}, timeout=30) as r:
            # Same 200-vs-201 mistake as _post_transcript — this was silently
            # turning every real BRIDGED result into a reported "FAILED".
            if r.ok:
                body = await r.json()
                return body.get("result", "FAILED")
            logger.warning("transfer post %s -> HTTP %s", call_id, r.status)
    except Exception as e:  # noqa: BLE001
        logger.warning("transfer post failed: %s", e)
    return "FAILED"


# ── Comfort audio ──────────────────────────────────────────────────────────
#
# Frames are pushed through `session.say(text="", audio=...)`, which bypasses
# TTS entirely and reuses the agent's already-published output track. Doing it
# that way rather than publishing a second track means the SIP mixer sees one
# audio source from us, and `session.interrupt()` / session shutdown still stop
# it the way they stop speech.
#
# `_ParticipantAudioOutput.capture_frame` has no backpressure — it pushes onto
# an unbounded channel — so an unpaced generator would enqueue minutes of audio
# in a burst and the "stop" would arrive minutes late. Hence `_Pacer`.

_FRAME_MS = 20
# Keep this much audio queued ahead of real time: enough to ride out scheduler
# jitter, short enough that stopping is perceptually instant.
_PACER_LEAD_S = 0.4

_COMFORT_TONE_HZ = 425.0  # the AU/EU call-progress tone frequency — familiar, unalarming
_COMFORT_TONE_ON_S = 0.35
_COMFORT_TONE_OFF_S = 2.65
_COMFORT_TONE_AMPLITUDE = 0.10  # deliberately quiet; this is reassurance, not content
_COMFORT_TONE_FADE_S = 0.02  # without a fade the burst edges click on a narrowband codec

_HOLD_MUSIC_MAX_BYTES = 8 * 1024 * 1024


class _Pacer:
    """Releases audio at wall-clock speed, keeping a small lead."""

    def __init__(self) -> None:
        self._t0 = time.monotonic()
        self._queued = 0.0

    async def wait(self, frame_duration: float) -> None:
        self._queued += frame_duration
        ahead = self._queued - (time.monotonic() - self._t0)
        if ahead > _PACER_LEAD_S:
            await asyncio.sleep(ahead - _PACER_LEAD_S)


def _tone_period_pcm(sample_rate: int) -> bytes:
    """One on/off cycle of the comfort tone as 16-bit mono PCM."""
    frame_samples = max(1, sample_rate * _FRAME_MS // 1000)
    on = int(sample_rate * _COMFORT_TONE_ON_S)
    total = int(sample_rate * (_COMFORT_TONE_ON_S + _COMFORT_TONE_OFF_S))
    # Round up to whole frames so the loop can be sliced cleanly and never
    # produces a short trailing frame (which would drift the tone's period).
    total = ((total + frame_samples - 1) // frame_samples) * frame_samples
    fade = max(1, int(sample_rate * _COMFORT_TONE_FADE_S))

    buf = array.array("h", bytes(2 * total))
    for i in range(on):
        envelope = min(1.0, i / fade, (on - i) / fade)
        buf[i] = int(
            32767 * _COMFORT_TONE_AMPLITUDE * envelope
            * math.sin(2 * math.pi * _COMFORT_TONE_HZ * i / sample_rate)
        )
    return buf.tobytes()


async def _fetch_hold_music_pcm(sample_rate: int) -> bytes | None:
    """Download + decode `HOLD_MUSIC_URL` to raw mono PCM at `sample_rate`.

    Done once, at worker start, into memory: a hold-music file is small, and
    decoding it lazily at hand-off time would put a download on the critical
    path of the exact moment we are trying to make gapless. Returns None on any
    problem — the caller falls back to the synthesised tone, which needs no
    network at all.
    """
    if not HOLD_MUSIC_URL:
        return None
    try:
        from livekit.agents.utils.codecs import AudioStreamDecoder

        timeout = aiohttp.ClientTimeout(total=30)
        async with aiohttp.ClientSession(timeout=timeout) as s, s.get(HOLD_MUSIC_URL) as r:
            if not r.ok:
                logger.warning("hold music %s -> HTTP %s; using comfort tone", HOLD_MUSIC_URL, r.status)
                return None
            mime = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower() or None
            body = await r.content.read(_HOLD_MUSIC_MAX_BYTES)

        decoder = AudioStreamDecoder(sample_rate=sample_rate, num_channels=1, format=mime)
        decoder.push(body)
        decoder.end_input()
        chunks: list[bytes] = []
        try:
            async for frame in decoder:
                chunks.append(bytes(frame.data))
        finally:
            await decoder.aclose()

        pcm = b"".join(chunks)
        # Anything under a second loops audibly and sounds broken — worse than
        # the tone it was meant to improve on.
        if len(pcm) < sample_rate * 2:
            logger.warning("hold music decoded to %d bytes — too short to loop; using comfort tone", len(pcm))
            return None
        logger.info("hold music ready: %.1fs of audio at %dHz", len(pcm) / 2 / sample_rate, sample_rate)
        return pcm
    except Exception as e:  # noqa: BLE001 — hold music is a comfort, not a requirement
        logger.warning("hold music prefetch failed (%s); using comfort tone", e)
        return None


async def _comfort_audio(stop: asyncio.Event, sample_rate: int, pcm: bytes | None) -> AsyncIterator[rtc.AudioFrame]:
    """Loop `pcm` (hold music) or a synthesised tone until `stop` is set."""
    loop_pcm = pcm or _tone_period_pcm(sample_rate)
    frame_samples = max(1, sample_rate * _FRAME_MS // 1000)
    frame_bytes = frame_samples * 2
    frame_duration = frame_samples / sample_rate
    pacer = _Pacer()
    offset = 0
    total = len(loop_pcm)
    while not stop.is_set():
        end = offset + frame_bytes
        if end <= total:
            chunk = loop_pcm[offset:end]
            offset = end % total
        else:
            # Wrap, stitching the tail of the buffer to its head so the loop
            # point never emits a short frame (which the room output would
            # happily forward, shifting everything after it by a few samples).
            head = end - total
            chunk = loop_pcm[offset:] + loop_pcm[:head]
            offset = head
        yield rtc.AudioFrame(
            data=chunk,
            sample_rate=sample_rate,
            num_channels=1,
            samples_per_channel=frame_samples,
        )
        await pacer.wait(frame_duration)


# ── Room / participant helpers ─────────────────────────────────────────────


def _is_human_agent(participant: rtc.Participant, me: str) -> bool:
    """True for a CoCally human agent's WebRTC leg.

    Identity conventions come from `telephony/livekit.service.ts`:
      • `lead-<callId>` — the customer's SIP leg (also `PARTICIPANT_KIND_SIP`)
      • `sup-<supervisorId>` — a supervisor. A whispering or barging supervisor
        DOES publish audio, but they are coaching, not taking the call over;
        treating them as the arriving agent would cut the AI off mid-transfer
        and leave the customer with whoever happened to be listening.
      • anything else — the agent (their raw user id).
    """
    if participant.identity == me:
        return False
    if getattr(participant, "kind", None) == rtc.ParticipantKind.PARTICIPANT_KIND_SIP:
        return False
    return not participant.identity.startswith(("lead-", "sup-"))


async def _wait_for_live_audio(ctx: agents.JobContext, timeout: float = 45.0) -> None:
    """Block until the lead has an actual audio track flowing, not just a
    participant object in the room.

    A browser "lead" tab only appears in the room once it has already
    connected and published its mic, so this returns almost instantly there.
    A SIP dial-out is different: `createSipParticipant` can add the SIP
    participant to the room while the phone is still ringing, well before
    anyone picks up. Speaking immediately (the previous behaviour) meant the
    greeting was generated and sent into a call nobody had answered yet —
    lost by the time they actually picked up, which read as dead air followed
    by a mid-conversation greeting or nothing at all.
    """
    participant = await ctx.wait_for_participant()
    for pub in participant.track_publications.values():
        if pub.kind == rtc.TrackKind.KIND_AUDIO and pub.track is not None:
            return

    audio_ready = asyncio.Event()

    def _on_subscribed(track: rtc.Track, *_args: object) -> None:
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            audio_ready.set()

    ctx.room.on("track_subscribed", _on_subscribed)
    try:
        await asyncio.wait_for(audio_ready.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        logger.warning("no live audio track from %s after %.0fs — speaking anyway", participant.identity, timeout)
    finally:
        ctx.room.off("track_subscribed", _on_subscribed)


async def _wait_for_agent_audio(ctx: agents.JobContext, timeout: float = AGENT_AUDIO_TIMEOUT_S) -> bool:
    """The symmetric twin of `_wait_for_live_audio`, at the other end of the call.

    On dial-out we wait for the *customer's* audio before speaking. On hand-off
    we wait for the *agent's* audio before leaving — same failure mode (a
    participant object exists long before media does), same fix. Returns True if
    the agent's audio actually arrived.
    """
    me = ctx.room.local_participant.identity
    for participant in ctx.room.remote_participants.values():
        if not _is_human_agent(participant, me):
            continue
        for pub in participant.track_publications.values():
            if pub.kind == rtc.TrackKind.KIND_AUDIO and pub.track is not None:
                return True

    agent_ready = asyncio.Event()

    def _on_subscribed(track: rtc.Track, _pub: object, participant: rtc.RemoteParticipant) -> None:
        if track.kind == rtc.TrackKind.KIND_AUDIO and _is_human_agent(participant, me):
            logger.info("human agent audio is live: %s", participant.identity)
            agent_ready.set()

    ctx.room.on("track_subscribed", _on_subscribed)
    try:
        await asyncio.wait_for(agent_ready.wait(), timeout=timeout)
        return True
    except asyncio.TimeoutError:
        logger.warning("no human-agent audio after %.0fs — leaving anyway", timeout)
        return False
    finally:
        ctx.room.off("track_subscribed", _on_subscribed)


async def _wait_until_quiet(session: AgentSession | None, grace: float = 4.0, quiet_for: float = 0.3) -> None:
    """Let whatever the agent is currently saying finish.

    `_handoff` is spawned from inside the `request_transfer` tool call, i.e.
    BEFORE the LLM has produced (let alone spoken) its "give me one moment"
    line. Starting uninterruptible comfort audio at that instant would take the
    speech scheduler and swallow the hand-off line entirely.

    "thinking" counts as busy, not quiet: immediately after a tool returns the
    session sits in `thinking` with no `current_speech` for as long as the LLM
    takes, and treating that as silence is precisely the window in which we
    would talk over ourselves.
    """
    if session is None:
        return
    deadline = time.monotonic() + grace
    quiet_since: float | None = None
    while time.monotonic() < deadline:
        busy = session.agent_state in ("thinking", "speaking") or session.current_speech is not None
        if busy:
            quiet_since = None
        elif quiet_since is None:
            quiet_since = time.monotonic()
        elif time.monotonic() - quiet_since >= quiet_for:
            return
        await asyncio.sleep(0.05)


async def _drop_customer_leg(ctx: agents.JobContext, call_id: str | None) -> None:
    """Hang the customer's SIP leg up.

    Best-effort and fully wrapped. Room/identity are derived from the callId the
    same way `LivekitService` derives them (`call-<id>` / `lead-<id>`), so no
    lookup is needed. Removing the SIP participant is also what makes the API's
    `CallProgressService` finalise the call — outcome, retry matrix, CLI health
    — instead of waiting out LiveKit's empty-room timeout.
    """
    if not call_id:
        return
    try:
        from livekit import api

        await ctx.api.room.remove_participant(
            api.RoomParticipantIdentity(room=f"call-{call_id}", identity=f"lead-{call_id}")
        )
        logger.info("customer SIP leg removed (call=%s)", call_id)
    except Exception as e:  # noqa: BLE001 — the API's webhook path is the backstop
        logger.warning("could not remove the customer SIP leg (call=%s): %s", call_id, e)


# ── Session endings ────────────────────────────────────────────────────────


async def _handoff(
    ctx: agents.JobContext,
    session: AgentSession | None,
    hold_music_pcm: bytes | None,
    sample_rate: int,
) -> None:
    """Cover the transfer hand-off with audio instead of silence.

    THE BUG THIS REPLACES: this used to be `await asyncio.sleep(6)`. Six seconds
    of nothing — through the accept window, the transfer cascade, the agent's
    token fetch, their WebRTC handshake and (first time on the page) a browser
    mic-permission prompt. The customer had just been told "give me one moment"
    and then heard dead air; a good share of them concluded the call had dropped
    and hung up before the agent's first word. It was also a blind guess: too
    short and the agent's mic wasn't up yet, too long and the AI sat mute in a
    room the human had already joined.

    The fix has two halves, and both matter:
      1. Never go silent — publish hold music (or a soft periodic tone) for the
         whole gap, so the line audibly stays alive.
      2. Never guess — wait for the agent's audio track to actually appear,
         with a timeout only as a backstop.
    """
    stop = asyncio.Event()
    handle = None

    # Don't step on the "give me just one moment" line we just returned.
    await _wait_until_quiet(session)

    if session is not None:
        try:
            handle = session.say(
                "",
                audio=_comfort_audio(stop, sample_rate, hold_music_pcm),
                allow_interruptions=False,
                add_to_chat_ctx=False,
            )
            logger.info("comfort audio started (%s)", "hold music" if hold_music_pcm else "tone")
        except Exception as e:  # noqa: BLE001 — silence is bad, a crashed worker is worse
            logger.warning("could not start comfort audio: %s", e)

    arrived = await _wait_for_agent_audio(ctx)

    stop.set()
    if handle is not None:
        try:
            await asyncio.wait_for(handle.wait_for_playout(), timeout=3.0)
        except Exception as e:  # noqa: BLE001
            logger.debug("comfort audio did not drain cleanly: %s", e)

    ctx.shutdown(  # sync — not awaitable
        reason="handed off to human agent" if arrived else "handed off (agent audio never appeared)"
    )


async def _no_agent_close(ctx: agents.JobContext) -> None:
    await asyncio.sleep(4)
    ctx.shutdown(reason="no agent available")  # sync — not awaitable


async def entrypoint(ctx: agents.JobContext) -> None:
    await ctx.connect()

    # Real calls carry the CoCally call id in room metadata; demo calls don't.
    call_id = None
    try:
        meta = json.loads(ctx.room.metadata or "{}")
        call_id = meta.get("callId")
    except (ValueError, TypeError):
        pass

    brief = await _fetch_brief(call_id) if call_id else None
    instructions = brief["instructions"] if brief else DEFAULT_INSTRUCTIONS
    first_turn = (
        brief["firstTurnHint"]
        if brief
        else "Greet the person, give the AI + recording disclosure in one sentence, and ask if now is a good moment."
    )
    logger.info("starting agent (call=%s, brief=%s)", call_id, bool(brief))

    session = AgentSession(
        # Groq (OpenAI-compatible endpoint) for low-latency LLM; Deepgram for
        # STT + Aura TTS. llama-3.3-70b-versatile: best quality/latency/
        # tool-calling balance for voice. Swap to "openai/gpt-oss-120b" for
        # higher quality (a bit slower) or "llama-3.1-8b-instant" for the
        # lowest latency. `openai.LLM.with_groq` was removed from the plugin
        # (livekit-agents 1.6.x) — built manually via base_url instead.
        # nova-2-phonecall (not nova-2/nova-3 general) is Deepgram's model
        # tuned for narrowband/noisy telephone audio — the generic model was
        # observed stalling >20s waiting for a clean silence gap that a real
        # phone line's background noise never gave it. utterance_end_ms turns
        # on Deepgram's word-timing-based UtteranceEnd signal as a second,
        # noise-robust path to finalize a turn instead of relying solely on
        # endpointing's raw-silence VAD, which is exactly what stalled.
        stt=deepgram.STT(model="nova-2-phonecall", utterance_end_ms=1000, endpointing_ms=25),
        llm=openai.LLM(
            model="llama-3.3-70b-versatile",
            base_url="https://api.groq.com/openai/v1",
            api_key=os.environ["GROQ_API_KEY"],
        ),
        # Aura-1 (asteria) was tuned for lowest-latency demo speed and reads
        # as fast/clipped on a real call. Deepgram's Aura TTS has no direct
        # speech-rate knob, so "slower" means picking a calmer-cadence Aura-2
        # voice, not a rate parameter. Other options to try: aura-2-hera-en
        # (warm/measured), aura-2-orpheus-en (smooth), aura-2-andromeda-en.
        tts=deepgram.TTS(model="aura-2-luna-en"),
        vad=silero.VAD.load(),
        # Uncompromising-on-latency tuning. The framework already implements
        # the full VAD-barge-in / cancellable-generation / adaptive-backchannel
        # pattern internally (confirmed: "adaptive interruption detector" and
        # "using preemptive generation" already fire per-turn) — these knobs
        # tune it, not reimplement it.
        turn_handling={
            "endpointing": {
                "mode": "dynamic",  # adapts to this caller's pace instead of one fixed wait
                "min_delay": 0.3,  # framework default 0.5s — snappier turn-taking
                "max_delay": 2.0,  # framework default 3.0s — cap worst-case wait
            },
            "interruption": {
                "mode": "adaptive",  # ML backchannel detection ("yeah"/"hmm" won't cut the agent off)
                "min_duration": 0.3,  # framework default 0.5s — stop audio faster on a real interruption
            },
            "preemptive_generation": {
                "enabled": True,  # start the LLM before the turn is even confirmed
                "preemptive_tts": True,  # also start speaking before confirmation — biggest first-audio win
            },
        },
    )

    # Per-turn latency budget: log a warning the moment any stage blows past
    # target so a slow call is visible in the worker log immediately, not
    # discovered later by re-reading a transcript's timestamps by hand.
    LATENCY_BUDGET_S = {"eou": 1.0, "llm_ttft": 1.0, "tts_ttfb": 0.5, "interruption_detect": 0.3}

    @session.on("metrics_collected")
    def _on_metrics(event) -> None:  # noqa: ANN001 — livekit-agents event type
        m = event.metrics
        kind = getattr(m, "type", "")
        if kind == "eou_metrics":
            over = m.end_of_utterance_delay > LATENCY_BUDGET_S["eou"]
            (logger.warning if over else logger.debug)(
                "eou_delay=%.2fs transcription_delay=%.2fs (call=%s)",
                m.end_of_utterance_delay, m.transcription_delay, call_id,
            )
        elif kind == "llm_metrics":
            over = m.ttft > LATENCY_BUDGET_S["llm_ttft"]
            (logger.warning if over else logger.debug)("llm_ttft=%.2fs cancelled=%s (call=%s)", m.ttft, m.cancelled, call_id)
        elif kind == "tts_metrics":
            over = m.ttfb > LATENCY_BUDGET_S["tts_ttfb"]
            (logger.warning if over else logger.debug)("tts_ttfb=%.2fs cancelled=%s (call=%s)", m.ttfb, m.cancelled, call_id)
        elif kind == "interruption_metrics":
            over = m.detection_delay > LATENCY_BUDGET_S["interruption_detect"]
            (logger.warning if over else logger.debug)(
                "interruption_detect=%.2fs backchannels=%d interruptions=%d (call=%s)",
                m.detection_delay, m.num_backchannels, m.num_interruptions, call_id,
            )

    qualifier = Qualifier(instructions=instructions, call_id=call_id, job_ctx=ctx)
    qualifier.session_ref = session

    # Prefetch hold music now, in the background, so the transfer hand-off never
    # waits on a download at the one moment latency is most audible. The room
    # output isn't attached until session.start(), so this uses the framework's
    # documented RoomOutputOptions default (24 kHz mono) — we never override it,
    # and `_handoff` reuses this same number so the music can't drift in pitch.
    qualifier.output_sample_rate = DEFAULT_OUTPUT_SAMPLE_RATE

    async def _prefetch_hold_music() -> None:
        qualifier.hold_music_pcm = await _fetch_hold_music_pcm(qualifier.output_sample_rate)

    qualifier.spawn(_prefetch_hold_music())

    async def _post_and_react(speaker: str, text: str) -> None:
        if qualifier.closing:
            return
        body = await _post_transcript(call_id, speaker, text)
        await qualifier.handle_engine_response(body)

    if call_id:

        @session.on("conversation_item_added")
        def _on_item(event) -> None:  # noqa: ANN001 — livekit-agents event type
            item = event.item
            role = getattr(item, "role", None)
            if role not in ("user", "assistant"):
                return
            text = item.text_content if hasattr(item, "text_content") else None
            if not text:
                return
            speaker = "ai" if role == "assistant" else "customer"
            qualifier.spawn(_post_and_react(speaker, text))

        # AMD from the FIRST transcript we see — interim partials included,
        # which is the whole point (waiting for `conversation_item_added`, i.e.
        # a *finalised* turn, would give up most of the latency advantage over a
        # carrier classifier). `report_amd` latches, so the later partials and
        # the final turn are no-ops.
        @session.on("user_input_transcribed")
        def _on_transcript(event) -> None:  # noqa: ANN001 — livekit-agents event type
            text = (getattr(event, "transcript", "") or "").strip()
            if text:
                qualifier.report_amd(text)

        # ── DTMF ───────────────────────────────────────────────────────────
        # `sip_dtmf_received` is the rtc SDK's SIP keypad event (livekit 1.0.23,
        # `livekit/rtc/room.py`: emitted with a single `SipDTMF(code, digit,
        # participant)`). Every digit is forwarded: the API decides what a digit
        # means (opt-out vs IVR navigation), the worker only reports.
        _DTMF_CODE_TO_DIGIT = {**{i: str(i) for i in range(10)}, 10: "*", 11: "#"}

        async def _forward_dtmf(digit: str) -> None:
            body = await _post_dtmf(call_id, digit)
            # `{ok, optOut, closingLine}` — the same envelope the spoken rail
            # returns, handled by exactly the same code path.
            await qualifier.handle_engine_response(body)

        @ctx.room.on("sip_dtmf_received")
        def _on_dtmf(sip_dtmf) -> None:  # noqa: ANN001 — rtc.SipDTMF
            if qualifier.closing:
                return
            digit = (getattr(sip_dtmf, "digit", "") or "").strip()
            if not digit:
                # Some carriers report only the numeric event code.
                digit = _DTMF_CODE_TO_DIGIT.get(getattr(sip_dtmf, "code", -1), "")
            # The API validates `^[0-9*#]$`; sending anything else is a 400 we
            # can cheaply avoid.
            if len(digit) != 1 or digit not in "0123456789*#":
                logger.warning("ignoring unrecognised DTMF event: %r", sip_dtmf)
                return
            logger.info("DTMF %r (call=%s)", digit, call_id)
            qualifier.spawn(_forward_dtmf(digit))

    await session.start(
        agent=qualifier,
        room=ctx.room,
        room_input_options=RoomInputOptions(),
    )

    # Don't speak until someone can actually hear it — see
    # _wait_for_live_audio's docstring for why this matters most for a real
    # phone dial-out, where the SIP participant can appear before pickup.
    await _wait_for_live_audio(ctx)
    # AMD's zero point: the instant the customer's audio is actually flowing.
    qualifier.audio_live_at = time.monotonic()
    if call_id:
        # Fires only if no transcript at all arrives — `report_amd` latches, so
        # a customer who speaks first turns this into a no-op.
        qualifier.spawn(qualifier.amd_silence_watchdog())

    await session.generate_reply(instructions=first_turn)


if __name__ == "__main__":
    agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint))
