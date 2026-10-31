# AI 编码入口

先阅读 [AI 项目上下文](docs/ai/README.md)与[维护约束](docs/ai/maintenance.md)，再阅读待修改模块的源码和调用方。

本机开发在 WSL2 Ubuntu 的 `/home/ubuntu/Project/MarkSix` 执行。源码、依赖、Git、构建、测试和服务使用 Linux 工具及 Linux 文件系统。

涉及审查、重构或测试建设时，按[质量验证与迭代入口](docs/ai/quality.md)选择对应边界的测试；覆盖率以包含未测文件的清单为依据，不用测试通过率代替覆盖率。
