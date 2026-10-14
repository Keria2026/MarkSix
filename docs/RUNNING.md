# Ubuntu 本机运行

需要 Docker Engine 与 Docker Compose v2、Python 3，以及可访问镜像仓库和开奖接口的网络。数据库不暴露宿主机端口，网页仅监听本机。首次构建请预留足够磁盘空间（建议至少 6 GB）；数据库与备份空间随历史记录增长。

```bash
git clone https://github.com/Keria2026/MarkSix.git
cd MarkSix
python3 scripts/configure.py
docker compose up -d --build
docker compose ps
```

打开 **http://127.0.0.1:8088**，使用配置脚本中自行设置的管理员账号与密码。没有默认密码。首次构建需要下载 Rust、Bun 与依赖；建议在内存至少 2 GB 的构建机上构建，1 GB 运行机使用预构建镜像。

管理员凭据只在数据库首次初始化时创建。之后修改 `.env` 不会重置已有账号。保管好 `.env` 与备份；不要提交到 Git。初始三个玩法只是说明书示例，正式录入前核对赔率、反水、封盘时间和生肖表。

## 页面与流程

- 本期概览：盘口本金、反水、实际盈亏或开奖前精确极值及对应示例开奖。
- 录入投注：选择玩法、单式或复式、选项和每注金额；预览按投注者口径显示。
- 投注详情：查看每条拆分基础注；封盘前可撤销整条记录并重新录入。
- 历史统计：按期查询，未结算金额与已实现盈亏分开。
- 玩法与配置：版本化规则、下一期封盘时间、未来生效的生肖映射。历史快照不随配置变化。

时间统一按北京时间处理。默认 08:00 开始、21:28 封盘、21:34 起每 60 秒抓取开奖。无有效数据时保留待结算本金；不会编造或手动补填开奖。风险计算超时会明确显示，不能当作已通过性能验收。

## 更新与镜像

更新前备份，然后 `git pull --ff-only`、`docker compose up -d --build`。数据库迁移启动时自动执行。

GitHub Actions 在每次提交中验证代码和构建镜像，并上传镜像归档。手动运行 CI 时启用 `publish` 可发布到 GHCR；在 `.env` 设置该次运行输出的 `BACKEND_IMAGE`、`FRONTEND_IMAGE` 完整标签，然后执行：

```bash
docker compose pull
docker compose up -d --no-build
```

私有 GHCR 镜像需要先 `docker login ghcr.io`。不要混用不同提交的前后端镜像。

## 备份、恢复与停止

```bash
bash scripts/backup.sh
# 恢复会覆盖当前数据，先另存现状备份，再执行：
CONFIRM_RESTORE=yes bash scripts/restore.sh backups/marksix-时间.sql.gz
```

备份包含完整投注与管理员哈希，应保存在受限位置并定期复制到另一块磁盘。恢复失败时保持服务停止，检查错误后重新恢复。

`docker compose down` 停止服务且保留数据库卷；不要使用 `down -v`，它会删除持久数据库。

## 排查

```bash
docker compose ps
docker compose logs --tail=100 backend
docker compose logs --tail=100 db
```

若数据库初始化中，等待其健康检查通过。若接口不可用，页面会显示获取异常并按窗口重试。首次启动日期与接口不匹配时不会结算不匹配结果。端口占用时修改 `.env` 的 `PORT` 后重新启动。

Compose 的三项服务合计限制 2 vCPU、832 MiB 内存。实际目标机仍需按 [测试说明](TESTING.md) 验收；镜像编译资源不属于运行资源预算。
