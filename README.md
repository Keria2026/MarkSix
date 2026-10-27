# MarkSix

面向盘口方的托管账本。客户手工录注，系统按玩法快照拆注、结算并统计原受注、飞出和自留盈亏；auth 管理客户账号与授权。

- **录入**：普通、多选、复式、拖、包肖及跨玩法组合单；北京时间每日 06:00 切期，开奖后补录即时结算。
- **对账**：投注人及受注方分类、逐注判定、金额纠正、撤销、PDF／PNG 对账单。
- **配置**：玩法搜索、排序、导入导出、批量管理及普通／特殊赔率反水。
- **隔离**：每客户独立业务库、单会话登录、账号授权和自助改密。

当前实现：Rust / Axum / SQLx / MySQL 8.4，Svelte 5 / TypeScript / Vite / Bun，Ubuntu Docker / Nginx。客户站点 `https://3801.win`，auth `https://admin.3801.win`。

开发推送 `dev` 进行 CI；验收后合并 `master`，Actions 验证、打包并部署同一次构建。`dev` 不发布生产。

[文档索引](docs/README.md) · [开发规范](AGENTS.md) · [部署与恢复](docs/deployment/vps.md)
