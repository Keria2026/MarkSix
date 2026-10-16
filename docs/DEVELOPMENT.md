# 开发指南

生产部署与恢复只在 [VPS 指南](../deploy/vps/README.md) 维护。业务定义见 [规范](SPECIFICATION.md)，发布门槛见 [测试指南](TESTING.md)。

## 环境

Rust 1.90.0、MySQL 8.4、Bun 1.3.14、Python 3.10+。复用已有 checkout；依赖更新必须同步锁文件。测试 MySQL 的 max_connections 至少 64，凭据只保存在私有环境配置。

```bash
# backend：auth 管理端
BIND_ADDR=127.0.0.1:8090 cargo run --locked -- --hosted-authority
# backend：另一个终端，使用受限 portal 连接
BIND_ADDR=127.0.0.1:8080 INTERNAL_AUTHORITY_URL=http://127.0.0.1:8090 cargo run --locked -- --hosted
# frontend：另一个终端
bun install --frozen-lockfile
API_TARGET=http://127.0.0.1:8080 bun run dev
```

仅回环开发环境可不启用 SECURE_COOKIE；生产必须使用 HTTPS。客户通过 auth 创建并激活。

## 代码职责

| 模块 | 职责 |
| --- | --- |
| domain / risk | 金额、规则、拆注和结算／同一合法开奖的精确极值 |
| api / queries | 写入事务与 API 边界／类型化只读查询 |
| ledger / configuration | 金额、飞出与统计／玩法版本、导入导出和批量变更 |
| store / worker | 业务库及期次快照／抓取、结算和风险任务生命周期 |
| hosted/accounts / portal / tenancy | 中央身份及激活／按有效会话分派／账本池与 Router 缓存 |
| hosted/management / history | auth 管理／历史清空与备份凭据 |
| App / Workspace | 客户认证壳／账号内导航与账本协调 |
| BetEntry / PlayEditor / SystemSettings | 投注草稿与报价／玩法编辑／配置及历史清空 |
| requests / Management | 可销毁请求作用域／auth 管理界面 |

客户默认玩法来自 backend/src/default-plays.json，与 fixtures/customer-plays.json 逐字段一致；测试校验此契约。稳定计算夹具单独存于 backend/test_support，不进入生产业务默认值。

## 验证命令

数据库测试会破坏性重置专用 marksix_test。禁止指向业务库，禁止与浏览器夹具并行操作同一测试库。

```bash
# 仓库根目录
python3 -m unittest discover -s scripts/tests -v
python3 scripts/audit_dependencies.py
# backend
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo test --locked --test upgrade -- --ignored
cargo test --locked --test workflow -- --ignored
cargo test --locked --lib hosted::tests -- --ignored
cargo test --locked --lib worker::recovery_tests -- --ignored
cargo run --release --locked --example risk_bench
cargo build --locked --example runtime_server
# 仓库根目录
python3 scripts/runtime_acceptance.py
```

风险故障测试通过测试管理连接安装／移除临时触发器，仅接受 marksix_test。业务连接不因此获得生产管理权限。

浏览器夹具固定北京时间 2026-10-14 12:00，仅监听回环，不编译进生产镜像。完整重跑前重启夹具以重置数据库。

```bash
# backend，独立终端
cargo run --locked --example e2e_server
# frontend，独立终端
API_TARGET=http://127.0.0.1:8081 bun run dev --port 5174
bun x playwright install chromium
bun x prettier --check 'src/**/*.{svelte,ts,css}' 'tests/*.ts' '*.ts'
bun audit
bun run check
bun run build
bun run test:e2e
```

托管整体验收使用随机 Compose 项目、自签名证书和独立测试账号。root 执行时核查生产 UID 10001；非 root 本地测试只调整测试容器 UID，使其能够访问测试备份目录。

```bash
python3 scripts/hosted_acceptance.py --backend marksix-backend:v1-test --frontend marksix-frontend:v1-test --browser --bun /完整路径/bun
```

实际结果与未执行项目记录在 [验收索引](ACCEPTANCE.md)，不把默认忽略的测试计为已执行。

## 附录：变量与契约

- auth：CONTROL_DATABASE_URL、PROVISION_DATABASE_URL、AUTHORITY_ADMIN_USERNAME、AUTHORITY_ADMIN_PASSWORD、TENANT_DB_HOST/PORT、BACKUP_ROOT。
- MarkSix：受限 CONTROL_DATABASE_URL、TENANT_DB_HOST/PORT、INTERNAL_AUTHORITY_URL。
- 测试：TEST_DATABASE_URL 与 TEST_PROVISION_DATABASE_URL 必须同属专用 marksix_test，TEST_ADMIN_PASSWORD 至少 12 字符；浏览器缓存可设置 PLAYWRIGHT_BROWSERS_PATH。
- 投注筛选统一为 POST /api/bets/search；bettors、play_ids 是 JSON 数组。GET /api/bets 与单字段旧筛选已移除。排序仅支持 newest、amount_asc、amount_desc；金额为整条本金。
- 包版本以 backend/Cargo.toml 为唯一来源，构建可注入 MARKSIX_REVISION；/api/site 提供版本和提交，前端不另维护产品版本。
- 历史 SQL 迁移不可改写。现有规则和基础注的缺省字段继续服务持久化快照；风险缓存通过 0008 失效，移除旧净额回退公式。
- authority 容器标识、启动参数、环境变量和 cookie 属于当前部署契约；产品对外称 auth，内部标识无需为更名而迁移。
