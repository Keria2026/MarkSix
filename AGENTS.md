# AGENTS.md — 项目架构与目录规范

## 1. 总体原则

所有 AI 编码代理及开发人员必须遵循本文档。
**做长期正确的事。做长期正确的事。做长期正确的事。**
核心要求：

1. 统一项目结构，禁止随意创建顶层目录。
2. 前后端分离，职责明确。
3. 按业务领域组织代码，保持模块边界清晰。
4. 优先使用现有技术栈，禁止未经批准引入替代框架。
5. 遵循 KISS、DRY、YAGNI 原则，避免过度设计。
6. 优先复用已有模块、组件和工具函数。
7. 统一 API 契约、错误格式、命名规则。
8. 所有正式技术文档集中存放在 `docs/`。
9. 代码、数据库、API 和文档必须保持同步。
10. 不得为了未来可能出现的需求提前构建复杂架构。
11. 长期主义，面向维护，新增改动应降低未来开发成本，禁止引入技术债
12. 结构性问题用重构解决，禁止补丁、特例绕过
13. 迭代修改而非增量修改，重写/重构后删旧代码
14. 遵循可执行最佳、现代的实践
15. 除非特别要求，不做兼容，不保留历史包袱，面向长期干净整洁，减少复杂度
16. 视觉效果和前端设计必须遵循DESIGN.MD （如果有）
17. Avoid unnecessary secondary labels and description. let the layout speak for itself. Avoid unnecessary text and explanation.


---

## 2. 固定技术栈

### Frontend

- Language: TypeScript
- Framework: Svelte 5
- Meta Framework: SvelteKit
- Runtime & Package Manager: Bun
- Build Tool: Vite
- native: Tauri (if desktop app is needed)
### Backend

- Language: Rust Stable
- Framework: Axum
- Database Access: SQLx
- Package Manager: Cargo

### Database

- PostgreSQL
- SQLx Migrations
- Sqlite (for local development and testing and for Tauri desktop app)

### Infrastructure

- Docker
- Docker Compose
- GitHub Actions

### API Contract

- HTTP / JSON
- OpenAPI
- Rust 定义 API 契约
- TypeScript API 类型自动生成

未经明确批准，不得更换上述技术栈。

---

## 3. 标准项目目录

项目采用以下目录结构：

```text
project-root/
├── apps/
│   ├── web/
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   ├── lib/
│   │   │   │   ├── components/
│   │   │   │   │   ├── ui/
│   │   │   │   │   └── layout/
│   │   │   │   ├── features/
│   │   │   │   ├── server/
│   │   │   │   ├── generated/
│   │   │   │   ├── utils/
│   │   │   │   └── types/
│   │   │   ├── app.html
│   │   │   └── app.css
│   │   ├── static/
│   │   ├── tests/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── svelte.config.js
│   │   └── vite.config.ts
│   │
│   └── api/
│       ├── src/
│       │   ├── main.rs
│       │   ├── app.rs
│       │   ├── config.rs
│       │   ├── state.rs
│       │   ├── modules/
│       │   ├── http/
│       │   └── db/
│       ├── migrations/
│       ├── tests/
│       └── Cargo.toml
│
├── docs/
│   ├── README.md
│   ├── getting-started/
│   ├── architecture/
│   ├── standards/
│   ├── guides/
│   ├── api/
│   ├── deployment/
│   ├── adr/
│   └── templates/
│
├── infra/
│   ├── compose.yaml
│   ├── compose.prod.yaml
│   └── docker/
│       ├── web.Dockerfile
│       └── api.Dockerfile
│
├── scripts/
├── .github/
│   └── workflows/
├── .sqlx/
├── AGENTS.md
├── README.md
├── Cargo.toml
├── Cargo.lock
├── package.json
├── bun.lock
├── rust-toolchain.toml
├── rustfmt.toml
├── .editorconfig
├── .env.example
└── .gitignore
```

以上为目标结构，并不要求预先创建全部空目录。

只有实际功能需要时才创建对应目录。

禁止建立多个职责相同的目录。

---

## 4. Frontend 结构规范

前端统一位于：

`apps/web/`

### 4.1 routes/

仅存放 SvelteKit 路由相关文件。

包括：

- `+page.svelte`
- `+page.ts`
- `+page.server.ts`
- `+layout.svelte`
- `+layout.ts`
- `+layout.server.ts`
- `+server.ts`

必须遵循 SvelteKit 官方文件系统路由约定。

页面文件主要承担页面组合、数据加载和交互入口职责。

禁止在路由文件中堆积大量可复用业务逻辑。

### 4.2 lib/components/

存放跨业务复用的组件。

- `ui/`：按钮、输入框、弹窗等基础组件。
- `layout/`：导航、侧边栏、页面布局组件。

业务专属组件应优先放在对应的 `features/` 模块。

### 4.3 lib/features/

按照业务领域组织前端代码。

例如：

```text
features/
├── auth/
├── users/
└── orders/
```

每个 Feature 可以包含：

```text
orders/
├── components/
├── state/
├── api/
├── types/
└── utils/
```

以上子目录按实际需求创建。

禁止为每个 Feature 强制生成全部空目录。

### 4.4 lib/server/

仅存放 SvelteKit 服务端代码。

包括：

- 服务端 API 请求封装
- 服务端认证逻辑
- 服务端专用工具

严禁将服务端密钥、私有配置或数据库访问逻辑暴露到浏览器。

### 4.5 lib/generated/

仅存放自动生成的代码。

例如：

- OpenAPI TypeScript 类型
- API 契约生成产物

禁止手工修改自动生成文件。

### 4.6 Svelte 5 规范

- 新代码优先使用 Svelte 5 Runes。
- 必须启用 TypeScript Strict。
- 优先采用 SvelteKit 内置能力。
- 避免无必要引入全局状态管理库。
- 组件保持职责单一。
- 业务逻辑尽可能提取为可测试模块。

---

## 5. Backend 结构规范

后端统一位于：

`apps/api/`

采用 Axum 模块化单体架构。

### 5.1 顶层文件职责

| 文件 | 职责 |
|---|---|
| `main.rs` | 程序入口、启动服务器 |
| `app.rs` | 组装 Router 和 Middleware |
| `config.rs` | 加载和验证配置 |
| `state.rs` | 定义共享 AppState |
| `modules/` | 业务模块 |
| `http/` | 通用 HTTP 错误与中间件 |
| `db/` | 数据库连接池及通用基础设施 |

### 5.2 业务模块结构

按照业务领域拆分。

例如：

```text
modules/
├── mod.rs
├── auth/
│   ├── mod.rs
│   ├── routes.rs
│   ├── handler.rs
│   ├── service.rs
│   ├── repository.rs
│   └── dto.rs
├── users/
└── orders/
```

职责如下：

- `routes.rs`：定义路由。
- `handler.rs`：HTTP 请求解析、校验及响应。
- `service.rs`：业务规则和业务流程。
- `repository.rs`：SQLx 数据库操作。
- `dto.rs`：API 请求及响应数据结构。

基本调用关系：

`Handler → Service → Repository → PostgreSQL`

允许简单模块适当合并文件，禁止为了符合形式而建立无意义的转发层。

### 5.3 模块依赖约束

- Handler 不应包含复杂业务规则。
- Handler 不直接编写业务 SQL。
- Service 不依赖 Axum HTTP 请求或响应类型。
- Repository 不处理 HTTP 逻辑。
- 不允许循环依赖。
- 禁止跨业务模块直接访问其他模块的内部 Repository。
- 跨模块协作必须通过明确的公开接口。
- 共享代码只有在存在真实复用需求时才抽取。

### 5.4 Rust 编码约束

- 使用 Rust Stable。
- 遵循 Rust 官方命名与格式化规范。
- 使用 `cargo fmt`。
- 使用 `cargo clippy`。
- 使用明确的错误类型和错误传播机制。
- 禁止在正常可恢复错误路径中随意使用 `unwrap()` 或 `expect()`。
- 异步代码不得执行长时间阻塞操作。
- 优先使用成熟标准库和现有依赖。

禁止未经批准引入新的后端 Web 框架。

---

## 6. Database 结构规范

数据库统一使用 PostgreSQL。

### 6.1 数据库访问

- 所有业务数据库访问由 Rust 后端负责。
- 使用 SQLx。
- 优先使用参数化查询。
- 使用连接池管理数据库连接。
- 禁止通过字符串拼接构造含不可信输入的 SQL。

### 6.2 Migrations

所有数据库结构变更必须使用：

`apps/api/migrations/`

要求：

1. 每次 Schema 变更新增 Migration。
2. 禁止随意修改已经在共享或生产环境执行的 Migration。
3. Migration 必须纳入 Git 版本控制。
4. 生产环境不得绕过 Migration 手工修改 Schema。
5. 数据库变更必须考虑向后兼容与回滚策略。

### 6.3 命名规范

- 表名：`snake_case`
- 字段名：`snake_case`
- 索引名：使用统一可识别前缀
- 外键：统一使用明确的关联字段名
- 时间字段：优先使用 `TIMESTAMPTZ`
- 存储时间：统一采用 UTC

### 6.4 SQLx 元数据

SQLx 离线查询元数据统一保存在：

`.sqlx/`

根据实际 SQLx 版本和配置生成。

生成内容不得手工修改。

CI 必须验证相关查询和元数据的一致性。

---

## 7. API 统一规范

### 7.1 API 路由

API 统一使用版本前缀：

`/api/v1`

示例：

```text
GET    /api/v1/users
GET    /api/v1/users/{id}
POST   /api/v1/users
PATCH  /api/v1/users/{id}
DELETE /api/v1/users/{id}
```

遵循 HTTP 方法语义。

### 7.2 API 契约

Rust 后端是 API 契约的唯一事实来源。

推荐流程：

`Rust DTO → OpenAPI → TypeScript Types`

要求：

- OpenAPI 从 Rust 代码生成。
- 前端 API 类型从 OpenAPI 自动生成。
- 禁止手工维护重复的请求响应类型。
- 禁止手工修改生成文件。
- API 契约修改后必须同步重新生成类型。
- CI 应检查 API 契约与生成产物一致性。

### 7.3 JSON 命名

统一使用 `camelCase`。

例如：

```json
{
  "userId": 1,
  "userName": "example",
  "createdAt": "2026-10-18T08:00:00Z"
}
```

### 7.4 错误响应

统一错误结构：

```json
{
  "code": "USER_NOT_FOUND",
  "message": "User not found",
  "requestId": "request-id",
  "details": null
}
```

业务错误码必须保持稳定。

禁止直接向客户端暴露数据库错误、堆栈信息或内部敏感数据。

---

## 8. 统一文档管理

这是项目强制规范。

### 8.1 文档唯一入口

仓库根目录：

`README.md`

作为项目入口。

`docs/README.md`

作为正式技术文档索引。

所有正式技术文档必须集中在 `docs/` 下。

例外：

- 根目录 `README.md`
- 根目录 `AGENTS.md`
- 工具本身要求的配置和说明文件
- 自动生成的代码、配置及元数据

### 8.2 文档目录

```text
docs/
├── README.md
├── getting-started/
├── architecture/
├── standards/
├── guides/
├── api/
├── deployment/
├── adr/
└── templates/
```

目录职责：

- `getting-started/`：安装、配置、首次运行。
- `architecture/`：总体架构、模块设计、数据流。
- `standards/`：编码、接口、数据库及文档规范。
- `guides/`：具体功能和开发操作指南。
- `api/`：API 规范及生成的契约文档。
- `deployment/`：构建、部署、监控、备份与回滚。
- `adr/`：架构决策记录。
- `templates/`：统一文档模板。

### 8.3 文档格式

- 统一使用 Markdown。
- 说明性文字使用简体中文。
- 代码、路径、技术名称保持英文。
- 文件名使用 `kebab-case.md`。
- 文档采用清晰的标题层级。
- 使用相对路径引用其他仓库文档。
- 避免重复记录同一技术规则。
- 不保留过期、矛盾或未经验证的说明。

### 8.4 文档同步

以下变更必须同步更新相关文档：

1. 目录结构或架构变更。
2. API 契约变更。
3. 重要数据库结构变更。
4. 环境变量变更。
5. 构建与部署流程变更。
6. 开发规范变更。

禁止代码已经变更，但对应文档仍描述旧行为。

### 8.5 AI 文档维护要求

AI 修改代码时必须：

1. 检查是否存在相关文档。
2. 优先更新原有文档。
3. 不得随意新增重复文档。
4. 不得为简单代码变更创建无意义说明文件。
5. 保持文档与实际代码一致。
6. 新增重要文档时更新 `docs/README.md` 索引。

禁止随意创建以下文件：

- `TEMP.md`
- `NOTES.md`
- `SUMMARY.md`
- `IMPLEMENTATION_NOTES.md`
- `FINAL_REPORT.md`

如确有需要，应纳入统一文档体系，并使用明确名称。

---

## 9. Infrastructure 规范

所有部署与基础设施配置统一放在：

`infra/`

包括：

- Docker Compose
- Dockerfile
- 生产环境部署配置

统一位置：

```text
infra/
├── compose.yaml
├── compose.prod.yaml
└── docker/
    ├── web.Dockerfile
    └── api.Dockerfile
```

要求：

- Dockerfile 不在多个目录重复维护。
- 开发环境和生产环境配置明确区分。
- 环境变量通过配置注入。
- 密钥不得写入 Docker 镜像或 Git 仓库。
- 容器尽量使用非 Root 用户运行。
- 服务提供健康检查。
- PostgreSQL 数据使用持久化存储。
- 生产部署应具备备份和恢复方案。


---

## 10. CI/CD 规范

GitHub Actions 统一存放：

`.github/workflows/`

建议：

```text
workflows/
├── ci.yml
└── deploy.yml
```

### CI 检查要求

Frontend：

- 依赖锁文件检查
- TypeScript / Svelte 类型检查
- 代码测试
- 生产构建

Backend：

- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --workspace`
- SQLx 相关检查

Contract：

- OpenAPI 契约检查
- 前端生成类型一致性检查

Documentation：

- Markdown 格式检查
- 文档内部链接检查

### CD 要求

- CI 成功后才允许部署。
- 生产环境使用构建完成的 Docker 镜像。
- 使用明确的镜像版本标记。
- 生产数据库迁移必须受控执行。
- 部署完成后执行健康检查。
- 保留可执行的回滚方案。

---

## 11. 命名规范

| 对象 | 规范 |
|---|---|
| Rust 模块 | snake_case |
| Rust 函数 | snake_case |
| Rust 结构体 | PascalCase |
| Rust 常量 | SCREAMING_SNAKE_CASE |
| TypeScript 变量 | camelCase |
| TypeScript 函数 | camelCase |
| TypeScript 类型 | PascalCase |
| Svelte 组件 | PascalCase.svelte |
| SvelteKit 路由 | 遵循框架约定 |
| 数据库表名 | snake_case |
| 数据库字段 | snake_case |
| JSON 字段 | camelCase |
| Markdown 文档 | kebab-case.md |
| 环境变量 | SCREAMING_SNAKE_CASE |

---

## 12. 依赖管理规则

前端统一使用 Bun。

后端统一使用 Cargo。

要求：

1. 禁止混用 npm、pnpm、yarn 与 Bun 作为包管理器。
2. 禁止提交 `package-lock.json`、`pnpm-lock.yaml` 或 `yarn.lock`。
3. 提交 `bun.lock` 和 `Cargo.lock`。
4. 优先使用现有依赖解决问题。
5. 引入新依赖必须说明必要性。
6. 禁止为了简单功能引入大型框架。
7. 避免功能重复的依赖。
8. 新增依赖必须与当前技术栈兼容。

---

## 13. AI 编码代理执行规则

### 本地开发环境约束

- 本项目本地开发只允许在 WSL2 Ubuntu 的 Linux 原生文件系统进行，当前目录为 `/home/ubuntu/Project/MarkSix`。
- 禁止在 Windows checkout、PowerShell、CMD 或 `/mnt/c` 等 Windows 挂载盘直接编辑、安装依赖、构建、测试或运行项目。
- Windows 只可用作 WSL 的启动入口或 VS Code Remote WSL／Codex 的界面；代码和工具进程必须在 WSL 内运行。若代理宿主在 Windows，必须通过 `wsl -d Ubuntu-24.04 -- bash -lc ...` 操作上述 Linux 目录。
- Cargo、Bun、Node、Git、Docker 和 Python 均使用 WSL 内的 Linux 可执行文件。不得复用 Windows 的 node_modules、可执行文件或构建缓存。
- Linux CI 和 Linux 容器沿用现有测试、构建与部署流程。不得因迁移开发目录更换技术栈。
- 密码继续保存在 `~/.config/marksix/` 的未跟踪私有配置中；保留独立开发／测试数据库及现有数据卷。


所有 AI 编码代理在执行任务前必须：

1. 阅读根目录 `AGENTS.md`。
2. 检查相关目录及已有代码。
3. 检查是否存在可复用模块。
4. 确认修改所属的业务边界。
5. 遵循当前目录结构和命名规范。

执行过程中：

1. 优先进行最小必要修改。
2. 不随意重构无关代码。
3. 不随意移动文件。
4. 不创建重复模块。
5. 不增加无必要的抽象层。
6. 不为简单问题引入新依赖。
7. 不修改无关配置。
8. 不手工修改自动生成文件。
9. 不将敏感信息写入代码、日志或文档。
10. 不绕过类型检查和已有测试。

任务完成后：

1. 检查代码格式。
2. 执行相关类型检查。
3. 执行相关测试。
4. 验证 API 和数据库变更。
5. 同步必要文档。
6. 明确说明实际完成的变更。
7. 如有未完成的验证，必须如实说明。

禁止声称执行了实际上未运行的测试。

---

## 14. 架构变更规则

以下情况必须先说明技术理由，并获得明确批准：

- 引入微服务。
- 引入 Kubernetes。
- 更换前后端框架。
- 更换数据库。
- 引入新的 ORM。
- 引入消息队列。
- 引入全新的全局状态管理体系。
- 创建新的顶层目录。
- 改变前后端通信协议。
- 大规模重组项目结构。

对于常规功能开发，不得以“未来可能需要扩展”为理由主动增加复杂度。

---

## 15. 最终架构原则

本项目长期遵循：

**一个仓库、统一技术栈、清晰模块边界、统一 API 契约、统一数据库迁移、统一文档入口、统一 CI/CD。**

优先级：

1. 正确性与安全性
2. 可维护性
3. 简洁性
4. 一致性
5. 可测试性
6. 可扩展性
7. 性能优化

性能优化应以实际测量结果为依据。

当规则存在冲突时：

- 以用户当前明确要求为最高优先级。
- 遵循语言和框架的必要技术约束。
- 在项目内部优先保持现有架构一致性。
- 无法确定时，不擅自作出影响全项目的架构决策。

**禁止过度工程化（Overengineering）。以最简单、可靠、可维护的方式解决实际问题。**
