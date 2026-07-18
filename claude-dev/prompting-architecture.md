# How CoCally talks to the AI models

> Written 19 July 2026, in answer to: *"how do I configure the prompts? how does the customer response feed back? how is this sent to the model — with a context, or context + system prompt?"*

## The short answer

**System prompt + full rolling conversation history, every turn.** You author one prompt per `AI_CONVERSATION` node in the flow editor; the engine wraps it with live call state (answered facts, rebuttal playbook, reply contract) into a **system prompt that is rebuilt every turn**, and sends it together with the whole turn history to the LLM. The model must answer in a fixed JSON "envelope"; the engine executes the envelope.

Everything below is inspectable live in the app: **Flows → open editor → select the AI node → "Preview exact prompt"** shows the exact composed system prompt and message assembly (served by `POST /api/v1/flows/prompt-preview`).

## 1. Where you author prompts

Flow editor (`/flows/[id]`) → select the `AI_CONVERSATION` node. You write the **node prompt**: persona, goal, what to qualify, tone. Example (the seeded pilot flow):

> You are a warm, natural Australian outbound assistant qualifying homeowners for a free solar assessment for Aurora Solar. Qualify: home ownership, existing panels, quarterly bill size, dwelling type, and interest in a free assessment visit. Be brief, never pushy, one question at a time.

The node also configures: **exit intents** (which model-emitted intents leave the node and drive flow edges), **capture variables** (the structured facts the node should fill, AI-06), **max turns**, and an optional **per-node LLM override** (PAL-04 — e.g. a cheap fast model on qualification, a stronger one on an objection-handling node).

Campaign-level prompt inputs live on the campaign: the **rebuttal library** (objection → guidance, AI-04), the **scoring config** (fact weights + thresholds, AI-05), and the **summary template** (PAL-11).

## 2. What the model actually receives each turn

Implemented in [`apps/api/src/modules/engine/prompt.ts`](../apps/api/src/modules/engine/prompt.ts) (`composeSystemPrompt`) — a pure function shared by the live engine and the preview endpoint, so the preview can never lie.

```
[system]  ← REBUILT EVERY TURN:
  1. Your node prompt, with {{variables}} interpolated (lead fields, campaign fields)
  2. "You have already identified yourself as an AI assistant." (if AI-07 toggle on)
  3. "ALREADY ANSWERED (never re-ask these): owner=true, billHigh=true, …"   ← from live captured facts
  4. "OBJECTION PLAYBOOK: - If "not_interested": …"                          ← campaign rebuttal library
  5. The JSON envelope contract (see §3)

[user]       customer utterance, turn 1  (raw STT text)
[assistant]  the model's JSON envelope reply, turn 1
[user]       customer utterance, turn 2
[assistant]  envelope, turn 2
…full rolling history, one pair per turn…
[user]       the newest customer utterance   ← the turn being answered
```

Key design points:

- **The system prompt is rebuilt every turn** so the ALREADY-ANSWERED list includes facts captured seconds ago. This is what mechanically enforces AI-03 ("never re-asks an answered question") rather than hoping the model remembers.
- **History is the full turn log**, not a summary — at ≤16 turns of one-sentence exchanges this is small, and it gives the model complete context for objection memory ("I already got a call today" must never be contradicted later).
- Request parameters: `jsonMode: true`, `temperature 0.6`, `maxTokens 400`.

## 3. How the customer's response feeds back — the envelope

The model must reply with **one JSON object**:

```json
{
  "reply":     "what the AI says next — spoken via TTS",
  "intent":    "continue | qualified | objection | opt_out | callback | end",
  "captured":  { "owner": true, "billHigh": true },
  "objection": "not_interested"  // or null
}
```

The engine (in [`flow-executor.service.ts`](../apps/api/src/modules/engine/flow-executor.service.ts) → `runConversation`) executes it:

| Envelope field | What the engine does with it |
|---|---|
| `reply` | Spoken to the customer through the TTS chain; appended to transcript + recording |
| `captured` | Merged into the call's **structured facts** (AI-06) → recomputes the weighted **propensity score** (AI-05) → streams score to the supervisor floor feed → updates the incremental summary (PAL-11) |
| `intent` | `qualified` (or score ≥ transfer threshold) exits the node → the flow's edges route it (typically → TRANSFER). `opt_out` → instant suppression write + polite goodbye. `callback`/`end` → their edges |
| `objection` | Logged for objection analytics (DASH-03); marked *recovered* if the conversation moves past it |

**Before** the model is even called, the raw customer utterance passes the safety rails (AI-09): a do-not-call phrase triggers an instant opt-out write and polite exit; profanity/distress triggers a graceful exit. These are regex-level guards that don't depend on model behaviour.

If the model returns malformed JSON, the engine falls back to using the raw text as `reply` with `intent: continue` — a bad model turn degrades the conversation, never crashes the call.

## 4. Full loop: one turn of a live call

```
customer speaks
  → STT chain (PAL: deepgram → whisper → sim)          [transcript, keywords boosted per campaign]
  → safety rails (opt-out / distress regex)
  → composeSystemPrompt(node prompt, facts, rebuttals) [rebuilt with current facts]
  → LLM chain (PAL: per-node override → campaign → tenant → platform; fallback on failure)
  → parse envelope
  → apply captured facts → score → maybe pre-reserve agent (XFER-02)
  → TTS chain speaks `reply`
  → repeat, or exit node via intent/score → flow edges decide (transfer / book / nurture / end)
```

Which provider actually served each stage is recorded per call (`providersUsed`) with cost composition (telco+STT+TTS+LLM) for the cost views.

## 5. Provider credentials — why one "API key" box was wrong

Each adapter now declares its own **credential schema**, and the Providers page renders that schema as the form. Stored per tenant, AES-256-GCM encrypted as one bundle (PAL-12); shape differs per provider:

| Provider | Fields |
|---|---|
| ElevenLabs / Deepgram / Anthropic / Gemini | `apiKey` |
| OpenAI GPT / Whisper | `apiKey` + optional `baseUrl` (Azure OpenAI or self-hosted vLLM/Ollama) |
| Azure Speech | `apiKey` + `region` |
| Google Cloud TTS | `apiKey` (service-account OAuth arrives with the streaming SIP driver) |
| Self-hosted LLM | `baseUrl` + `model` + optional `apiKey` |
| Simulation adapters | none — always available |

The Providers page also shows, per capability, the **active fallback chain** (reorderable, ▲▼), per-entry **model selection** for LLM hops, the three **LLM roles** (conversation / summary / scoring — independently configurable per PAL-03), and warns when a chain hop has no credentials (it will be skipped at runtime, falling through to the next hop — ultimately the simulation adapter, which is why calls always work in dev).

## 6. Testing: the interactive test-drive (why scripted simulation wasn't enough)

A real outbound call is: **dial → AMD → the AI opens (disclosure + greeting) → unpredictable turn-taking** — the customer says "who is this?", objects, asks questions — **→ live consequences** (every answer moves the score; the threshold triggers the transfer; "don't call me" opts out instantly) **→ close** (transfer / book / exit).

A pre-scripted reply list can't exercise that, because the whole point of a conversation is that the customer is unpredictable. So the flow editor's **Live test-drive** runs the *actual engine* — same executor, same `composeSystemPrompt`, same scoring, same safety rails, same transfer orchestration — with the executor **suspended at every `listen()`** while *you* type the customer's side in a chat UI. Beside the chat: live score, captured facts, open/recovered objections, compliance events, and the incremental summary the agent would see on the transfer card.

Mechanics (`sim-session.service.ts`): `POST /flows/versions/:id/test-drive` starts a server-side session (the `InteractiveRuntime`'s `listen()` returns a promise resolved only by your next reply); each `POST /flows/test-drive/:sid/reply` feeds one customer utterance and returns everything that happened up to the next pause. Only the phone line is simulated — with real LLM keys configured, the conversation model in the test-drive is the same one live calls use.

## 7. Where to change what — cheat sheet

| I want to… | Go to |
|---|---|
| Change what the AI says / qualifies | Flows → editor → AI node prompt |
| See the exact final prompt sent to the model | Flows → editor → AI node → **Preview exact prompt** |
| Add/change objection handling | Campaign `rebuttals` (API `PATCH /campaigns/:id`; UI form is a fast-follow) |
| Change when a lead transfers vs books | Campaign `scoring.thresholds` |
| Use a different LLM for one node | Flow editor → AI node → LLM override |
| Use a different LLM everywhere / set fallbacks | Providers → chain editor (per LLM role) |
| Add provider keys | Providers → provider row → Configure |
| Change the transfer-card summary wording | Campaign `summaryTemplate` |
