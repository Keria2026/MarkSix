# MarkSix

单管理员、本机访问的盘口统计工作台。v0.3 支持投注人、原受注／飞出／自留账目，以及按同一合法开奖结果计算的精确盈亏极值。界面采用 Svelte 5、系统字体和 Liquid Glass 风格。

## 下载与部署

在 [GitHub Actions](https://github.com/Keria2026/MarkSix/actions) 选择 **dev 分支最新成功运行**，下载相应 Artifact 并完整解压：

| 环境 | 工作流 / 工件 | 启动方式 |
| --- | --- | --- |
| Windows 10/11 x64 原生 | Windows Native / `MarkSix-Windows-Native-x64` | 安装包内 VC++ 运行库，首次 `Install.cmd`，日常 `Start.cmd` |
| Ubuntu x64 服务器 | CI / `MarkSix-Ubuntu-x64` | 预先安装 Docker Engine、Compose v2、Python 3，运行 `bash install.sh` |

默认访问 `http://127.0.0.1:8088`。首次登录后，填写自己配置的授权服务 HTTPS 地址和一次性授权码；到期需新码续期。授权服务和发码步骤见 [授权说明](docs/LICENSING.md)。Windows 原生版不需要 Docker、WSL、Node 或 Rust。首次安装自行设置管理员密码，没有默认密码。下载工件需要 GitHub 登录，工件保留 30 天，过期后可手动运行工作流重建。

**升级前先备份。** 新版自动进行增量数据库迁移；旧投注的规则和结算快照保持原样。旧记录没有投注人，显示“未登记（旧记录）”。Windows 的旧数据继续保存在原用户 `%LOCALAPPDATA%\MarkSix`。

## 本版功能

- 按接口红、蓝、绿波色展示开奖；自动抓取、异常提示和结算恢复。
- 必填投注人；投注金额筛选、纠正金额、撤销及永久操作记录。
- 飞出沿用原基础注赔率和反水，支持多个受注方；分别统计原受注、飞出和自留盈亏。
- 玩法 JSON 导入／导出共享；删除保留历史快照。投注页按名称匹配玩法，越界选择立即提示并阻止。
- 复式默认关闭，按玩法启用；普通多选按数量规则拆注；可另设“最多可选数量”。
- 号码、生肖、波色、尾数、单双、大小、生肖种数（四肖亮等）；二中二含特分档赔率；特碰、软碰、“至少命中 N 项”（含 3 中 2）。
- 大小／单双在所选开奖范围出现 49 时退本，无有效本金和反水。
- 每年元旦自动轮换生肖；号码、生肖、尾数、大小、单双可配置本命肖特殊赔率和反水。
- 本期统计、投注人和飞出受注方分类；历史详情保留在历史统计下。
- 开始／封盘时间需再次验证管理员账号密码，下一期生效。
- 官方频道内嵌调码助手，同时提供新窗口入口。

赔率表规则可在玩法配置中导入包内 `fixtures/customer-plays.json`：33 条玩法，统一 10% 反水。导入会新增配置，先预览确认。

## 文档

- [当前业务与开发规范](docs/SPECIFICATION.md)
- [领域术语](CONTEXT.md)
- [开发、架构与验证命令](docs/DEVELOPMENT.md)
- [Ubuntu 部署、备份和升级](docs/RUNNING.md)
- [Windows 原生安装、中文路径与升级](docs/WINDOWS.md)
- [授权服务、设备绑定与发码](docs/LICENSING.md)
- [验证范围与限制](docs/TESTING.md)
- [赔率表真实运行核对](docs/RUNTIME_ACCEPTANCE.md)

当前仅交付 Ubuntu Server 与 Windows Native。旧 Windows Docker 脚本、打包流程和过期文档已删除，历史版本可在 Git 中查看。
