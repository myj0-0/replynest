# 自部署指南

**直接使用官方服务：[https://replynest.cn/](https://replynest.cn/)。以下操作只针对你自己的环境。**

## 本地完整栈

使用 Docker Compose、Bash 和至少能容纳 Chatwoot、数据库、文档处理及杀毒服务的开发机器。首次拉取镜像与病毒库可能较慢；基础配置仅绑定 loopback，不是可直接公网部署的生产清单。

1. 将 `.env.example` 复制为 `.env`。为数据库、Redis、`SECRET_KEY_BASE`、`SAAS_SSO_SHARED_SECRET`、`MOCK_WECHAT_SECRET`、`DEMO_TENANT_API_KEY` 和本地账号密码设置互不复用的随机值；不要保留 `CHANGE_ME`。可用 `openssl rand -hex 48`，不要提交结果。
2. 保持真实邮件／短信、模型、支付、微信发送与自动化执行关闭。模板里的 Chatwoot 账号、Inbox 和 Token 需在创建自己的实例后填写，不存在默认的官方账号。
3. 运行 `bash scripts/doctor.sh` 核对本地配置，再运行 `bash scripts/bootstrap.sh` 构建源码、初始化数据库并启动原生服务。
4. 通过 `http://localhost:3000` 完成自己 Chatwoot 实例的首位管理员和 API Inbox 设置，按自己的配置补齐 `CHATWOOT_ACCOUNT_ID`、`CHATWOOT_INBOX_ID`、`CHATWOOT_INBOX_IDENTIFIER`、`CHATWOOT_API_ACCESS_TOKEN`，再执行 `docker compose up -d` 启动网关／控制台及其余服务。
5. 查看 `docker compose ps` 和服务健康状态，使用合成访客验证租户隔离与工作台会话链，不向真实客户发送测试消息。

| 本地入口 | 地址 |
| --- | --- |
| 控制台 | `http://localhost:3200` |
| Chatwoot | `http://localhost:3000` |
| 网关健康 | `http://localhost:3001/health` |
| Mock 微信 | `http://localhost:3100` |
| Mailpit | `http://localhost:8025` |
| 状态页 | `http://localhost:3300` |

文档独立构建：`docker build -t replynest-docs -f apps/help-docs/Dockerfile .`，然后仅在本机运行 `docker run --rm -p 127.0.0.1:3400:8080 replynest-docs`。

基础栈按本地 `legacy` 初始化流程创建开发数据库。生产的角色拆分、迁移所有者和 `verify` 结构校验须另行建立，不能将开发配置直接覆盖到已有生产库。代码运行器、自动化执行等可选服务需自己编写并审阅隔离编排，不能因为源码存在就打开执行开关。

## 从本地走向生产

- 换成自己的域名、HTTPS、公开 Origin 和安全 Cookie；禁用 `CONSOLE_DEMO_LOGIN`、Mock 和调试管理入口。
- 仅公开必要的反向代理端点，内网隔离 PostgreSQL／Redis／Chatwoot 内部接口／杀毒／代码运行器。不要照搬源码中的官方域名允许列表。
- 独立业务与原生库角色，迁移凭据只给一次性所有者作业；核对全部表、序列、函数、默认权限和扩展成员所有权。
- 配置自己的运营主体、联系方式、法律条款与备案标识。`RegistrationLinks` 的备案内容通过自己设置的环境变量展示，默认不展示官方标识。
- 微信、邮件、短信、模型和支付使用自己的账号、密钥、签名与回调域名；先完成隔离验收和预算／限额配置，再允许真实外发。
- 备份数据库、附件、知识文件、配置和恢复凭据，密文与凭据分离保存，实测恢复；固定镜像摘要并建立可回滚发布检查点。
- 监控健康、任务滞留、投递失败、数据库压力、AI 预占与实际扣费，保留审计；不把网络重试变成重复付款或重复外发。

此仓库不包含官方环境的边缘网络、主机地址、秘密目录、发布账号或灾备操作脚本；应按自己的基础设施建立运行手册。
