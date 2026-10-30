# VPS 部署

## 准备服务器和域名

准备 Ubuntu 22.04 或 24.04 x64 VPS、可使用 sudo 的 SSH 账号，以及两个不同的域名，分别用于客户工作台和运营管理端。将两个域名的 DNS 解析到 VPS；开放 SSH、80 和 443 端口。证书签发期间，域名需能直接访问该服务器的 80 端口。

部署资源分为发布目录 `/opt/marksix/releases/<commit>` 和持久化目录 `/opt/marksix/shared`。`/opt/marksix/current` 指向当前发布的 `hosted` 目录。

## 配置 GitHub Actions

在自己的仓库中创建 `production` Environment，配置以下变量与密钥：

| 类型     | 名称                   | 内容                                |
| -------- | ---------------------- | ----------------------------------- |
| Variable | `APP_URL`、`ADMIN_URL` | 客户与管理端的 HTTPS 地址           |
| Variable | `VPS_HOST`             | VPS 的 SSH 主机名或 IP              |
| Variable | `VPS_USER`             | 部署用 SSH 用户                     |
| Variable | `VPS_PORT`             | SSH 端口                            |
| Variable | `VPS_KNOWN_HOSTS`      | 经独立核对的服务器 SSH 主机公钥记录 |
| Secret   | `VPS_SSH_KEY`          | 部署账号对应的私钥                  |

将对应公钥加入服务器部署账号的 `authorized_keys`。当前工作流通过 `sudo -n` 执行版本内的 `release.sh`，部署账号需要相应的免交互 sudo 权限。

## 初始化环境

从 Actions 的 `MarkSix-Ubuntu-x64` 工件下载并解压部署包，将其中的 `hosted` 目录上传至服务器的临时准备目录。在该目录运行：

```bash
sudo bash prepare-server.sh <部署用户>
sudo python3 configure.py \
  --shared /opt/marksix/shared \
  --domain app.example.com \
  --admin-domain admin.example.com \
  --email ops@example.com \
  --owner owner
```

将示例域名、邮箱和管理员名替换为自己的值。配置程序生成 `/opt/marksix/shared/.env`，包含域名和随机密钥。首次管理端登录凭据从该文件私下读取。

| 配置位置                              | 管理内容                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `/opt/marksix/shared/.env`            | `APP_DOMAIN`、`ADMIN_DOMAIN`、`ACME_EMAIL`、初始管理员、数据库密钥与 `BACKUP_KEEP` |
| 仓库 `.github/workflows/ci.yml`       | 分支触发、验证、镜像构建、工件传输及部署步骤                                       |
| 仓库 `deploy/vps/compose.yaml`        | 容器拓扑与资源配置                                                                 |
| 仓库 `deploy/vps/nginx.conf.template` | TLS 与按域名路由                                                                   |

常规部署只需设置服务器环境和 Actions 参数。域名由持久化配置注入 Nginx 模板。

## 发布

推送开发变更至 `dev`，通过 Pull Request 验收后合并至 `master`。Actions 对该提交完成验证、镜像构建及运行检查，生成 Ubuntu 工件，再经 SSH 传输至服务器部署。

首次发布会加载镜像、初始化数据库并申请 TLS 证书。发布结束后，检查 Actions 的部署结果及两个域名的 `/api/health`。

## 维护

```bash
cd /opt/marksix/current
sudo python3 ops.py status
sudo python3 ops.py backup
```

备份保存在 `shared/backups`，包含控制库与客户库的一致备份代次。另行保存持久化配置与证书，并将备份复制至其他存储位置。

恢复指定备份：

```bash
sudo python3 ops.py restore \
  --manifest /opt/marksix/shared/backups/control/<备份代次>.json \
  --confirm-restore
```

恢复会覆盖数据库，应在维护窗口操作。恢复前校验备份完整性；数据库恢复失败时，应用保持停止，需先检查状态和日志再继续。

切换至保留的健康版本：

```bash
sudo python3 rollback.py --sha <完整提交SHA> --confirm-rollback
```

应用回滚要求两个版本的数据库迁移契约一致。涉及数据库变更时，需要同时恢复匹配的备份。
