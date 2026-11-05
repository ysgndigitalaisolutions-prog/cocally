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
        "To voicemail. The person you're trying to reach is not available.",  # 4 Nov, verbatim
    ]:
        assert agent._amd_revises_human(greeting, 5.0), greeting


def test_real_people_are_never_taken_for_a_mailbox():
    for said in [
        "Hello.", "Yes, I am.", "He's not available.", "She isn't available right now",
        "Who is this?", "How did you get my number?", "I'm with AGL.", "Sorry, you've got the wrong person",
        "I don't want to leave my details", "Sorry I missed your call earlier", "Who's the person you're calling?", "Is this the number you called?", "He can't come to the phone", "I'll get back to you", "Not interested, take me off your list",
    ]:
        assert not agent._amd_revises_human(said, 5.0), said


def test_voicemail_revision_only_applies_early_in_the_call():
    assert not agent._amd_revises_human("Can I leave a message for the specialist?", 90.0)
    assert not agent._amd_revises_human("You've reached the right person", None)


def test_later_words_revise_human_to_voicemail_once():
    q = agent.Qualifier.__new__(agent.Qualifier)
    q.awaiting_connect = False
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


def test_entrypoint_builds_nothing_from_qualifier_before_it_exists():
    # 4 Nov: `hang_up=qualifier.hang_up_on_silence` ran before `qualifier = ...`
    # and every call crashed at pick-up. Handlers and lambdas run later and are fine.
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(agent))
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == "entrypoint")
    assigned = min(
        n.lineno for n in ast.walk(fn)
        if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "qualifier" for t in n.targets)
    )
    deferred = set()
    for n in ast.walk(fn):
        if isinstance(n, (ast.Lambda, ast.FunctionDef, ast.AsyncFunctionDef)) and n is not fn:
            deferred.update(id(c) for c in ast.walk(n))
    early = [
        n.lineno for n in ast.walk(fn)
        if isinstance(n, ast.Name) and n.id == "qualifier" and isinstance(n.ctx, ast.Load)
        and n.lineno < assigned and id(n) not in deferred
    ]
    assert not early, f"qualifier read before it is assigned, lines {early}"


def test_dead_air_hang_up_survives_the_goodbye_cancelling_the_timer():
    # 5 Nov: the goodbye made the agent "speaking", which cancelled the watch's
    # task, which was the task running the hang-up. The line stayed open.
    import asyncio

    done = []

    async def go():
        async def hang_up():
            await asyncio.sleep(0.02)  # the goodbye playing
            done.append("line dropped")

        w = agent._DeadAirWatch(lambda: None, hang_up, lambda: False, 0.01, 0.01)
        w.arm()
        await asyncio.sleep(0.02)  # re-check asked
        w.arm()
        await asyncio.sleep(0.02)  # hang-up has started, goodbye playing
        w.cancel()  # what agent_state_changed -> speaking does
        await asyncio.sleep(0.05)

    asyncio.run(go())
    assert done == ["line dropped"]


def test_connect_gate_digit_is_read_from_the_prompt():
    for said, digit in [
        ("To connect your call, press two.", "2"),
        ("to connect your call press 5", "5"),
        ("To connect your call, press zero.", "0"),
        ("press seven.", "7"),  # all that survives with the filter on, 5 Nov
        ("your call, press nine", "9"),
    ]:
        assert agent._gate_digit(said) == digit, said
    for said in [
        "To connect your call", "To connect your call, press", "Press two for sales", "Hello?",
        "I think you told me I should go and press two",
    ]:
        assert agent._gate_digit(said) is None, said


def _gate_qualifier(monkey_ctx):
    q = agent.Qualifier.__new__(agent.Qualifier)
    q._call_id, q._ctx, q.session_ref = None, monkey_ctx, None
    q._closing = q._transfer_triggered = q.awaiting_connect = q.heard_speech = False
    q._amd_reported, q._amd_class = True, "HUMAN"
    q.gate_presses, q._gate_timeout, q.audio_live_at = 0, None, 0.0
    q._gate_last_press, q.customer_spoke = (None, 0.0), False
    q.opening_line = "Hello, how are you doing today?"
    return q


def test_gate_press_sends_the_digit_and_waits_for_the_handset():
    import asyncio
    from types import SimpleNamespace

    sent = []

    async def dtmf(code, digit):
        sent.append((code, digit))

    ctx = SimpleNamespace(room=SimpleNamespace(local_participant=SimpleNamespace(publish_dtmf=dtmf)))

    async def go():
        q = _gate_qualifier(ctx)
        await q.press_gate("2")
        assert q.awaiting_connect and not q._amd_reported and q._amd_class is None
        await q.press_gate("2")  # the final of the same prompt: not pressed twice
        assert len(sent) == 1
        for d in "7890":
            await q.press_gate(d)  # the gate re-prompts with new digits: capped
        q._gate_timeout.cancel()
        return q

    q = asyncio.run(go())
    assert sent[0] == (2, "2") and len(sent) == agent.GATE_MAX_PRESSES and q.gate_presses == agent.GATE_MAX_PRESSES


def test_gate_is_ignored_once_a_person_has_spoken():
    import asyncio
    from types import SimpleNamespace

    sent = []

    async def dtmf(code, digit):
        sent.append(digit)

    q = _gate_qualifier(SimpleNamespace(room=SimpleNamespace(local_participant=SimpleNamespace(publish_dtmf=dtmf))))
    q.customer_spoke = True
    asyncio.run(q.press_gate("2"))
    assert sent == [] and not q.awaiting_connect


def test_machine_recordings_overturn_human():
    assert agent._amd_revises_human("As this mobile phone is not monitored, can you call us", 5.0)
    assert agent._amd_revises_human("Thank you for getting in touch with Solar Boat.", 5.0)


def _after_press(seconds_ago=0.0):
    import time

    q = _gate_qualifier(None)
    q._call_id, q.awaiting_connect, q._handset_live = "c1", True, False
    q._amd_reported, q._amd_class = False, None
    q.audio_live_at = time.monotonic() - seconds_ago
    q.spawn = lambda coro: coro.close()
    return q


def test_quiet_after_the_gate_press_is_not_silence():
    # 5 Nov: SILENCE fired 5 s after "press four" and cut a line still connecting.
    q = _after_press()
    q.report_amd(None)
    assert not q._amd_reported and q._amd_class is None


def test_voicemail_after_the_gate_is_timed_from_its_first_word():
    # 5 Nov: the mailbox line came 21.7 s after the press, past the 20 s window,
    # so the AI greeted the voicemail.
    q = _after_press(seconds_ago=20.0)
    q.report_amd("Your call has")
    assert q._amd_class == "HUMAN"
    q.report_amd("Your call has been forwarded to voicemail.")
    assert q._amd_class == "VOICEMAIL"


def test_more_machine_wording_overturns_human():
    assert agent._amd_revises_human("No message can be left on this service.", 2.0)
    assert agent._amd_revises_human("You have finished recording, you may hang up.", 2.0)
    assert agent._amd_revises_human("Just leave your number, and I can ring you back.", 2.0)
    assert agent._amd_revises_human("Hello. I'm not able to get to the phone at the moment.", 2.0)


def test_worker_capacity_counts_calls_not_cpu():
    from types import SimpleNamespace

    five = SimpleNamespace(active_jobs=[object()] * 5)
    assert agent._calls_load(five) < 1.0  # a fifth call in progress: still takes a sixth
    six = SimpleNamespace(active_jobs=[object()] * agent.WORKER_MAX_CALLS)
    assert agent._calls_load(six) >= 1.0


def _objection_qualifier():
    q = agent.Qualifier.__new__(agent.Qualifier)
    q.script_lines = {"Q4": "I understand.", "Q6": "When can we call you back?", "E1": "No worries."}
    q.blocked_tags = set()
    q._closing = q._transfer_triggered = q._objection_pending = False
    q._objection_stage = 0
    return q


def test_bill_objection_goes_rebuttal_callback_goodbye():
    q = _objection_qualifier()
    assert q.next_objection_tag("No. My electricity bill is fine.") == "Q4"
    assert q.next_objection_tag("No, I'm fine.") == "Q6"
    assert q.next_objection_tag("No, no need to call back.") == "E1"


def test_fine_after_how_are_you_is_not_an_objection():
    q = _objection_qualifier()
    for said in ("I'm fine.", "Good thanks, how are you?", "No, that's my husband.", "Yes, that's me."):
        assert q.next_objection_tag(said) is None
    assert q._objection_stage == 0


def test_agreeing_or_a_time_goes_to_the_model():
    q = _objection_qualifier()
    assert q.next_objection_tag("I'm happy with my current offer.") == "Q4"
    assert q.next_objection_tag("Okay then, go on.") is None
    q = _objection_qualifier()
    q.next_objection_tag("Not interested.")
    assert q.next_objection_tag("No, I'm fine.") == "Q6"
    assert q.next_objection_tag("Tomorrow after 5 pm.") is None
    assert q.next_objection_tag("Tomorrow is fine.") is None


def test_opt_out_wording_is_never_given_a_rebuttal():
    q = _objection_qualifier()
    assert q.next_objection_tag("I'm not interested, don't call me again.") is None
    assert q.next_objection_tag("Not interested in any calls.") is None
    assert q._objection_stage == 0


def test_objection_lines_are_spoken_and_the_goodbye_ends_the_call(monkeypatch=None):
    import asyncio

    said, dropped, ended = [], [], []

    class _Session:
        def say(self, line, **kw):
            said.append(line)
            fut = asyncio.get_running_loop().create_future()
            fut.set_result(None)
            return fut

    async def drop(ctx, call_id):
        dropped.append(call_id)

    real_drop, real_sleep = agent._drop_customer_leg, asyncio.sleep

    async def no_sleep(_):
        return None

    q = _objection_qualifier()
    q._call_id, q.session_ref = None, _Session()
    q._ctx = type("Ctx", (), {"shutdown": lambda self, reason="": ended.append(reason)})()
    agent._drop_customer_leg, asyncio.sleep = drop, no_sleep
    try:
        asyncio.run(q._say_objection_line("Q4", "My bill is fine."))
        assert said == ["I understand."] and not dropped and not q._closing
        asyncio.run(q._say_objection_line("E1", "No."))
    finally:
        agent._drop_customer_leg, asyncio.sleep = real_drop, real_sleep
    assert said[-1] == "No worries." and dropped == [None] and q._closing and ended


def test_every_event_the_worker_posts_is_one_the_api_accepts():
    # 5 Nov: connect_gate was refused with a 400, unseen, so a pressed gate left no
    # trace and those calls were counted as people.
    import os
    import re

    here = os.path.dirname(os.path.abspath(__file__))
    controller = open(os.path.join(here, "../../apps/api/src/modules/engine/engine.controller.ts")).read()
    allowed = set(re.findall(r"'(\w+)'", re.search(r"CALL_EVENT_KINDS = \[(.*?)\]", controller).group(1)))
    posted = set(re.findall(r'_post_event\(\s*[\w.]+,\s*"(\w+)"', open(agent.__file__).read()))
    assert "connect_gate" in posted and "heard" in posted
    assert posted <= allowed, posted - allowed


def test_greeting_only_is_answering_the_phone_not_answering_us():
    for said in ("Hello.", "Hi", "Hello. Jason's", "Jason speaking.", "Hello, it's Jason.", "Hello, this is Mary", "Jason speaking with you."):
        assert agent._GREETING_ONLY.match(said), said
    for said in ("Good, thank you.", "Good.", "Yes.", "Who is this?", "Hello, who is this?", "I'm busy right now.", "Hello, how are you?"):
        assert not agent._GREETING_ONLY.match(said), said


def test_reply_holds_only_while_a_greeting_is_followed_by_more():
    import asyncio
    from types import SimpleNamespace

    q = agent.Qualifier.__new__(agent.Qualifier)
    q._call_id = None
    q.session_ref = SimpleNamespace(user_state="speaking")
    assert asyncio.run(q._customer_carried_on("Hello, Jason speaking."))
    assert not asyncio.run(q._customer_carried_on("Good, thank you."))
    q.session_ref = SimpleNamespace(user_state="listening")
    assert not asyncio.run(q._customer_carried_on("Hello."))


def test_only_asking_how_we_are_earns_an_answer():
    for said in ("Good, how are you?", "How's it going?", "Good thanks, and you?"):
        assert agent._ASKED_HOW_WE_ARE.search(said), said
    for said in ("Good, thank you.", "Hello, Jason speaking.", "Who are you?"):
        assert not agent._ASKED_HOW_WE_ARE.search(said), said
