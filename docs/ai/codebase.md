# 源码地图

## 后端

| 模块                   | 边界与关联                                           |
| ---------------------- | ---------------------------------------------------- |
| `main.rs`              | 选择客户服务、运营服务或健康检查模式                 |
| `lib.rs`               | 模块导出、停止信号与构建标识                         |
| `api.rs`               | 业务 Router、认证、安全头、通用错误、玩法和映射入口  |
| `domain.rs`            | 规则验证、金额、映射、基础注展开、命中和结算等纯逻辑 |
| `store.rs`             | SQLx 连接、迁移、初始化、共享状态、期次视图及审计    |
| `betting.rs`           | 单项与整单提交、重试、版本验证、容量和原子入账       |
| `records.rs`           | 单据查询、回执、撤销与对账导出数据                   |
| `queries.rs`           | 投注及期次查询、筛选和分页                           |
| `configuration.rs`     | 玩法导入导出、版本、排序、批量更新与删除             |
| `ledger.rs`            | 金额纠正、飞出、撤销、资金方向与统计                 |
| `features.rs`          | 客户模块可用性与最近录注方式                         |
| `text_entry.rs`        | 文本单预览、简称与金额偏好、投注人费率关联           |
| `market.rs`            | 市场身份、香港期次建立与跨日录入边界                 |
| `worker.rs`            | 开奖拉取、结算恢复、风险任务调度与结果持久化         |
| `risk.rs`              | 有截止时间和取消能力的精确极值求解                   |
| `hosted/accounts.rs`   | 密码、Cookie、会话、账号有效性与授权兑换             |
| `hosted/portal.rs`     | 客户端入口、会话解析、授权与租户路由                 |
| `hosted/management.rs` | 管理端入口、客户开通、迁移、管理员及删除             |
| `hosted/tenancy.rs`    | 独立客户连接池、租用生命周期、后台扫描               |
| `hosted/history.rs`    | 历史清除事务、备份处理及独立擦除回执                 |

`AppState` 是客户业务上下文；`Control` 是控制库与账号上下文。租户状态从经过验证的账号构造，不能由请求中的数据库名或账号参数直接创建。

`default-plays.json` 是默认玩法的唯一文件来源，经 `configuration::bundled` 验证并用于新账本初始化。已存在客户的配置通过数据库中的玩法版本管理。

## 前端

`main.ts` 查询站点模式，选择 `App.svelte` 或 `Management.svelte`。`App` 管理客户登录与授权边界，`Workspace` 组合业务页面、请求作用域、导航及草稿。

| 目录或模块                                                               | 职责                                   |
| ------------------------------------------------------------------------ | -------------------------------------- |
| `components/BetEntry.svelte`、`SlipComposer.svelte`                      | 手工选项和组合单草稿                   |
| `components/TextEntry.svelte`                                            | 文本校验、确认弹窗与提交               |
| `components/RecordsTable.svelte`、`SlipDetail.svelte`                    | 单据展示和操作入口                     |
| `components/Statistics.svelte`、`BettorExport.svelte`                    | 统计与导出                             |
| `components/PlayEditor.svelte`、`BatchEditor.svelte`、`PlayOrder.svelte` | 玩法设置                               |
| `components/SystemSettings.svelte`                                       | 模块、映射与账号相关设置               |
| `components/Modal.svelte`、`lib/modal.ts`                                | 模态状态、焦点及页面锁定               |
| `lib/types.ts`                                                           | 当前前端契约、金额与选项工具           |
| `lib/requests.ts`                                                        | 账号范围请求取消和认证失效处理         |
| `lib/features.ts`                                                        | 功能与录注方式派生                     |
| `lib/drag.ts`、`selection.ts`                                            | 拖投注与选项预检                       |
| `lib/statement.ts`                                                       | 对账单金额核对、分组和文件名纯逻辑     |
| `lib/business-date.ts`                                                   | 与后端一致的北京时间 06:00 业务日期    |
| `lib/bettor-statement.ts`                                                | PDF/PNG 排版与文档渲染                 |
| `lib/text-entry/`                                                        | 领域解析、候选、编译、剪切板与回执恢复 |
| `lib/generated/`                                                         | 离线训练生成的候选词典                 |

API 使用 `/api` 前缀、JSON 和当前源码中的 snake_case 字段。失败主体通常为 `{ "error": "..." }`。当前契约由 Rust/TypeScript 类型共同维护，仓库没有 OpenAPI 类型生成链。

## 部署与工具

`deploy/vps/compose.yaml` 描述 MySQL、运营 API、客户 API、Nginx 和维护工具容器。Nginx 按配置中的主机名路由，同一个前端构建按 API 站点模式选择界面。

`configure.py` 生成私有环境；`receive.py` 校验并接收工件；`deploy.py` 管理切换；`ops.py` 管理备份恢复；`releases.py` 管理顺序、磁盘空间与保留；`rollback.py` 检查迁移契约后切换应用。

`scripts/` 包含依赖审计、文档校验、打包、工件清理和文本语料工具。默认玩法在后端源文件维护，部署镜像携带该数据。
