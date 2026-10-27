"""Run: agent-worker/.venv/bin/python agent-worker/tests/test_out_of_area.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agent  # noqa: E402

PAT = agent.out_of_area_pattern(["Aurora Energy", "Ergon Energy", "Jacana Energy", "Synergy"])


def test_matches_how_customers_say_it():
    for said in ["I'm with Synergy.", "Ergon, I think", "it's Aurora Energy", "Jacana", "we're on synergy mate"]:
        assert PAT.search(said), said


def test_does_not_match_other_retailers():
    for said in ["AGL", "I think it's Simple Energy.", "Origin Energy", "Energy Australia", "Red Energy", "Powershop", "Yes.", "about 400 a month",
                 # 1st Energy as the STT heard it in the specialist recordings
                 "I'm with First Synergy", "we went for Synergy", "it's 1st synergy", "Force Synergy"]:
        assert not PAT.search(said), said


def test_empty_list_means_no_rule():
    assert agent.out_of_area_pattern([]) is None


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
            print("PASS", n)
