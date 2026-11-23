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
                 "Just leave me alone", "lose my number", "You can't call me.", "You cannot ring this number", "My number is on the DNC register", "I'll make a complaint"]:
        assert agent._OPT_OUT_REQUEST.search(said), said
    for said in ["I'm not interested.", "Call me back later.", "Yes, that is me.", "Sorry, who is this?", "I don't want it.", "About 300 a quarter", "You can call me back at five.", "I can't talk right now"]:
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


def test_ai_said_as_a_statement_is_answered_too():
    for said in ["You're AI. You're not a real person.", "you're a robot", "You are not a real person", "This is a recording", "It's just a bot"]:
        assert agent._AI_QUESTION.search(said), said
    for said in ["You're right.", "You're not from here?", "This is Colin.", "It's a bit much.", "You're a broker?"]:
        assert not agent._AI_QUESTION.search(said), said


def test_ask_your_supervisor_is_a_request_for_a_person():
    for said in ["Ask your supervisor.", "Get your manager", "Can you get your boss"]:
        assert agent._HUMAN_REQUEST.search(said), said
    assert not agent._HUMAN_REQUEST.search("Ask me later")


def test_a_cut_off_playbook_answer_still_counts_as_given():
    q, _ = _make((OPENING, "Good question. Our specialist can"))
    assert "Q7" in q._answers_given()
    lines, advance = q._lines_for_reply()
    assert advance.get("Q7") in ("QR", "E1"), advance
    q2, _ = _make((OPENING, "Good"))
    assert "Q7" not in q2._answers_given()
    q3, _ = _make((OPENING, LINES["S1"]))
    assert q3._answers_given() == set()


def test_a_written_out_playbook_answer_is_not_said_twice():
    async def go():
        q, _ = _make((OPENING, LINES["S1"]))
        return await _say_reply(q, ["[Q1] I'm calling from Australian Deal, an energy broker. ", "[S1Q]"])

    out = asyncio.run(go())
    assert out == f"{LINES['Q1']} {LINES['S1Q']}", out


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


# 17 Nov: John (Marong) said "Oh," twice while thinking and heard the question three times.
S1_SAID = (OPENING, LINES["S1"])


def test_a_thinking_noise_waits_then_asks_again_once():
    async def go():
        agent.FILLER_WAIT_S = 0.05
        q, _ = _make(S1_SAID)
        assert await _turn(q, "Oh,"), "a filler is not a turn for the model"
        assert q.session_ref.said == [], "nothing said straight away"
        await asyncio.sleep(0.15)
        assert q.session_ref.said == ["Are you the account holder?"], q.session_ref.said
    asyncio.run(go())


def test_their_answer_after_a_thinking_noise_cancels_the_reask():
    async def go():
        agent.FILLER_WAIT_S = 0.05
        q, _ = _make(S1_SAID)
        assert await _turn(q, "Um,")
        handled = await _turn(q, "Yes, that's me.")
        await asyncio.sleep(0.15)
        assert not handled, "their answer goes to the model as usual"
        assert q.session_ref.said == [], q.session_ref.said
    asyncio.run(go())


def test_third_ask_of_a_yes_no_step_is_a_bare_yes_no():
    # 18 Nov (Geoffrey): "I am" twice came out of the STT as "Hi, Anne".
    async def go():
        agent.FILLER_WAIT_S = 0.05
        q, _ = _make(S1_SAID + (LINES["S1Q"],))
        assert await _turn(q, "Oh,")
        await asyncio.sleep(0.15)
        assert q.session_ref.said == [agent.YES_NO_REASK], q.session_ref.said
        lines, _ = q._lines_for_reply()
        assert lines["S1Q"] == agent.YES_NO_REASK
        assert lines["S1"] == LINES["S1"], "the script line itself is unchanged"
    asyncio.run(go())


def test_third_ask_of_an_open_question_keeps_the_lead_in():
    q, _ = _make(S1_SAID + ("Yes.", LINES["S2"], LINES["S4"], LINES["S4Q"]))
    lines, _ = q._lines_for_reply()
    assert lines["S4Q"] == "Sorry, just to check, which energy company are you with now?", lines["S4Q"]


def test_the_yes_no_ask_counts_once_and_not_for_the_next_step():
    q, _ = _make(S1_SAID + (LINES["S1Q"], agent.YES_NO_REASK))
    lines, _ = q._lines_for_reply()
    assert lines["S1Q"] == LINES["Q6"], "three asks, then the callback question"
    q, _ = _make(S1_SAID + (LINES["S1Q"], agent.YES_NO_REASK, LINES["S2"], LINES["S4"]))
    lines, _ = q._lines_for_reply()
    assert lines["S4Q"] == LINES["S4Q"], "the earlier yes/no is not an ask of S4"


CONSENT = "Thanks. From what you've said, there may be a better offer for you. Would you like me to put you through to our specialist now? It only takes a couple of seconds."


def test_no_transfer_without_a_yes_to_being_put_through():
    q, _ = _make()
    q.script_lines["S5"] = CONSENT
    for said, pending in [("Yes please.", False), ("Yeah, sure.", False), ("Okay.", False), ("No thanks.", True),
                          ("Not now, call me back later.", True), ("Nah.", True), ("What's that?", True), ("No worries, go ahead.", False)]:
        q.last_user_text = said
        assert q._consent_pending() is pending, said
    q.script_lines.pop("S5")
    q.last_user_text = "No."
    assert q._consent_pending() is None, "no consent step, no gate"


def test_hostile_includes_the_stt_pack_off():
    # 18 Nov: "Fuck off" came out of the STT as "Pack off."
    assert agent._HOSTILE.search("Pack off.")


def test_first_repeat_is_still_word_for_word():
    q, _ = _make(S1_SAID)
    lines, _ = q._lines_for_reply()
    assert lines["S1Q"] == LINES["S1Q"]


def test_what_counts_as_a_thinking_noise():
    for said in ["Oh,", "Um", "Uh...", "Hmm.", "Oh, um", "Well,", "Let me think."]:
        assert agent._FILLER_ONLY.match(said), said
    for said in ["Mm-hmm.", "Uh-huh", "No.", "Oh, yes", "Oh no", "Yeah", "Um, yes I am", "Hello?"]:
        assert not agent._FILLER_ONLY.match(said), said


def test_after_three_asks_the_callback_question_then_goodbye():
    # 17 Nov (Rajni, Tarneit): "Are you the account holder?" ten times.
    reworded = agent.YES_NO_REASK
    q, _ = _make(S1_SAID + (LINES["S1Q"], reworded))
    lines, _ = q._lines_for_reply()
    assert lines["S1Q"] == LINES["Q6"], lines["S1Q"]
    assert q._reask_line() == LINES["Q6"]
    q, _ = _make(S1_SAID + (LINES["S1Q"], reworded, LINES["Q6"]))
    lines, _ = q._lines_for_reply()
    assert lines["S1Q"] == LINES["E1"], lines["S1Q"]


SCREEN = "Hi, this is Emma from Australian Deal, calling regarding your electricity bills."


def test_google_call_assist_gets_our_line_and_again_when_it_asks_again():
    # 17 Nov (Sonia): our line was cut off by the screener's next prompt, and every
    # later prompt got "Sorry, I didn't quite catch that" from the stall guard.
    async def go():
        q, _ = _make()
        q.screening_line = SCREEN
        assert await _turn(q, "Hi. Call Assist by Google recording this call for the person you're trying to reach.")
        assert q.session_ref.said == [SCREEN]
        assert await _turn(q, "Before I try to connect you, can I ask what you're calling about?")
        assert q.session_ref.said == [SCREEN, SCREEN], q.session_ref.said
        assert await _turn(q, "Before I try to connect you, could you please give me a quick description of why you're calling?")
        assert q.session_ref.said == [SCREEN, SCREEN], "twice at most, then wait"
        assert q.quiet_on_purpose, "the stall guard must not fill the wait"
        assert await _turn(q, "Okay. Let me try to get the person you are trying to reach on the line.")
        assert q.quiet_on_purpose and q.session_ref.said == [SCREEN, SCREEN]
    asyncio.run(go())


def test_a_thinking_noise_keeps_the_stall_guard_quiet_and_their_next_words_clear_it():
    async def go():
        agent.FILLER_WAIT_S = 5
        q, _ = _make(S1_SAID)
        assert await _turn(q, "Um,")
        assert q.quiet_on_purpose
        await _turn(q, "Yes, that's me.")
        assert not q.quiet_on_purpose
    asyncio.run(go())


def test_a_short_you_back_is_asking_how_we_are():
    # 18 Nov test call: "I'm good. Are you?" got no "I'm doing well" back.
    for said in ["I'm good. Are you?", "Good, you?", "Not bad, and you?", "Fine thanks, how about you?", "How are you?", "Good thanks. How's your day?"]:
        assert agent._ASKED_HOW_WE_ARE.search(said), said
    for said in ["Who are you?", "Good.", "Where are you from?", "Are you a robot?", "What do you want?"]:
        assert not agent._ASKED_HOW_WE_ARE.search(said), said


def test_someone_in_hospital_gets_a_kind_goodbye_and_nothing_else():
    # 18 Nov (6:07pm): "I'm in hospital at the moment" got the bill question and
    # six tries at the callback question.
    for said in ["When I'm home, yeah, I'm in hospital at the moment.", "My wife's in hospital, so I'm waiting for calls for her.",
                 "I'm not feeling well.", "I'm really sick at the moment", "She just had a heart attack", "My husband passed away last week."]:
        assert agent._UNWELL.search(said), said
    for said in ["Not good.", "I'm good.", "Sick of these calls", "Yes.", "I'm fine thanks", "Well, how much is it?"]:
        assert not agent._UNWELL.search(said), said
    q, ctx, handled = _run("I'm in hospital at the moment, nearly asleep.", S1_SAID)
    assert handled
    assert q.session_ref.said == [agent.UNWELL_LINE], q.session_ref.said
    assert ctx.ended, "the call ends"


def test_a_callback_line_cut_off_twice_is_not_begun_again():
    cut = "No problem. What would be a"
    q, _ = _make(S1_SAID + ("Yes.", LINES["S2"], cut, cut))
    _, advance = q._lines_for_reply()
    assert advance.get("Q6") == "E1", advance
    q, _ = _make(S1_SAID + ("Yes.", LINES["S2"], cut))
    _, advance = q._lines_for_reply()
    assert "Q6" not in advance, "one cut-off try is not enough"


def test_an_out_of_area_retailer_gets_the_company_question_once_more():
    # 18 Nov (6:54pm): "Meter Ergon?" closed a Victorian on "only power" as out of area.
    async def go():
        q, ctx = _make(S1_SAID + ("Yes.", LINES["S2"], LINES["S4"]))
        q.out_of_area_re = agent.out_of_area_pattern(["Ergon Energy"])
        q.out_of_area_line = "Thank you, we cannot cater to your area. Bye, take care."
        orig = agent._no_agent_close
        closed = []
        async def fake_close(*a, **k):
            closed.append(a)
        agent._no_agent_close = fake_close
        try:
            assert await _turn(q, "Meter Ergon?")
            assert q.session_ref.said == [LINES["S4Q"]], q.session_ref.said
            assert not closed and not q._closing
            assert await _turn(q, "Ergon.")
            await asyncio.sleep(0)
            assert q._closing and closed, "the second time it closes"
        finally:
            agent._no_agent_close = orig
    asyncio.run(go())


# 23 Nov fixes: someone else looks after the bills, screener hand-off, opening on disk.

def test_my_husband_looks_after_it_asks_for_him():
    for text, line in [
        ("Yes. Oh, it's my husband.", "Is he around for a quick chat, or is there a better time to call him?"),
        ("My daughter pays all the bills for me.", "Is she around for a quick chat, or is there a better time to call her?"),
        ("I don't... No. Not me.", "Are they around for a quick chat, or is there a better time to call them?"),
    ]:
        q, ctx, handled = _run(text, S1_SAID)
        assert handled and not ctx.ended, text
        assert q.session_ref.said == ["No worries. " + line], (text, q.session_ref.said)


def test_my_husband_and_i_is_a_yes():
    for text in ["My husband and I both do.", "Yes, me and my wife."]:
        q, _, handled = _run(text, S1_SAID)
        assert not handled and not q.session_ref.said, text


def test_someone_else_only_after_the_bill_question():
    q, _, handled = _run("My husband's at work.", (OPENING, LINES["S1"], LINES["S2"]))
    assert not any("quick chat" in s for s in q.session_ref.said)


def test_someone_else_then_fetched_then_greeted():
    async def go():
        q, _ = _make(S1_SAID)
        assert await _turn(q, "It's my husband.")
        q._chat_ctx.add_message(role="assistant", content=q.session_ref.said[-1])
        assert await _turn(q, "Yeah.")
        assert q.session_ref.said[-1] == agent.HOLD_LINE
        q._chat_ctx.add_message(role="assistant", content=agent.HOLD_LINE)
        assert not await _turn(q, "He's coming.")  # still the first person: the model's turn
        assert await _turn(q, "Hello?")
        assert q.session_ref.said[-1] == OPENING
        q._chat_ctx.add_message(role="assistant", content=OPENING)
        assert not await _turn(q, "Good thanks.")  # the model asks [S1] again
        notes = [i.text_content for i in q._chat_ctx.items if getattr(i, "role", None) == "system"]
        assert any("Say the [S1] line again" in n for n in notes), notes

    asyncio.run(go())


def test_someone_else_not_around_gets_the_callback_question():
    async def go():
        q, _ = _make(S1_SAID)
        await _turn(q, "My wife does.")
        q._chat_ctx.add_message(role="assistant", content=q.session_ref.said[-1])
        assert await _turn(q, "No, she's at work.")
        assert q.session_ref.said[-1] == LINES["Q6"]

    asyncio.run(go())


def test_someone_else_with_a_time_is_booked():
    async def go():
        q, _ = _make(S1_SAID)
        await _turn(q, "My wife does.")
        q._chat_ctx.add_message(role="assistant", content=q.session_ref.said[-1])
        assert not await _turn(q, "Call back after six tonight.")
        notes = [i.text_content for i in q._chat_ctx.items if getattr(i, "role", None) == "system"]
        assert any("schedule_callback" in n for n in notes), notes

    asyncio.run(go())


def test_i_just_said_i_pay_them_is_a_yes():
    async def go():
        q, _ = _make((OPENING, LINES["S1"], LINES["S1Q"]))
        assert not await _turn(q, "I just said I pay them.")
        notes = [i.text_content for i in q._chat_ctx.items if getattr(i, "role", None) == "system"]
        assert any("They said yes" in n for n in notes), notes

    asyncio.run(go())


def test_screener_handing_over_is_not_the_customer():
    async def go():
        q, _ = _make((OPENING,))
        assert await _turn(q, "Thanks, Emma. Please stay on the line.")
        assert not q.session_ref.said and q.quiet_on_purpose
        assert await _turn(q, "Hello?")  # the person: the greeting again
        assert q.session_ref.said == [OPENING]

    asyncio.run(go())


def test_please_stay_on_the_line_after_step_one_is_left_alone():
    q, _, handled = _run("Please stay on the line.", S1_SAID)
    assert not q._screener_handed_over


def test_opening_on_disk_round_trip(tmp_path=None):
    import tempfile

    d = tempfile.mkdtemp()
    old = agent.OPENING_CACHE_DIR
    agent.OPENING_CACHE_DIR = d
    try:
        frames = [rtc.AudioFrame(np.arange(n, dtype=np.int16).tobytes(), 24000, 1, n) for n in (480, 480, 123)]
        path = agent._opening_cache_path(OPENING)
        assert agent._load_opening(path) is None
        agent._save_opening(path, frames)
        back = agent._load_opening(path)
        assert [f.samples_per_channel for f in back] == [480, 480, 123]
        assert all(bytes(a.data) == bytes(b.data) for a, b in zip(frames, back))
        assert back[0].sample_rate == 24000
        assert agent._opening_cache_path(OPENING + "!") != path
        with open(path, "r+b") as fh:  # cut short
            fh.truncate(200)
        assert agent._load_opening(path) is None
    finally:
        agent.OPENING_CACHE_DIR = old


# 23 Nov: fixed lines are spoken once, then served from saved audio.

def test_split_fixed_lines_out_of_a_reply():
    s1 = LINES["S1"]
    parts = agent._split_fixed(f"I'm doing well, thanks. {s1}", [s1])
    assert parts == [(False, "I'm doing well, thanks. "), (True, s1)]
    assert agent._split_fixed("Something else.", [s1]) == [(False, "Something else.")]
    # the longer of two overlapping lines wins
    assert agent._split_fixed("Are you the account holder? Yes.", ["Are you the account holder?", "account holder"])[0] == (True, "Are you the account holder?")


def test_fixed_lines_are_saved_then_reused():
    import tempfile

    async def go():
        d = tempfile.mkdtemp()
        old_dir, old_default = agent.OPENING_CACHE_DIR, agent.Agent.default.tts_node
        agent.OPENING_CACHE_DIR = d
        agent._PRERENDER_CACHE.clear()
        synthesised = []

        async def fake_tts(self, text, settings):  # noqa: ANN001
            words = "".join([t async for t in text])
            synthesised.append(words)
            for _ in range(3):
                yield rtc.AudioFrame(np.zeros(480, dtype=np.int16).tobytes(), 24000, 1, 480)

        agent.Agent.default.tts_node = fake_tts
        try:
            q, _ = _make()

            async def reply(*chunks):
                async def text():
                    for c in chunks:
                        yield c
                return [f async for f in q.tts_node(text(), None)]

            first = await reply("Good to hear. ", LINES["S1"])
            await asyncio.sleep(0.2)  # the save runs in the background
            assert synthesised == ["Good to hear. ", LINES["S1"]]
            assert len(first) == 6
            synthesised.clear()
            agent._PRERENDER_CACHE.clear()  # a new call: from disk, not memory
            hooked = []
            q2, _ = _make()
            q2.on_cached_audio = lambda: hooked.append(1)

            async def text2():
                yield LINES["S1"]
            again = [f async for f in q2.tts_node(text2(), None)]
            assert synthesised == [] and len(again) == 3, synthesised
            assert hooked == [1]  # the turn's timing is still recorded
        finally:
            agent.OPENING_CACHE_DIR, agent.Agent.default.tts_node = old_dir, old_default
            agent._PRERENDER_CACHE.clear()

    asyncio.run(go())


def test_a_line_cut_off_is_not_saved():
    import tempfile

    async def go():
        d = tempfile.mkdtemp()
        old_dir, old_default = agent.OPENING_CACHE_DIR, agent.Agent.default.tts_node
        agent.OPENING_CACHE_DIR = d
        agent._PRERENDER_CACHE.clear()

        async def fake_tts(self, text, settings):  # noqa: ANN001
            async for _ in text:
                pass
            for _ in range(5):
                yield rtc.AudioFrame(np.zeros(480, dtype=np.int16).tobytes(), 24000, 1, 480)

        agent.Agent.default.tts_node = fake_tts
        try:
            q, _ = _make()

            async def text():
                yield LINES["S1"]
            gen = q.tts_node(text(), None)
            await gen.__anext__()
            await gen.aclose()  # the customer talked over it
            await asyncio.sleep(0.2)
            assert agent._load_opening(agent._opening_cache_path(LINES["S1"])) is None
        finally:
            agent.OPENING_CACHE_DIR, agent.Agent.default.tts_node = old_dir, old_default
            agent._PRERENDER_CACHE.clear()

    asyncio.run(go())
