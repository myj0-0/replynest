# 第三方软件与许可边界

ReplyNest 自有代码使用根目录的 [MIT License](LICENSE)。这不改变依赖或容器镜像的许可证，不包含第三方托管服务的使用授权。

- **Chatwoot CE**：基于 `chatwoot/chatwoot:v4.16.2-ce` 的最小 Overlay。Chatwoot Inc. 的许可声明见 [`patches/chatwoot-v4.16.2-ce-saas-sso/UPSTREAM_LICENSE`](patches/chatwoot-v4.16.2-ce-saas-sso/UPSTREAM_LICENSE)；上游 `enterprise/` 目录另有许可证，本仓库不复制或授权 Enterprise 内容。
- **braces 本地构建保护**：保留 [`apps/help-docs/security/braces-LICENSE.txt`](apps/help-docs/security/braces-LICENSE.txt) 的原作者许可与声明。保护机制与剩余原始告警见 [SECURITY.md](SECURITY.md)。
- **npm／pnpm 依赖**：版本和解析来源由各组件 package 与锁文件固定。发布二进制／镜像时仍须从实际安装结果生成第三方清单，保留相应许可证与 NOTICE；不以本文件代替完整 SBOM。
- **外部容器**：PostgreSQL／pgvector、Redis、ClamAV、Caddy、Mailpit、Cap／Valkey 等各自保留许可。特别是当前 Redis 7.4 系列不使用 MIT；部署／再分发前须查看所选镜像对应的许可证，不能称整个栈都是 MIT。
- **外部平台**：微信、阿里云、邮件、支付、模型、对象存储等服务仍按各自条款和接口授权使用，开源许可证不提供商户、公众号、短信或模型账号。

上游来源：[Chatwoot](https://github.com/chatwoot/chatwoot)、[Next.js](https://github.com/vercel/next.js)、[Docusaurus](https://github.com/facebook/docusaurus)、[Redis](https://github.com/redis/redis)、[ClamAV](https://github.com/Cisco-Talos/clamav)。官网：[replynest.cn](https://replynest.cn/)。
