# 开发与架构

工具链：Rust 1.90.0、Bun 1.3.14、MySQL 8.4。锁文件均已提交。

`backend/src/domain.rs` 管规则、组合、金额和结算；`risk.rs` 对同一合法开奖计算精确极值；`store.rs` 管 MySQL 与不可变期次快照；`api.rs` 管认证及事务写入；`ledger.rs` 管投注人、金额纠正、飞出与统计；`configuration.rs` 管可移植玩法与逻辑删除；`license.rs` 管设备绑定、签名和独立授权服务；`worker.rs` 管抓取、恢复、结算和风险任务。前端使用 Svelte 5、TypeScript 和系统字体，无远程字体依赖。

金额使用整数分和缩放整数赔率，乘法通过 i128 中间值防溢出，每基础注四舍五入后汇总。MySQL 中一条原始投注保存所有基础注与规则 JSON，事务原子提交；期次行锁串行化容量校验、撤销和结算。请求 UUID 实现幂等。会话只保存随机令牌的 SHA-256，密码用 Argon2。

## Dev1.0 托管开发

新增 `backend/src/hosted/`：accounts 处理凭据、会话和核销，management 提供 Web 管理 API，portal 验证客户会话后分发，tenancy 维护独立客户池和共享计算并发限制。`frontend/src/Management.svelte` 是管理后台，入口通过 `/api/site` 选择站点。

生产容器和权限以 [VPS 指南](../deploy/vps/README.md) 为准。授权端先迁移控制库及所有 ready 客户库，再启动客户服务；客户服务不持有建库权限。新版本只追加迁移，不重写已发布迁移。Dev1.0 使用全新控制库，旧部署独立保留。

本地分别设置私有环境变量后运行（命令不要粘贴真实密码到文档）：

```bash
# 授权端：CONTROL_DATABASE_URL、PROVISION_DATABASE_URL、AUTHORITY_ADMIN_USERNAME/PASSWORD
# TENANT_DB_HOST / TENANT_DB_PORT 指向同一测试 MySQL
BIND_ADDR=127.0.0.1:8090 cargo run --locked -- --hosted-authority
# 客户端：CONTROL_DATABASE_URL；生产使用受限 portal 数据库账号
BIND_ADDR=127.0.0.1:8080 cargo run --locked -- --hosted
```

前端 Vite 的 API_TARGET 指向要调试的服务。生产 Secure Cookie 使用 HTTPS；仅本地调试允许 SECURE_COOKIE=false。

测试 MySQL 的 max_connections 至少设为 64；旧本机开发容器的 20 连接配置不足以运行托管连接池边界测试。

真实托管集成测试会创建、授权并删除随机独立数据库及 MySQL 用户。仅对专用测试 MySQL 执行，TEST_DATABASE_URL 必须以 /marksix_test 结尾；另设置 TEST_PROVISION_DATABASE_URL 指向同一测试服务器的数据库管理连接，并配置 TENANT_DB_HOST/PORT：

```bash
cargo test --locked --lib hosted::tests -- --ignored
```

Docker 验收使用随机 Compose 项目和自签名测试证书，不接触旧系统。CI 以 root 执行，验证生产 UID 10001；非 root 本地运行只调整测试授权容器 UID 来匹配测试备份目录。

```bash
# 仓库根目录；先构建 marksix-backend:dev1-test / marksix-frontend:dev1-test
python3 scripts/hosted_acceptance.py --browser --bun /完整路径/bun
# 容量目标，必须记录失败、延迟及资源信息，不能只看在线会话数
python3 scripts/hosted_acceptance.py --users 200 --load-seconds 60
```

本机 Playwright 浏览器缓存可用 --browser-cache 指定。容器测试结果写入 test-results/hosted-acceptance.json，不包含密码和激活码。其他浏览器测试使用下方原有 e2e_server，不要与会重置 marksix_test 的测试同时运行。

## 业务引擎及历史本机调试

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
cargo test --locked --lib license::tests::online_activation -- --ignored
cargo test --locked --test license_cli -- --ignored
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

生产二进制始终启用授权，不能通过环境变量关闭；本机正式开发也要激活。仅测试示例构造未启用授权的 AppState，不能部署示例程序。

测试后端使用固定北京时间 2026-10-14 12:00，仅作为测试工具，不会进入生产镜像。每次重跑完整浏览器测试前重启测试后端以重置数据库。

## 赔率表真实运行验收

在依次完成数据库测试后，从仓库根目录运行（同样会清空 `marksix_test`，需要空闲的 localhost:8082）：

```bash
cargo build --locked --manifest-path backend/Cargo.toml --example runtime_server
python3 scripts/runtime_acceptance.py
```

保留 `TEST_DATABASE_URL` 和 `TEST_ADMIN_PASSWORD`。脚本自动启动及停止测试服务、导入赔率表、生成投注、推进测试时钟及开奖、核对逐注结算和分类汇总，并生成 `test-results/runtime-acceptance.json`。固定种子 20261015，独立 Python Decimal 实现不调用后端计算函数作为预期值。夹具控制接口只编译到 example，随机令牌保护，仅绑定回环地址，不进入生产包。授权门禁由单独的真实协议与原生安装测试覆盖。测试结果与边界见 [运行验收](RUNTIME_ACCEPTANCE.md)。

## 风险算法边界

按等价条件合并基础注；仅号码单选的可分离组合使用精确线性路径，其他使用号码等价类与保守上下界分支搜索。只有完整证明最优时才发布结果。任务绑定投注版本，被替代任务不能覆盖新结果；取消、失败和 60 秒超时不返回估算。

任意配置下的全规模最坏情况性能尚需继续验证；已通过的固定基准不构成对所有混合玩法的性能保证。

## 数据契约

`0002_people_and_layoffs.sql` 为增量迁移，增加投注人、版本、和局字段、飞出及幂等修改表；不要改写已部署的迁移。旧基础注缺失的新字段通过 serde 默认值保持旧结算语义，旧规则和投注快照不回填。

锁顺序为期次 → 投注；录入、纠正、飞出、撤销及结算均在期次锁下校验。金额操作包含 UUID 和 revision，网络重试必须复用同一 UUID 和内容；刷新后才使用新版本提交。飞出不得超过每注原金额，原注不能改到已飞出金额以下。

所有财务汇总先逐基础注计算，不使用浮点数。风险引擎通过带符号头寸合并飞出，并处理 49 退本造成的可变反水；`min_net`／`max_net` 是净额极值，不能把兼容字段 `min_payout`／`max_payout` 当作飞出后的现金返还。

前端的组合数预览只用于交互反馈，后端再次执行完整规则和容量校验。官方频道 iframe 仅允许 macaujc.com，CSP 保留 `frame-ancestors 'none'`。

`0003_configuration_and_license.sql` 只新增玩法删除时间和授权表，不修改旧规则、旧基础注或迁移文件。删除玩法仅隐藏新投注入口，不删除版本、投注或统计。玩法导入为 schema 1，包含 rule/enabled，整批校验、事务新增，不携带业务 ID／账号／设备信息，同名不覆盖。每文件及活动玩法总量最多 1,000 条。

新增 JSON 字段 `zodiac_count`、`special_hit_odds`、基础注 `special_hit_payout` 均有 serde 默认值，不改历史快照或已发布迁移。生肖种数从生肖并集推导，风险上下界按未来各生肖号码容量计算；含特码赔率展开为以特码号码为门控的差额项，金额修改及飞出重算两档返还。

新增 `selection_limit` 默认为 null，兼容旧快照；它同时约束普通／复式候选池，数量关系仍控制基础注。前后端均校验，最多 1,000 基础注限制不变。

## 构建发布

推送 dev 触发 Ubuntu CI 和 Windows Native 两个工作流。CI 包含真实 MySQL 事务、独立穷举风险校验、浏览器与 Axe 检查、Compose 健康及备份验证；原生流程在 Windows PowerShell 5.1 下实际使用中文安装目录／数据目录验证初始化、登录、授权门禁、失效 PID 安全停止、重复停止、重启、备份及恢复。测试成功后才上传对应安装工件。

Ubuntu 包构建命令：`python3 scripts/package_ubuntu.py --output ubuntu-package --version <提交> --backend <镜像> --frontend <镜像>`。Windows 使用 `scripts/package_windows_native.ps1`。没有 Windows Docker 打包分支。

授权服务与 CLI、私钥保管及重新构建公钥的步骤见 [授权说明](LICENSING.md)。测试签名使用临时随机密钥，发布包始终使用仓库公钥；签发私钥不进入 GitHub 构建环境。

## v0.4 授权时间与路由

`license/clock.rs` 使用 Linux CLOCK_BOOTTIME／Windows GetTickCount64，租约只在内存，重启不读取持久化时间作为授权依据。`license/routing.rs` 验证 MSX1 激活封装及签名迁移文件；发现入口可配置，版本拒绝回退。`0004` 增加发现地址、路由版本、核销 UUID、预绑定及绝对期限，不能改写前三个已发布迁移。

真实协议测试注入独立单调时钟并推进／回退，覆盖休眠、离线重启、过期、复制设备、密码变更、旧码不同提交拒绝、同次重试、旧地址实际停用后的发现迁移、签名文件迁移及原期限保持；CLI 测试实际执行 owner 命令并校验签名和数据库中的天数／固定期限／预绑定。生产私钥不参与测试。
