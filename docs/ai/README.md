# AI 项目上下文

## 系统定位

MarkSix 是盘口方使用的多客户投注账本。运营管理员开通客户及授权；客户在自己的账本内维护投注人、投注与结算。客户工作台和运营端是不同的安全边界。

先读[人的架构视图](../human/architecture.md)和[领域模型](../human/domain.md)，再按任务选择下列上下文：

| 上下文                     | 关注点                                   |
| -------------------------- | ---------------------------------------- |
| [源码地图](codebase.md)    | 入口、业务模块、调用关系和修改位置       |
| [数据与一致性](data.md)    | 数据归属、事务、快照、时间和恢复         |
| [文本录注](text-entry.md)  | 分层解析、确认、学习和重复提交           |
| [质量验证](quality.md)     | 修改边界、回归选择、覆盖率口径与完成标准 |
| [测试边界](testing.md)     | 各层测试的职责、隔离和运行方式           |
| [维护约束](maintenance.md) | 开发、文档与发布规则                     |
| [界面体系](interface.md)   | 组件职责、视觉来源和交互边界             |

## 当前技术事实

代码位于 `frontend/`、`backend/`、`deploy/vps/` 和 `scripts/`。前端为 Svelte 5 单页应用，通过 Vite 构建，使用 Bun 管理依赖；不是 SvelteKit 路由应用。后端为 Rust/Axum 模块化单体，以两种服务模式运行；SQLx 使用 MySQL 驱动。数据库为 MySQL 8.4。

这些事实应从入口、清单、迁移和部署配置交叉核对。架构目标与已运行结构必须分开；维护任务不隐含框架、数据库或目录迁移授权。

## 阅读路径

业务写入：`frontend/src/Workspace.svelte` → 录入组件 → `backend/src/api.rs` / `hosted/portal.rs` → `betting.rs` → `domain.rs` / `store.rs`。

开奖与结算：`worker.rs` → `domain.rs` → 期次及账本事务。

合并日报：`reporting.rs` → `records.rs` / `ledger.rs` → 按录入业务日期汇总港澳投注。

客户生命周期：`Management.svelte` → `hosted/management.rs` → `accounts.rs` / `tenancy.rs` / `history.rs`。

发布：`.github/workflows/ci.yml` → `scripts/package_ubuntu.py` → `deploy/vps/receive.py` → `release.sh` / `deploy.py` → `ops.py` / `releases.py`。
