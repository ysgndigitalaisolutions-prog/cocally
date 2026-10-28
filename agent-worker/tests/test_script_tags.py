"""Run: .venv/bin/python -m pytest agent-worker/tests -q (from the repo root)."""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from livekit.agents.llm import ChatChunk, ChoiceDelta, FunctionToolCall  # noqa: E402

import agent  # noqa: E402

LINES = {
    "S2": "As you may know, energy prices can be quite expensive. Electricity only, or gas as well?",
    "Q6": "What would be a convenient time for us to call you back?",
    "Q1": "I'm calling from Australian Deal.",
    "S3": "How much do you usually spend?",
    "S2Q": "Electricity only, or gas as well?",
    "S5": "No problem. Who sends you the bill?",
    "S4": "Just to get a rough idea, how much do you spend, monthly or quarterly? Like 200 to 300 dollars, or more than that?",
}


async def _collect(pieces, blocked=frozenset(), asked=frozenset({"S2"})):
    async def gen():
        for p in pieces:
            yield p

    out = []
    async for c in agent._expand_tag_stream(gen(), LINES, blocked, asked):
        out.append(c)
    return out


def _text(out):
    # A tag line is yielded with its trailing pad; TTS and the transcript trim it.
    return "".join(c for c in out if isinstance(c, str)).strip()


def _chunks(*texts):
    return [ChatChunk(id="x", delta=ChoiceDelta(role="assistant", content=t)) for t in texts]


def run(pieces, blocked=frozenset(), asked=frozenset({"S2"})):
    return asyncio.run(_collect(pieces, blocked, asked))


def test_single_tag_whole():
    assert _text(run(_chunks("[S2]"))) == LINES["S2"]


def test_tag_split_across_chunks():
    assert _text(run(_chunks("[", "S", "2", "]"))) == LINES["S2"]


def test_reply_ends_at_the_first_step():
    assert _text(run(_chunks("[S2][S3]"))) == LINES["S2"]
    assert _text(run(_chunks("[Q1] [S2] [S3]"))) == f"{LINES['Q1']} {LINES['S2']}"
    # 25 Oct: the model went on to answer for the customer.
    assert _text(run(_chunks("[S2]", "We have both electricity", " and gas.[S3]"))) == LINES["S2"]


def test_reply_ends_at_a_tagged_question():
    assert _text(run(_chunks('[Q6] "No problem.', ' (We\'ll use schedule_callback)'))) == LINES["Q6"]


def test_tool_call_after_the_step_still_passes():
    call = FunctionToolCall(name="end_call", arguments="{}", call_id="c2")
    tool = ChatChunk(id="x", delta=ChoiceDelta(role="assistant", tool_calls=[call]))
    out = run(_chunks("[S2]", "extra") + [tool])
    assert _text(out) == LINES["S2"] and tool in out


def test_own_words_end_at_the_first_question():
    assert _text(run(_chunks("Which company are you with? We", "'re with AGL."))) == "Which company are you with?"


def test_written_out_line_keeps_its_second_question():
    # 25 Oct call: the model wrote S3 itself; the cut at "?" lost the rest.
    out = _text(run(_chunks("No problem. Just to get a rough idea, how much do you ", "spend, monthly or quarterly?", " So")))
    assert out == LINES["S4"]


def test_written_out_line_missing_its_start_is_spoken_whole():
    # 28 Oct eval: the model said only the last question of S4.
    out = _text(run(_chunks("Got it. Like 200 to 300 ", "dollars, or more than that?")))
    assert out == LINES["S4"]


def test_json_in_reply_is_never_spoken():
    assert _text(run(_chunks('Booked for 5 pm. Goodbye.', '{"when": "x"}Now end call.'))) == "Booked for 5 pm. Goodbye."


def test_tool_talk_is_never_spoken():
    assert _text(run(_chunks("Thanks for your time. ", "We need to call end_call."))) == "Thanks for your time."


def test_repeat_question_tag_and_written_out_repeat_stay_short():
    assert _text(run(_chunks("[S2Q]"))) == LINES["S2Q"]
    assert _text(run(_chunks("Sorry. Electricity only, or gas ", "as well?"))) == LINES["S2Q"]


def test_first_ask_is_always_the_full_step():
    assert _text(run(_chunks("[S2Q]"), asked=frozenset())) == LINES["S2"]
    assert _text(run(_chunks("Electricity only, or gas as well?"), asked=frozenset())) == LINES["S2"]


def test_short_warm_reaction_before_a_line_is_spoken():
    assert _text(run(_chunks("Oh, I hear you, prices have gone up. ", "[S2]"))) == f"Oh, I hear you, prices have gone up. {LINES['S2']}"


def test_long_reaction_is_dropped():
    long = "Well I totally understand how you feel about all of this because it is really hard. "
    assert _text(run(_chunks(long, "[S2]"))) == LINES["S2"]


def test_no_reaction_before_a_line_that_opens_with_its_own():
    assert _text(run(_chunks("Oh wow. ", "[S5]"))) == LINES["S5"]


def test_blocked_tag_is_not_spoken():
    assert _text(run(_chunks("[Q6]Great, booked for 5 pm."), frozenset({"Q6"}))) == "Great, booked for 5 pm."


def test_two_tags():
    assert _text(run(_chunks("[Q1] [S3]"))) == f"{LINES['Q1']} {LINES['S3']}"


def test_two_tags_no_space():
    assert _text(run(_chunks("[Q1][S3]"))) == f"{LINES['Q1']} {LINES['S3']}"


def test_plain_text_untouched_including_split_words():
    assert _text(run(_chunks("No wor", "ries, ", "thanks!"))) == "No worries, thanks!"


def test_text_then_tag():
    assert _text(run(_chunks("Got it. ", "[S3]"))) == f"Got it. {LINES['S3']}"


def test_stage_directions_are_dropped():
    assert _text(run(_chunks("[Awaiting", " response]"))) == ""
    assert _text(run(_chunks("Thanks. [End of conversation]"))) == "Thanks."
    assert _text(run(_chunks("[Z9] ok"))) == "ok"


def test_unclosed_bracket_is_spoken():
    assert _text(run(_chunks("see [note"))) == "see [note"


def test_tool_call_chunk_passes_through():
    call = FunctionToolCall(name="request_transfer", arguments="{}", call_id="c1")
    tool = ChatChunk(id="x", delta=ChoiceDelta(role="assistant", tool_calls=[call]))
    out = run([tool])
    assert out == [tool]


def test_whole_string_helper():
    assert agent.expand_script_tags("[Q1] [S3]", LINES) == f"{LINES['Q1']} {LINES['S3']}"
