# pi-roleplay

独立、单用户、可在 VPS 部署的 Roleplay 应用。架构见 `docs/architecture.md`，调试见 `docs/development.md`，公开范围见 `docs/open-source.md`。

- 仅在 pi-roleplay 目录开发；运行时与测试依赖必须来自本项目，不能引用父目录、相邻项目或外部工作区的文件、node_modules、服务。
- 新代码使用 TypeScript。迁入的纯领域 JavaScript 可保留原实现与回归测试；不要为了转换语法而改变业务规则。
- RP 核心不能依赖 React、Fastify、Cordis 或其他 Agent 宿主。Pi 只负责模型与 Agent 循环，故事事件是会话事实的唯一权威来源。
- 共享资料可变且按 ID 实时引用；每轮冻结实际上下文。剧情提交原子化；未提交草稿不更新剧情状态。
- 逐项保留现有业务行为，包括 Writer、Chat/Agent、变量/MVU、Prompt、消息操作、完整工具和子代理；不能用占位实现、模拟成功或删功能代替迁移。
- 产品界面默认中文、阅读优先，支持电脑和手机。复用 Radix/shadcn 基础组件，Motion 动效支持减少动画偏好。
- 模型命令只能通过独立工具服务执行。应用数据库、模型密钥、宿主机根目录和 Docker socket 不可交给工具环境。
- 每完成一个模块，运行针对性的测试并更新验收证据。完成必须同时有构建、功能、浏览器、隔离与部署恢复的证据。
- 不复制工作区的个人数据或未经审查的第三方角色卡/图片到本项目。保留迁入代码的许可与来源。
- `docs/evidence/` 和 `docs/migration.md` 为本地验收记录，不进入公开包；公开文档不能链接到它们。发布前执行 `pnpm release:check`，使用 `pnpm release:pack` 生成源码包。
- 本地热更新使用 `pnpm dev`（前端 18767、API 18768），数据与密钥仅在 `.dev/`；不重用生产数据或密钥。
- 生产 Docker 默认仅开放应用入口 `127.0.0.1:18767`，用户可接自己的反代；`--caddy` 才启用 Caddy。不得启动、停止或替换旧 Harness 的 3080 服务。
