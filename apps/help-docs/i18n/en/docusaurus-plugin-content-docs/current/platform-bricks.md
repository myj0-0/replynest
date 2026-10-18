---
title: AI Custom Studio reference
description: Current capabilities, configuration and access boundaries of ReplyNest AI Custom Studio.
---

# AI Custom Studio reference

Version D1, schema version 1, catalog `2026-10-09.1`. Reviewed 2026-10-09.

[Open AI Custom Studio](https://console.replynest.cn/extensions). This replaces the former platform-bricks display name; URLs, saved apps and permissions remain unchanged.

The current release supports controlled single-page forms, record tables and submit-time conditional field assignments. It supports bounded JavaScript form transformations in a separate runtime, not executable HTML, SQL or host-system code. Only actual tenant administrator console sessions can use it; tenant API keys, impersonation and embedded Copilot sessions cannot.

## Supported building blocks

The builder exposes capability catalog `2026-10-09.1`, shared with the AI generator. Availability is not authorization. Weekly rotation drafts can be simulated and then explicitly authorized by an administrator for scheduled assignment. Generation never grants access or enables a task.

The automation laboratory previews weekly rotations and literal keyword routing using synthetic samples only. It does not read real conversations, validate real member identities, persist rules, schedule background jobs or assign conversations. Timezone is fixed to Asia/Shanghai. AI can generate rule drafts; generation never authorizes execution. Semantic samples require separate consent and consume AI points. `GET /api/extensions/capabilities` returns the catalog and `POST /api/extensions/automation-preview` runs the pure preview under an administrator console session, not a public API key. See the Chinese reference for the full parameter contract.

- Fields: text, multiline text, number, date, single select and checkbox.
- Page: title, description, one/two-column layout and submit button text.
- Rules: strict `equals`/`not_equals` for all field types; `gte`/`gt`/`lt`/`lte` for numbers only; case-sensitive literal `contains`/`starts_with`/`ends_with` for text/textarea only. Missing optional fields never match, including inequality. Values must match field types and select options; there is no string-to-number conversion, date ordering, regex or semantic classification. Matches assign a constant to a field on the same new record. Each operator has its own `rule.OPERATOR` capability ID and must be declared in the AI manifest. Publishing still requires administrator review and grants no external actions.
- Lifecycle: immutable drafts, simulation, explicit permission confirmation, publication, disable and re-publication of an older version. Existing records are not migrated or undone.

Workflow conditions read the original validated submission, not earlier rule outputs. Rules cannot query historical records, customers, conversations, knowledge, orders, payments, secrets or environment variables. Metadata returned by console endpoints is not available as workflow variables. There is no automatic interpolation or direct send. Separately confirmed HTTPS and campaign-draft actions are supported below; scripts still have no network or database access.

AI receives the current requirement and platform schema, not customer data or the previous app definition automatically; selected knowledge excerpts require per-generation consent. Do not paste secrets or real customer information into generation requests.

## Configuration and endpoints

### Custom charts

Optional top-level `charts` contains up to three unique `{key,title,type,group_by,metric,value_field?}` entries. Types: `bar` or `line`; metrics: `count`, `sum`, `average`. Grouping references an existing text/select/date/checkbox field. Lines require a date field. Sum/average require a numeric `value_field`; count must omit it. Keys use lowercase ASCII identifiers, at most 32 characters; titles are nonempty, at most 80 characters. Example: `{"key":"amounts","title":"Amount by priority","type":"bar","group_by":"priority","metric":"sum","value_field":"amount"}` with corresponding select and number fields.

AI-generated definitions with charts must declare `ui.chart`. A no-AI chart starter is also available. Charts are versioned with the app and require the usual simulation and publication confirmation. Server aggregation covers all saved records in the selected tenant/app/version (1,000 records maximum across all app versions), not only the latest 100 displayed rows. Versions never mix. Missing group/metric values are excluded; zero and negative values count. Average divides by included records only. Display rounds to at most two decimals; this is not a financial ledger.

Bars show the 30 highest-valued groups. Lines show the latest 30 recorded dates chronologically, use calendar spacing and do not fill missing dates with zero. Omitted group counts are explicit. `GET /api/extensions/{id}` includes `chart_summaries` keyed by version, containing `{key,record_count,included_count,omitted_groups,points:[{label,value,count}]}`. The existing `records` list remains capped at 100. Charts are administrator-only; workbench form access does not grant chart/record reads. No records are sent to the AI provider. No SQL, executable expressions, external data sources or cross-app queries are accepted. Old definitions without charts retain their normalized shape and hashes.

### Durable read-only plans

After sample simulation, bind symbolic assignees to active, synchronized tenant members and save an immutable rule version. Administrators can explicitly authorize conversation reads and plan scheduling, publish a version, pause it and inspect recent runs. Draft changes do not replace the published version. `AUTOMATION_PLANNING_ENABLED` defaults to false. No plan executes assignments, outbound messages or refunds.

Weekly rules use Asia/Shanghai time; keyword and semantic rules support manual plans, weekly filtering or explicitly authorized new-message routing. Each run scans at most the 100 most recently mapped tenant conversations, not the full account. Keyword matching uses only the latest accessible public incoming message from the fetched page, up to 4,000 characters, never private notes or model inference. Runs have a roughly 45-second work budget and report partial results explicitly. Scheduled runs over five minutes late are skipped; manual queue entries expire after fifteen minutes. Pause cancels queued work; an in-flight read may finish. Authorization is rechecked per conversation.

Session endpoints under `/api/extensions`: `GET/POST /automation-rules`, `GET /{rule_id}/rule-versions`, `POST /{rule_id}/rule-publish`, `POST /{rule_id}/rule-pause`, `POST /{rule_id}/rule-plan`, and `GET /{rule_id}/rule-runs`. Required publication grants are `conversation.read_for_plan` and `automation.schedule_plan`. Plan results contain `mode:plan_only` and `executed:false`.

The platform atomic adapter compares snapshots and records transactional receipts. A fresh completed rotation or routing plan can be approved using `POST /{run_id}/execute-plan` with `confirm:true` and `permission:conversation.assign_plan`; check `GET /{run_id}/execution-status`. Changed state is skipped and uncertain writes are looked up, not resent. Scheduled weekly assignment needs the separate consent below; keyword/semantic automatic routing requires its own continuous grant. Tenants do not install this internal adapter, and pause cannot recall in-flight writes.

The complete parameter tables, JSON examples, request/response fields, quotas and error codes are currently maintained in the [Chinese developer reference](/platform-bricks).

The console uses same-origin `/api/extensions` session endpoints. These are **not a public third-party API-key integration**. Do not extract or share login cookies or bearer tokens. Publishing requires a successful simulation, the expected active version and explicit confirmation of the fixed app-record permissions.

Limits: 20 apps per tenant, 100 versions and 1,000 records per app; 12 fields and 8 rules per definition. Generation is limited to one request per minute and shared concurrency limits. With AI points enabled, actual usage is metered rather than capped at 20 per day. The current record view loads the latest 100 records across versions, then filters the selected live version; pagination is not available.

Use a stable idempotency key and identical input when retrying a record submission. After a timeout, refresh before creating another draft or repeating a write. Disable blocks new submissions without deleting records.

## Bounded JavaScript form logic

Optional definition property: `code: { language: "javascript", source: "return {...input, amount: input.amount * 0.8};" }`. Declare `code.execute` in the AI capability manifest. The source is a synchronous function body receiving validated current form data after rules. Return a JSON object of declared fields. Output is revalidated, never rendered as executable HTML.

Limits: 8,000 source characters; 500 ms guest execution; 2 seconds whole task; 16 MiB guest heap; 32 KiB input/output; 30 attempts per tenant per minute, including failures. The runtime container has a separate 256 MiB total memory cap and 0.5 CPU budget. These are different limits, not a claim of absolute isolation.

No Node.js, filesystem, network, modules, timers, database connection or provider credentials are exposed. Tenant records are stored only by the authenticated platform service after output validation. Simulation and explicit `code_confirmed: true` on version publication are required. New versions require new confirmation. Repeated successful submissions reuse the idempotent record and do not rerun code.

Start with the code-based discount calculator in the studio, edit JavaScript, save a new draft, simulate, publish, and optionally add it to the workbench. AI generation uses existing AI points; running this first-version script does not invoke a model.

Database: `tenant_extensions.custom_metadata` is a reserved bounded JSON object, not a public write permission. Version `runtime_metadata` records policy. `tenant_extension_code_runs` records tenant/version/actor/status/duration/error, not code inputs/outputs. This does not expose arbitrary SQL or tenant-defined database migrations.

Message routing and campaign-draft actions now have separate grants; refunds, arbitrary network and full replacement workbenches remain unavailable.

## Opt-in weekly execution (2026-09-28)

Simulate a weekly rotation, save it, bind active tenant members, then explicitly select scheduled assignment when publishing. Existing plans remain read-only. All seven weekdays implement daily schedules; arbitrary cron, one-off dates and JavaScript scheduling are not supported.

`POST /{rule_id}/rule-publish` accepts `execution_mode: "scheduled"` with `confirm:true` and permissions `["conversation.read_for_plan","automation.schedule_plan","conversation.assign_scheduled"]`. Omission or `plan_only` keeps read-only behavior. Weekly definitions may filter by keywords or semantic intent, requiring corresponding additional permissions. The independent platform gate is `AUTOMATION_SCHEDULE_EXECUTION_ENABLED`; planning and atomic assignment must also be enabled.

Each publication gets a fresh grant. Only scheduled runs born under that grant can auto-queue. Manual previews never auto-execute. Pause/republication, invalid administrators or members, changed conversation snapshots and inactive tenants block subsequent writes; in-flight requests may finish. Only complete plans less than five minutes old execute. Partial, interrupted and late plans are not replayed, and uncertain writes are receipt-only reconciled.

Each run scans at most the latest 100 mapped conversations and assigns at most `max_actions` (1–100). More mappings or read failures make the plan partial and prevent automatic dispatch. This is not an unlimited historical sweep. Shanghai time and a roughly 15-second polling interval apply. `rule-runs` exposes `schedule_execution_state` (`queued`/`skipped`) and `schedule_execution_code`; use `execution-status` for actual per-command receipts. Queued does not mean applied.

## Workspace customization and intent classification

`workbench` configures platform-owned workspace title, theme, density, list/detail widths and tool placement. Publish and add the application to the workspace, then choose its style from the top selector. Default layout remains available. Authentication, tenant isolation, data consent and explicit message sending cannot be replaced by templates. No arbitrary frontend HTML/CSS or browser scripts.

`intent: {labels: ["Refund", "Product question"]}` adds a manual classifier to that workspace tool. Each analysis requires explicit consent to send up to 20 public text messages (6,000 characters total) to the AI provider and spend AI points. Internal notes, attachments and customer profile fields are excluded; basic phone/email masking is not complete anonymization. The result only displays a configured label and model confidence; it never sends or assigns conversations. Low-confidence results abstain.

The marketplace now separates quick replies, knowledge and Studio templates at `/template-market/quick_replies`, `/template-market/knowledge` and `/template-market/studio`. Official examples cover supported capabilities. Import creates an unpublished draft without grants or schedules; review, simulate and authorize before using it.

## Routing, selected knowledge and action workflows (2026-10-09)

Rotation is labeled **“排班预览 · 授权后可启用定时转派”**: preview first, then bind members and explicitly authorize execution. Preview never executes.

Rules support `weekly`, `manual_sample` and `message_received`. Keywords use literal case-insensitive containment. Optional `semantic:{labels:["Refund enquiry"],min_confidence:0.85}` uses 1–10 unique business intents (≤30 characters each, excluding 无法判断), threshold 0.8–1, mutually exclusive with keywords. Do not classify personality/protected traits. Model confidence is not a calibrated correctness probability. Existing assignees are retained unless `overwrite_assigned:true`.

Semantic preview requires `semantic_confirmed:true` and ≤10 samples. Live plans classify ≤10 candidates using latest public incoming text and consume AI points even when unmatched or later cancelled. No private notes/attachments. Incomplete plans do not assign.

Manual plans need single-run approval; weekly continuous execution uses `execution_mode:"scheduled"`, incoming-message execution uses `"message_event"`. Recurring permissions are conversation reads, plan creation and recurring assignment; message triggers also require `conversation.message_event`, keyword rules `conversation.keyword_routing`, semantic rules `conversation.semantic_routing` and `ai.points.consume`. Republication replaces the grant. Signed events are queued without text/model calls; workers check native message identity, recency, channel ownership, current grant and atomic snapshot. Old/superseded messages are skipped; ≤100 pending/running plans per tenant, event plans older than five minutes skipped. Message rules do not execute arbitrary scripts, HTTP or broadcasts.

Generation may reference ≤3 administrator-selected currently valid published knowledge documents after per-request consent. Each excerpt is the first ≤1,200 content characters plus title/version, not whole-library retrieval. Metadata loads on demand, 20 documents/page. `GET /knowledge-options?cursor=…`; `POST /generate` accepts `knowledge_document_ids` and `knowledge_confirmed:true`. Draft, foreign, expired or unsafe sources are rejected; source changes prevent saving. Excerpts are untrusted reference data, never instructions.

Optional app `actions` (≤2 unique keys):

```json
{"actions":[
 {"key":"sync","title":"External sync","kind":"http","fields":["subject","amount"]},
 {"key":"promotion","title":"Campaign draft","kind":"campaign","name_field":"subject","content_field":"body","audience_tag_field":"product"}
]}
```

Save a form record, select it under the live app, review its payload and explicitly confirm each action. Generation/import/simulation/publication never executes actions. Only tenant administrators execute these actions, not ordinary workbench seats.

HTTP: bind a fixed public HTTPS POST endpoint per version (443 only, no query/userinfo/redirects). DNS addresses must all be public IPv4; transport pins a verified IP. Only declared record fields are sent. Optional Bearer tokens are encrypted server-side, never sent to AI or echoed. New/replaced bindings need new confirmation. Scripts remain network-free. Payload ≤24 KiB, ~10-second transport deadline, ≤8 concurrent external POSTs globally and ≤20 action attempts per tenant/minute. Each record/action executes once; uncertain outcomes are not resent. `x-replynest-action-id` supports receiver idempotency; 2xx is not proof of completed business processing.

Campaign: professional tier and an independent official account required; shared accounts rejected. It creates a draft, not a send. Continue audience/consent review, approval and scheduling in Messages & Activities using the existing executor. Optional tag field selects one customer tag, omission means all eligible opted-in recipients. Real independent-account receipt acceptance requires separate test prerequisites.

Session endpoints: GET `/{extension_id}/actions`; POST binding `{operation:"bind",version,action_key,endpoint,bearer_token?,confirm:true}`, revoke using `enabled:false`; execute `{operation:"run",version,record_id,action_key,binding_id?,confirm:true}`. HTTP requires current binding ID. Results include status and successful campaign ID. Repeated calls return the same result without resending. See the Chinese reference for complete examples and boundaries.
