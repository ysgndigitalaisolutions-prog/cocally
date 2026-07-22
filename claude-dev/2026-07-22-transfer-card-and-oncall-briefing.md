# 2026-07-22 — Cleaner transfer card opener + on-call briefing (summary + script)

## Problem
- Incoming warm-transfer card showed an ugly opener: `suggestedOpener` was
  `` `Opener: pick up from — ${call.summary.slice(0,140)}` `` — i.e. it echoed the
  raw rendered `summaryTemplate` blob ("Lead Tara in Carlton. Score 70. Facts:
  owner: true; dwellingHouse: true; …"), redundant with the name/score/facts
  already rendered structurally on the card.
- After accepting, the agent often had NO summary: `call.summary.updated` is
  emitted during the AI leg, before `agentIdRef.current` is set, so a just-bridged
  agent misses it. And no campaign script/rebuttals were exposed to agents at all
  (flow prompt + `GET /campaigns/:id` are ADMIN/SUP/QA only).

## Changes
1. `apps/api/src/modules/workspace/transfers.service.ts` — replaced the opener
   blob with `buildOpener(lead, openObjection)`: a natural first line keyed on an
   open objection or appointment interest, else a generic greeting.
2. `apps/api/src/modules/telephony/calls.controller.ts` — new
   `GET /calls/:id/briefing` (`@Roles AGENT,SUPERVISOR,ADMIN,QA`), tenant-scoped,
   call-scoped. Returns `{ leadName, location, score, summary, facts[], objection,
   campaignName, rebuttals[] }`. Gives a bridged agent both context and the
   playbook without a socket race or broad campaign access.
3. `apps/web/src/app/(app)/workspace/page.tsx` — fetch `/calls/:id/briefing` when
   `activeCallId` is set; on-call panel now shows AI summary + facts checklist on
   the left and campaign Script & rebuttals on the right (flagged objection's
   rebuttal highlighted). Cleared on disposition.

## Verified
- Typecheck clean (api + web).
- `GET /calls/:id/briefing` as `agent`/`1234` → 200 with summary, structured
  facts, campaign name, and rebuttals playbook.

## Note / possible follow-up
- The stored `call.summary` is still the templated blob (its format is the
  admin-editable campaign `summaryTemplate`). On the on-call panel it's shown as
  reference alongside structured facts; if the blob format is undesirable there,
  clean the campaign `summaryTemplate` rather than parsing it in the UI.
