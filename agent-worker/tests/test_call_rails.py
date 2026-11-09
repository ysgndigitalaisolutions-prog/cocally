"""The 9 Nov fixes, played through the real turn handler.

Run: agent-worker/.venv/bin/python agent-worker/tests/test_call_rails.py
"""
import asyncio
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np  # noqa: E402
from livekit import rtc  # noqa: E402
from livekit.agents import StopResponse  # noqa: E402

import agent  # noqa: E402

LINES = {
    "S1": "I'm calling about your electricity bill. Are you the account holder?",
    "S1Q": "Are you the account holder?",
    "S2": "Energy prices have gone up a lot, so we're doing a quick survey to help lower your bills! Do you have electricity only, or gas as well?",
    "S2Q": "Do you have electricity only, or gas as well?",
    "S4": "Thanks! There may be a better offer for you! Which energy company are you with now?",
    "S4Q": "Which energy company are you with now?",
    "Q1": "I'm calling from Australian Deal, an energy broker.",
    "Q6": "No problem. What would be a convenient time for us to call you back?",
    "Q7": "Good question. Our specialist can explain that in detail.",
    "E1": "No worries. Thank you for your time. Have a great day!",
}
OPENING = "Hi, it's Emma from Australian Deal. How are you doing today?"


class Session:
    user_state = "listening"

    def __init__(self):
        self.said = []

    def say(self, text, **_):
        self.said.append(text)
        fut = asyncio.get_event_loop().create_future()
        fut.set_result(None)
        return fut

    def interrupt(self, force=False):
        pass


class Ctx:
    def __init__(self):
        self.ended = []

    def shutdown(self, reason=""):
        self.ended.append(reason)


def _make(said_so_far=(OPENING,)):
    ctx = Ctx()
    q = agent.Qualifier(instructions="x", call_id=None, job_ctx=ctx)
    q.session_ref = Session()
    q.script_lines = dict(LINES)
    q.client_name = "Australian Deal"
    q.opening_line = OPENING
    q.greeting_started = True
    q.greeting_started_at = None
    q._first_turn_done = True
    for line in said_so_far:
        q._chat_ctx.add_message(role="assistant", content=line)
    return q, ctx


async def _turn(q, text):
    """One customer turn. True if the code handled it, False if the model gets it."""
    try:
        await q.on_user_turn_completed(q._chat_ctx, SimpleNamespace(text_content=text))
    except StopResponse:
        for _ in range(5):
            await asyncio.sleep(0)
        return True
    return False


def _run(text, said=(OPENING,)):
    async def go():
        q, ctx = _make(said)
        q._drop = []
        orig = agent._drop_customer_leg
        agent._drop_customer_leg = lambda *a, **k: asyncio.sleep(0)
        try:
            handled = await _turn(q, text)
            await asyncio.sleep(0.7)  # closing lines wait a beat before the hang-up
        finally:
            agent._drop_customer_leg = orig
        return q, ctx, handled

    return asyncio.run(go())


def test_tar_yu_is_opted_out_not_read_the_next_line():
    q, ctx, handled = _run("Good. But I don't want you ringing me up.")
    assert handled and q.closing and ctx.ended == ["customer opted out"], (handled, ctx.ended)
    assert "account holder" not in " ".join(q.session_ref.said)


def test_every_way_of_saying_stop():
    for said in ["Don't call me again.", "Stop calling me", "I don't want anyone to call me", "take me off your list", "Stop bothering me.",
                 "Just leave me alone", "lose my number", "My number is on the DNC register", "I'll make a complaint"]:
        assert agent._OPT_OUT_REQUEST.search(said), said
    for said in ["I'm not interested.", "Call me back later.", "Yes, that is me.", "Sorry, who is this?", "I don't want it.", "About 300 a quarter"]:
        assert not agent._OPT_OUT_REQUEST.search(said), said


def test_their_goodbye_gets_the_script_goodbye():
    q, ctx, handled = _run("Goodbye.", (OPENING, LINES["S1"]))
    assert handled and q.session_ref.said == [LINES["E1"]] and ctx.ended, (q.session_ref.said, ctx.ended)
    for said in ["Bye.", "Okay, bye bye.", "Thanks, bye.", "Bye for now.", "No thanks, goodbye", "see ya mate"]:
        assert agent._CUSTOMER_GOODBYE.match(said), said
    for said in ["Goodbye to my old plan.", "What do you say then?", "Say bye to who?"]:
        assert not agent._CUSTOMER_GOODBYE.match(said), said


def test_are_you_an_ai_gets_the_truth():
    q, _, handled = _run("Are you an AI?")
    assert handled and q.session_ref.said == [
        "Yes, I'm an AI assistant calling for Australian Deal. I can connect you with one of our specialists. Are you the account holder?"
    ], q.session_ref.said
    # Later in the script, it goes back to the question they were on.
    q, _, _ = _run("Hang on, is this a robot?", (OPENING, LINES["S1"], LINES["S2"]))
    assert q.session_ref.said[0].endswith(LINES["S2Q"]) and q.session_ref.said[0].startswith("Yes, I'm an AI"), q.session_ref.said
    for said in ["Are you a real person?", "Am I talking to a robot?", "Are you a bot", "Is this a recording?", "You sound like a robot.", "are you human", "Are you real?",
                 "Is this an AI?", "Am I speaking with a real person?", "Are you a computer?", "Is this automated?"]:
        assert agent._AI_QUESTION.search(said), said
    for said in ["Are you the person who called?", "Is this the hotel?", "Who is this?", "Are you with AGL?", "Is this real?", "Yes, I'm the person who pays it.", "How are you?", "Are you from Melbourne?"]:
        assert not agent._AI_QUESTION.search(said), said


def test_wanting_a_person_is_handed_over():
    calls = []

    async def fake(self, reason, line=None):
        calls.append(line)

    orig = agent.Qualifier._do_transfer
    agent.Qualifier._do_transfer = fake
    try:
        _, _, handled = _run("I don't want to talk to a robot.")
        _, _, handled2 = _run("Can I speak to a real person")
    finally:
        agent.Qualifier._do_transfer = orig
    assert handled and handled2 and calls == [agent.PERSON_LINE, agent.PERSON_LINE], calls


def test_stuart_gate_keeps_the_greeting_for_the_person():
    async def go():
        q, _ = _make(())
        q.gate_presses = 1
        q.awaiting_connect = True
        assert await _turn(q, "Thanks, Emma.")
        assert await _turn(q, "Please stay on the line.")
        assert q.awaiting_connect and q.session_ref.said == [] and not q.customer_spoke
        q._gate_timeout.cancel()
        assert await _turn(q, "Hello?")
        assert q.session_ref.said == [OPENING] and not q.awaiting_connect
        return True

    assert asyncio.run(go())


def test_hello_after_a_gate_gets_the_introduction_even_after_step_one():
    async def go():
        q, _ = _make((OPENING, LINES["S1"]))
        q.gate_presses = 1
        assert await _turn(q, "Hello?")
        assert q.session_ref.said == [OPENING]
        # No gate: an ordinary "hello?" mid-script stays the model's.
        q2, _ = _make((OPENING, LINES["S1"]))
        assert not await _turn(q2, "Hello?")
        return True

    assert asyncio.run(go())


async def _say_reply(q, chunks):
    async def stream():
        for c in chunks:
            yield c

    out = [c async for c in agent._expand_tag_stream(stream(), q.script_lines, frozenset(q.blocked_tags), q._steps_asked(), {}, q._guard_own_words)]
    return " ".join("".join(out).split())


def test_made_up_lines_never_reach_the_customer():
    async def go():
        q, _ = _make((OPENING, LINES["S1"]))
        q.last_user_text = "What do you say then?"
        out = await _say_reply(q, ["You just ended the call on me, I didn't say goodbye. ", "What do you say?"])
        assert out == f"{LINES['Q7']} {LINES['S1Q']}", out
        assert q._blocked_lines == 1
        # Promises and facts of its own are stopped the same way.
        q.last_user_text = "Okay"
        out = await _say_reply(q, ["We can save you 30 percent on your bill today."])
        assert out == LINES["S1Q"], out
        # Third strike: the script's goodbye, not a loop.
        out = await _say_reply(q, ["Let me tell you about our plans."])
        assert out == LINES["E1"], out
        return True

    assert asyncio.run(go())


def test_script_tags_and_warm_reactions_still_speak():
    async def go():
        q, _ = _make((OPENING,))
        assert await _say_reply(q, ["[S1]"]) == LINES["S1"]
        assert await _say_reply(q, ["I'm doing well, thanks for asking! ", "[S1]"]) == f"I'm doing well, thanks for asking! {LINES['S1']}"
        assert await _say_reply(q, ["You just ended the call on me. ", "[S1]"]) == LINES["S1"]
        assert await _say_reply(q, ["We save you 30 percent! ", "[S1]"]) == LINES["S1"]
        assert await _say_reply(q, [LINES["S1Q"]]) in (LINES["S1"], LINES["S1Q"])  # written out, not tagged
        assert q._blocked_lines == 0
        # A booked callback is confirmed in the model's own words.
        q.blocked_tags.add("Q6")
        assert await _say_reply(q, ["Great, we'll call you Monday at 5. Goodbye."]) == "Great, we'll call you Monday at 5. Goodbye."
        return True

    assert asyncio.run(go())


def _tone(hz, sr=24000, seconds=1.0, amp=6000):
    t = np.arange(int(sr * seconds)) / sr
    return (np.sin(2 * np.pi * hz * t) * amp).astype(np.int16)


def _through(pcm, sr=24000, chunk=480):
    shaper = agent._VoiceShaper()
    out = []
    for i in range(0, len(pcm) - chunk + 1, chunk):
        f = shaper.shape(rtc.AudioFrame(pcm[i:i + chunk].tobytes(), sr, 1, chunk))
        assert f.samples_per_channel == chunk and f.sample_rate == sr
        out.append(np.frombuffer(f.data, dtype=np.int16))
    return np.concatenate(out)


def _gain_db(hz):
    pcm, gain = _tone(hz), agent.TTS_GAIN_DB
    agent.TTS_GAIN_DB = 0
    try:
        y = _through(pcm)
    finally:
        agent.TTS_GAIN_DB = gain
    rms = lambda a: float(np.sqrt(np.mean(a[4800:].astype(np.float64) ** 2)))
    return 20 * np.log10(rms(y) / rms(pcm[: len(y)]))


def test_clarity_cuts_rumble_and_lifts_speech():
    got = {hz: round(_gain_db(hz), 1) for hz in (100, 200, 400, 1000, 2200, 3400)}
    print("   response dB", got)
    assert got[100] < -8, got
    assert -6 < got[200] < 0, got
    assert got[2200] > 4, got
    assert got[3400] > 2, got
    assert got[1000] > 1.5, got


def test_clarity_has_no_clicks_at_frame_edges():
    # The same tone in one big frame and in small frames must come out the same.
    pcm = _tone(1000, amp=4000)
    y_small = _through(pcm, chunk=240)
    y_big = _through(pcm, chunk=len(pcm))
    n = min(len(y_small), len(y_big))
    assert np.abs(y_small[:n].astype(int) - y_big[:n].astype(int)).max() <= 2


def test_clarity_is_cheap():
    import time

    shaper = agent._VoiceShaper()
    frame = rtc.AudioFrame(_tone(1000, seconds=0.1).tobytes(), 24000, 1, 2400)
    t0 = time.perf_counter()
    for _ in range(50):
        shaper.shape(frame)
    each = (time.perf_counter() - t0) / 50 * 1000
    print(f"   {each:.2f} ms per 100 ms of speech")
    assert each < 10


def test_voicemail_wording_of_9_nov():
    for said in ["Hi. You've called West My Long Signs.", "Hi. It's Christina Dodo. I'm not available at the moment.", "I'll get back to you as soon as I can.",
                 "I'm just on another call. I'll get right back to you.", "Just try sending a text.", "Please try again later.", "David, I've missed your call."]:
        assert agent._amd_revises_human(said, 5.0), said
    for said in ["Hello?", "You've called the wrong number.", "Good. Thanks. How are you?", "He's not available.", "I'm busy.", "Are you an AI?"]:
        assert not agent._amd_revises_human(said, 5.0), said


if __name__ == "__main__":
    failed = 0
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            try:
                f()
                print("PASS", n)
            except Exception as e:  # noqa: BLE001
                failed += 1
                print("FAIL", n, repr(e)[:400])
    sys.exit(1 if failed else 0)
