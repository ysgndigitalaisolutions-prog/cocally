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
