# 质量验证与迭代入口

## 修改前确定边界

先查看工作区差异，保留已有改动。按[源码地图](codebase.md)找到调用方、被调用模块和对应测试，再修改共享原因。涉及多端契约时同时阅读 Rust 与 TypeScript 类型。不要根据函数名推断金额单位、客户身份或日期口径。

| 修改边界       | 必须核对的行为                                             | 验证位置                                                 |
| -------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| 金额与规则     | 整数分、精度拒绝、溢出、复式展开、和局及历史费率           | `backend/tests/rules.rs`                                 |
| 业务写入       | 同标识重试、内容冲突、事务回滚、期次锁顺序、快照           | `backend/tests/ledger.rs`                                |
| 身份与生命周期 | 账号隔离、失效请求、禁用与到期、恢复后的擦除约束           | `backend/src/hosted/tests.rs`、`backend/test_support/`   |
| 前端请求与回执 | 取消后禁止更新旧视图、存储损坏拒绝提交、响应丢失恢复       | `frontend/tests/unit/state.test.ts`、`transport.test.ts` |
| 文本录注       | 选项、金额、分组、原文范围、歧义保留、合计核对             | `frontend/tests/unit/text-entry-*.test.ts`、语料评估脚本 |
| 对账导出       | 独立本金与派彩核算、反水分档、和局退款、快照不完整时拒绝   | `frontend/tests/unit/statement.test.ts`                  |
| UI 与 UX       | 窄屏溢出、可访问名称、键盘与焦点、等待与失败状态、减少动画 | `frontend/tests/e2e/`                                    |
| 部署与脚本     | 文件摘要、路径与链接、备份预检、失败后状态、发布顺序       | `scripts/tests/`、`scripts/verify_hosted.py`             |

前端测试和 TypeScript 语料脚本本身也须通过 `bun run check:tests`；Bun 执行通过不代表 TypeScript 类型检查通过。

新增测试使用合成输入，期望金额独立计算。禁止用被测展开、计划或汇总函数生成其自身的期望值。接口模拟只能证明界面契约；SQL 原子性和租户隔离必须用独立 MySQL 实例验证。

## 覆盖率测量

CI 在 `test-results/coverage/` 生成原始测量和统一清单，并上传 `coverage-report` 工件。

- Rust：`cargo-llvm-cov` 汇总纯逻辑和真实数据库测试的行覆盖率。
- 前端逻辑：Bun 输出 LCOV；执行目录为 `frontend/`。
- 浏览器：`bash scripts/test_browser.sh` 启动并清理独立测试服务，后端 API 的浏览器访问也计入 Rust 测量。设置 `COVERAGE_DIR` 后，Playwright fixture 收集 V8 覆盖率并通过 source map 映射回 TypeScript/Svelte。无覆盖率环境变量时不增加采集开销。
- Python：使用 `scripts/requirements-test.txt` 中的工具及根目录 `.coveragerc` 测量行与分支。
- 清单：`scripts/coverage_report.py` 枚举运行时代码，列出没有测量数据的文件。TypeScript 工具脚本与 Shell 脚本单列，类型声明和测试代码不属于运行时代码分母。

不能把已加载模块的覆盖率称为整个项目覆盖率。统一清单合并同一源码行的命中，不能把不同测试运行的分母累加。行覆盖率不能代替分支覆盖率，浏览器生成代码覆盖率不能代替源文件覆盖率。

```sh
# 在仓库根目录；需先安装锁定的测试工具和项目依赖。
python3 -m coverage run -m unittest discover -s scripts/tests -v
python3 -m coverage json

# 在 frontend/ 中运行。
bun test --coverage --coverage-reporter=lcov --coverage-dir=../test-results/coverage/frontend tests/unit
COVERAGE_DIR=../test-results/coverage/browser bun run test:e2e

# 最后回到仓库根目录汇总。
python3 scripts/coverage_report.py
python3 scripts/coverage_report.py --strict
```

`--strict` 在存在未测文件、未覆盖行或已测 Python 分支缺口时返回失败。它是目标检查，不能证明其他语言未测的分支已经覆盖。普通报告模式保留缺口事实，不宣称目标达成。每次完整测量应从空的 `test-results/coverage/` 开始，避免混入旧源码或旧浏览器用例的数据；Rust 使用 `cargo llvm-cov clean --workspace` 清除历史测量后重测。

Rust 工具安装、数据库环境变量、语料评估及浏览器服务启动顺序以 `.github/workflows/ci.yml` 为准。浏览器可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定本机 Chromium，CI 默认使用 Playwright 安装的版本。测试只连接独立的 `marksix_test`。

## 完成标准

提交前检查真实差异及未跟踪文件；依次完成受影响测试、格式、类型、构建、文档链接和依赖审计。金融、认证、解析、恢复变更必须运行对应失败路径测试。跨端修改运行浏览器及数据库集成测试。

报告区分静态审查、模拟接口验证、真实数据库验证、镜像验收和生产部署。未运行、被跳过、失败或尚未覆盖的部分必须明示。逐次审查结论及日志放在忽略的 `test-results/`，本目录只保留长期有效的约束和导航。
