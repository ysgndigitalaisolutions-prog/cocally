# Latency plan: reply gap of 600-800 ms

Date: 30 Sep 2026. File name is historical: production is Sydney only, via
Telvoq. Calls to Indian numbers over Twilio are test calls.

## Target

Gap the customer hears between finishing their sentence and the AI starting:
600-800 ms, for an Australian customer on Telvoq. Today 0.9-1.1 s at the
LiveKit recording.

## Decisions

- The worker stays in Sydney. No US or Mumbai worker, no per-country routing.
- India test calls are judged from the ops Latency tab and the recording, not
  by ear. The India phone leg (tester <-> Twilio <-> LiveKit Sydney) adds
  delay an Australian customer will not have.

## Measured from the Sydney VM

| Stage | Today | Candidate | Status |
|---|---|---|---|
| End of turn (voice detector 0.25 s + transcript) | 0.49 s, Deepgram Flux | Cartesia Ink-2 | Ink-2 not yet run from Sydney; about 0.10 s from India |
| Language model, first token | 0.39 s, Cerebras | none found near Sydney | Cerebras generates in 0.03 s, rest is distance to the US |
| Voice, first audio | 0.27 s, ElevenLabs (Singapore) | Cartesia Sonic-3.6 | 0.08 s measured |

Estimated gap with Cartesia voice and speech-to-text: about 0.8 s. Under that
needs a fast language model served near Sydney.

## Steps

1. Deploy the interruption fix and the Cartesia Sonic-3.6 option.
2. Switch the voice to Cartesia; test call; compare the voice stage in the ops Latency tab.
3. Run `~/stt_bench.py` from the Sydney VM. If Ink-2 is fast there, add it as a speech-to-text option and compare accuracy with Flux on live calls.
4. Look for a fast language model served near Sydney.
5. Before go-live: test call over Telvoq to an Australian number.
