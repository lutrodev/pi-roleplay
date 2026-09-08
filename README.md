# pi-roleplay

一个可自行部署的单用户角色扮演与故事创作应用。使用角色卡、世界书和人设组织故事，让模型续写正文、维护变量，或在 Agent 模式中处理资料和工作文件。

Self-hosted, single-user roleplay and story writing with character cards, world books, persistent state, and an isolated Agent tool environment.

## 能做什么

- **故事与阅读**：流式正文、对话高亮、分支、编辑与重生成，支持桌面和手机，中英文界面。
- **共享资料**：角色卡、世界书、用户人设、预设和文风；修改共享资料后，引用它的会话在下一轮使用新内容。
- **生成与状态**：Chat / Agent、Writer、任务子代理、变量 / MVU、剧情总结、回复建议和快捷回复。
- **Writer 预置历史**：在设置页编辑两轮原生消息与串行工具记录，默认关闭，按运行冻结；详见 [使用说明](docs/writer-history.md)。
- **工作文件**：命名工作区、文件预览与下载、附件和 Skills；Bash 与文件操作在独立工具容器中执行。
- **模型连接**：在网页配置提供方、模型与密钥，支持项目中的 OpenAI 兼容及 Anthropic 协议适配。

项目处于活跃开发阶段，面向个人自托管。只有一个管理员，没有多用户注册、权限分组或计费系统。模型 API 由使用者自行配置，费用由提供方收取。

## 本地一键调试

需要 **Node.js 24、pnpm 11.23.0、Docker（含 Compose）**，支持 macOS 和 Linux 普通用户；Windows 使用 WSL2。先启动 Docker，然后在源码根目录运行：

```bash
./dev.sh
# 已安装依赖时也可用：pnpm dev
```

入口会检查环境和端口、安装锁文件中的依赖、初始化独立数据、构建工具容器，并启动前后端：

| 项目 | 默认位置 |
| --- | --- |
| 浏览器入口 | http://127.0.0.1:18767 |
| API | http://127.0.0.1:18768 |
| 调试数据、密钥、工作文件 | `.dev/` |
| 首次登录密码 | `.dev/admin-password` |

在另一个终端执行 `cat .dev/admin-password` 查看本机初始密码。登录后到 **设置 → 模型** 添加提供方和密钥。

前端修改自动热更新；后端源码修改自动重启。按 **Ctrl+C** 关闭本次调试的进程与容器，数据会保留。工具服务代码变化后重新运行入口即可重新构建。调试环境不读取生产 `.env`、`state/` 或 `secrets/`，也不会停止已经占用端口的服务。

```bash
./dev.sh --check                          # 只检查环境和端口
./dev.sh --web-port 28767 --api-port 28768 # 自定义端口
./dev.sh password                         # 重置调试密码
```

首次依赖安装和镜像构建需要联网；后续复用依赖和 Docker 缓存。详细说明见 [本地开发](docs/development.md)。

## 部署到 VPS

服务器需要 **Docker Engine、Compose v2.30+、Python 3**，无需安装 Node 或 pnpm。提供两种部署模式：

| 模式 | 服务与端口 |
| --- | --- |
| 外部反代（默认） | 运行 app、tools；网页与 API 共用 `127.0.0.1:18767`，域名和 HTTPS 由用户管理 |
| 内置 Caddy | 额外启动 Caddy 接管 VPS 的 `80/443`，自动管理 HTTPS；要求端口空闲并放行、域名解析正确 |

在服务器源码根目录运行，填写最终访问的域名：

```bash
./deploy.sh install https://rp.example.com
# 使用内置 Caddy 时加 --caddy
./deploy.sh install https://rp.example.com --caddy
```

以上命令二选一。脚本生成配置与密钥，构建镜像，提示输入管理员密码并启动所选服务。后续更新和备份不会自动切换模式。应用监听地址和端口可调整，参数见 `./deploy.sh install --help`。

若只需先生成配置，运行 `./deploy.sh configure https://rp.example.com`。它会创建 `.env` 和随机密钥；初始化后可对照 [`.env.example`](.env.example) 调整域名、端口、代理模式与数据目录。

登录网页后在 **设置 → 模型** 配置模型连接即可使用。已有数据的部署不会被 `install` 覆盖。

已有部署可用 `./deploy.sh proxy external` 或 `./deploy.sh proxy caddy` 保存接入方式，再在空闲时执行 `./deploy.sh up` 应用。旧版配置首次升级需显式选择一次；配置与密钥保留，不要重新初始化。

```bash
./deploy.sh status       # 容器健康和应用状态
./deploy.sh logs -f      # 持续查看日志；Ctrl+C 结束查看
./deploy.sh password     # 重置管理员密码
./deploy.sh backup       # 空闲时冷备份，然后恢复服务
./deploy.sh stop         # 停止服务，保留数据
./deploy.sh up           # 启动已有部署
```

## 更新版本

Git 克隆并已配置上游分支时：

```bash
./deploy.sh update --pull
```

源码压缩包安装时，先替换源码并保留部署配置、密钥和数据，然后运行：

```bash
./deploy.sh update
```

更新会先构建独立版本的镜像，构建失败时现有服务继续运行；随后检查是否空闲、冷备份、关闭写入并切换版本。所选模式的全部服务健康后才保存新镜像配置并恢复写入。更新期间会短暂停服；忙碌时拒绝切换。

失败记录、旧镜像 ID 和旧配置保存在 `.deploy/updates/`，剧情备份在 `backups/`。如果新版本已经迁移数据库，脚本会停止 app/tools 并保留现场；不会自动用旧程序打开新数据库。恢复步骤见 [部署、备份与恢复](docs/deployment.md)。

**备份归档不含配置和密钥。** `.env`、`config/`、`secrets/` 与自定义 Skills 需单独保存；尤其原 `secrets/session_key` 是解密网页保存密钥的必要条件。数据归档与校验清单应一起备份到另一台设备。

## 开发与验证

```bash
pnpm typecheck            # 类型检查
pnpm test                 # 领域与应用测试，不使用付费模型
pnpm build                # 构建应用、工具与网页
pnpm test:backup          # 备份、恢复和更新控制流程的回归测试
pnpm test:entrypoints     # 干净源码副本的首次部署、升级失败保护与恢复
pnpm test:deployment      # 真实 Docker 部署与恢复验收，需要先构建测试镜像
pnpm release:check        # 公开文件、敏感值、素材与 Git 历史检查
pnpm release:pack         # 生成经过检查的公开源码包
```

发布包位于 `output/releases/`，只包含经过公开规则检查的文件，不包含运行数据、密钥、本地验收记录或 Git 历史。发布前请阅读 [开源范围与检查说明](docs/open-source.md)，不要直接压缩整个开发目录。

## 项目结构

```text
apps/web/          React 页面与阅读界面
apps/server/       API、SQLite、模型调度与会话服务
apps/tools/        独立工具服务、Bash 与文件操作
packages/rp-core/  剧情、Prompt、变量及资料领域逻辑
packages/protocol/ 前后端与工具协议
skills/builtin/    随应用提供的资料操作指导
deploy/           Docker、Compose 与 Caddy
scripts/           开发、构建、部署、验证与源码打包
```

架构与运行边界见 [架构说明](docs/architecture.md)，贡献方式见 [CONTRIBUTING](CONTRIBUTING.md)。

## 许可与素材

项目代码采用 [MIT License](LICENSE)。迁入代码的版权和来源记录保留在 [第三方说明](THIRD_PARTY_NOTICES.md) 与 [来源清单](docs/source-provenance.json)。依赖继续适用各自的许可证。

公开包不包含用户上传的角色卡、聊天记录、附件或社区图片。随应用提供的三张氛围背景由图像生成工具生成，来源提示词单独保留。安全问题的提交方式见 [SECURITY](SECURITY.md)。
