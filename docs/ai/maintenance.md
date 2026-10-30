# 维护约束

## 开发环境

本机仅在 WSL2 Ubuntu 的 `/home/ubuntu/Project/MarkSix` 开发。Windows 作为客户端，禁止在旧 Windows checkout 或挂载盘编辑、安装依赖、构建、测试和运行源码。工具与缓存均使用 Linux 版本。

私有环境保存在 `~/.config/marksix/` 等未跟踪位置。开发和测试使用不同数据库实例；保留本机数据卷和现有账本。不要在输出中暴露密码。

## 修改范围

先阅读调用方、相关纯逻辑、数据边界和验证入口。修复共享原因，删除被替代的旧代码。复用既有模块，避免重复配置、无用抽象和无关重构。

沿用 Rust/Axum、Svelte、Bun、SQLx、MySQL、Docker 及当前目录边界。框架、数据库、协议、全局状态方案或大规模目录迁移需要明确授权。新依赖应有现有库或平台能力无法解决的具体理由。

已执行数据库迁移不得改写；变更另加迁移。生成文件使用对应工具重建。修改安全、金额、事务、解析和恢复逻辑时，增加能检测错误的行为测试。

## 文档维护

`docs/human` 解释现有架构、概念和环境使用；`docs/ai` 提供源码导航、业务不变量、边界及维护上下文。根 README 保持项目简介和入口。

正式文档不保存聊天记录、用户原话、修改时间线、通过次数或用来证明合规的自评段落。不罗列源码已能直接说明的每个功能细节。使用示例域名，部署说明定位到可配置参数。

文档组织参考微软 Engineering Fundamentals Playbook 的 [Creating Good Documentation](https://microsoft.github.io/code-with-engineering-playbook/documentation/best-practices/good-documentation/) 与 [Projects and Repositories](https://microsoft.github.io/code-with-engineering-playbook/documentation/guidance/project-and-repositories/)。按读者目的组织内容；自动检查可替代的事实由工具维护。

## Git 与本地状态

`.vscode/`、`.impeccable/`、密钥、环境文件、编译缓存、测试结果和临时运行数据属于忽略内容。测试用公开样例不得复制私有原文和真实客户数据。

开发在 `dev` 进行；发布通过 `master` 的 Actions。用户要求创建 PR 时只创建或更新 PR，不自行合并。推送前检查实际变更、格式、类型、测试及构建，报告未运行项目。

## 测试报告

测试日志、浏览器报告、评估 JSON 和性能结果写入忽略的 `test-results/` 或 CI 工件。文档描述测试结构和执行入口，不追加某一轮验证记录。不能将未执行的检查写成已通过。
