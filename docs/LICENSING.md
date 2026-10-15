# 授权服务与发码（v0.3）

客户端首次登录后显示激活页；账号密码验证通过还不代表已经获得业务使用权。未激活、过期、设备或密码绑定变化时，业务 API 返回 402，后台抓取／结算／风险计算暂停。登录、授权、退出、健康检查及本机备份恢复仍可用。

## 机制与边界

- 授权码为 192 位随机数，数据库只保存 SHA-256；发码时指定 1–3650 天，未使用的码须在 30 天内激活。
- 独立授权服务以事务核销，一码只创建一份授权，绑定设备与管理员账号密码哈希。不同设备／账号不能重用；同一绑定的网络重试只取回原授权，不延长有效期；到期必须用新码。
- 客户端内置 Ed25519 公钥，签发私钥只在授权服务。服务地址可由激活页配置，跨网络必须 HTTPS，本机测试允许 `http://127.0.0.1:8090`；HTTPS 重定向不自动跟随。
- 激活后的凭证每 60 秒在线核验。到期、撤销或超过缓存期后无法连接授权服务，会锁定业务；不自动给离线宽限期。系统时钟须准确。
- 设备来自 Windows MachineGuid 或 Ubuntu 主机 machine-id；账号绑定包含保存的 Argon2 密码哈希。复制数据库到另一台设备后须用新码重新激活。正常版本升级保留账号哈希和设备标识，不重新消耗授权码。
- 签名可防止伪造授权，HTTPS 保护传输；Rust release 裁剪符号。任何本地软件都无法保证“不可破解”，拥有管理员权限的人仍可修改程序、克隆设备标识或分析内存。私钥不能通过混淆或客户端加密来保密，必须留在你控制的服务端。

## 你保管的签发私钥

仓库的 `backend/license-public-key.hex` 是本批安装包的公开验签锚点，可以公开。与之配对的签发私钥通过单独的所有者文件交付，**不在 Git、Actions、客户端包或镜像中**。请保存到你控制的服务器并离线备份，丢失后无法为当前安装包签发新授权。

如需更换自己的密钥：`marksix --license-keygen 新私钥路径`，把输出的公钥写入 `backend/license-public-key.hex`，重新构建两端客户端，再部署配对私钥。旧公钥客户端不会接受新私钥签发的凭证。

## Ubuntu 上部署授权服务

Ubuntu 包包含 `license-authority/`，复用包内 backend 和 MySQL 镜像，不需要新增另一种客户端。开发源码对应 `deploy/license-authority/`。授权服务应部署到你控制的服务器，独立于客户的业务数据库。

```bash
# 在 Ubuntu 包根目录；如果未导入镜像，先 docker load -i images.tar.gz
cd license-authority
python3 setup.py
# 将单独交付的匹配私钥复制为本目录 signing-key.hex，切勿提交到 Git。
sudo chown 10001:10001 signing-key.hex
sudo chmod 400 signing-key.hex
docker compose up -d --wait --wait-timeout 180
# 核对下面输出与仓库公钥一致，不要输出私钥：
docker compose exec -T authority marksix --license-public-key
```

源码部署时先构建 `docker build -t marksix-backend:local backend`，在 `deploy/license-authority` 执行上述步骤。授权数据库也需要 MySQL 8.4。`.env` 由脚本单独生成，首次启动运行增量迁移。

在 Nginx／Caddy 为服务配置你自己的 HTTPS 域名，反向代理到 `127.0.0.1:8090`。应用路径 `/redeem`、`/refresh` 和 `/health`；反向代理可增加按来源的限速。不要将 MySQL 端口或 Docker 管理接口开放给客户。客户端激活页填 `https://你的域名`，若反向代理有路径前缀，也应包含该前缀。

## 发码、查看与撤销

```bash
# 签发激活后有效 30 天的一次性授权码；仅在你的服务器终端执行。
docker compose exec -T authority marksix --license-issue 30
# 撤销指定授权（客户凭证的 id，可从下方数据库查询获得）：
docker compose exec -T authority marksix --license-revoke 64位授权ID
```

发码输出只出现一次，请通过你自己的渠道交给客户；不要把授权码放进公开日志、Git 或客户端包。客户先设置本机管理员账号密码，登录后填写你提供的服务地址和授权码。到期再签发新码。提前使用新码的期限从新码激活时起算，不叠加未用完时间。

查看授权状态（不显示可使用的原始授权码）：

```bash
docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u authority marksix_authority -e "SELECT code_hash,valid_days,redeem_before,redeemed_at,binding FROM license_codes ORDER BY redeem_before DESC"'
```

## 授权库备份

授权库与客户业务库分别备份。授权服务数据库丢失／回滚可能导致已核销码状态丢失，不能用旧备份当作新的发码库。恢复后先保持服务停止，核对恢复点之后的核销和撤销记录，再重新开放。

```bash
umask 077
docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysqldump --single-transaction --no-tablespaces --set-gtid-purged=OFF --hex-blob -u authority marksix_authority' > authority-backup.sql
```

同时离线备份私钥与 `.env`，仅拥有 SQL 备份不能替代签发私钥。
