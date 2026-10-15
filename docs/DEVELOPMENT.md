# 开发与测试

当前唯一产品为 Ubuntu Docker 托管版：Rust 1.90.0 / Axum、MySQL 8.4、Svelte 5 / TypeScript、Bun 1.3.14。依赖锁文件必须随实际依赖更新。生产部署见 [VPS 指南](../deploy/vps/README.md)。

## 代码职责

- `domain.rs`：定点金额、规则校验、拆注和结算；`risk.rs`：同一合法开奖下的精确极值。
- `store.rs`：业务库、期次快照；`api.rs`：业务 API 与事务；`ledger.rs`：金额纠正、飞出和统计；`configuration.rs`：玩法导入导出及逻辑删除。
- `hosted/accounts.rs`：中央账号、会话与激活；`management.rs`：管理后台；`portal.rs`：按验证会话选择客户；`tenancy.rs`：独立客户数据库池及并发预算；`history.rs`：客户历史清空及备份删除。
- `worker.rs`：开奖抓取、结算和风险任务；`logging.rs`：固定 error 级运行日志。财务审计不是运行日志，继续保存于业务库。
- 前端 `App.svelte` 为客户工作台，`Management.svelte` 为运营后台，按 `/api/site` 选择入口。

## 开发环境

使用已有 checkout，不需创建额外 worktree。MySQL 测试实例 max_connections 至少 64。凭据只放私有环境配置，不写入 Git。授权端需要 CONTROL_DATABASE_URL、PROVISION_DATABASE_URL、AUTHORITY_ADMIN_USERNAME、AUTHORITY_ADMIN_PASSWORD、TENANT_DB_HOST/PORT、BACKUP_ROOT；客户服务使用受限 portal 数据库连接。

```bash
cd backend
BIND_ADDR=127.0.0.1:8090 cargo run --locked -- --hosted-authority
# 另一个终端，配置客户服务连接
BIND_ADDR=127.0.0.1:8080 INTERNAL_AUTHORITY_URL=http://127.0.0.1:8090 cargo run --locked -- --hosted
# frontend 目录
bun install --frozen-lockfile
API_TARGET=http://127.0.0.1:8080 bun run dev
```

生产 Secure Cookie 配合 HTTPS；仅回环开发环境可不设置 SECURE_COOKIE=true。客户通过运营后台创建并激活，不提供本机设备授权命令。

## 必须执行的验证

真实数据库测试会重置专用 `marksix_test` 数据库，禁止指向业务库。TEST_DATABASE_URL 为专用测试连接，TEST_PROVISION_DATABASE_URL 为同一测试 MySQL 的建库管理连接，TENANT_DB_HOST/PORT 指向该实例。各套数据库测试顺序执行，不能与浏览器夹具共享数据库并行重置。

```bash
cd backend
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo test --locked --test upgrade -- --ignored
cargo test --locked --test workflow -- --ignored
cargo test --locked --lib hosted::tests -- --ignored
cargo run --release --locked --example risk_bench
cargo build --locked --example runtime_server
# 仓库根目录，设置 TEST_ADMIN_PASSWORD 至少 12 字符
python3 scripts/runtime_acceptance.py
```

运行验收使用独立 Python Decimal 预期值、真实 HTTP 和 MySQL，覆盖赔率表与补充规则。结果写入 test-results/runtime-acceptance.json，不把后端计算函数当作预期值。

浏览器夹具只绑定回环，固定北京时间 2026-10-14 12:00，不进入生产镜像。每次完整重跑前重启夹具以重置测试库。

```bash
# backend 目录；保留同一 TEST_ADMIN_PASSWORD
cargo run --locked --example e2e_server
# frontend 目录，另一个终端
API_TARGET=http://127.0.0.1:8081 bun run dev --port 5174
bun x playwright install chromium
bun run check
bun run build
bun run test:e2e
```

托管整体验收使用随机 Compose 项目、自签名测试证书和独立测试账号；不连接生产。root 运行验证生产 UID 10001，非 root 本地仅调整测试授权容器 UID 以匹配测试备份目录。

```bash
python3 scripts/hosted_acceptance.py --backend marksix-backend:dev1-test --frontend marksix-frontend:dev1-test --browser --bun /完整路径/bun
python3 scripts/hosted_acceptance.py --users 200 --load-seconds 60
```

本机浏览器缓存可通过 --browser-cache 指定。200 在线目标必须结合延迟、失败率、资源和实际账本规模评估，固定基准不代表任意混合玩法都能在一分钟内求出极值。

## 财务和升级约束

金额为整数分，赔率为缩放整数，通过 i128 中间值防溢出；每基础注返还和反水独立舍入到分。金额修改与飞出沿用原基础注费率快照。期次 → 投注的锁顺序保证容量、封盘、撤销和结算一致；请求 UUID 和 revision 防重复及覆盖。

0 尾配置字段 `zero_tail_odds` 可空，只支持尾数。拆分后含 0 的基础注使用该赔率，优先于本命肖赔率；反水沿用原有逐注本命肖规则。未配置时保持原赔率。实际快照进入基础注 `odds/payout`，风险与飞出无需再次按当前配置推导费率。

多选查询通过 POST /api/bets/search 传入参数化 JSON 数组，避免大量姓名超过代理的 URL 长度上限；GET /api/bets 仍供现有查询工具使用。排序参数只允许 newest / amount_asc / amount_desc。金额排序指整条投注总本金 stake；稳定并列顺序为创建时间和记录 ID。候选列表来自当期投注快照，删除玩法后仍可筛选历史记录。

历史清空在授权端执行，客户服务没有备份目录访问权。验证当前会话、密码、确认文字并锁定账号，使用客户自身数据库权限；锁顺序为备份文件锁 → 账号 → 期次。删除本期之前的期次、投注、飞出、金额变更及相关财务审计，保留本期、规则、映射、配置、账号及授权。请求 ID 重试不会扩大清空范围。清除客户托管备份，持久化非实名清空凭据，恢复工具拒绝清空前的全量备份。

生产已存在的迁移文件不得改写。新增字段保留 serde 默认值，以读取已上线的规则和投注快照；这是必要的数据升级保障。0006 增加清空幂等凭据；0007 移除托管库中已停用的设备授权表。Windows 安装脚本、旧独立授权服务、签名 CLI 和本机部署模式不再编译或交付。

## CI/CD

仅 Ubuntu CI：dev / master push、PR 触发验证。master push 且 verify/images 成功后，从同一次构建上传的 MarkSix-Ubuntu-x64 工件部署；生产并发串行且不自动取消。dev 不部署。

`python3 scripts/package_ubuntu.py --output ubuntu-package --version <提交> --backend <已测镜像> --frontend <已测镜像>` 仅打包托管配置、三份镜像、玩法夹具和 SHA-256 清单。verify.py 验证工件完整性。发布前冷备份、增量迁移、健康检查和 TLS 路由验收；失败不能用旧程序直接连接已升级数据库。
