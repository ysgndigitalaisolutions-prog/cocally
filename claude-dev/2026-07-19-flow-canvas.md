# CoCally — Visual flow canvas

> Session log: 19 July 2026 (second session that day). Added a visual canvas to the flow editor — the graph was previously shown only as a text list of nodes and edges.

## What was built

**`apps/web/src/components/FlowCanvas.tsx`** (new, ~290 lines) — a dependency-free SVG canvas:

- **Auto-layout**: longest-path layering from `entryNodeId` — each node sits one column right of its furthest predecessor, so the graph reads left → right in call order. Relaxation is bounded by node count so an (invalid) cyclic graph can't hang the UI. Shorter columns are vertically centred against the tallest.
- **Nodes**: cards with a per-type colour bar (AMD purple, SPEAK/PLAY sky, AI_CONVERSATION amber, LISTEN_CAPTURE teal, SEND_DTMF orange, TRANSFER green, BRANCH pink, END dim), mandatory `★`, `▶ entry` badge.
- **Edges**: cubic-bézier arrows with condition labels (`amd.class = HUMAN`, `else` for lower-priority catch-alls); backward edges bow downward. Edges touching the selected node highlight in accent.
- **Interaction**: click a node → selects it in the existing node editor panel (same `selectedNodeId` state); drag to arrange — positions persist per flow in `localStorage` (`cocally-flow-layout-<flowId>`); "Auto-arrange" resets.
- Deliberately **not** structural editing (add/remove nodes/edges) — content edits go through the node editor as before; graph shape still comes from drafts/templates.

**`apps/web/src/app/(app)/flows/[id]/page.tsx`** — the old "Nodes" list + "Edges" text section was replaced by a full-width canvas card; the node editor and test-drive/preview panels moved to a 2-column grid below.

## Verification

- `pnpm typecheck` + `next build` clean (14 routes).
- Live: started the stack (API on :4000 was down, an existing `next dev` already owned :3000 and hot-reloaded), logged in as owner via API, drove headless Chrome (puppeteer-core + installed Google Chrome) to `/flows/<NSW Battery Rebate flow>`: canvas rendered the 10-node graph correctly; dispatching `pointerdown` on the AI_CONVERSATION node highlighted it and loaded it into the node editor. Screenshots in session scratchpad.

## Status notes recorded this session (asked by Nithin)

- **Transcripts**: done & surfaced — Calls page deep-dive shows redacted transcript, score-over-time, compliance events, auto-QA.
- **Recordings**: API complete (`GET /recordings/lead/:leadId/timeline` stitched dual-leg timeline, audited `:id/raw`, legal hold); counts appear in agent/team insights — but **no UI page yet renders the per-lead recording timeline**. Candidate next feature.
- **Lead-level insights**: leads table (state/score/attempts) exists; lead state-history timeline exists in the backend but **no per-lead drill-down UI yet**. Candidate next feature.
- **BPO-floor insights**: complete and verified — see [`agent-insights.md`](./agent-insights.md).
