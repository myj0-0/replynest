---
title: External applications API v1
---

# External applications API v1

Tenant administrators can create explicitly scoped, 90-day server-side credentials under **Platform bricks → External application access** (`/open-platform`). Tokens are shown once and can be revoked. They cannot access legacy administrator APIs.

Base URL: `https://api.replynest.cn/api/v1/open`.

Current scopes: `customers.basic.read`, `customers.contact.read`, `customers.notes.read`, `app.records.read`, `app.records.write`. Customer fields are omitted unless authorized. Records are isolated per application and tenant. The API allows 60 requests per application per minute.

Available endpoints: `GET /customers`, `GET /customers/{id}`, `GET /records`, `POST /records`. Creates require a UUID `Idempotency-Key`. Optional signed HTTPS webhooks emit `app.record.created` identifiers, with retry and at-least-once delivery. Customer modification, outbound messages, billing actions and general OAuth are not available in v1.

Workbench bricks require a separate administrator opt-in. Each agent must explicitly authorize selected customer fields before the tool can read the current conversation's customer. Consent is version-bound and revocable; data is not automatically sent to an AI model or external server.

See the [complete API reference, webhook verification example and limits](/external-apps/) in Chinese.
