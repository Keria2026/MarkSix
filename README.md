# MarkSix · Dev1.0

由运营方托管的盘口统计网站。客户登录网站手工录注，各自拥有独立的投注、玩法、配置和账本；运营方通过独立后台创建账号、签发一次性激活码和管理授权。

客户网站：`https://3801.win`；管理后台：`https://admin.3801.win`。Dev1.0 已完成首次上线；dev 后续改动仍须测试并由运营方合并 master 后发布。

## 架构与发布

Rust 1.90 / Axum / MySQL 8.4，Svelte 5 / TypeScript / Bun 1.3.14。前端保持系统字体、Liquid Glass 风格、键盘操作与触摸目标。

Docker Compose 运行 Nginx、MarkSix 客户服务、授权管理服务和一个 MySQL 服务。Nginx 按域名转发；每个客户使用独立业务库及数据库权限。应用与数据库端口不对公网开放。

```text
Codex → dev → Actions 验证 → 人工验收并合并 master
      → Actions 测试和构建 → 传输同一构建工件 → 备份、迁移、更新、健康检查
```

dev 不更新生产。生产密码、SSH 私钥和证书不进入 Git、镜像或工件。VPS 无需安装 Rust、Node 或客户安装包。

## 业务功能

- 接口波色展示、自动抓取、异常提示及原子结算。
- 投注人、金额筛选与纠正、撤销、飞出及原受注／飞出／自留统计。
- 玩法导入导出、搜索匹配、数量边界、按规则拆注、赔率和反水快照。
- 号码、生肖、波色、尾数、大小、单双、生肖种数；特碰、软碰、三中二及二中二含特分档。
- 大小／单双按所选范围处理 49 退本；年度生肖与本命费率。
- 尾数玩法可设置 0 尾特殊赔率，含 0 尾的基础注逐注应用并保留快照。
- 本期统计含投注记录，自动列出已有投注人和玩法供多选筛选，支持投注总额升降序。
- 客户可验证密码后永久清空本期之前的历史及托管备份；本期、配置和授权保留。
- 同一合法开奖结果下的精确盈亏极值；过期、超时和失败明确显示。
- 账号专用激活码、提前续期、永久授权、单会话及永久删除客户。

可导入 `fixtures/customer-plays.json`：33 条玩法，统一 10% 反水。导入另建配置，先预览确认。

## 文档

- [Dev1.0 设计与已确认边界](docs/DEV1_ARCHITECTURE.md)
- [业务开发规范](docs/SPECIFICATION.md) · [领域术语](CONTEXT.md)
- [开发与测试](docs/DEVELOPMENT.md) · [验证范围](docs/TESTING.md)
- [Dev1.0 实际验收记录与未验证范围](docs/DEV1_ACCEPTANCE.md)
- [VPS / Actions / Docker / Nginx 部署](deploy/vps/README.md)
- [账号、激活与续期](docs/LICENSING.md)
- [赔率表运行核对](docs/RUNTIME_ACCEPTANCE.md)

当前仅交付 Ubuntu VPS Docker 托管版。Windows / 本机安装及旧设备授权实现已退役，资料可从 Git 历史查阅；已有旧系统和备份不受本仓库清理影响。运行日志仅记录 error，财务操作审计独立保存在数据库。
