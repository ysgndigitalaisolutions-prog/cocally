# Latency plan: reply gap of 600-800 ms, India first, then Australia

Date: 30 Sep 2026.

## Target

Gap the customer hears between finishing their sentence and the AI starting:
600-800 ms. Today 0.9-1.1 s, measured at the LiveKit recording, which does not
include the phone leg (customer <-> carrier <-> LiveKit).

## Principle

The worker's location is chosen per country, not once. Two workers can run at
the same time, each registered under its own agent name, and the API dispatches
a call to the worker for that call's country. Moving the India worker to the US
does not move Australian calls.

## Measured so far

| Stage | Today (worker in Sydney) | Best measured from India (laptop) | Best measured from Sydney VM |
|---|---|---|---|
| End of turn (voice detector 0.25 s + transcript) | 0.49 s | 0.25 s + Cartesia Ink-2 about 0.10 s | Ink-2 not yet run from Sydney |
| Language model, first token | 0.39 s | Cerebras 0.42-0.44 s | Cerebras 0.39 s |
| Voice, first audio | 0.27 s | Cartesia Sonic-3.6 0.12 s | Cartesia Sonic-3.6 0.08 s |

Cerebras spends about 0.03 s generating; the rest is distance to the US.

## India: two placements to test

| | A. Worker in Mumbai | B. Worker in the US |
|---|---|---|
| Speech-to-text | Cartesia Ink-2, about 0.10 s | Deepgram or Cartesia, est. 0.05 s |
| Language model | Cerebras, about 0.42 s | Cerebras, est. 0.10 s |
| Voice | Cartesia, about 0.12 s | Cartesia or ElevenLabs, est. 0.10 s |
| Audio travel, India <-> worker | short | est. +0.25 s per reply |
| Estimated gap | about 0.9 s | about 0.8 s |

Estimates, not measurements. In India the language model is the blocker: no
fast model is served near India on the keys we hold.

## Australia: worker stays in Sydney

| Stage | Plan | Expected |
|---|---|---|
| End of turn | Voice detector 0.25 s + Cartesia Ink-2, if the Sydney run matches India | about 0.35 s |
| Language model | Cerebras from Sydney | 0.39 s |
| Voice | Cartesia Sonic-3.6 | 0.08 s |
| Estimated gap | | about 0.8 s |

To go under 0.8 s in Australia the language model has to be served near
Sydney. Open: whether any fast provider offers that on a plan we can buy.

## Steps

1. Benchmark the three stages from a Mumbai machine and a US machine.
2. Pick the India placement from the numbers; start a second worker there under its own agent name.
3. Switch voice to Cartesia Sonic-3.6; test Ink-2 against Flux on live calls for accuracy.
4. Test calls to an Indian number; read the gap from the recording and the ops Latency tab.
5. Australia: run the Ink-2 benchmark from the Sydney VM, switch the Sydney worker to Cartesia, test call over Telvoq to an Australian number.
