---
title: 外部应用接入 API v1
description: 答巢外部应用的独立密钥、字段授权、数据接口与签名事件。
---

# 外部应用接入 API v1

第二层允许复杂业务运行在企业自己的服务器，答巢只提供已授权的数据和动作入口。它不是任意脚本插件，也不是管理员 API 的通行证。

## 当前能力与边界

| 能力 | 当前 v1 |
| --- | --- |
| 客户资料 | 按权限读取姓名、联系方式或内部备注；仅当前企业 |
| 应用数据 | 每个应用独立读取和新增扁平 JSON 记录 |
| 事件 | `app.record.created`，只包含记录 ID；HTTPS 签名推送、失败重试 |
| 管理 | 管理员逐项授权、一次性显示密钥、查看投递记录、撤销 |
| 限流 | 每应用每分钟 60 次，包括已鉴权但参数/权限错误的请求 |
| 尚未开放 | 会话全文、发送消息、修改客户、退款付款、任意网络代理、知识库全文、通用 OAuth 应用市场 |

`app.records.write` 只写此应用的数据，不会修改客户、触发 AI 自动回复或向任何渠道发消息。现有AI 定制工坊记录与外部应用记录是两套独立数据，不能混用 ID。

## 创建应用与授权

控制台 → **AI 定制工坊 → 外部应用接入 · API 授权管理**，或进入 `/open-platform`。

1. 企业管理员本人填写应用名称和权限；代登录和普通坐席不能创建密钥。
2. 逐项勾选所需权限，特别核对手机、邮箱和内部备注。默认没有任何权限。
3. 可选填自己的公网 HTTPS 事件接收地址。
4. 确认数据将由外部服务器处理后，点击“授权并创建”。
5. 立即保存 API Token，以及配置了 Webhook 时返回的验签密钥。仅显示一次。

密钥有效期为 **90 天**。仅存放在您自己的服务器密钥管理系统，不能放进浏览器、网页嵌入代码、AI 提示词或公共仓库。外部服务器无法弹出答巢浏览器授权窗，因此首次授权在创建应用时由管理员完成；没有授权不会返回敏感字段。

权限不能原地扩展。更换权限、地址或密钥时请创建新应用、切换服务器配置，再撤销旧应用。每企业最多保留 100 个应用（含已撤销）；达到上限请联系支持。

### 权限清单

| Scope | 返回或允许的字段/动作 | 敏感性 |
| --- | --- | --- |
| `customers.basic.read` | `name`, `created_at`, `updated_at` | 客户基本信息 |
| `customers.contact.read` | `phone`, `email` | 敏感，独立选择 |
| `customers.notes.read` | `support_note` | 内部备注，独立选择 |
| `app.records.read` | 此应用创建的记录 | 不包含其他应用或AI 定制工坊记录 |
| `app.records.write` | 新增此应用自己的记录 | 不修改客户，不发送消息 |

客户接口至少需要一个 `customers.*.read` 权限。`id` 始终返回；未授权字段**省略**，而不是返回占位符。不会返回上游 OpenID、令牌、任意 `attributes`、内部账户映射或其他租户信息。

## 通用协议

Base URL：`https://api.replynest.cn/api/v1/open`

```http
Authorization: Bearer rn_app_<仅保存在服务端的密钥>
Content-Type: application/json
```

不接受普通控制台会话作为外部应用密钥；新密钥也不能调用现有 `/api/v1/customers` 或管理员接口。路径中的 `v1` 是协议版本；不兼容升级使用新版本。此处接口不是控制台内部 `/api/v1/open-apps` 的替代品。

成功响应为 `{ "request_id": "UUID", "data": ... }`。错误为 `{ "request_id": "UUID", "error": { "code": "..." } }`。资源不存在和不属于此租户统一返回 404。

限流响应包含 `X-RateLimit-Limit: 60` 和 `X-RateLimit-Remaining`；429 时按 `Retry-After` 秒数等待。窗口按服务端自然分钟计，不保证突发并发吞吐。撤销和写入按应用串行协调，撤销返回后不接受新的访问；已经传出的数据无法收回。

## 读取客户列表

`GET /customers?after=<可选客户UUID>`

每页最多 50 条，按客户 UUID 排序（不是创建时间顺序）。返回的 `next_after` 为下一页参数，`null` 表示结束。分页不是数据库快照；需要持续同步时应安排重复全量扫描并按 ID 去重。

```json
{
  "request_id": "00000000-0000-4000-8000-000000000001",
  "data": {
    "items": [{"id": "00000000-0000-4000-8000-000000000002", "name": "示例客户", "created_at": "2026-09-25T00:00:00.000Z", "updated_at": "2026-09-25T00:00:00.000Z"}],
    "next_after": null
  }
}
```

上例只授权基本信息。授权联系方式后可能返回 `phone`、`email`（未填写为 `null`）；授权备注后返回 `support_note`（未填写通常为空字符串）。时间为 ISO 8601。

## 读取单个客户

`GET /customers/{customer_id}`

响应 `data` 为一个按权限裁剪后的客户对象。跨企业 ID 返回 404。

## 创建应用记录

`POST /records`，权限 `app.records.write`。

必须带 `Idempotency-Key: <UUID>`。同一应用中同一键、相同 JSON 内容重复请求返回同一条记录；不同内容返回 409 `idempotency_conflict`。网络超时后用原键、原 JSON 请求重试，不要自动换键。对象键顺序也应保持一致。

```json
{"data":{"subject":"预约安装","customer_ref":"答巢客户UUID","completed":false,"amount":199}}
```

`customer_ref` 是应用自己的普通字符串字段，不赋予访问所引用客户的权限。

字段规则：

- 最多 32 个字段；字段名匹配 `[a-z][a-z0-9_]{0,31}`。
- 不允许 `tenant_id`、`constructor`、`prototype`、`__proto__`。
- 值只允许字符串（最多 2,000 字符）、有限数字、布尔值或 `null`；不支持嵌套对象/数组。
- 单条数据 JSON 最多 16,000 字节，请求体最多 20,000 字节。
- 每应用最多 10,000 条记录；v1 不提供更新和删除接口。

响应：`data.record_id`、`data.data`、`data.created_at`。同一幂等操作只创建一次记录和一次事件。

## 读取应用记录

`GET /records?after=<可选记录UUID>`，权限 `app.records.read`。

返回 `data.items` 和 `data.next_after`，每页最多 50 条。只有该密钥所属应用的记录可见，其他应用即使同属一家企业也不可读取。

## 签名 Webhook

创建应用时填入事件 URL 后，新记录产生 `app.record.created`。不追溯创建应用前的数据，不自动订阅客户、会话或支付事件。

```json
{
  "id": "00000000-0000-4000-8000-000000000003",
  "type": "app.record.created",
  "api_version": "v1",
  "created_at": "2026-09-25T00:00:00.000Z",
  "data": {"record_id": "00000000-0000-4000-8000-000000000004"}
}
```

请求头：

- `X-ReplyNest-Event-Id`：事件 UUID。
- `X-ReplyNest-Timestamp`：发送时 Unix 秒数；每次重试重新生成。
- `X-ReplyNest-Signature`：`v1=<HMAC-SHA256 十六进制>`。

签名输入是 **时间戳 + 英文句点 + 原始请求体**。不能先解析 JSON 再序列化验签。请限制接收请求体大小、校验时间偏差（建议 5 分钟）、使用常量时间比较，并持久化事件 ID 去重。

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret, timestamp, signature, rawBody) {
  if (!/^\d{10}$/.test(timestamp ?? '')) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  if (!/^v1=[a-f0-9]{64}$/.test(signature ?? '')) return false;
  const expected = createHmac('sha256', secret)
    .update(timestamp + '.').update(rawBody).digest();
  const actual = Buffer.from(signature.slice(3), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

先验证签名，再检查头部事件 ID 与正文 `id` 一致，持久化后尽快返回 2xx。业务处理放入自己的队列。已经处理过的合法重复事件也返回 2xx。

投递语义为**至少一次**：网络中断或投递成功后进程重启都可能重复，不能假设只投递一次。单次 HTTP 最多 10 秒；失败最多尝试 8 次，退避约为 30、60、120、240、480、960、1,920 秒，另加队列调度时间。最终失败可在授权管理页“查看事件投递”中看到；v1 尚不支持手工重放。

URL 只支持公网 HTTPS、443 端口、有效证书和公网 IPv4 DNS 解析。不跟随重定向；每次投递重新检查 DNS 并将连接固定到检查过的地址，拒绝内网、环回和链路本地地址。暂不支持仅 IPv6 的接收端。

撤销应用会取消未投递事件。正在投递的请求可能先完成，撤销会等待此应用的在途操作结束。已被接收方保存的信息不能远程删除。

## 错误与排障

| HTTP | code 示例 | 处理 |
| --- | --- | --- |
| 400 | `invalid_scopes`, `invalid_record`, `invalid_cursor`, `idempotency_key_required` | 修正参数；不能通过传 `tenant_id` 切换企业 |
| 401 | `unauthorized` | 检查密钥、90 天有效期、撤销和企业状态 |
| 403 | `insufficient_scope`, `consent_required` | 回控制台由管理员明确授权，不要重试越权请求 |
| 404 | `not_found` | 检查版本、路径和本企业资源 ID |
| 409 | `idempotency_conflict` | 恢复原请求内容，或在确认为新操作时使用新键 |
| 413 | `request_too_large`, `record_too_large` | 缩小请求 |
| 429 | `rate_limited`, `record_limit`, `app_limit` | 按 Retry-After 等待或处理额度问题 |
| 503 | `open_platform_disabled`, `open_platform_unavailable` | 保存 request_id，联系平台支持 |

## 工作台中的AI 定制工坊与授权

在 [AI 定制工坊](./platform-bricks.md) 发布后，管理员点击“添加到工作台”，坐席才能在客户详情侧栏的“工作台积木”中使用。移动端先打开客户详情抽屉。默认关闭此入口，不会把全部管理员表单自动开放给坐席。

应用使用受控字段与规则，可选[受限 JavaScript 表单计算](platform-bricks.md)，不是浏览器任意脚本。坐席读取当前客户资料时，姓名、联系方式、内部备注分别授权；拒绝仍可用普通表单。授权绑定**企业、应用、版本和坐席**，90 天有效，新版本重新授权，仅当前选中会话的客户，不支持遍历企业。

资料仅在当前工作台显示，可手动填入表单，不自动发给 AI 或外部服务器。提交后成为企业内应用记录，管理员可查看；撤销不抹除已提交记录。

授权可用“撤销资料授权”取消。管理员移出工作台或停用积木后运行入口失效。外部应用密钥不能访问这些内部运行接口。

## 工作台搜索与快捷键

- 输入框 **Enter 发送**；**Ctrl+Enter 换行**，也兼容 Shift+Enter / macOS Command+Enter 换行。
- 中文输入法选词时不会发送；快捷回复列表中 Enter 先选择，不直接外发。
- 搜索支持客户姓名、电话、邮箱、内部客户备注；高级搜索增加消息内容和最后活动日期。
- 多个条件同时满足才返回。日期按北京时间，包含结束日期整天。
- 内容查询由会话引擎检索 incoming/outgoing 文本（可能包含私人便笺），不是附件内容 OCR；客户备注指客户资料中的备注。
- 每次扫描有上限，列表底部“继续查找更早的会话”代表仍有未扫描历史，不应把当前空页理解为全库无结果。切换条件会重新开始查询。

## 推荐接入顺序

先仅授权 `app.records.read/write`，验证幂等和事件验签；确有业务需要时再创建包含必要客户字段的新授权。不要把访问到的客户信息直接加入 AI 提示词或任意第三方服务；相关处理目的与授权应另行向企业和用户说明。
