# 文档索引

| 文档                                          | 负责内容                               |
| --------------------------------------------- | -------------------------------------- |
| [业务规则](guides/betting.md)                 | 归期、拆注、金额、结算、账目与页面行为 |
| [领域术语](architecture/domain.md)            | 账目和投注模型的统一含义               |
| [系统架构](architecture/system.md)            | 服务边界、隔离、并发、事务与数据升级   |
| [账号授权](guides/accounts.md)                | 激活、续期、会话、改密与删除账号       |
| [开发指南](getting-started/development.md)    | 环境、代码职责和执行命令               |
| [测试门槛](guides/testing.md)                 | 必须覆盖的验证与发布条件               |
| [本次验证](guides/verification.md)            | 本轮实际执行结果及未验收范围           |
| [部署运维](deployment/vps.md)                 | VPS、CI/CD、备份、恢复、回退与日志     |
| [文本录注方案](guides/text-entry-proposal.md) | 尚未实现的 NLP 设计与待确认范围        |

当前代码与部署契约以各文档描述的现状为准。[AGENTS.md](../AGENTS.md) 的 PostgreSQL、SvelteKit、apps 目录及自动契约生成属于目标规范；本次功能迭代保留现有 MySQL、Svelte / Vite、backend / frontend 和 API 契约。数据库或框架迁移须单独评估。

历史版本和旧验证记录由 Git 历史保存。工件中的部署指南由 `docs/deployment/vps.md` 复制生成，不另维护副本。
