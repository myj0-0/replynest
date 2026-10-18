# 开发与测试

Node.js 24、Python 3、pnpm 11.19.0。安装及构建只使用锁文件，不需要官方生产凭据。

```sh
cd services/channel-integration
npm ci
npm audit --audit-level=moderate
npm test

cd ../blackbox-monitor
npm test

cd ../code-runner
npm ci
npm audit --audit-level=moderate
npm test

cd ../../apps/console
corepack pnpm install --frozen-lockfile
corepack pnpm audit --audit-level=moderate
corepack pnpm typecheck
corepack pnpm build

cd ../help-docs
npm ci
npm run security:test
npm run security:check
npm run build
```

控制台权限、导航、成员、隐私、知识、画像、工作台与快捷回复测试由 `.github/workflows/quality.yml` 明确列出。额外的 Excel 兼容测试：`node --test scripts/test-dependency-moderate-console.mjs`（在仓库根目录）。

默认网关测试自动编译，只发现当前源码的 `.test.ts`，使用合成配置且不继承生产凭据。需要数据库／Linux 解码环境的用例会明确跳过，不能算作已经验收。隔离 PostgreSQL 指标对照测试由 CI 单独设置临时数据库运行。

端到端、真实渠道、短信、模型、Webhook 和支付测试不是默认单元测试的一部分。历史命名的集成入口只供自行配置的隔离环境，勿向官方服务或真实客户运行。公开 CI 不保存部署密钥，也不会部署生产。

帮助文档安全构建依赖保护见 [SECURITY.md](../SECURITY.md)。文档可使用 `DOCUSAURUS_SSG_WORKER_THREAD_COUNT=2` 及 `security/worker.config.js` 验证双语言多线程 SSG。所有构建缓存、日志和测试报告均应保持不跟踪。
