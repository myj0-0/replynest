# Chatwoot CE 集成

`chatwoot-v4.16.2-ce-saas-sso/` 保存当前使用的最小 Overlay、原生迁移和构建入口，基于官方 Chatwoot CE `v4.16.2-ce`。不包含 Enterprise 源码或维护者的冻结生产镜像。

Overlay 涵盖受签名保护的内部身份／成员／工作区接口、原子消息／分配、原生历史及已读回执、产品界面和只填入草稿的 Composer Bridge。执行能力须匹配环境、租户、成员、会话和独立授权，不能直接公开内部 API。

升级上游时核对文件覆盖、签名／重放、成员／租户隔离、数据库迁移与只填入不发送等契约。生产需明确迁移与回滚计划，不将开发初始化用于现有数据库。

Chatwoot 原始许可见 [UPSTREAM_LICENSE](chatwoot-v4.16.2-ce-saas-sso/UPSTREAM_LICENSE)，自有修改按根目录 MIT 许可提供。官网：[replynest.cn](https://replynest.cn/)。
