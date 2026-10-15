# 开发与架构

工具链：Rust 1.90.0、Bun 1.3.14、MySQL 8.4。锁文件均已提交。

`backend/src/domain.rs` 管规则、组合、金额和结算；`risk.rs` 对同一合法开奖计算精确极值；`store.rs` 管 MySQL 与不可变期次快照；`api.rs` 管认证及事务写入；`ledger.rs` 管投注人、金额纠正、飞出与统计；`worker.rs` 管抓取、恢复、结算和风险任务。前端使用 Svelte 5、TypeScript 和系统字体，无远程字体依赖。

金额使用整数分和缩放整数赔率，乘法通过 i128 中间值防溢出，每基础注四舍五入后汇总。MySQL 中一条原始投注保存所有基础注与规则 JSON，事务原子提交；期次行锁串行化容量校验、撤销和结算。请求 UUID 实现幂等。会话只保存随机令牌的 SHA-256，密码用 Argon2。

## 本机开发

自行创建开发数据库及专用账号，在当前终端设置 `DATABASE_URL`、`ADMIN_USERNAME`、`ADMIN_PASSWORD`，不要把密码写入仓库。然后：

```bash
cd backend
cargo run --locked
```

另一个终端：

```bash
cd frontend
bun install --frozen-lockfile
bun run dev
```

访问 http://127.0.0.1:5173；Vite 将 `/api` 转发到本机 8080。可用 `API_TARGET` 调整后端地址。

## 检查与测试

```bash
cd backend
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo run --release --locked --example risk_bench
```

真实数据库测试**会清空测试数据库**。必须单独创建名为 `marksix_test` 的数据库并设置 `TEST_DATABASE_URL`，切勿指向业务数据库：

```bash
cargo test --locked --test upgrade -- --ignored
cargo test --locked --test workflow -- --ignored
```

浏览器测试也清空 `marksix_test`，不要与集成测试同时运行。设置 `TEST_ADMIN_PASSWORD` 为至少 12 字符的测试密码，然后依次启动：

```bash
# backend 目录，第一个终端
cargo run --locked --example e2e_server
# frontend 目录，第二个终端
API_TARGET=http://127.0.0.1:8081 bun run dev --port 5174
# frontend 目录，第三个终端，同一个 TEST_ADMIN_PASSWORD
bun x playwright install chromium
bun run check
bun run build
bun run test:e2e
```

测试后端使用固定北京时间 2026-10-14 12:00，仅作为测试工具，不会进入生产镜像。每次重跑完整浏览器测试前重启测试后端以重置数据库。

## 风险算法边界

按等价条件合并基础注；仅号码单选的可分离组合使用精确线性路径，其他使用号码等价类与保守上下界分支搜索。只有完整证明最优时才发布结果。任务绑定投注版本，被替代任务不能覆盖新结果；取消、失败和 60 秒超时不返回估算。

任意配置下的全规模最坏情况性能尚需继续验证；已通过的固定基准不构成对所有混合玩法的性能保证。

## v0.2 数据契约

`0002_people_and_layoffs.sql` 为增量迁移，增加投注人、版本、和局字段、飞出及幂等修改表；不要改写已部署的迁移。旧基础注缺失的新字段通过 serde 默认值保持旧结算语义，旧规则和投注快照不回填。

锁顺序为期次 → 投注；录入、纠正、飞出、撤销及结算均在期次锁下校验。金额操作包含 UUID 和 revision，网络重试必须复用同一 UUID 和内容；刷新后才使用新版本提交。飞出不得超过每注原金额，原注不能改到已飞出金额以下。

所有财务汇总先逐基础注计算，不使用浮点数。风险引擎通过带符号头寸合并飞出，并处理 49 退本造成的可变反水；`min_net`／`max_net` 是净额极值，不能把兼容字段 `min_payout`／`max_payout` 当作飞出后的现金返还。

前端的组合数预览只用于交互反馈，后端再次执行完整规则和容量校验。官方频道 iframe 仅允许 macaujc.com，CSP 保留 `frame-ancestors 'none'`。

## 构建发布

推送 dev 触发 Ubuntu CI 和 Windows Native 两个工作流。CI 包含真实 MySQL 事务、独立穷举风险校验、浏览器与 Axe 检查、Compose 健康及备份验证；原生流程在 Windows PowerShell 5.1 下实际使用中文安装目录／数据目录验证初始化、登录、预览、重启和备份。测试成功后才上传对应安装工件。

Ubuntu 包构建命令：`python3 scripts/package_windows.py --target ubuntu --output ubuntu-package --version <提交> --backend <镜像> --frontend <镜像>`。文件名沿用旧通用镜像打包脚本；默认旧 Windows Docker 模式仅用于历史维护，不再由 Actions 自动交付。
