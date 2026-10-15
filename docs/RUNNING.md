# Ubuntu 部署与维护

## 使用 Actions 构建包

适用 Ubuntu 22.04／24.04 x64，需预先安装 Docker Engine、Docker Compose v2 和 Python 3；当前用户须能运行 Docker。运行目标 2 vCPU／1 GB，构建建议使用更大内存机器或 GitHub Actions。

1. 在 dev 分支成功的 **CI** 工作流下载 `MarkSix-Ubuntu-x64` 并完整解压到固定目录。
2. 运行 `bash install.sh`。脚本验证包内 SHA256，首次要求设置管理员账号和密码，生成私有 `.env`，导入包含 MySQL 的镜像并等待服务健康。
3. 浏览器访问 `http://127.0.0.1:8088`。包不包含任何预置账号密码。
4. 日常启动 `bash start.sh`，停止 `bash stop.sh`。已启动服务通过 Docker 重启策略恢复。

默认仅绑定服务器本机。远程管理可使用 `ssh -L 8088:127.0.0.1:8088 user@server`，再在自己电脑访问该地址。不要直接公开数据库端口。

## 从源码部署

在仓库根目录执行：

```bash
python3 scripts/configure.py
docker compose up -d --build --wait --wait-timeout 180
```

首次构建需要下载依赖。`.env` 已存在时配置脚本拒绝覆盖；修改环境变量不会重置数据库中的管理员密码。

## 备份和恢复

```bash
bash scripts/backup.sh
# 恢复会覆盖当前数据库，确认目标和备份后执行：
CONFIRM_RESTORE=yes bash scripts/restore.sh backups/marksix-时间.sql.gz
```

备份包含业务数据及账号密码哈希，应复制到其他存储并限制访问。恢复脚本会停止应用和前端，导入后再启动。

## 升级

1. 先备份数据库、旧程序包及 `.env`。
2. 停止旧应用，完整解压新版文件；保留 `.env`，不要删除 Docker 卷。
3. 运行新包 `bash install.sh` 导入镜像并启动。原 Compose 项目名为 `marksix`，数据库卷沿用。
4. 检查登录、历史记录和当期期次。v0.2 使用增量迁移，旧投注快照不变；旧投注人显示“未登记（旧记录）”。

不要运行 `docker compose down -v`，它会删除数据库。迁移后回退旧程序，应同时恢复对应旧版数据库备份。

## 日志和配置

```bash
docker compose ps
docker compose logs --tail=100 backend db
```

网页端口由 `.env` 中 PORT 控制，默认 8088。应用与数据库只在 Compose 内部通信。开始／封盘时间在网页配置，需要再次验证管理员账号密码，下一期生效。

开奖接口和官方频道需要外网。运行服务不需要 GitHub 凭据；安装包不包含云开发环境的配置或密钥。
