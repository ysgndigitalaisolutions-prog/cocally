"""Text-only eval of the scripted call against the real LLM chain.

Builds the call brief's instructions the way engine.controller.ts does (the
seed's PROMPT and playbook, the same rules), plays scripted customer turns
through the worker's real Qualifier (tags, guards, tools) and prints what the
AI would say and which tools it called. No phone, STT or TTS.

    cd agent-worker
    LLM_MODEL=openai/gpt-oss-120b .venv/bin/python tests/script_eval.py [scenario ...]

Keys come from agent-worker/.env (CEREBRAS_API_KEY etc). Keep the RULES below
in step with the instructions in EngineController.brief.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.dirname(HERE))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(os.path.dirname(HERE), ".env"))
logging.basicConfig(level=logging.WARNING, format="      LOG %(message)s")

import agent  # noqa: E402
from livekit.agents import AgentSession  # noqa: E402

CLIENT = "Australian Deal"
OPENING = "Hello, how are you doing today?"
LOCAL_NOW = "Monday 2 November 2026 at 11:30 am"

seed = open(os.path.join(REPO, "apps/api/src/seeds/seed-test-campaign.ts")).read()
prompt = re.search(r"const PROMPT = `(.*?)`;", seed, re.S).group(1).replace("{{clientName}}", CLIENT)
pb = re.search(r"const playbook = \(clientName: string\) => \[(.*?)\n\];", seed, re.S).group(1)
rebuttals = "\n".join(
    f'- If they say "{m.group(2)}": ' + m.group(4).replace("${clientName}", CLIENT).replace("\\'", "'")
    for m in re.finditer(r"\{ objection: (['\"`])(.*?)\1, rebuttal: (['\"`])(.*?)\3 \}", pb)
)
LINES: dict[str, str] = {}
for m in re.finditer(r'\[([A-Z]\d{1,2}Q?)\]\s*"([A-Za-z0-9][^"]*)"', prompt + "\n" + rebuttals):
    LINES.setdefault(m.group(1), m.group(2).strip())

RULES = [
    "- Speak naturally, one short question at a time. Never sound like a form.",
    f'- The person you are speaking to is Sam. You have ALREADY said: "{OPENING}" Never repeat that opening line.',
    "- Say scripted lines word for word. Anything you say off-script stays under 25 words: at most one short acknowledgement, then the next scripted step.",
    "- Never re-ask something already answered.",
    "- If they object, acknowledge warmly and use the playbook below; never argue.",
    "- When the script says to connect them, call the request_transfer tool and say nothing yourself: the hand-off line is spoken for you.",
    f"- To book a callback, call schedule_callback with the time they chose as ISO 8601 including their UTC offset. Only once THEY have said a day or time; never suggest or guess one. It is now {LOCAL_NOW} for them (Australia/Melbourne, UTC+11:00); use offset +11:00. Confirm the time back to them in words.",
    "- When the script ends the call (after your goodbye line), call the end_call tool.",
    "- If they ask not to be called, mention the Do Not Call Register, or threaten a complaint, call the opt_out tool and say nothing yourself: the closing line is spoken for you and their number is suppressed.",
    "- SCRIPTED LINES ARE TAGGED like [S2]. To say one, output its tag, e.g. [S2]; it is spoken for you word for word. Be warm: when the customer shares a feeling or a complaint, or asks how you are, you may put ONE short reaction (under 8 words) before the tag, for example: I'm doing well, thanks for asking! or: Oh, I hear you, prices have gone up. Otherwise output the tag alone. To answer a question and then carry on, output both tags, e.g. [Q1] [S3]. Never output two S tags in one turn: say one step, then wait for their answer. Write your own words only when no tagged line fits, and keep them under 25 words.",
]
INSTRUCTIONS = "\n".join([prompt, "CONVERSATION RULES:", *RULES, f"\nOBJECTION PLAYBOOK:\n{rebuttals}"])

SCENARIOS = {
    # On script
    "happy": ["Good thanks, how are you?", "Yes, that's me.", "Both electricity and gas.", "About 400 a quarter.", "We're with AGL."],
    "not_holder": ["I'm fine.", "No, that's my husband."],
    "dnc": ["Good.", "My number is on the DNC Register."],
    "busy": ["Hi.", "I'm at work and can't talk.", "Tomorrow after 5 pm.", "Yes thanks."],
    "distributor": ["Good.", "Yes.", "Electricity only.", "About 300 a quarter.", "It says Jemena on the bill."],
    "unclear": ["Good.", "Yes.", "I think I will let the city on.", "Electricity only.", "About 400 a month.", "AGL."],
    # Off script
    "robot": ["Good.", "Wait, am I talking to a robot?", "Yes.", "Electricity only."],
    "scam": ["Hi.", "Is this a scam? How did you get my number?", "Yes it's me.", "Both."],
    "email": ["Good.", "Yes.", "Can you just email me the offer instead?", "Electricity only."],
    "renter": ["Good.", "I'm renting, my landlord pays the bill.", "Okay."],
    "solar": ["Good.", "Yes.", "We have solar panels, does that matter?", "Both.", "About 200 a quarter."],
    "manager": ["Good.", "Yes.", "I want to speak to a real person right now."],
    "rude": ["What the hell do you want?", "Fine, yes.", "Electricity, now hurry up."],
    "ramble": ["Good.", "Yeah look, my wife usually handles it but she's away, I mean I pay it sometimes, why?", "Electricity only."],
    "call_soon": ["Good.", "Can you call me back in ten minutes? I'm driving."],
    "language": ["Hello.", "Sorry, my English not good. You speak Hindi?"],
    "who": ["Who is this? I don't know any Daniel."],
    "price_push": ["Good.", "Yes.", "Just tell me how much I'll save, give me a number.", "Electricity only."],
}


class _Ctx:
    def shutdown(self, reason: str = "") -> None:
        print(f"      <call ends: {reason}>")


async def _fake_transfer(self, reason):  # noqa: ANN001, ANN202 — real calls: worker speaks the hand-off
    self._transfer_triggered = True
    print("      <transfer: hand-off line spoken by worker>")
    return None


agent.Qualifier._do_transfer = _fake_transfer


async def run(name: str, turns: list[str]) -> list[float]:
    print(f"\n=== {name}")
    q = agent.Qualifier(instructions=INSTRUCTIONS, call_id=None, job_ctx=_Ctx())
    q.script_lines = LINES
    q.out_of_area_re = agent.out_of_area_pattern(["Aurora Energy", "Ergon Energy", "Jacana Energy", "Synergy"])
    q.out_of_area_line = "Thank you, we cannot cater to your area. Bye, take care."
    q._chat_ctx.add_message(role="assistant", content=OPENING)  # the worker said the opener
    times = []
    async with agent._make_llm() as llm, AgentSession(llm=llm) as sess:
        q.session_ref = sess
        await sess.start(q)
        for t in turns:
            print(f"  CUST: {t}")
            q.last_user_text = t  # what on_user_turn_completed records on a spoken turn
            t0 = time.monotonic()
            try:
                res = await asyncio.wait_for(sess.run(user_input=t), 30)
            except Exception as e:  # noqa: BLE001
                print(f"      <error {type(e).__name__}: {e}>")
                break
            times.append(time.monotonic() - t0)
            for ev in res.events:
                it = getattr(ev, "item", None)
                kind = type(ev).__name__
                if kind == "ChatMessageEvent" and getattr(it, "role", "") == "assistant":
                    print(f"  AI  : {it.text_content!r}")
                elif kind == "FunctionCallEvent":
                    print(f"  TOOL: {it.name}({it.arguments})")
            if q.closing or q._transfer_triggered:
                break
    return times


async def main() -> None:
    names = sys.argv[1:] or list(SCENARIOS)
    all_times: list[float] = []
    for n in names:
        all_times += await run(n, SCENARIOS[n])
    if all_times:
        all_times.sort()
        print(f"\nturns={len(all_times)} median={all_times[len(all_times) // 2]:.2f}s max={all_times[-1]:.2f}s (whole-reply time, text only)")


if __name__ == "__main__":
    asyncio.run(main())
