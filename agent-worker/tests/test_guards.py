"""Run: agent-worker/.venv/bin/python agent-worker/tests/test_guards.py"""
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agent  # noqa: E402


def test_human_request_is_detected():
    for said in ["I want to speak to a real person right now.", "Can I talk to a human please", "Put me through to your manager",
                 "Just transfer me to someone", "I'd like a real person", "Let me speak with the supervisor",
                 # 2 Nov negative-scenario call, as transcribed
                 "The Connect to your specialist now.", "Can you connect to the specialist right now?"]:
        assert agent._HUMAN_REQUEST.search(said), said


def test_questions_about_being_human_are_not_requests():
    for said in ["Am I talking to a robot?", "Are you a real person?", "Is this a person?", "Yes, I'm the person who pays it.", "Who is this?"]:
        assert not agent._HUMAN_REQUEST.search(said), said


def _minutes_from_now(iso: str) -> float:
    return (datetime.fromisoformat(iso) - datetime.now(timezone.utc)).total_seconds() / 60


def test_relative_callback_times():
    w = "2026-11-02T12:00:00+11:00"
    for said, mins in [("Call me back in ten minutes, I'm driving.", 10), ("in 20 mins please", 20), ("in half an hour", 30),
                       ("try in an hour", 60), ("in a couple of hours", 120), ("in 2 hours", 120)]:
        got = agent._relative_callback_time(said, w)
        assert got and got.endswith("+11:00"), (said, got)
        assert abs(_minutes_from_now(got) - mins) < 1, (said, got)


def test_absolute_times_are_left_to_the_model():
    for said in ["Tomorrow after 5 pm.", "Monday morning", "at 3"]:
        assert agent._relative_callback_time(said, "2026-11-03T17:00:00+11:00") is None, said


def test_stalled_first_word_is_retried():
    import asyncio
    from livekit.agents import Agent
    from livekit.agents.llm import ChatChunk, ChoiceDelta

    calls = {"n": 0}

    async def fake_llm_node(self, chat_ctx, tools, model_settings):
        calls["n"] += 1
        if calls["n"] == 1:
            await asyncio.sleep(5)  # hung request
        yield ChatChunk(id="b", delta=ChoiceDelta(role="assistant", content="Hello there."))

    orig, agent.LLM_FIRST_WORD_DEADLINE_S = agent.LLM_FIRST_WORD_DEADLINE_S, 0.3
    saved = Agent.default.llm_node
    Agent.default.llm_node = fake_llm_node

    class Ctx:
        def shutdown(self, reason=""): pass

    async def go():
        q = agent.Qualifier(instructions="x", call_id=None, job_ctx=Ctx())
        t0 = asyncio.get_event_loop().time()
        out = [c async for c in q.llm_node(None, [], None)]
        return "".join(c.delta.content for c in out if hasattr(c, "delta") and c.delta and c.delta.content), asyncio.get_event_loop().time() - t0

    try:
        text, took = asyncio.run(go())
    finally:
        Agent.default.llm_node = saved
        agent.LLM_FIRST_WORD_DEADLINE_S = orig
    assert calls["n"] == 2 and text == "Hello there." and took < 1.0, (calls, text, took)


def test_voice_gain_is_louder_and_never_clips():
    import numpy as np
    from livekit import rtc

    pcm = (np.sin(np.linspace(0, 200, 2400)) * 12000).astype(np.int16)
    out = agent._apply_gain(rtc.AudioFrame(pcm.tobytes(), 24000, 1, 2400), 4.0)
    y = np.frombuffer(out.data, dtype=np.int16)
    assert len(y) == 2400 and out.sample_rate == 24000
    assert abs(np.abs(y).max() / np.abs(pcm).max() - 10 ** (4 / 20)) < 0.02  # quiet audio: exactly +4 dB
    loud = (np.sin(np.linspace(0, 200, 2400)) * 32000).astype(np.int16)
    z = np.frombuffer(agent._apply_gain(rtc.AudioFrame(loud.tobytes(), 24000, 1, 2400), 4.0).data, dtype=np.int16)
    assert np.abs(z).max() < 32767  # loud peaks are rounded off, no hard clipping
    assert np.abs(z).max() > np.abs(loud).max() * 0.9


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
            print("PASS", n)


def test_other_voice_vendors_get_a_deepgram_backup():
    # Deepgram alone stays as it is; anything else must not leave a call silent.
    os.environ.setdefault("DEEPGRAM_API_KEY", "x")
    dg = agent.deepgram.TTS(model="aura-2-aries-en", api_key="x")
    assert agent._with_tts_fallback(dg) is dg
    from livekit.plugins import cartesia

    wrapped = agent._with_tts_fallback(cartesia.TTS(model="sonic-3.6", api_key="x", emotion="excited"))
    assert isinstance(wrapped, agent._tts.FallbackAdapter)
    assert isinstance(wrapped._tts_instances[1], agent.deepgram.TTS)


def test_cartesia_socket_swap_hands_out_the_fast_one():
    import asyncio

    os.environ.setdefault("CARTESIA_API_KEY", "x")
    agent.TTS_PROVIDER = "cartesia"
    closed = []
    try:
        tts = agent._build_tts()
    finally:
        agent.TTS_PROVIDER = "deepgram"
    pool = tts._pool

    async def close(ws):
        closed.append(ws)

    async def scenario(idle):
        pool._close_cb = close
        pool._connections["slow"] = __import__("time").time()
        if idle:
            pool._available.add("slow")
        tts._swap_socket("slow", "fast")
        got = await pool.get(timeout=1)
        if not idle:
            pool.put("slow")  # the sentence on the slow socket ends
        pool.put(got)
        return got, await pool.get(timeout=1)

    # Idle: the next sentence uses the fast socket and the slow one gets closed.
    assert asyncio.run(scenario(True)) == ("fast", "fast")
    assert closed == ["slow"]
    # Mid-sentence: the slow socket stays usable, then is closed when returned.
    pool._available.clear()
    pool._connections.clear()
    closed.clear()
    assert asyncio.run(scenario(False)) == ("fast", "fast")
    assert closed == ["slow"]


def test_voicemail_words_overturn_an_early_human_verdict():
    for greeting in [
        "Hello. You've reached zero four zero nine one two",  # 4 Nov call, verbatim
        "Please leave a message.",
        "Hi. Sorry I missed your call. Please leave a text message, and I will get back to you.",  # 4 Nov, verbatim
        "Leave your name and number after the tone",
        "The Telstra mobile you have called is switched off or not answering",
        "The person you are calling can't take your call right now",
    ]:
        assert agent._amd_revises_human(greeting, 5.0), greeting


def test_real_people_are_never_taken_for_a_mailbox():
    for said in [
        "Hello.", "Yes, I am.", "He's not available.", "She isn't available right now",
        "Who is this?", "How did you get my number?", "I'm with AGL.", "Sorry, you've got the wrong person",
        "I don't want to leave my details", "Sorry I missed your call earlier", "He can't come to the phone", "I'll get back to you", "Not interested, take me off your list",
    ]:
        assert not agent._amd_revises_human(said, 5.0), said


def test_voicemail_revision_only_applies_early_in_the_call():
    assert not agent._amd_revises_human("Can I leave a message for the specialist?", 90.0)
    assert not agent._amd_revises_human("You've reached the right person", None)


def test_later_words_revise_human_to_voicemail_once():
    q = agent.Qualifier.__new__(agent.Qualifier)
    q._call_id, q._amd_reported, q._amd_class, q.audio_live_at = "c", False, None, agent.time.monotonic()
    spawned = []
    q.spawn = lambda coro: (spawned.append(coro), coro.close())
    q.report_amd("Hello.")
    assert q._amd_class == "HUMAN"
    q.report_amd("Still just talking")
    assert q._amd_class == "HUMAN" and len(spawned) == 1
    q.report_amd("Hello. You've reached zero four zero nine")
    assert q._amd_class == "VOICEMAIL" and len(spawned) == 2
    q.report_amd("Please leave a message.")
    assert q._amd_class == "VOICEMAIL" and len(spawned) == 2


def _dead_air_run(script):
    """Runs a watch with short timers; `script(watch)` plays the call. Returns what it did."""
    import asyncio

    did = []
    stopped = {"v": False}

    async def hang_up():
        did.append("hang_up")

    async def go():
        w = agent._DeadAirWatch(lambda: did.append("reprompt"), hang_up, lambda: stopped["v"], 0.02, 0.02)
        await script(w, stopped)
        w.cancel()

    asyncio.run(go())
    return did


def test_dead_air_asks_once_then_cuts_the_call():
    import asyncio

    async def silent_line(w, _):
        w.arm()
        await asyncio.sleep(0.04)  # the re-check plays, the AI goes back to listening
        w.arm()
        await asyncio.sleep(0.04)

    assert _dead_air_run(silent_line) == ["reprompt", "hang_up"]


def test_dead_air_customer_speech_starts_it_over():
    import asyncio

    async def answers_the_check(w, _):
        w.arm()
        await asyncio.sleep(0.04)
        w.customer_spoke()  # "yes, sorry, I'm here"
        w.arm()
        await asyncio.sleep(0.01)
        w.customer_spoke()
        await asyncio.sleep(0.04)

    assert _dead_air_run(answers_the_check) == ["reprompt"]


def test_dead_air_stays_out_of_transfers_and_closing():
    import asyncio

    async def on_hold(w, stopped):
        w.arm()
        stopped["v"] = True  # a transfer or closing line started
        await asyncio.sleep(0.04)
        w.arm()
        await asyncio.sleep(0.04)

    assert _dead_air_run(on_hold) == []
