# Windows Docker Desktop 部署包

适用 Windows 10/11 x64，Docker Desktop 使用 WSL 2 后端和 Linux 容器模式。暂不支持 Windows ARM64 或 Windows 容器模式。安装包不是独立 EXE，Docker Desktop 需要事先安装并启动；Docker Compose 要求 2.20 或更新版本。

## 下载

打开 https://github.com/Keria2026/MarkSix/actions ，选择 master 分支最新的成功 CI，在页面底部 Artifacts 下载 **MarkSix-Windows-x64**。需要登录 GitHub。工件保存 14 天；过期后可在 Actions 中手动运行 CI 重新生成，无需启用 publish。

解压整个 ZIP 到固定目录，例如 `C:\MarkSix`，不要直接在压缩包中运行，也不要只复制安装脚本。路径包含空格可以正常使用。

## 安装

1. 启动 Docker Desktop，等待 Engine running。
2. 双击 Install.cmd。
3. 按提示设置管理员账号和密码。密码至少 12 字符，不含单引号、反斜杠和换行；输入时不回显。
4. 等待镜像导入、数据库初始化和健康检查，成功后自动打开 http://127.0.0.1:8088 。

包内包含前端、后端和 MySQL 的 Linux amd64 镜像，安装时不需要 Rust、Bun、Python、Git、镜像仓库账号或本地编译，也不需要下载镜像。运行中的自动开奖抓取仍需要互联网。安装脚本会校验文件 SHA-256，检测下载损坏；未采用代码签名。

账号与随机数据库密码保存到 `data\.env`，目录访问权限限制为当前 Windows 用户及 SYSTEM。没有默认密码，重复运行 Install.cmd 不会覆盖已有配置或修改密码。建议始终由同一个 Windows 账号安装和管理。

默认端口 8088。若已被占用，可在 PowerShell 执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -Port 8090
```

`-Port` 仅在首次创建配置时生效；安装后修改端口需编辑 `data\.env` 的 PORT 再运行 Start.cmd。不要通过修改此文件重置已有管理员密码。

## 日常操作

- Start.cmd：启动并打开网页。
- Stop.cmd：停止应用，保留全部数据库数据。
- Backup.cmd：将完整 SQL 备份保存到 `data\backups`，包含投注及账号哈希，妥善保管并复制到另一块磁盘。
- Docker Desktop 的 Containers 页面：查看 marksix 服务组状态和日志。

数据库实际保存在 Docker 命名卷 `marksix_mysql-data`，不在解压目录。不要删除该卷，也不要执行 `docker compose down -v`。复制安装目录不等于备份数据库。

## 更新

先运行 Backup.cmd 并另存备份，停止应用，解压新包到另一目录，将旧目录的 **data 文件夹完整复制过去**，再运行新包 Install.cmd。固定项目名与数据库卷保证数据延续；升级前的备份需要保留。若检测到已有数据库却缺少原配置，安装会停止，避免误生成新密码。

从旧版手动 Compose 部署迁移时，把原 `.env` 放入新包 `data\.env`，保留原密码及端口；数据库卷必须是同一 Docker Desktop 引擎中的 `marksix_mysql-data`。其他项目名或引擎的数据需要先由管理员备份迁移。

## 资源与验证范围

Docker Desktop 建议分配至少 2 GB 内存，另预留镜像、数据库及备份所需磁盘空间。应用 Compose 限额为合计 2 vCPU、832 MiB，不包含 Windows、WSL 和 Docker Desktop 本身开销。

CI 在 Windows runner 上验证 PowerShell 5.1 和 7 的脚本语法、配置权限、幂等安装及校验逻辑；在 Linux runner 上实际启动打包所用镜像。Windows Docker Desktop 的完整交互安装仍需实机验收，不能把脚本测试视为已完成桌面端全链路测试。

故障时保留控制台错误，在 Docker Desktop 查看日志。若提示脚本被组织策略禁止，应联系管理员，不要更改整机执行策略。启动器只对当前 PowerShell 进程设置执行策略。
