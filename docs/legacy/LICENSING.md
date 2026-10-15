> 历史版本资料：适用于 v0.4 本机部署，不适用于 Dev1.0 托管版。

# 授权服务与发码（v0.4）

签发私钥和授权数据库只部署在你控制的服务器上。客户安装包包含公开验签密钥；没有你的签发权限，不能生成被客户端接受的激活码。首次激活、到期续期、换设备或重建账号密码绑定，都需要新的激活码。

## 激活、绑定与到期

- 新码为 `MSX1.…` 签名封装，自动携带初始授权地址及可选的长期发现入口，客户粘贴完整激活码即可。编码不等于加密，域名不能对本机管理员保密。
- 每码只生成一次授权，首次核销后绑定设备及管理员账号密码哈希。可用 `--bind` 在发码时预绑定客户激活页显示的 64 位绑定标识。授权端不接收客户明文密码。
- 数据库事务锁保证并发核销只有一个绑定成功。已使用的码用于新的激活操作会被拒绝；同一提交 UUID 的网络重试仅恢复原授权，不增加次数或有效期。正常重启使用已有凭证联网复核，不重新激活、不消耗新码。
- 可以指定激活后有效天数，或固定到期时间。按天授权从首次成功核销开始；新码不叠加旧授权剩余时间。未使用的码默认须在签发后 30 天内激活。
- 普通复制程序目录、镜像或业务数据库到另一台机器，会因设备／账号绑定不同而不能使用。Windows 使用 MachineGuid，Ubuntu 挂载宿主机 machine-id；重置密码、重建数据库或更换机器要新码。正常升级保留原账号哈希及设备标识。

## 授权专用时钟

授权期限判断不读取客户设置的系统日期。启动后必须联网获取带新随机挑战的服务器签名时间，再使用包含睡眠／休眠时间的单调计时：Ubuntu `CLOCK_BOOTTIME`，Windows `GetTickCount64`。界面显示签名到期日和剩余天／时／分／秒。

内存中的在线租约最多 60 秒，不持久化。重启、恢复数据库或租约失效后，必须重新联网；无有效响应就锁定业务。倒拨日期、修改本地授权到期字段或恢复旧数据库，不能生成新签名或恢复内存租约。休眠超过租约期限后，唤醒也须重新校验。响应按请求开始时刻保守计时，网络延迟不会增加可用时间。

授权到期后拒绝新的业务 API 请求，后台不再发起业务任务并取消风险计算；界面正常轮询约 6 秒后回到激活页。已开始的请求或数据库事务可能完成，保持账目原子性。登录、授权、健康检查和本机备份恢复保留，数据不删除。在线撤销或失联在下一次租约复核时生效。

这不是客户绝对无法修改的物理时钟。拥有系统／虚拟机管理权限的人仍可能修改可执行文件、内核或克隆整机身份；纯本地软件不能保证绝对不可破解。服务器时间、私钥、数据库及发现入口必须由你控制；服务器本身应校准时间。客户主机的错误日期也可能导致操作系统 HTTPS 证书验证失败，此时锁定，不能借此延长授权。

## 私钥保管与版本升级

仓库 `backend/license-public-key.hex` 是公开验签锚点。与之配套的签发私钥单独交付，**不进入 Git、Actions、客户端包或镜像**。保存并离线备份原私钥；更换服务器／域名时继续使用它及原授权库。

不要为迁移重新生成密钥或新建空授权库，否则旧码和已使用状态不能延续。若有意更换密钥，必须重新构建并分发配对公钥客户端。

升级到本版时先备份并升级授权服务器，再升级客户端。数据库自动追加 `0004`，旧证书继续使用同一公钥重新核验。旧 48 位码作为兼容格式，需要在“旧码与服务迁移”中填写地址；已消费旧码不恢复次数。新 `MSX1` 码需使用 v0.4 客户端。

## 在 Ubuntu 上部署授权服务

Ubuntu 部署包包含 `license-authority/`，复用包内 backend 和 MySQL 镜像。服务器无需部署客户业务工作台。

```bash
# 在 Ubuntu 包根目录
 docker load -i images.tar.gz
 cd license-authority
 python3 setup.py
```

编辑私有 `.env`，保留脚本生成的数据库密码，并设置：

```dotenv
PUBLIC_AUTHORITY_URL=https://你的当前授权服务域名
LICENSE_DISCOVERY_URL=https://你的长期发现入口/route.json
```

`LICENSE_DISCOVERY_URL` 可以暂时留空，未来更换域名时使用签名迁移文件。默认 loopback 地址只供本机测试，给远程客户发码前必须改为可访问的 HTTPS 地址。

把原匹配私钥复制为当前目录 `signing-key.hex`，然后：

```bash
sudo chown 10001:10001 signing-key.hex
sudo chmod 400 signing-key.hex
docker compose up -d --wait --wait-timeout 180
docker compose exec -T authority marksix --license-public-key
```

最后一条只显示公钥，核对与仓库一致。Nginx／Caddy 将你的 HTTPS 地址反向代理至 `127.0.0.1:8090`，保留 `/redeem`、`/refresh`、`/health` 路径。不要对客户开放数据库、SSH 管理权限或 Docker 接口。

源码部署先执行 `docker build -t marksix-backend:local backend`，再在 `deploy/license-authority/` 按同样步骤操作。

## 签发

在你服务器的 `license-authority` 目录执行：

```bash
# 首次激活后有效 30 天
docker compose exec -T authority marksix --license-issue 30
# 固定到期时间，必须写明时区
docker compose exec -T authority marksix --license-until '2026-12-31T23:59:59+08:00'
# 可选：提前绑定客户提供的完整绑定标识
docker compose exec -T authority marksix --license-issue 30 --bind 客户的64位绑定标识
```

天数范围 1–3650；固定到期时间须在未来 3650 天内。输出一整行激活码，立即安全保存并交给对应客户；服务器只保存随机令牌哈希，不能找回原码。客户只填写激活码，无需自己填写域名。到期后你再发新码。

## 更换服务器或域名

自动迁移需要一个仍能访问的长期发现入口，客户端不能凭空知道新地址：

1. 备份并迁移原授权数据库、原私钥及 `.env` 到新服务器，避免新旧授权库独立接受核销。
2. 修改 `PUBLIC_AUTHORITY_URL` 为新 HTTPS 地址并重建授权服务容器：`docker compose up -d --wait --wait-timeout 180`。
3. 签发更高版本的地址文件，并发布到原来的长期发现入口：

```bash
docker compose exec -T authority marksix --license-route 2 > route.json
```

首次发布用版本 1，以后每次迁移递增。`route.json` 只含公开地址及签名，可作为 HTTPS 静态文件发布；客户端验签并拒绝版本回退。只要发现入口可达，旧码自动连接新服务。授权库和私钥不变时，原有未使用码仍可核销，已使用码仍保持已使用，原授权到期时间不变。

若所有旧地址和发现入口都已不可达，把新的签名 `route.json` 文件交给客户。在激活页展开“旧码与服务迁移”，导入后点击“更新服务地址并重新核验”。此操作不消费激活码、不续期；已有授权按原期限恢复校验，未使用的旧码也能继续激活。迁移文件签名必须与原安装包公钥匹配。

## 查看与撤销

```bash
docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u authority marksix_authority -e "SELECT code_hash,valid_days,expires_at,redeem_before,redeemed_at,binding,intended_binding FROM license_codes ORDER BY redeem_before DESC"'
docker compose exec -T authority marksix --license-revoke 64位授权ID
```

客户可以从配置页复制授权编号。撤销后客户端下一次在线复核锁定，通常在当前 60 秒租约到期时生效。

## 授权库备份

```bash
umask 077
docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysqldump --single-transaction --no-tablespaces --set-gtid-purged=OFF --hex-blob -u authority marksix_authority' > authority-backup.sql
```

授权库与客户业务库分别备份，同时私下备份私钥和 `.env`。恢复授权库前暂停核销并核对备份点之后的记录，防止把已经用过的码恢复成未使用状态。SQL 备份不能替代原私钥。
