# 开发指南

生产部署与恢复只在 [VPS 指南](../deployment/vps.md) 维护。业务定义见 [规范](../guides/betting.md)，发布门槛见 [测试指南](../guides/testing.md)。

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

### WSL Ubuntu 本地环境

当前工作站使用 WSL2 Ubuntu-24.04，唯一开发目录为 Linux 原生文件系统中的 `/home/ubuntu/Project/MarkSix`（`~/Project/MarkSix`）。禁止在 Windows checkout、PowerShell／CMD 或 `/mnt/c` 等挂载盘直接开发。Rust、Bun、Node.js 24 LTS、Git、Docker Engine / Compose、MySQL 客户端及 Playwright Chromium 均运行在 WSL 内；Windows 编辑器须连接 Remote WSL。Node.js 只供开发工具运行，依赖仍统一由 Bun 管理。Rust 构建缓存位于 `~/.cache/marksix/target`，本地 `backend/target` 链接到该目录。前端依赖由 WSL 中的 Bun 在新目录安装，不搬用 Windows 的依赖目录。

本地配置集中在 `~/.config/marksix/`，不属于 Git 仓库；目录权限为 700，密码配置权限为 600。不要将这些文件或其内容复制到仓库、终端日志或提交中。

| 用途         | 地址                           | 配置                                  |
| ------------ | ------------------------------ | ------------------------------------- |
| MarkSix 页面 | <http://localhost:5173>        | `portal.env`，API 为 `127.0.0.1:8080` |
| auth 页面    | <http://localhost:5175>        | `auth.env`，API 为 `127.0.0.1:8090`   |
| 开发数据库   | `127.0.0.1:13306/marksix_dev`  | `mysql-dev.env`                       |
| 测试数据库   | `127.0.0.1:13307/marksix_test` | `mysql-test.env`、`test.env`          |

两个数据库分别运行在 `marksix-local` Compose 项目的 MySQL 8.4 容器内，使用不同密码和持久化卷，`max_connections=128`，仅发布回环端口。开发客户的独立租户库也只创建在开发实例中。auth 使用迁移及租户管理连接，MarkSix 使用受限的 portal 连接。

开发管理员用户名为 `dev-admin`，密码见本地 `auth.env`；已激活的开发客户为 `dev-user`，密码见本地 `customer.env`。测试账号密码仅见 `test.env`。

在 WSL 终端中启动（或运行 Remote WSL 工作区任务 `MarkSix: start development`）：

```bash
cd ~/Project/MarkSix
bash ~/.config/marksix/start.sh --keep-alive
```

从 Windows 启动 WSL 或编辑器只作为入口，不在 Windows 运行开发命令：

```powershell
wsl -d Ubuntu-24.04 --cd /home/ubuntu/Project/MarkSix
code --remote wsl+Ubuntu-24.04 /home/ubuntu/Project/MarkSix
```

Vite 配置会拒绝 Windows 进程及 Windows 挂载盘中的开发／构建。Remote WSL 终端默认使用 Bash，Git 使用 `/usr/bin/git`；不得从资源管理器以普通 Windows 工作区打开 UNC 路径后运行开发工具。

启动脚本先等待数据库健康、构建后端，再启动 `marksix-local.target` 下的四个用户服务。`--keep-alive` 保持一个 WSL 客户端运行，防止 WSL 因空闲回收实例；同一用户的重复启动不会创建多个保活进程。首次配置已启用用户 linger。重启 Windows 或显式关闭 WSL 后，重新执行启动命令。

在 WSL 内检查、停止应用或加载测试配置：

```bash
systemctl --user status marksix-local-{auth,api,web,auth-web}.service
systemctl --user stop marksix-local.target
# 仅停止本项目数据库，不删除卷：
docker compose -f ~/.config/marksix/compose.yaml stop
# 测试终端单独加载；不要同时运行数据库测试与浏览器夹具：
set -a
. ~/.config/marksix/test.env
set +a
```

停止应用和数据库不会结束保活进程；需要结束时，在保活终端按 Ctrl+C，后台启动时可在 WSL 执行 `kill "$(cat ~/.local/state/marksix/wsl-keepalive.pid)"`。本次检查日志位于 `~/.local/state/marksix/`，运行时验收报告位于仓库忽略的 `test-results/`。

## 代码职责

| 模块                                                   | 职责                                                 |
| ------------------------------------------------------ | ---------------------------------------------------- |
| domain / risk                                          | 金额、规则、拆注和结算／同一合法开奖的精确极值       |
| api / queries                                          | 写入事务与 API 边界／类型化只读查询                  |
| betting / records                                      | 单笔与组合单原子提交／按单分页、整单撤销及对账快照   |
| ledger / configuration                                 | 金额、飞出与统计／玩法版本、导入导出和批量变更       |
| store / worker                                         | 业务库及期次快照／抓取、结算和风险任务生命周期       |
| hosted/accounts / portal / tenancy                     | 中央身份及激活／按有效会话分派／账本池与 Router 缓存 |
| hosted/management / history                            | auth 管理／历史清空与备份凭据                        |
| App / Workspace                                        | 客户认证壳／账号内导航与账本协调                     |
| BetEntry / PlayEditor / BatchEditor / SystemSettings   | 投注草稿与报价／单条编辑／批量变更／配置及历史清空   |
| SlipComposer / SlipDetail / PlayOrder / PasswordChange | 组合单草稿／分项入口／排序／客户改密                 |
| BettorExport / bettor-statement                        | 格式选择、导出与取消／PDF、PNG 共享排版及 ZIP 命名   |
| selection / drag / modal                               | 文本选项解析／拖的输入预览／共享弹窗滚动锁与动效     |
| requests / Management                                  | 可销毁请求作用域／auth 管理界面                      |

客户默认玩法来自 backend/src/default-plays.json，与 fixtures/customer-plays.json 逐字段一致；测试校验此契约。稳定计算夹具单独存于 backend/test_support，不进入生产业务默认值。

## 验证命令

数据库测试会破坏性重置专用 marksix_test。禁止指向业务库，禁止与浏览器夹具并行操作同一测试库。

```bash
# 仓库根目录
python3 -m unittest discover -s scripts/tests -v
python3 scripts/check_docs.py
python3 scripts/audit_dependencies.py
# backend
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo test --locked --test upgrade -- --ignored
cargo test --locked --test workflow -- --ignored
cargo test --locked --test receipts -- --ignored
cargo test --locked --lib hosted::tests -- --ignored
cargo test --locked --lib worker::recovery_tests -- --ignored
cargo run --release --locked --example risk_bench
cargo build --locked --example runtime_server
# 仓库根目录
python3 scripts/runtime_acceptance.py
```

风险故障测试通过测试管理连接安装／移除临时触发器，仅接受 marksix_test。业务连接不因此获得生产管理权限。

纯界面套件通过 tests/authenticated.ts 在 worker 内复用真实会话，凭据与 cookie 不写入文件；登录、失效与托管隔离测试独立执行，不关闭生产限流。

浏览器夹具固定北京时间 2026-10-14 12:00，仅监听回环，不编译进生产镜像。完整重跑前重启夹具以重置数据库。

```bash
# backend，独立终端
cargo run --locked --example e2e_server
# frontend，独立终端
API_TARGET=http://127.0.0.1:8081 bun run dev --port 5174
bun x playwright install chromium
bun x prettier --check 'src/**/*.{svelte,ts,css}' 'tests/*.ts' '*.ts'
python3 ../scripts/audit_dependencies.py --frontend
bun run check
bun run build
bun run test:e2e
```

托管整体验收使用随机 Compose 项目、自签名证书和独立测试账号。root 执行时核查生产 UID 10001；非 root 本地测试只调整测试容器 UID，使其能够访问测试备份目录。

```bash
python3 scripts/hosted_acceptance.py --backend marksix-backend:v1-test --frontend marksix-frontend:v1-test --browser --bun /完整路径/bun
```

实际结果与未执行项目记录在 [验收索引](../guides/verification.md)，不把默认忽略的测试计为已执行。

## 文本录注开发

文本录注的领域语义解析、语法边界及确认式学习见[功能指南](../guides/text-entry-proposal.md)。语料生成器以独立语义标签生成 5,000 条样本，训练／验证／测试为 3,500／750／750；原文保留在用户私有路径。在仓库根目录执行以下命令，候选产物仅包含词汇频次，不包含原文或账号数据：

```bash
bun scripts/generate_text_entry.ts test-results/text-entry-corpus
bun scripts/train_text_entry.ts test-results/text-entry-corpus/train.jsonl
bun scripts/evaluate_text_entry.ts test-results/text-entry-corpus/train.jsonl
bun scripts/evaluate_text_entry.ts test-results/text-entry-corpus/validation.jsonl
bun scripts/evaluate_text_entry.ts test-results/text-entry-corpus/test.jsonl
# frontend；浏览器测试须先启动上述独立测试夹具
bun run test:e2e tests/text-entry-parser.spec.ts tests/text-entry-corpus.spec.ts tests/text-entry.spec.ts tests/account-scope.spec.ts --trace off
```

生成文件 `frontend/src/lib/generated/text-entry-candidates.json` 不得手工修改。修改解析器后应重跑语料评估及以上测试；涉及学习持久化时另外执行 receipts、upgrade 和 hosted 数据库测试。录制 trace 可能保留输入及认证信息，本地真实文本验收应禁用 trace。

## 附录：变量与契约

- auth：CONTROL_DATABASE_URL、PROVISION_DATABASE_URL、AUTHORITY_ADMIN_USERNAME、AUTHORITY_ADMIN_PASSWORD、TENANT_DB_HOST/PORT、BACKUP_ROOT。
- MarkSix：受限 CONTROL_DATABASE_URL、TENANT_DB_HOST/PORT、INTERNAL_AUTHORITY_URL。
- 测试：TEST_DATABASE_URL 与 TEST_PROVISION_DATABASE_URL 必须同属专用 marksix_test，TEST_ADMIN_PASSWORD 至少 12 字符；浏览器缓存可设置 PLAYWRIGHT_BROWSERS_PATH。
- 批量规则 `POST /api/plays/batch` 保留 odds、rebate_percent、enabled 字段；rule 为增量对象，省略的键保留原值，null 只用于可空字段清除。仅允许规则白名单字段，名称不可批量设置；每条合并后复用 Rule.validate，整批事务与版本校验。
- 工作台列表使用 POST /api/records/search 按单分页；POST /api/bets/search 保留原始分项查询，供财务核对及分项分析。两者共用筛选校验，bettors、play_ids 为 JSON 数组，排序仅支持 newest、amount_asc、amount_desc。按单查询的金额为未撤销分项本金之和，玩法命中任一分项时保留整单。
- 包版本以 backend/Cargo.toml 为唯一来源，构建可注入 MARKSIX_REVISION；/api/site 提供版本和提交，前端不另维护产品版本。
- 历史 SQL 迁移不可改写。现有规则和基础注的缺省字段继续服务持久化快照；风险缓存通过 0008 失效，移除旧净额回退公式。
- authority 容器标识、启动参数、环境变量和 cookie 属于当前部署契约；产品对外称 auth，内部标识无需为更名而迁移。

## 附录：数据与字体

玩法排序及组合单父子关系使用 0009 迁移，包肖使用 0010，拖使用 0011。排序不写规则版本；已有投注的 slip_id 为空，直接作为独立单据读取。历史清空先删除分项，再删组合单，最后删期次。新字段不改写既有规则和金额快照。

中文 PDF 使用 SIL OFL 1.1 的 Noto Sans SC，许可随 frontend/public/fonts/OFL.txt 交付。来源为 google/fonts 的 ofl/notosanssc/NotoSansSC[wght].ttf，提交 2894aab31764f10f29c421bdfd2340d3b382d384。使用 fontTools 4.61.1 固定 wght=400（updateFontNames=True），将 glyf.padding 设为 4 后保存为 NotoSansSC-Regular.ttf，以兼容 PDF 字体子集的短 loca 偏移。静态字体位于 frontend/src/assets，Vite 生成带内容摘要的 URL，首次导出才加载，避免缓存旧字体。静态文件随源码交付，部署无需安装字体工具；更新字体后必须实际渲染及提取文本验证，不能只检查 PDF 文件头。
