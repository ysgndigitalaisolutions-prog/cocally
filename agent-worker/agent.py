"""
CoCally — LiveKit Agents voice worker.

Holds a real spoken conversation in a LiveKit room (streaming STT -> LLM -> TTS
with barge-in). Providers match the CoCally stack: Deepgram (STT + Aura TTS) and
Google Gemini (LLM). No ElevenLabs / OpenAI needed.

Two ways it runs:
  • Demo (no phone): talk to it from https://agents-playground.livekit.io.
  • Real call: the CoCally API dials a lead via LiveKit SIP + Twilio and passes
    the call id in the room metadata; the worker fetches the authoritative brief
    (prompt + disclosure + rebuttals) from the API so conversation content lives
    in one place. See claude-dev/2026-07-19-live-call-build-plan.md.

Run:
    pip install -r requirements.txt
    cp .env.example .env    # fill LiveKit + DEEPGRAM_API_KEY + GOOGLE_API_KEY
    python agent.py dev
"""
from __future__ import annotations

import asyncio
import json
import logging
import os

import aiohttp
from dotenv import load_dotenv
from livekit import agents, rtc
from livekit.agents import Agent, AgentSession, RoomInputOptions, function_tool
from livekit.plugins import deepgram, openai, silero

load_dotenv()
logger = logging.getLogger("cocally-agent")

ENGINE_BASE_URL = os.getenv("ENGINE_BASE_URL")
ENGINE_SERVICE_TOKEN = os.getenv("ENGINE_SERVICE_TOKEN")

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


class Qualifier(Agent):
    def __init__(self, instructions: str, call_id: str | None, job_ctx: agents.JobContext) -> None:
        super().__init__(instructions=instructions)
        self._call_id = call_id
        self._ctx = job_ctx
        # Set once session.start() returns; lets the score-triggered auto-transfer
        # (not an LLM tool call) actually speak its handoff line.
        self.session_ref: AgentSession | None = None
        self._transfer_triggered = False

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
        if self._transfer_triggered:
            return
        logger.info("auto-transfer triggered (call=%s): %s", self._call_id, reason)
        text = await self._do_transfer(reason)
        if self.session_ref is not None:
            await self.session_ref.say(text)

    async def _do_transfer(self, reason: str) -> str:
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
            asyncio.create_task(_handoff(self._ctx))
            return "Great, give me just one moment."
        # NO_AGENT or FAILED: no one is free — be honest and close warmly
        # instead of leaving the lead on hold indefinitely.
        asyncio.create_task(_no_agent_close(self._ctx))
        return (
            "I'm sorry, everyone's a little busy right now — "
            "I'll have someone call you back shortly. Thanks for your time today."
        )


async def _handoff(ctx: agents.JobContext) -> None:
    # Gives the human's browser time to fetch a token, complete the LiveKit
    # WebRTC handshake, and grant mic permission (which can itself take a
    # few seconds if this is the agent's first time on the page) before the
    # AI leaves — 3s cut it too close and could leave the lead with a gap
    # of silence between the AI disconnecting and the agent's mic coming up.
    await asyncio.sleep(6)
    ctx.shutdown(reason="handed off to human agent")  # sync — not awaitable


async def _no_agent_close(ctx: agents.JobContext) -> None:
    await asyncio.sleep(4)
    ctx.shutdown(reason="no agent available")  # sync — not awaitable


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
            # (including a true shouldTransfer=true) as if it had failed.
            if r.ok:
                return await r.json()
            logger.warning("transcript post %s -> HTTP %s", call_id, r.status)
    except Exception as e:  # noqa: BLE001 — the live summary is a nice-to-have, never worth killing the call
        logger.warning("transcript post failed: %s", e)
    return None


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

    async def _post_and_maybe_transfer(speaker: str, text: str) -> None:
        result = await _post_transcript(call_id, speaker, text)
        if result and result.get("shouldTransfer"):
            await qualifier.maybe_auto_transfer("qualification score crossed the campaign's transfer threshold")

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
            asyncio.create_task(_post_and_maybe_transfer(speaker, text))

    await session.start(
        agent=qualifier,
        room=ctx.room,
        room_input_options=RoomInputOptions(),
    )

    # Don't speak until someone can actually hear it — see
    # _wait_for_live_audio's docstring for why this matters most for a real
    # phone dial-out, where the SIP participant can appear before pickup.
    await _wait_for_live_audio(ctx)
    await session.generate_reply(instructions=first_turn)


if __name__ == "__main__":
    agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint))
