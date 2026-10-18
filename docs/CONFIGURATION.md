# 配置说明

官网：[replynest.cn](https://replynest.cn/)。本文件描述自部署配置，不包含官方服务器信息。

备案标识 `NEXT_PUBLIC_ICP_NUMBER`、`NEXT_PUBLIC_PUBLIC_SECURITY_NUMBER`、`NEXT_PUBLIC_PUBLIC_SECURITY_CODE` 是公开的构建输入，默认留空。设置自己的标识后重新构建控制台镜像；只重启旧镜像不会更新已生成的公开页面。它们不应用于存放任何密钥。

`.env.example` 是变量模板，服务不会自动替你读取或修改模板。Compose 将变量插值并传给相应服务；服务中的显式 `environment` 值可能覆盖 `env_file`。修改有效配置后重新创建相应容器，单独 `restart` 不会重新读取 Compose 环境。

| 类别 | 典型变量 | 注意 |
| --- | --- | --- |
| 数据库 | `POSTGRES_*`、`CHATWOOT_POSTGRES_*`、`REPLYNEST_POSTGRES_*` | 生产分库、分角色；初始化变量不修改已有卷中的用户密码 |
| 原生与会话 | `SECRET_KEY_BASE`、`SAAS_SSO_SHARED_SECRET`、`CHATWOOT_*` | 独立随机值；内部接口不能公开 |
| 租户开发样例 | `DEMO_TENANT_*`、`CONSOLE_BOOTSTRAP_PASSWORD` | 仅本地合成数据；生产关闭旧演示登录 |
| 邮件／短信 | `MAIL_PROVIDER`、`MAIL_LIVE_SEND_ENABLED`、`ALIYUN_*` | 配置不代表允许外发；真实发送单独开启并设预算 |
| 模型与索引 | `LLM_*`、`EMBEDDING_*`、Provider 相关变量 | 自己的 Provider 凭据、网络权限与计费 |
| 微信 | `WECHAT_*`、`SHARED_WECHAT_*` | 自己的 AppID／接口权限；接收、管理与发送分别控制 |
| 对象存储／推送 | `S3_*`、`WEB_PUSH_*` | 使用独立账号与最小权限，勿公开私钥 |
| 支付 | `ALIPAY_*`、`WECHAT_PAY_*` | 自己的商户配置及回调域名；先在隔离环境验收 |
| 运行边界 | `DATABASE_STARTUP_MODE`、`REPLYNEST_DB_RUNTIME_SPLIT_ENABLED` | 开关不能代替迁移、授权或角色降权 |

`secretValue` 支持的参数可用同名 `_FILE` 从受限文件读取；并不是所有第三方客户端都自动支持该形式。挂载须由部署者明确配置，运行服务不能持有迁移所有者凭据。加密主密钥的替换需配合已有密文迁移，不能只改一个环境变量。

套餐价格、点数包、试用、赠金、邀请门槛和返佣等运营规则通过内部管理数据库设置，不应硬编码价格或通过改 env 追溯修改旧订单。企业 AI 接待／客户画像授权与每日预算由企业管理员单独保存。

功能传递示例见 `compose.features.yaml`，默认关闭，不自动授予执行权限。`.env.example` 可能列出尚未传入基础本地 Compose 的高级变量；添加变量时同时核对消费者和 Compose 映射，不以“写进 env”代替配置生效检查。
