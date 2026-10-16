# MarkSix V1.0 · VPS 部署与维护

客户访问 `https://3801.win`，运营方访问 `https://admin.3801.win`。客户免安装。
GitHub Actions 构建并验证 Docker 镜像，合并 master 后将**同一次构建的 Ubuntu 工件**传入 VPS 部署。

## 架构与数据

四个常驻容器：Nginx、MarkSix 服务端、auth 管理端、共用 MySQL。备份恢复使用按需启动的维护客户端容器，完成后停止，不挤占数据库容器内存额度。两个应用复用同一 Rust 镜像，使用不同启动参数与数据库权限。数据库及应用端口不对公网发布。数据库日志轮转受限，单机冷备份方案不启用 MySQL 二进制日志。

客户业务库和 MySQL 账号分别创建。客户服务最多保留 12 个热账本池，每池 2 个连接；请求和计算中的账本暂不淘汰。客户服务通过服务端验证的会话选择账本；不能通过请求参数切换客户。
控制库保存账号、单会话、期限和激活码核销信息；只有管理服务持有数据库创建权限。

Compose 项目为 `marksix-hosted`。旧的 `marksix`、`marksix-license` 服务、数据库及备份不迁移、不删除；它们若占用 80/443，需要先明确安排访问入口。

## 一次性准备（由服务器管理员完成）

可先在服务器执行 `sudo bash hosted/prepare-server.sh ubuntu`，脚本支持 Ubuntu 22.04/24.04，核对 Docker 官方签名密钥，保留已有可用 Docker，并安装 Certbot 等依赖。

先核实 Ubuntu 版本和软件包。需要 Docker Engine、Docker Compose v2、Python 3.10+、curl、Certbot 和 systemd。不要把构建工作放到 1 GB VPS 上。

为 `ubuntu` 配置专用 SSH 部署公钥；私钥只保存到 GitHub `production` 环境的 `VPS_SSH_KEY`。该账号必须可以通过无交互 sudo 执行部署，拥有该部署权限相当于拥有服务器应用管理权限。不要使用来源未经核对的 SSH 主机公钥。

```bash
sudo install -d -m 755 -o ubuntu -g ubuntu /opt/marksix/releases
sudo install -d -m 700 /opt/marksix/shared
```

完成 GitHub SSH 配置后，首次 master 发布会自动准备依赖、生成服务器私有配置、部署并注册定时器。默认后台账号 owner，随机初始密码只保存在服务器 shared/.env 中。以下手动步骤用于预先自定义账号、域名或证书邮箱。

首次将测试通过的 Ubuntu 工件完整解压到 `/opt/marksix/releases/<完整提交SHA>/`。下面命令在该目录运行：

```bash
sudo python3 hosted/configure.py --shared /opt/marksix/shared \
  --domain 3801.win --admin-domain admin.3801.win --owner owner
```

可加 `--email 你的证书通知邮箱`。脚本不打印密码；初始管理员凭据只存在服务器的 `/opt/marksix/shared/.env`，请在服务器上私下读取并安全保管。已有配置不会被覆盖。不要把此文件、数据库密码、SSH 私钥或证书私钥提交 GitHub。

确认防火墙允许 22、80、443，MySQL 不映射公网端口。两个域名必须能转发 ACME HTTP 验证请求到此服务器。使用 Cloudflare 代理时，检查规则没有拦截 `/.well-known/acme-challenge/`，源站证书取得后使用 Full (strict) 模式。

首次部署会使用 Certbot 为两个域名申请证书；不关闭 TLS 验证。成功部署后安装定时器：

```bash
sudo bash /opt/marksix/current/install-timers.sh
```

备份默认保留最近 14 代，可在私有配置中设置 BACKUP_KEEP（1–90）。证书每天检查两次。备份在 UTC 19:00（北京时间次日 03:00）执行，避开默认开奖时段。

## GitHub 一次性配置

创建 `production` Environment，配置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Variable | `VPS_HOST` | `95.40.250.145` |
| Variable | `VPS_USER` | `ubuntu` |
| Variable | `VPS_PORT` | `22` |
| Variable | `VPS_KNOWN_HOSTS` | 经服务器控制台核实的 SSH known_hosts 记录 |
| Secret | `VPS_SSH_KEY` | 专用部署私钥 |
| Variable（可选） | `APP_URL` / `ADMIN_URL` | 公网检查地址，默认分别为两个当前 HTTPS 域名 |

在 master 设置分支保护，要求 PR 审查及 CI 验证通过，禁止常规直接推送。
dev 与 PR 只测试和构建；只有 push master 运行生产部署。生产部署串行执行，不因下一次提交自动取消。进入生产队列后重新检查最新 master；过期工件跳过。服务器在操作锁内核对 Actions run_number/run_attempt，拒绝较早构建及较早尝试。手工回退不降低这个高水位。

镜像随已测试工件传输，VPS 无须 GitHub PAT 或私有镜像仓库凭据。工件不包含生产密码和私钥。
首次安全配置完成后，再合并经过验收的 dev PR。不要为测试部署而绕过失败的验证。

## 更新与失败恢复

每个版本在独立 releases 目录，配置、证书和备份留在 shared。传输前按照外层 tar、展开工件、Docker 未压缩镜像与 2 GiB 余量预检磁盘；上传到独立 staging，拒绝越界路径和链接，校验后原子转为版本目录并删除外层 tar。载入镜像前再次核对空间。发布前校验工件 SHA256 和提交编号；暂停两个应用后分别备份控制库与客户库，再启动迁移和新容器。Nginx 按域名转发到两个应用。

检查源站 HTTPS、服务健康、两个站点身份及实际运行提交均与工件一致后，才切换 `/opt/marksix/current`。Actions 还检查公网域名转发及响应提交；Cloudflare 拦截会导致这一步失败，需要修复 CDN 规则。源站检查成功不代表所有公网访问路径已经可用。

若更新失败，应用保持停止，数据库和备份保留，`shared/deployment.json` 记录阶段。**不自动把旧程序连接到可能已迁移的数据库**。审查迁移兼容性后，选择修复新版本或恢复备份及配套旧版本。不要执行 `docker compose down -v`。

```bash
sudo python3 /opt/marksix/current/ops.py status
sudo python3 /opt/marksix/current/ops.py stop
sudo python3 /opt/marksix/current/ops.py start
sudo python3 /opt/marksix/current/ops.py backup
sudo python3 /opt/marksix/current/ops.py restore \
  --manifest /opt/marksix/shared/backups/control/某次备份.json --confirm-restore
```

stop 可重复执行，不删除数据库。冷备份会短暂停止两个应用，保证账号与各客户账本的备份边界一致；备份后重新启动。恢复会在停服前校验备份完整性及清空凭据，不合法的备份直接拒绝，网站继续运行。停服后再次校验，如尚未修改数据库就被拒绝，会重新启动应用；一旦开始修改数据库后失败，应用保持停止。恢复前自动创建恢复点。恢复不保留旧登录会话，并沿用当前已删除客户的删除凭据，避免通过旧控制库恢复已删除客户。

## 应用回退与工件保留

只回退应用、保留当前业务数据时，使用当前版本的独立恢复入口：

```bash
sudo python3 /opt/marksix/current/rollback.py --sha <保留的完整提交SHA> --confirm-rollback
```

该命令核对目标曾健康运行、工件校验和，以及最近部署尝试与目标的全部 SQL 迁移契约完全一致；缺少契约元数据或有任何变化均在停服前拒绝。通过后停服、创建恢复点、启动配套旧镜像并验证源站健康，再切换 current。不修改发布序号，不自动恢复 SQL，不承诺数据库结构改变后的无损回退。

若迁移契约不同，先在维护窗口审查配套版本与备份，按上方 restore 流程恢复匹配 SQL，再启动该备份对应的工件。恢复备份会丢失备份时间之后的业务变更；必须明确接受范围并检查删除／清空凭据。禁止靠手工改契约或改序号绕过校验。

正常保留最近 3 个健康工件和最近 3 个受管理的尝试，额外保护 current、上次版本及本次候选。只清理带本项目管理凭据的目录及三种提交专属镜像标签，不运行全局 prune、不删除 Docker 卷或备份。未知旧目录和其他系统必须人工盘点，不能自动删除。正常退出时清除本次残留 staging；进程被强制终止而未清理的 staging，超过 48 小时后由保留清理回收。

首次升级前若磁盘已不足，先按 current 和 shared/deployment.json 识别必须保留的工件，再由管理员清理已确认的旧工件；空间不足不会触发未经确认的全局清理。

## 附录：永久删除

管理员输入 `永久删除 客户账号` 后才执行。账号立即停用，删除独立数据库、数据库用户、会话、激活码、账号资料及服务器管理的客户备份。旧控制库备份包含账号资料，因此一并清除；其他客户独立的业务备份保留。完成后应重新生成全量备份。

只保留不含姓名、密码或业务内容的删除凭据。服务器外人工另存的副本无法由系统远程擦除，须由其持有人删除。

## 附录：容量

目标 VPS 为 2 vCPU / 1 GB / 40 GB，目标 200 人在线。数据库连接、登录密码计算和精确极值任务设并发上限；200 人在线不等于 200 个精确计算并行。
是否达标以实际压测记录为准，不能把默认资源限制当成容量证明。200 个长期满额账本持续增长，40 GB 不能视为无限历史存储；上线后必须监测磁盘及备份占用并按实际数据量扩容。应用不自动删除历史投注来腾空间。

## 附录：客户清空历史与备份

客户可在“玩法与配置 → 配置设置 → 清空我的历史记录”输入登录密码和指定确认文字。永久清除该客户本期之前的投注、飞出、结算、对应操作记录及该客户的服务器托管备份；本期、玩法、配置和授权保留。清空由授权服务执行，客户服务无需访问备份目录。

`shared/backups/erasures/` 保存非实名清空凭据，迁移服务器时必须一并保留，禁止手工删除或用旧备份覆盖。含已清空数据的旧全量备份不再允许恢复；其他客户的独立 SQL 文件仍保留。清空后应执行一次新的全量备份，恢复时选择新的完整代次。服务器外另存副本由持有人处理。

## 附录：Error 日志

应用固定仅输出 ERROR，不读取 RUST_LOG 以开启其他级别。Nginx `access_log off`，error 写入 stderr；MySQL 关闭 general/slow/binlog，错误详细度设为 1。财务和授权审计保存在数据库，不属于运行日志，不因 error 日志策略而停用。Docker 日志每服务最多 3 个文件、每文件 10 MB，重启／部署的命令输出用于运维状态检查。

```bash
sudo docker compose --env-file /opt/marksix/shared/.env --env-file /opt/marksix/current/.images.env -f /opt/marksix/current/compose.yaml logs --tail 100 backend authority nginx
```

当前仅构建 Ubuntu 托管工件，Windows Native 和旧独立设备授权服务已退役；不要使用旧安装命令操作当前系统。已发布 SQL 迁移的校验值保留，新迁移删除未使用的设备授权表，不触碰其他独立部署和备份。
