# 本地开发

## 工具

使用 Linux 或 WSL2 Ubuntu，安装 Rust 1.90、Bun 1.3.14、Node.js 24、Python 3.10 及以上、Docker Engine 与 Compose 插件。源码及依赖放在 Linux 文件系统。

```bash
git clone <你的仓库地址> MarkSix
cd MarkSix
cd frontend
bun install --frozen-lockfile
bun run check
bun run build
cd ../backend
cargo build --locked
```

## 服务配置

运行拓扑与[系统架构](architecture.md)一致。准备一个 MySQL 8.4 控制数据库以及两个数据库身份：运营服务负责迁移与租户开通，客户服务负责会话验证和业务访问。连接信息从环境变量读取。

| 服务     | 环境变量                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 运营服务 | `CONTROL_DATABASE_URL`、`PROVISION_DATABASE_URL`、`AUTHORITY_ADMIN_USERNAME`、`AUTHORITY_ADMIN_PASSWORD`、`BACKUP_ROOT`、`TENANT_DB_HOST`、`TENANT_DB_PORT`、`BIND_ADDR` |
| 客户服务 | `CONTROL_DATABASE_URL`、`TENANT_DB_HOST`、`TENANT_DB_PORT`、`INTERNAL_AUTHORITY_URL`、`BIND_ADDR`                                                                        |
| 两端     | HTTPS 环境下配置 `SECURE_COOKIE=true`                                                                                                                                    |

运营服务先启动，完成控制库与现有客户库迁移；再启动客户服务。两端使用相同的源码版本。

```bash
# 分别在已加载相应私有环境变量的终端中运行
cargo run --locked --manifest-path backend/Cargo.toml -- --hosted-authority
cargo run --locked --manifest-path backend/Cargo.toml -- --hosted
```

前端使用 Vite 代理 API。分别以客户服务和运营服务作为 `API_TARGET`，启动两个前端进程：

```bash
cd frontend
API_TARGET=http://127.0.0.1:8080 bun run dev --port 5173
# 另一个终端
API_TARGET=http://127.0.0.1:8090 bun run dev --port 5175
```

需要完整数据库权限初始化及 HTTPS 环境时，使用[部署指南](deployment.md)中的 Compose 配置。

## 测试

无数据库的检查：

```bash
cargo fmt --manifest-path backend/Cargo.toml --all --check
cargo clippy --locked --manifest-path backend/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path backend/Cargo.toml
python3 -m unittest discover -s scripts/tests -v
python3 scripts/check_docs.py
cd frontend
bun test tests/unit
bun run check
bun run build
```

数据库测试使用独立 MySQL 实例，数据库名为 `marksix_test`。在未跟踪的私有配置中设置 `TEST_DATABASE_URL`、`TEST_PROVISION_DATABASE_URL`、`TEST_ADMIN_PASSWORD`、`TENANT_DB_HOST` 和 `TENANT_DB_PORT`。其中 provision 身份需要在该测试实例创建、删除租户库和数据库用户的权限。

```bash
cargo test --locked --manifest-path backend/Cargo.toml -- --ignored --test-threads=1
```

浏览器测试使用测试 API 和单独前端端口。测试 API 会重置测试业务表：

```bash
cargo run --locked --manifest-path backend/Cargo.toml --example e2e_server
# 另一个终端
cd frontend
API_TARGET=http://127.0.0.1:8081 bun run dev --port 5174 --strictPort
# 另一个终端
cd frontend
bun x playwright install chromium
bun run test:e2e
```

测试结构及数据边界见 [AI 测试地图](../ai/testing.md)。
