---
title: AI 定制工坊开发参考
description: AI 定制工坊 D1 的能力、JSON 参数、工作流、数据权限和控制台接口参考。
---

# AI 定制工坊开发参考

版本：D1 / `schema_version: 1`，能力目录 `2026-10-09.1`，核对日期：2026-10-09。

[进入AI 定制工坊](https://console.replynest.cn/extensions)。企业管理员本人可创建、发布和管理应用；管理员另行点击“添加到工作台”后，主管和客服可在工作台使用其表单。代登录及 Copilot 嵌入会话不可用。

:::important 这是受控配置，不是任意代码插件
AI 将需求转成 JSON，由平台渲染单页表单、运行有限条件规则并保存应用内记录。支持独立受限环境中的 JavaScript 表单计算，不执行 HTML、SQL 或宿主系统代码，不安装第三方插件。以下仅描述当前已支持的能力，不代表已经开放通用开发者 API。
:::

## 1. 可以做到多细？

### 能力目录与 AI 生成边界

控制台“平台能力目录”展示同一份提供给 AI 的机器可读清单，当前版本为 `2026-10-09.1`。清单不是权限授权：`available` 为已支持的受控配置，`manual_only` 仅能经人工授权使用，`preview_only` 是预览入口，真实执行须走独立绑定与授权流程，`unavailable` 尚未开放。

生成结果必须声明 `capability_version`、`kind` 和实际使用的 `required_capabilities`。服务端独立校验定义及能力声明；未知字段、夹带动作、遗漏或额外声明能力都会被拒绝。模型遇到核心不支持的需求应返回 `unsupported`，界面展示缺少的能力，不创建一个冒充完整功能的登记表。结构校验不能代替管理员对业务含义的核对，发布前仍须模拟并确认。

| 能力 ID | 可用范围 |
| --- | --- |
| `ui.form`、`ui.table` | 表单与本应用台账 |
| `field.text/textarea/number/date/select/checkbox` | 六种字段；每个类型是独立 ID，例如 `field.text` |
| `rule.equals/not_equals/gte/gt/lt/lte/contains/starts_with/ends_with` | 九种条件；每种为独立 ID，例如 `rule.lt` |
| `event.form_submitted`、`record.create`、`record.set_field` | 提交、新增、修改本次新记录的字段 |
| `workbench.customer_context` | 仅工作台人工逐项授权，不是生成器自动数据源 |
| `preview.rotation`、`preview.keyword_routing` | 手动样本上的每周轮班、关键词分流模拟 |
| `automation.plan_management` | 人工绑定真实坐席并授权发布只读定时计划，不转派 |
| `automation.execute_plan` | 原子适配器就绪后，管理员单次授权执行完整的排班、关键词或语义分流计划；不授予 AI 自动执行权限 |
| `conversation.assign`、`schedule.execute` | 排班、关键词和语义规则可经管理员持续授权定时转派；不是任意工作流执行 |
| `event.message_received` | 已验签的公开客户消息触发已授权分流规则，不触发任意代码或群发 |
| `ui.chart` | 本应用同版本记录的柱状图、日期折线图：数量、合计、平均 |
| `ai.classify_conversation` | 坐席逐次授权后分析当前会话公开文本；不自动转派 |
| `ui.custom_workbench` | 受控布局、主题、栏目尺寸、业务表单与工具入口；安全控制不可覆盖 |
| `code.execute` | 当前表单的受限 JavaScript 业务计算，无网络或数据库访问 |
| `ai.semantic_routing` | 业务意图识别分流，逐次或持续授权，消耗 AI 点数 |
| `knowledge.read` | 生成前逐次选择并授权最多 3 份有效已发布知识摘要 |
| `http.request` | 绑定固定公网 HTTPS 地址，逐次确认外发指定记录字段 |
| `message.broadcast` | 表单记录创建营销草稿，专业版独立公众号，发送仍单独审核 |
| `payment.refund`、`sql.execute` | 尚未向生成工作流开放 |

这里的限制针对AI 定制工坊，不表示产品现有人工按钮或外部 API 没有对应能力。

### 排班预览 · 授权后可启用定时转派

可从轮班模板开始，不调用 AI；或明确要求 AI“仅模拟周一零点分配给客服 A、周二零点分配给客服 B”。只处理手动提供的合成样本，不读取真实会话、不验证真实成员、不保存规则、不启动后台任务。规则可通过“保存为持久规则”进入绑定与授权步骤；预览本身不执行。语义样本识别需单独确认并扣点，文字关键词预览不调用模型。

- `timezone`：固定 `Asia/Shanghai`。
- `trigger`：`weekly`（按周）、`manual_sample`（手动计划）或 `message_received`（新公开消息）。
- `slots`：最多 7 组，包含 `weekdays`（1–7 表示周一至周日）、`time`（HH:mm）、`assignee_ref`（负责人显示名称占位）；不能重复星期加时间。
- `keywords`：最多 10 个，每个最多 40 字符；文字包含匹配，不是 AI 语义判断。
- `statuses`：`open`、`pending` 的非空子集；已解决会话不参与。
- `overwrite_assigned`：是否在模拟中覆盖已有负责人，模板默认 `false`。
- `max_actions`：本次最多计划影响 1–100 条样本。
- 每周规则要求非空 `slots`、空字符串 `assignee_ref`；手动／消息分流规则要求空 `slots`、非空 `assignee_ref`，以及 `keywords` 或 `semantic` 二选一。

管理员会话接口：`GET /api/extensions/capabilities` 返回清单；`POST /api/extensions/automation-preview` 接收 `{capability_version, definition, samples, instant}`。`samples` 最多 100 项，每项为 `{id, text, status, assignee_ref}`，负责人可为 `null`；`instant` 为 UTC ISO 时间，如北京时间周一零点对应 `2026-09-27T16:00:00Z`。结果包含 `executed:false`、`real_conversations_read:0`、计划数量、逐项原因和后续计划时刻。它们不是对外 API Key 接口。

| 需求 | 当前实现 | 边界 |
| --- | --- | --- |
| 售后登记 | 事项、金额、类型、日期、优先级等字段；必填校验 | 不自动查询真实订单，也不退款 |
| 线索或服务需求登记 | 自定义文本、选择、复选字段，形成台账 | 不与后台客户档案自动关联 |
| 金额分级 | 金额大于等于 500，将新记录的优先级设为“优先” | 不是付款校验，金额由填写者输入 |
| 关键词标记 | 事项包含“加急”，设置内部分类字段 | 不发送通知、不指派客服 |
| 类别映射 | 类型等于“售后”，设置同一条记录的处理类别 | 不能读取其他记录或跨应用联动 |
| 双列表单 | 设置标题、说明、提交按钮、1/2 列布局、台账列顺序 | 不是自由布局设计器；窄屏自动单列 |
| 版本发布 | 草稿、预览、模拟、确认权限后发布、停用、重新发布旧版本 | 老版本数据不自动迁移 |

普通条件规则不提供公式或 AND/OR 条件组；算术可用下文受限 JavaScript。周轮班定时转派独立授权，不是任意定时工作流。附件字段、关联表、已有记录修改/删除、搜索分页/导出、公开表单或独立子页面仍不支持。登记预约时间不会自动检查冲突或发提醒。

## 2. 能获取哪些后台数据？

### 自定义统计图表

“AI 定制工坊”是原“平台积木”的新名称，页面路径 `/extensions`、接口路径、已保存应用和权限不变。

可描述“建立售后登记表，按优先级统计金额，按登记日期统计每天数量”，由 AI 生成带图表的草稿；也可点击“从统计图表模板开始（不调用 AI）”。图表随应用版本一起保存，须模拟、确认并发布。高级 JSON 的可选顶层字段 `charts` 示例：

```json
{"charts":[{"key":"priority_amount","title":"各优先级金额","type":"bar","group_by":"priority","metric":"sum","value_field":"amount"}]}
```

此示例需同时定义 `priority`（select/text）和 `amount`（number）字段，不能作为完整应用定义独立提交。

| 参数 | 约束 |
| --- | --- |
| `charts` | 可省略；最多 3 项；省略时旧定义和哈希保持兼容 |
| `key` / `title` | 唯一小写字母开头标识，最长 32 字符 / 非空标题，最长 80 字符 |
| `type` | `bar` 柱状图或 `line` 日期折线图 |
| `group_by` | 本应用字段 key，只允许 text/select/date/checkbox；折线图必须为 date |
| `metric` | `count` 数量、`sum` 合计、`average` 平均 |
| `value_field` | 合计/平均必填且须引用 number 字段；数量必须省略 |

图表在服务器统计当前企业、当前应用、当前定义版本的已保存记录，覆盖该版本全部记录（应用所有版本合计最多 1,000 条），不是最近 100 条台账的抽样。不同版本不混合，模拟记录不保存、不计入。缺少分组或数值的记录跳过，零和负数正常参与，平均值的分母仅为纳入记录数；数值显示最多两位小数，不是财务账本。柱状图按数值降序最多展示 30 组；折线图展示最近 30 个有记录的日期，按日历时间排列，不自动补零。超出组数明确提示，绝不暗中合并为“其他”。

`GET /api/extensions/{id}` 返回可选 `chart_summaries`，以版本号为 key，每项包含 `key`、`record_count`、`included_count`、`omitted_groups`、`points:[{label,value,count}]`。原 `records` 仍只返回最近 100 条。图表仅企业管理员本人可查看，客服工作台仅有表单提交权限的坐席不会因此获得应用记录或图表读取权限。

生成器须声明 `ui.chart`，服务器再次校验。没有数据源 URL、SQL、脚本、跨应用查询，也不自动读取会话、客户或账单；统计记录不会发送给 AI。未知字段或字段类型不匹配会拒绝保存。已支持受控工作台配置与受限 JavaScript 计算；营销草稿动作已开放，但不会未经审核自动群发；退款、任意 SQL 或宿主代码仍未开放。

### 持久规则与定时计划

实验室模拟通过后，可选择“保存为持久规则”，逐项将负责人占位绑定到本企业已同步且有效的坐席。此流程与表单应用独立，规则草稿持久保存，每次修改新增版本；新草稿不会覆盖已发布版本。最多 20 条规则、每条 100 个版本。

发布需要企业管理员本人确认 `conversation.read_for_plan` 与 `automation.schedule_plan`。这只授权读取和生成计划，**不授权自动转派或对外发送**。平台开关 `AUTOMATION_PLANNING_ENABLED` 默认关闭，关闭时仍可保存草稿和暂停规则。

每周规则按北京时间调度，可带关键词或语义筛选；`manual_sample` 只按人工请求生成计划；`message_received` 在持续授权后监听已验签的新公开入站消息，一次处理该消息所属会话。手动运行每周规则时，按下一次排班时刻生成计划。关键词只读取最近一页可获取消息中的最新公开入站文本，最多前 4,000 字符，进行字面包含匹配；不读取私人便笺，不发送给 AI。

每次最多扫描本企业最近映射的 100 条会话，最长工作预算约 45 秒（正在进行的读取可能稍后返回）。这不是全量会话扫描；未映射会话和更早的映射不在本次范围。达到扫描上限或部分读取失败会明确标记“部分完成”，`max_actions` 进一步限制计划影响数量。结果只保留会话标识、负责人和判断原因，不保存消息正文。

调度周期约 15 秒，共享全局最多 4 个并行计划、每企业 1 个；同一规则同一计划时刻去重。晚于计划时刻 5 分钟的定时任务标为 `missed`，不补跑；手动计划排队超过 15 分钟取消。工作进程中断的计划不会当作成功，也不盲目重试。暂停取消排队任务，正在进行的只读请求可能完成；每条会话前都会复核发布者、企业、目标成员及启用状态。

真实转派依赖平台原子适配器，在同一事务中比较快照、转派并记录幂等回执，还需独立执行开关。只读计划仍标记 `mode:plan_only`、`executed:false`；实际转派另有命令及回执，不把计划数量当作已执行数量。按周执行见下文，租户不需要自行安装适配器。

管理员可对“完整完成、5 分钟内、具有原子快照的排班或分流计划”单独确认执行一次。需要权限确认 `conversation.assign_plan`，不继承发布计划的只读授权。旧计划无快照时必须重新生成。快照检查账户、会话、负责人、机器人、状态及微秒更新时间；期间任何状态变化均不覆盖。新请求幂等到每个计划中的每条会话。后台再次复核发布者、执行批准者、目标坐席与规则启用状态。暂停阻止后续尚未开始的命令，已发出的请求可能完成。

超时或中断标记 `uncertain`，只查已提交命令回执，不盲目重派；无回执不等于失败。除逐次审批外，周计划和消息分流可独立授权持续执行；旧只读授权不扩展。语义规则读取公开入站文本并按实际模型用量扣 AI 点数，低置信度或无法判断不转派。工作台手动意图分类仍不自动转派。

控制台会话接口（不是第三方 API Key 接口）：

| 方法与路径（前缀 `/api/extensions`） | 参数 / 返回 |
| --- | --- |
| `GET /automation-rules` | 规则、可绑定成员、权限清单、平台计划与执行开关 |
| `POST /automation-rules` | `definition`；修改时附 `rule_id`、`expected_revision`。负责人字段必须为成员 UUID |
| `GET /{rule_id}/rule-versions` | 当前规则及最近版本 |
| `POST /{rule_id}/rule-publish` | `revision`、`expected_active_revision`、上述完整 `permissions`、`confirm:true` |
| `POST /{rule_id}/rule-pause` | 空对象；取消待处理计划 |
| `POST /{rule_id}/rule-plan` | 空对象；当前已发布规则排队生成计划，每企业每分钟最多一次 |
| `GET /{rule_id}/rule-runs` | 最近 30 次运行；包含逐条结果、部分完成/取消/失败等状态 |
| `POST /{run_id}/execute-plan` | `confirm:true`、`permission:conversation.assign_plan`；将本次计划排队，非立即完成 |
| `GET /{run_id}/execution-status` | 逐条命令回执：pending/sending/applied/state_changed/rejected/command_conflict/uncertain/cancelled |

常见错误：`rule_member_binding_required`（未绑定）、`rule_member_unavailable`（坐席无效）、`version_conflict`、`permission_confirmation_required`、`planning_disabled`、`plan_rate_limited`。修改与发布使用版本检查防止覆盖；规划结果可在控制台查看，发布、暂停与运行摘要同时进入审计。

必须区分“控制台接口返回的数据”和“工作流执行时可用的数据”。接口返回元信息，不表示工作流可以使用这些变量。

| 数据 | 控制台接口 | AI / 工作流能否直接读取 |
| --- | --- | --- |
| 当前企业的应用列表、名称、启用状态、线上版本 | 可以 | 工作流不能遍历应用 |
| 当前应用的定义、版本、配置摘要、模拟状态 | 可以 | AI 只接收本次需求及平台定义；不会自动加载旧版本定义 |
| 当前应用最近 100 条记录、记录版本和创建时间 | 可以 | 工作流不能查询历史记录 |
| 本次表单输入 | 可提交、模拟，正式提交后保存 | 工作流唯一的业务输入；模拟/运行不调用 AI |
| 租户 ID、创建者 ID、时间戳等元信息 | 部分随应用/版本响应返回 | 只读元信息，不能作为工作流系统变量 |
| 客户姓名、手机号、邮箱、内部备注 | 工作台定制工具专用入口，当前坐席逐项授权后读取当前客户 | 不自动传给 AI；不开放会话全文和昵称头像授权接口 |
| 企业知识库 | 生成前按页选择已发布文档，再逐次授权摘要读取 | 默认不读取；不能用模型输出选定其他文档 |
| AI 推荐回复、订单、支付与退款、套餐 | 不通过AI 定制工坊接口提供 | 不可直接读取或修改 |
| AppSecret、渠道 Token、AI 服务密钥、服务器环境变量 | 不提供 | 不可读取 |

没有 `$customer`、`$tenant`、`$now`、`{{客户姓名}}` 等变量替换机制。字段名叫 `customer_name`，也只是管理员手动填写的普通文本，不会自动绑定真实客户。

租户归属由服务端登录会话决定，不能传 `tenant_id` 选择其他企业。AI 生成默认只发送需求和平台结构定义；你可逐次选定并授权知识摘要，不自动发送客户资料；请不要在需求中粘贴密钥和真实客户隐私。

## 3. 完整配置示例

可以先用 AI 生成或从售后模板开始，再在“高级：查看 / 调整受控 JSON”中保存新版本。该编辑器填写的是下面的定义本体，不需要包一层 `definition`。

```json
{
  "schema_version": 1,
  "name": "售后登记",
  "description": "登记内部售后事项，不发送客户消息。",
  "page": {
    "title": "售后登记台",
    "description": "提交表单后按规则标记优先级。",
    "columns": 2,
    "submit_label": "登记事项"
  },
  "fields": [
    { "key": "subject", "label": "事项", "type": "text", "required": true },
    { "key": "amount", "label": "金额", "type": "number", "required": true },
    { "key": "priority", "label": "优先级", "type": "select", "required": true, "options": ["普通", "优先"] }
  ],
  "table_columns": ["subject", "amount", "priority"],
  "workflow": {
    "trigger": "form.submitted",
    "rules": [
      {
        "name": "高金额标记优先",
        "when": { "field": "amount", "operator": "gte", "value": 500 },
        "then": { "field": "priority", "value": "优先" }
      }
    ]
  }
}
```

### 顶层及页面参数

所有下列属性均必填。未知属性会被拒绝，不支持添加 `script`、`html`、`api_url` 等自定义动作。

| 参数 | 类型 / 限制 | 说明 |
| --- | --- | --- |
| `schema_version` | 数字，固定 `1` | 配置格式版本，不是应用草稿版本 |
| `name` | 非空字符串，最多 60 | 应用名称 |
| `description` | 非空字符串，最多 400 | 应用说明 |
| `page.title` | 非空字符串，最多 80 | 表单标题 |
| `page.description` | 非空字符串，最多 400 | 表单说明 |
| `page.columns` | 数字 `1` 或 `2` | 大屏列数，窄屏单列 |
| `page.submit_label` | 非空字符串，最多 30 | 正式提交按钮文字 |
| `fields` | 1–12 个字段 | 见下表 |
| `table_columns` | 1–12 个不同字段 key | 必须引用已有字段；数组顺序即展示顺序 |
| `workflow.trigger` | 固定 `form.submitted` | 仅提交时触发；模拟也使用相同规则 |
| `workflow.rules` | 0–8 条规则 | 空数组表示按原值保存 |

字符串长度按 JavaScript 字符串长度计算，emoji 等字符可能占多个长度单位；非空文本会去掉首尾空白，部分控制字符被拒绝。定义序列化后最多 24,000 UTF-8 字节。

### 字段参数与值类型

每个字段必须有 `key`、`label`、`type`、`required`。只有 `select` 必须填写 `options`，其他类型不允许此属性。

| 参数 | 限制 |
| --- | --- |
| `key` | 匹配 `^[a-z][a-z0-9_]{0,31}$`，字段间不能重复；保留 `id`、`tenant_id`、`constructor`、`prototype`、`__proto__` |
| `label` | 非空字符串，最多 60 |
| `required` | 布尔值 `true` / `false`，不是字符串 |
| `options` | 1–12 个互不重复的非空字符串，每项最多 60 |

| `type` | 提交值 | 校验 / 展示 |
| --- | --- | --- |
| `text` | 字符串 | 最多 200；单行输入 |
| `textarea` | 字符串 | 最多 2,000；多行输入 |
| `number` | JSON 数字 | 必须有限，绝对值不超过 1,000,000,000,000；允许小数和负数，不接受数字字符串 |
| `date` | `YYYY-MM-DD` 字符串 | 必须为真实日历日期，不支持时间或时区字段 |
| `select` | 字符串 | 必须等于某个 `options` 值，单选 |
| `checkbox` | JSON 布尔值 | `false` 也是有效值；`required:true` 不代表必须勾选 |

缺省、`null`、空字符串对必填字段报错；对非必填字段视为未填写，不保存该字段。纯空白字符串不算合法非空文本。界面复选框默认提交 `false`。不支持 `default`、`min`、`max`、正则、自定义校验或隐藏字段等额外配置。

## 4. 工作流规则

每条规则包含 `name`（非空，最多 80）、`when` 和 `then`。

| 参数 | 说明 |
| --- | --- |
| `when.field` | 当前定义中已有字段的 key |
| `when.operator` | 下表列出的九种操作符之一 |
| `when.value` | 与条件字段类型一致的常量 |
| `then.field` | 当前定义中已有字段的 key |
| `then.value` | 与目标字段类型一致的常量；选择字段必须是合法选项 |

| 操作符 | 可用字段 | 语义 |
| --- | --- | --- |
| `equals` | 全部六种类型 | 严格相等，不自动转换字符串与数字 |
| `not_equals` | 全部六种类型 | 严格不等于；可选字段未填写时不命中 |
| `gte` | `number` | 大于或等于 |
| `gt`、`lt`、`lte` | `number` | 分别为大于、小于、小于或等于；不支持字符串数字或日期比较 |
| `contains` | `text`、`textarea` | 区分大小写的子串匹配，不是正则或语义匹配 |
| `starts_with`、`ends_with` | `text`、`textarea` | 区分大小写的开头、结尾字面匹配；不支持正则 |

例如“金额小于 100 标记普通”“产品编码以 VIP 开头标记优先”“状态不等于已完成时标记待跟进”，都仅修改本次表单记录。条件值仍必须符合字段类型；选择字段使用已有选项。所有操作符在可选字段未填写时都不命中。无需新增权限，但更新后的应用仍需管理员审核发布；能力开放不等于自动授权外部动作。

执行顺序：先验证输入 → 保留原始输入快照 → 按规则数组顺序逐条判断 → 命中时给同一条新记录赋值。

- 所有条件都读取原始输入，后一个条件不会看到前一个规则刚修改的值。
- 多条规则修改同一字段时，最后命中的规则覆盖之前的赋值。
- `then.value` 是常量，不支持复制另一个字段、插值或计算表达式。
- 必填字段必须在输入中提供，不能先省略再期待规则补齐。
- 不读取历史台账、其他应用或真实业务表；没有外部副作用。

提交 `{"subject":"合成事项","amount":600,"priority":"普通"}` 时，上述例子输出：

```json
{
  "data": { "subject": "合成事项", "amount": 600, "priority": "优先" },
  "trace": [{ "rule": "高金额标记优先", "matched": true, "field": "priority" }],
  "external_effects": false
}
```

这里是规则结果本体。HTTP 接口还会包裹外层 `data`，所以 HTTP 响应中的记录值路径是 `data.data`。

## 5. 控制台接口参考

:::caution 不是第三方 API Key 接口
以下是当前控制台使用的会话接口，用于解释参数和行为。必须是已登录、选定企业的真实企业管理员会话。企业 API Key 不支持这些接口；不要提取、复制或交给第三方你的登录 Cookie / Bearer Token。跨站网页、AI 生成页和插件不能通过此文档获得额外权限。
:::

控制台同源路径：`https://console.replynest.cn/api/extensions`。POST 需要合法同源 Origin 和 JSON 请求体。控制台服务端转发至 `/api/v1/extensions` 并处理会话认证，租户无需填写服务端密钥。下表路径均相对控制台基础路径，`{id}` 为服务端返回的应用 UUID。

| 方法 / 路径 | 请求参数 | 成功结果 |
| --- | --- | --- |
| `GET /` | 无 | 200；应用列表、模型配置状态、权限、模板和限额 |
| `POST /` | `{ "definition": 配置本体 }` | 201；新应用 V1 草稿 |
| `POST /generate` | `prompt`；可选 `extension_id`、`knowledge_document_ids`、`knowledge_confirmed` | 201：AI 应用草稿；200：规则预览草稿；422：需求能力未开放 |
| `GET /{id}` | 无 | 200；应用、最多 100 个版本、最近 100 条记录、权限 |
| `POST /{id}/versions` | `{ "definition": 配置本体 }` | 201；已有应用的新草稿版本 |
| `POST /{id}/simulate` | `version`、`input` | 200；规则结果及执行轨迹，不保存表单记录 |
| `POST /{id}/publish` | `version`、`expected_active_version`、`permissions` | 200；`enabled:true` 和 `active_version` |
| `POST /{id}/disable` | 空对象 `{}` | 200；`enabled:false`，数据保留 |
| `POST /{id}/records` | `version`、`input`、`idempotency_key` | 200；记录 UUID、规则结果和轨迹；重复提交返回原记录 UUID |

接口不接受额外属性，当前不提供 PATCH / DELETE 或分页查询参数。

### 生成与版本

`prompt` 去掉首尾空白后至少 4、原始长度最多 3,000；`extension_id` 省略或为 `null` 创建新应用，提供 UUID 则为该应用生成新版本。模型与接口地址由平台配置，租户不能指定。

**为旧应用生成新版本不会自动把旧版本 JSON 发给模型。** 请在需求中完整描述要保留的字段和规则，或直接在高级 JSON 编辑器修改。生成成功只是保存草稿，不会发布或覆盖线上版本。

创建/保存版本返回：`extension_id`、整数 `version`、校验后的 `definition`、`definition_hash`。应用生成额外返回 `kind:app`、`capability_version`、`generation.input_tokens`、`generation.output_tokens`。模拟规则生成返回 `kind:automation_preview`、`definition`、`capability_version`、`persisted:false`、`executable:false`，不创建应用版本。不支持的需求返回 `unsupported_capabilities`、`missing_capabilities`、`missing_labels`。

### 模拟请求

```json
{
  "version": 1,
  "input": { "subject": "合成事项", "amount": 600, "priority": "普通" }
}
```

`version` 是应用版本正整数，不是 `schema_version`。`input` 仅允许当前定义中的字段 key。成功模拟保存通过标记和审计，不保存样例表单数据；变更定义生成新版本后需重新模拟。

### 发布请求

```json
{
  "version": 1,
  "expected_active_version": null,
  "permissions": [
    "extension.records.read",
    "extension.records.create",
    "extension.records.transform"
  ]
}
```

首次发布 `expected_active_version` 为 `null`；已有线上版本时，必须填刚读取的 `app.active_version`。版本不一致返回 409，请刷新确认，不要盲目覆盖。停用不清空 `active_version`，重新启用时也必须带原值。

权限数组必须与接口返回的值及顺序一致，分别代表读取本应用记录、新增记录、转换新记录字段，不代表读取全部客户或修改历史记录。必须先对该版本成功模拟。重新发布旧版本可回退应用逻辑，但不会撤销已经保存的数据。

### 正式提交与重试

```json
{
  "version": 1,
  "input": { "subject": "合成事项", "amount": 600, "priority": "普通" },
  "idempotency_key": "5e515775-07da-4f37-a1f2-5d7c56fdbe81"
}
```

示例 UUID 仅作格式参考；每次新的提交应生成新 UUID。同一次请求因网络失败重试时，保留原 UUID 和完整请求输入。当前实现按序列化输入计算摘要，重试时也应保持字段顺序不变。同一幂等键配不同输入会报 `idempotency_conflict`。

应用必须已启用，且 `version` 等于线上版本。新建成功时返回 `record_id`、`data`、`trace`、`external_effects:false`；重复提交返回 `record_id`、`replayed:true`，不会再次返回完整规则结果。停用/切换版本后，旧提交重试可能先被版本检查拒绝，请读取台账确认，不要自动创建新键重复提交。

### 响应格式与可读字段

正常网关响应为 `{"request_id":"...","data":{...}}`；失败为 `{"request_id":"...","error":{"code":"..."}}`。若错误产生在控制台代理层，可能没有 `request_id`。

| 位置 | 可读字段 |
| --- | --- |
| 列表 `data` | `apps`、`ai_configured`（仅表示存在配置，不保证请求成功）、`capabilities`、`automation_preview_example`、`permissions`、`starter_definition`、`limits`、`audience` |
| `apps[]` / 详情 `app` | `tenant_id`、`extension_id`、`name`、`enabled`、`active_version`、`created_at`、`updated_at`；列表额外有 `latest_version` |
| 详情 `versions[]` | `tenant_id`、`extension_id`、`version`、`definition`、`definition_hash`、`created_by`（用户 UUID）、`created_at`、`simulated` |
| 详情 `records[]` | `record_id`、`version`、`data`、`trace`、`created_at` |
| `trace[]` | `rule`（规则名）、`matched`（布尔）、`field`（目标字段） |

应用列表最多 20 个，按应用更新时间降序；版本按版本号降序。详情返回应用所有版本合计的最近 100 条记录，界面再过滤当前线上版本；不是“每版本 100 条”。历史数据保留，但当前没有更早记录的分页接口。时间戳由服务端产生，只读。

## 6. 限额和错误处理

| 项目 | 当前限制 |
| --- | --- |
| 每企业应用数 | 20（停用应用仍占用） |
| 每应用版本数 / 总记录数 | 100 / 1,000（包含历史版本记录） |
| 每版本字段 / 规则 | 12 / 8 |
| 每企业 AI 生成 | 每分钟 1 次；滚动 24 小时 20 次 |
| 平台共享 AI 生成额度 | 滚动 24 小时 200 次，同时最多 3 个处理中请求；其他企业用量可能导致限流 |
| 失败生成 | 已预留生成额度的失败请求仍计数 |
| POST 请求体 / 定义 | 32,000 UTF-8 字节 / 24,000 UTF-8 字节 |

| HTTP | 常见 `error.code` | 处理方式 |
| --- | --- | --- |
| 400 | `invalid_json`、`invalid_definition`、`required_field_missing` | 检查 JSON、未知字段、值类型及必填项；类型错误也可能统一报 invalid_definition |
| 400 | `invalid_prompt`、`invalid_extension_id`、`invalid_version`、`invalid_idempotency_key` | 修正参数 |
| 400 | `permission_confirmation_required` | 核对权限后明确确认发布 |
| 401 / 403 | `unauthorized`、`forbidden`、`session_scope_forbidden` | 检查登录、选定企业、管理员身份、会话类型与请求来源 |
| 404 | `not_found` | 资源不存在、不属于当前企业，或路径不支持 |
| 409 | `simulation_required`、`version_conflict`、`extension_not_active`、`idempotency_conflict` | 模拟或刷新核对状态，不能盲目重试写入 |
| 413 | `request_too_large` | 缩小请求体 |
| 429 | `generation_budget_exceeded`、`extension_limit`、`version_limit`、`record_limit` | 等待生成窗口恢复，或联系支持了解资源上限 |
| 502 | `qwen_invalid_definition`、`qwen_invalid_response` | 输出未通过校验，未发布；修改需求或稍后重试 |
| 503 | `extensions_disabled`、`extensions_unavailable` | 功能关闭或服务暂不可用；先刷新确认结果 |
| 503 | `qwen_not_configured`、`qwen_configuration_invalid`、`qwen_unavailable`、`qwen_request_failed`、`qwen_rate_limited` | 平台检查模型服务；不要向前端提供密钥 |

网络超时或 5xx 不保证操作完全没有完成。先刷新应用/台账核对；记录提交复用原幂等键；生成操作没有客户端幂等键，刷新确认后再决定是否重试，避免重复草稿和额度消耗。

## 7. 安全与后续能力

发布前请检查字段和规则，先用合成数据模拟。本版的“智能”用于搭建草稿，不代表每次填表都会调用 AI，也不会打开客服自动回复/自动发送。

工作台入口、当前客户资料授权及外部接口见 [API v1](./external-apps.md)，不会因更改应用 JSON 自动开启。受控工作台布局、生成参考知识摘要、受控外部接口与营销草稿已支持；任意导航、多子页面和直接自动群发仍不支持。产品的[知识库自动接待](automatic-reception.md)独立授权，不继承生成摘要的授权；不要用 URL、SQL 或密钥绕过限制。

## 受限 JavaScript 业务逻辑

定义可以增加以下可选字段；AI 生成时必须同时声明能力 `code.execute`：

```json
{
  "code": {
    "language": "javascript",
    "source": "return {...input, amount: Math.round(input.amount * 0.8 * 100) / 100};"
  }
}
```

`source` 是函数正文，参数 `input` 是本次表单经过校验和规则处理后的数据。返回已声明字段组成的 JSON 对象；只能修改当前新记录。计算结果字段应设为非必填，避免要求用户先填写结果。输出重新校验字段、类型、长度和必填要求，不作为 HTML 执行。

| 限制 | 当前值 |
| --- | --- |
| 源码 | 8,000 个字符 |
| 脚本执行时间 / 整个任务 | 500 毫秒 / 2 秒 |
| 脚本堆内存 | 16 MiB |
| 输入与输出 | 各 32 KiB |
| 每企业执行频率 | 每分钟最多 30 次，失败也计数 |
| 独立运行容器 | 总内存 256 MiB、0.5 CPU、64 PID；单任务执行 |

脚本堆上限与容器总内存不同。运行时有启动和引擎开销；这些是风险控制措施，不是绝对隔离或零漏洞保证。运行器不挂载业务文件，不接收数据库或模型密钥，不暴露公网端口；只加入独立内部网络。脚本没有 Node.js、文件、网络、模块加载、定时器、数据库连接或外部动作入口。

体验路径：AI 定制工坊 → **体验可编程折扣报价器** → 填写样例 → 模拟 → 编辑脚本并保存新草稿 → 再次模拟 → 勾选脚本数据处理权限并发布 → 按需添加到客服工作台。示例和脚本运行本身不调用模型；AI 生成仍按已有点数规则计费。

发布接口对含代码的版本额外要求 `code_confirmed: true`，否则返回 `code_confirmation_required`。超时、资源超限或结果非法不会保存业务记录；已成功提交的相同幂等键不重复运行。常见错误：`code_timeout`、`code_execution_failed`、`code_resource_limit`、`code_invalid_output`、`code_runner_busy`、`code_rate_limited`。

预留数据结构：
- `tenant_extensions.custom_metadata`：限 8 KiB 的 JSON 对象，预留应用扩展元数据；不等于对外授权写入。
- `tenant_extension_versions.runtime_metadata`：保存运行策略快照。
- `tenant_extension_code_runs`：按租户、应用、版本和操作人记录状态、耗时、错误，不存表单正文或输出；限流查询有租户时间索引。

自动消息事件、群发、退款、任意网络及完整替换工作台仍为独立能力，不因为开放 JavaScript 就获得这些权限。定时轮班转派采用下面的独立授权流程。

## 按周定时执行

现在支持“先模拟 → 保存规则 → 绑定本企业坐席 → 明确授权按周自动转派”。可设置周一/三/五客服 A、周二/四/六客服 B，或一条时间段选择全部七天实现每日执行。时区固定北京时间；当前不支持任意 cron、一次性日期或定时运行 JavaScript。

在规则发布区勾选 **启用持续自动转派**，再核对版本、覆盖已有负责人策略与数量上限，确认授权。旧规则保持只读，不自动升级。AI 仅生成可模拟的草稿，不能授予权限、选择真实成员或启动任务。

`POST /{rule_id}/rule-publish` 新增 `execution_mode`：省略或 `plan_only` 仅生成计划；`scheduled` 需要 `confirm:true` 和完整权限数组 `["conversation.read_for_plan","automation.schedule_plan","conversation.assign_scheduled"]`。允许 `trigger:weekly`，可筛选文字关键词或语义意图；有关键词时额外确认 `conversation.keyword_routing`，有语义时额外确认 `conversation.semantic_routing` 与 `ai.points.consume`，平台调度及原子转派开关须可用。平台另设 `AUTOMATION_SCHEDULE_EXECUTION_ENABLED` 总开关。

后台只自动排队在该次授权下产生、完整完成、有原子快照且完成不超过五分钟的定时计划。手动“生成一次真实会话计划”仍不自动执行。重新发布会更换授权标识，旧任务不能借用新授权；暂停、管理员/目标成员失效、租户停用都会阻止后续写入。已发出的请求可能完成。

每轮仍最多扫描最近映射的 100 条会话，单轮转派不超过 `max_actions`（1–100）。存在更多映射或读取失败时标记部分完成，不自动执行，不能理解为“全量转派全部历史会话”。迟到超过五分钟不补跑。不确定写入只查回执，不重发。

`rule-runs` 返回 `schedule_execution_state`（`queued` / `skipped`）及 `schedule_execution_code`。`queued` 不是成功计数；通过 `execution-status` 查看每条命令的 `applied`、`state_changed`、`cancelled`、`uncertain` 等结果。规则暂停按钮和运行记录始终保留。

## 工作台样式与意图分类

应用可增加 `workbench` 配置：`title`、`theme`（blue/emerald/violet）、`density`（comfortable/compact）、`list_width`（260/320/380）、`details_width`（280/360/440）、`tools_position`（before_profile/after_profile）。发布并“添加到工作台”后，在工作台顶部选择样式。可随时恢复默认；小屏保留客户资料抽屉。模板不支持覆盖登录、租户权限、资料授权或发送控制，也不执行任意 HTML/CSS/浏览器脚本。

应用可增加 `intent: {labels: ["退款咨询", "产品咨询"]}`，最多 10 个不重复标签，每个最多 30 字，不包含系统保留的“无法判断”。在工作台工具内逐次确认，才会读取当前会话最近最多 20 条公开文字（合计 6,000 字，每条最多 1,000 字），发送至平台 AI 服务并消耗 AI 点数。不读取内部备注、附件、客户资料字段；常见号码和邮箱遮蔽不保证完全匿名化。模型置信度低于 0.6 时显示“无法判断”；置信度不代表经校准的正确率。结果不发消息、不转派、不写入客户资料，仍需人工核对。

## 官方模板与分类目录

模板市场有独立的“快捷回复”“知识库”“AI 定制工坊”目录；发现、已领取与我的投稿均按类型分页。官方免费示例包括业务表单与图表、文本条件、折扣脚本、售后工作台与意图助手、轮班与定时执行指南、关键词样本实验。

工坊模板导入为新应用 V1 草稿，不发布、不授权、不运行代码、不安装定时任务。先查看步骤并模拟，再按需发布/添加到工作台；轮班模板还要独立绑定真实坐席并授权执行。应用中的 `automation_preview` 是独立规则草稿，仍须保存、绑定和授权；不会随表单发布自动执行。模板来源与免费使用许可随导入保留。

## 新公开消息分流与 AI 语义规则

关键词规则按最新公开客户文字做不区分大小写的包含匹配，不调用模型；例如“退款”“退货”转派客服主管。语义规则支持相近表达，例如“钱可以退回吗”，但只识别管理员声明的业务意图，不判定人格、受保护特征或客户“好坏”。

`semantic: {labels:["退款咨询"], min_confidence:0.85}`：1–10 个唯一业务意图，每项最多 30 字，不包含“无法判断”；阈值 0.8–1，与非空 `keywords` 互斥。默认保留已有负责人，需改为 `overwrite_assigned:true` 才会考虑改派。阈值是规则门槛，不是经过校准的正确率。

`POST /automation-preview` 使用语义样本时必须带 `semantic_confirmed:true`；最多 10 条样本，并计 AI 点数。真实批量计划同样最多识别 10 条，超限或不完整计划不转派；模型已完成的调用仍可能计费。输入仅为符合规则范围的最新公开入站文字，常见邮箱／号码遮蔽不等于完全匿名化，私人便笺和附件不读取。

消息规则例子（`assignee_ref` 在保存时换成本企业真实成员 UUID）：

```json
{
  "schema_version":1,"name":"退款咨询交给主管","timezone":"Asia/Shanghai",
  "trigger":"message_received","slots":[],"assignee_ref":"客服主管",
  "keywords":[],"semantic":{"labels":["退款咨询"],"min_confidence":0.85},
  "statuses":["open","pending"],"overwrite_assigned":false,"max_actions":10
}
```

保存后勾选持续自动转派，发布请求使用 `execution_mode:"message_event"`；完整权限按顺序为 `conversation.read_for_plan`、`automation.schedule_plan`、`conversation.assign_scheduled`、`conversation.message_event`，最后按规则附关键词或语义／扣点权限。纯只读发布仍使用前两项并附消息／筛选权限，不开启自动处理。

只接收平台已验签的公开客户入站事件，服务端从渠道绑定确定归属；队列不保存正文。工作器重新读取原生会话和最新公开消息；旧消息、已被后续消息替代、渠道绑定改变或授权已更换时跳过。按规则和消息去重，每企业待处理／处理中最多 100 个计划；晚于 5 分钟不补跑。消息规则不执行任意 JavaScript、外部接口或群发，这些是不同授权边界。

## 生成时参考企业知识

点击“选择企业知识”后才按页加载文档元信息，每页 20 条；最多选 3 份当前有效、已发布且安全处理完成的文档。每次生成需重新勾选同意：每份最多取正文前 1,200 字符，连同标题和版本给模型参考，并计入实际 AI 用量。不是全库读取或自动检索全部聊天。文档摘要是参考数据，不是系统指令；生成期间来源变更则拒绝保存。

接口：`GET /knowledge-options?cursor=…`；`POST /generate` 增加 `knowledge_document_ids:[UUID,…]` 和 `knowledge_confirmed:true`。未选择时不读取正文，未授权／他企业／草稿／过期文档拒绝使用。

## 外部接口与营销工作流动作

可在应用定义增加 `actions`（最多 2 个唯一 key），也可让 AI 生成以下配置。执行入口在“已发布应用”下方：先提交并保存记录，再选择记录、核对数据并逐次确认。生成、模拟、导入或发布本身不执行动作；客服工作台普通坐席没有这些管理员动作权限。

```json
{
  "actions":[
    {"key":"sync","title":"同步外部售后台账","kind":"http","fields":["subject","amount"]},
    {"key":"promotion","title":"创建促销群发草稿","kind":"campaign",
     "name_field":"subject","content_field":"body","audience_tag_field":"product"}
  ]
}
```

字段须在应用中声明；营销字段只允许 text/textarea/select。HTTP 只外发 `fields` 中该条记录已填的数据，不自动附客户、聊天或企业资料。管理员为每个应用版本绑定固定公网 HTTPS POST 地址：仅端口 443、无查询参数／URL 凭据，不跟随重定向，逐次解析 DNS 并拒绝内网地址，再固定到已验证 IP。Bearer Token 可选，只存服务端加密副本，不送模型、不在接口回显；更换地址或新版本须重新绑定。脚本沙箱仍无网络能力。

外发正文最多 24 KiB，传输约 10 秒上限；全局最多 8 个外部 POST 并行，每企业每分钟最多 20 次动作尝试。每条记录的每个动作只执行一次；超时／中断标记结果待核对，不自动重发。平台提供 `x-replynest-action-id` 供接收方幂等处理。接口 2xx 仅表示受理，不代表业务完成。

营销动作仅限**专业版、独立微信公众号**；共享公众号拒绝。它只创建“消息与活动”的营销草稿，不直接发送：继续核对受众及营销同意、审批、设定时间和限流，使用既有群发执行器。可选 `audience_tag_field` 代表一个客户标签，省略则草稿范围为全部符合发送条件的已同意接收者，不意味着绕过退订、额度或平台频率限制。独立公众号真实收件仍须在具备账号及同意接收者时另行验收。

控制台会话接口（不是第三方 API Key 接口）：

- `GET /{extension_id}/actions`：绑定摘要，不返回凭据。
- `POST /{extension_id}/actions`：绑定 `{operation:"bind",version,action_key,endpoint,bearer_token?,confirm:true}`；撤销 `{operation:"bind",version,action_key,enabled:false}`。
- 执行 `{operation:"run",version,record_id,action_key,binding_id?,confirm:true}`；HTTP 必须带当前绑定标识。结果含运行状态，营销成功还含 `campaign_id`；重复请求返回已有结果，不重复执行。

租户仍须自行确认数据外发目的和接收方可信度。目录“需明确授权”不等于已获得任何读取、转派或发送授权。
