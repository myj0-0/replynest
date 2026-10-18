---
title: AI modes, tone and historical learning
---

# AI modes, tone and historical learning

Open [Business settings](https://console.replynest.cn/settings/communications). Channels, knowledge and sending permissions are separate.

| Mode | Behavior |
| --- | --- |
| Human-assisted | Agent requests a suggestion, reviews and sends |
| Automatic draft | Eligible questions produce team-only drafts for agent review and sending |
| Automatic reception | Published effective knowledge is retrieved and independently checked; only authorized, grounded, low-risk answers passing the threshold are sent |

October 8, 2026 test-business screenshot, not default consent for new businesses.

## Enable and verify

Prepare [published/indexed knowledge](knowledge-copilot.md), test suggestions, save reception mode and review website/Official Account consent separately. Select only intended channels and refresh mode, consent and service status; saved consent is not proof of enabled execution. Test a new question and inspect [charges](https://console.replynest.cn/billing/history?view=reception).

Confidence is not a correctness guarantee. Missing sources, conditions, conflicts and risk cause handoff. Actual retrieval/generation/verification can be charged even without sending. Agent assignment does not pause AI: use **Pause 10 minutes** or early resume for the customer's conversations in this business. Expiry handles new questions only, without replaying paused or human-answered questions. Shared-account authorization does not permit broadcasts.

## Tone and pace

Select concise, neutral or friendly-detailed styles separately for drafts and reception. Style cannot create unverified promises.

Default pacing is 1–30 seconds from inbound receipt, increasing with length and approaching but not reaching the configured maximum. Adjust/disable it; model/queue/channel delays can make receipt later, so this is not a delivery guarantee. Manual sending and team drafts do not wait. AI-label settings do not grant sending permission or replace applicable disclosure duties; internal provenance remains.

## History permissions

Authorize/revoke separately: bounded current-customer public context from the past 30 days; human reply expression features, not facts; and sourced knowledge drafts from customer questions plus human answers. Private notes/deleted records are excluded. Enable the human-tone preference as well to use learned style. Each draft task makes at most five items requiring review, editing, explicit publication and indexing; actual model/indexing usage costs points.

For missing replies check new inbound receipt, mode, channel consent, knowledge, pause/human replies, points/service, grounding/risk and channel results. Accepted does not mean read. Uncertain results are not blindly retried and revocation cannot recall already submitted messages.
