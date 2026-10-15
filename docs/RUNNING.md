# Dev1.0 部署与维护

当前入口为 [VPS / Actions / Docker / Nginx 指南](../deploy/vps/README.md)，包含首次配置、双域名 HTTPS、GitHub Secrets、更新、备份、恢复及失败处理。

客户只访问网站。dev 验证后由运营方合并 master，Actions 成功才部署；不在 VPS 上现场构建。

旧本机工作台的 install.sh、8088 和设备激活流程见 [历史 Ubuntu 指南](legacy/RUNNING.md)，不适用于 Dev1.0。
