# 单人 VPS 部署

默认运行 app、tools 两个长期服务，Caddy 可选。React 是 app 内的静态页面，网页和 API 共用一个 HTTP 入口；SQLite 位于本地磁盘，模型通过远程 API 调用。建议从 Ubuntu 24.04、2 核、4 GB 内存、40 GB SSD 起步；这是部署基线，容量结论以实测记录为准。

## 一键入口

服务器中进入独立的源码目录，首次运行：

```bash
./deploy.sh install https://rp.example.com
```

默认使用**外部反代模式**：只运行 app、tools，网页和 API 共用 `127.0.0.1:18767`，域名和 HTTPS 由用户自行管理。使用**内置 Caddy 模式**时，在安装命令中加 `--caddy`，额外启动 Caddy 接管 `80/443` 并管理 HTTPS。监听地址和端口可调整，参数见 `./deploy.sh install --help`。

已有 Git 克隆用 `./deploy.sh update --pull` 拉取当前分支的快进更新、构建、备份并切换；源码包安装用 `./deploy.sh update` 发布当前目录中的源码。`./deploy.sh logs -f` 跟随日志，`./deploy.sh status` 检查状态。下面保留逐步配置和恢复说明，便于排查和手动维护。

`install` 在已有数据时拒绝覆盖。首次安装如果已经手动填写 `.env`，会在调用 Docker 前补齐缺失的 `secrets/models.env`、`secrets/session_key`、`secrets/tool_token` 和 `config/models.json`，保留现有文件、密钥与 `.env`。初始化或构建失败后，可以用同一个域名和项目名重试；密码设置之后失败时使用 `up` 继续。已有数据库但缺少原加密密钥时必须恢复原 `secrets/session_key`，安装不会生成新密钥替代它。

`--pull` 要求独立、无未提交源码改动的 Git 克隆以及已配置上游的分支。命令在服务器上执行，不包含从开发机上传数据或推送镜像到公共仓库。

## 准备

VPS 需要 Docker Engine、Compose v2.30 或更新版本、Python 3 和可用的远程模型账号。操作账号需要访问 Docker。使用完整、独立的 `pi-roleplay` 目录；宿主机无需安装 Node 或 pnpm。

默认模式在用户现有反代中配置最终域名、HTTPS 和应用上游。仅选择 Caddy 模式时，需要它能绑定 VPS 的 80/443；将域名解析到 VPS，并放行 TCP 80/443，UDP 443 可选用于 HTTP/3。自动证书要求 DNS、端口和 ACME 校验可用。[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)

在项目根目录执行：

```bash
python3 scripts/deploy.py configure https://rp.example.com
```

命令仅创建配置与随机密钥，不会启动服务，也不会覆盖已有 `.env` 或密钥。已有部署使用 `./deploy.sh proxy external` 或 `./deploy.sh proxy caddy` 选择模式，再在空闲时运行 `./deploy.sh up` 应用。旧版部署首次升级也需显式选择一次；数据和密钥保留。切回外部反代时移除本项目 Caddy 容器，证书卷保留。

根目录的 [`.env.example`](../.env.example) 提供与初始化命令一致的默认值和字段说明，并随公开源码分发。可以先执行上述初始化命令再编辑 `.env`，也可以复制示例、填写配置后直接运行 `install`，由安装入口补齐缺失文件。安装参数中的域名和项目名必须与 `.env` 一致，域名不带末尾斜杠。直接运行 `up` 或 `password` 前仍需完整的初始化文件。本地开发入口不读取生产 `.env`。

生成内容：

| 路径 | 用途 |
|---|---|
| `.env` | 域名、Compose 项目名、镜像标签、数据目录；不放模型密钥 |
| `config/models.json` | 允许使用的模型与默认主模型 |
| `secrets/models.env` | 模型密钥环境变量，仅传给 app |
| `secrets/session_key` | Cookie、网页模型密钥和搜索密钥的加密根密钥 |
| `secrets/tool_token` | app 与工具服务之间的令牌 |
| `state/app` | SQLite、原始附件、头像和备份状态 |
| `state/workspaces` | 独立故事与命名工作区的持久文件；分支继承创建时的目录 |
| `skills/custom` | 自定义 Skills；app 与 tools 均只读挂载 |
| `backups` | 冷备份和 SHA-256 清单 |

`secrets` 目录为 0700；两份单文件挂载的密钥为 0444，确保容器中的非 root 用户可读。Compose 使用文件型 secret 时保留宿主机文件权限，不依赖 YAML 中的 uid/gid 自动转换。不要把整个 secrets 目录挂到 tools。[Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/)

## 配置模型与首次启动

`config/models.json` 初始为空。启动后可在网页“设置 → 模型”添加提供方、模型和 API 密钥，再选择默认主模型并保存。ClinePass 可直接选择 DeepSeek V4 Flash 快速填写项。修改立即生效，模型任务运行期间禁止改动提供方。

也可在第一次启动前参照 `deploy/models.example.json` 填写初始清单；文件只在数据库尚未建立模型目录时导入。数据库中的模型目录随后是管理来源，重启不会覆盖网页修改。`provider` 是该路由的唯一分组名；`model` 是提供商实际接受的模型 ID。

- `api` 可选 `openai-completions`、`openai-responses`、`anthropic-messages`。
- `baseUrl`、`contextWindow`、`maxTokens` 和图片/思考能力应按照该提供商文档设置。
- `outputTokens` 控制一次输出上限；`keyEnv` 引用 `secrets/models.env` 中的变量名。
- `main` 指向清单中的一个模型。系统设置与故事设置可再选择主模型、Writer 和任务子代理的路由。
- 可选 `search` 使用独立的 Anthropic 兼容搜索地址、模型、`keyEnv` 与 `maxUses`；它需要支持结构化原生搜索工具，普通聊天端点不一定支持。未配置时搜索会明确报错。

网页输入的密钥使用 AES-256-GCM 加密后保存在应用数据库，不会回显或写进工具环境。恢复网页保存的模型或搜索密钥时，必须同时恢复原 `secrets/session_key`。

初始配置也可通过 `keyEnv` 引用 `secrets/models.env`，例如 `RP_MODEL_API_KEY=实际密钥`。网页编辑时留空保留现有密钥，明确选择“移除当前密钥”会停止使用环境密钥。环境变量的修改仍需重新创建 app 容器；已有模型目录的增删改应在网页完成。模型 JSON 文件本身不包含密钥，保持 `chmod 644 config/models.json`，这些部署文件不要提交到 Git。

首次启动前导入 ClinePass 的 DeepSeek V4 Flash 也可使用 `deploy/models.clinepass.example.json`，复制为 `config/models.json`，在 `secrets/models.env` 设置 `RP_CLINEPASS_API_KEY`。请求地址为 `https://api.cline.bot/api/v1/chat/completions`，完整模型 ID 必须保留 `cline-pass/deepseek-v4-flash`；不要替换成普通 Cline 或直接 DeepSeek 的模型 ID。[ClinePass 官方配置](https://docs.cline.bot/getting-started/clinepass)

这份 ClinePass 配置采用 128000 上下文、8192 输出能力上限及每次 4096 输出的保守本地预算，不声明提供商的最大容量；默认启用 `low` 思考。图片输入未启用，原生网页搜索需另行配置支持该协议的服务。模型密钥不会传入工具容器。

```bash
python3 scripts/deploy.py build
python3 scripts/deploy.py password
python3 scripts/deploy.py up
python3 scripts/deploy.py status
```

`build` 顺序构建应用与工具镜像，减少并行构建的内存峰值。`password` 从隐藏输入读取管理员密码，可用于首次初始化或在线重置；重置会撤销旧登录。`up` 等待 app、tools 的健康检查；开启 Caddy 时也等待其健康检查。用户自己的反代需要在外部配置并验证。

生产镜像和依赖版本固定在 Dockerfile、package.json 与锁文件中；不会在容器启动时安装 latest。应用和工具分别限制为 1.5 GB / 1 GB 内存，PID 上限 128，日志各保留最多 3 × 10 MB。默认只发布应用的回环 HTTP 端口；工具不发布端口，Caddy 只有启用后才发布 HTTP/HTTPS 端口。

工具容器可以联网，并且单用户的所有故事共用这个容器。新故事可使用独立目录或选定工作区，分支继承创建时的目录；Bash 会话各自独立，但不构成故事之间的安全隔离。工具无法挂载或读取应用数据库、Cookie 密钥、模型密钥和 Docker socket；附件与 Skills 为只读。模型生成的普通 Bash 子进程在停止/超时时终止；主动守护化的进程受整个工具容器生命周期和资源上限约束。

## 工作区与工具配置

侧栏“文件工作区 → 添加工作区”只需填写名称和选择文件权限。应用自动分配稳定 ID，通过工具服务在固定根目录 `/workspaces` 下创建 `workspace-<id>` 文件夹，对应部署存储中的 `state/workspaces/workspace-<id>`；用户不填写或浏览容器路径。名称不参与路径生成，重名或名称中的斜线不会覆盖其他文件夹。应用不直接访问工具卷。

已有工作区保留数据库记录的原路径、文件和会话关联，不搬移数据。创建 API 仅接受 `name`、`access`，不再接受 `directory`、`create`；目录浏览和关联任意已有目录的入口已移除。更新时应用与工具服务需一同升级。移除分组后的原文件仍保留，重新新建同名工作区会分配新的文件夹。

工作区可重命名、移除和选择只读/可写。重命名只改显示名称；移除只取消分组，文件、会话和原权限继续保留。会话输入栏的权限按钮与侧栏菜单都可切换归属。分支继承当时的目录与分组；切换目录会重置该会话的 Bash 环境。共享目录的权限统一管理，不能靠取消分组绕过只读；目录内存在运行或排队任务时，权限及归属修改会明确拒绝。

新目录默认可写，可在对应工作区或独立会话内修改权限。只读目录可浏览、预览、读取和下载，Bash、写入和编辑在独立工具服务被拒绝。侧栏提供分组/单列表、最近/手动顺序、分组折叠；目录及成员信息随 SQLite 备份，文件随工作区数据卷备份。

“设置 → 工具”提供命令超时、直接显示的输出字节上限、独立读取/搜索/子代理调用的并发数，以及子代理可选模型白名单。默认超时 300000 毫秒、输出 65536 字节、并发 1；Bash 与写操作仍顺序执行。超限输出完整保存到同一工作区，可从记录预览和下载。

网页搜索单独设置 Anthropic 兼容原生搜索地址、模型、每次最多搜索次数和密钥。替换或移除密钥均需保存，读取时不会回显；清除密钥后不会静默退回环境密钥。工具设置和加密凭证随应用数据库备份，恢复时需要原 `session_key`。当前生成始终使用开始时冻结的配置。

## 日常运维

```bash
python3 scripts/deploy.py status
python3 scripts/deploy.py password
python3 scripts/deploy.py stop
```

页面的“系统设置 → 服务状态”显示模型配置情况、工具服务、主任务、维护状态与最近备份。详细日志可使用：

```bash
./deploy.sh logs --tail 100 app tools
```

修改模型 JSON、非秘密配置或自定义 Skills 后，可在空闲时重启相应服务。内置 Skills 随镜像更新；自定义 Skill 文件与目录应让容器用户可读（通常目录 0755、文件 0644）。不要把凭据写入 Skill。

## 备份与恢复

```bash
python3 scripts/deploy.py backup
```

备份先通过 app 专属 Unix socket 检查主任务、后台总结、回复选项和修改请求；繁忙时拒绝执行。空闲后关闭新写入，持久化维护标记，正常停止 app/tools，检查 SQLite 完整性，再打包数据库、附件、头像和工作目录。随后启动服务并显式解除维护状态。浏览器断线不会替代停止命令。

每份备份包含 `.tar.gz` 和 `.tar.gz.json` 清单，记录校验值与实际运行的镜像 ID；最近保留 7 份完整备份。压缩失败会记录失败，命令返回非零。不要直接复制运行中的 `app.sqlite`，也不要在部署命令运行期间手动操作同一套容器。

备份默认仍在同一台 VPS。请将**归档与清单一起下载到另一台设备**；`.env`、`config/models.json`、`secrets`、`skills/custom` 应单独妥善备份，它们不在剧情数据归档中。Caddy 证书位于 Docker 卷，恢复到新 VPS 后可重新申请。

推荐在相同版本的新目录或新 VPS 恢复：

```bash
python3 scripts/deploy.py configure https://rp.example.com --project pi-roleplay-restored
# 恢复后使用内置 Caddy 时，configure 加 --caddy。
# 恢复 config/models.json、secrets（含原 session_key）和自定义 Skills，构建与备份对应的应用版本。
python3 scripts/deploy.py build
python3 scripts/deploy.py restore /path/to/rp-TIMESTAMP.tar.gz
python3 scripts/deploy.py up
```

恢复只接受**空的应用与工作目录**，且目标部署的服务必须已停止；不会覆盖已有故事。提取前校验 SHA-256、路径和链接边界，提取后检查 SQLite 完整性。管理员密码随数据库恢复。启动前恢复单独备份的原 `secrets/session_key`，否则数据库中的模型和搜索凭证无法解密。新域名或端口使用独立登录 Cookie，需要重新登录。检查登录、故事正文、附件原件和工作文件后再切换域名。

如果备份进程被强制终止，维护标记可能仍在。先检查 `backups` 与命令日志，运行 `up` 后使用 `python3 scripts/deploy.py resume` 明确解除维护；未完成的 `.partial` 不计作成功备份。恢复中途失败的目录应保留用于诊断，另选空目录重试。

## 升级与回退

`./deploy.sh update` 先为当前源码构建带唯一版本标签的 app/tools 镜像，现有服务继续运行。构建成功后检查空闲、关闭写入并冷备份，app/tools 在备份后保持停止和维护状态。随后重新创建当前模式启用的服务，等待健康检查，更新 `.env` 的镜像标签并解除维护。构建失败不会停止旧服务；忙碌时拒绝切换。更新不是零停机发布，也不会自动改变代理模式。

`.deploy/updates/` 保存更新状态、旧镜像 ID、Git 版本（存在时）、旧 `.env` 和备份位置。新版本启动或健康检查失败时停止 app/tools，保留数据现场和升级前备份。不要直接用旧程序打开可能已经迁移的数据库；需要恢复时按照下方约束在空目录中操作。旧镜像不会被脚本自动删除。

普通 `backup` 无论镜像标签是否被另一次手工构建移动，都会按备份时正在运行的确切镜像 ID 恢复服务。数据库迁移在应用启动时执行，遇到更新版本或已变更的迁移校验值会拒绝启动。

有数据库迁移时，回退应恢复升级前备份并使用匹配的旧应用版本，不能直接让旧程序打开已升级数据库。排队但未开始的任务可调度；进行中的任务在重启后标为中断，不自动重复执行模型或文件副作用。

## 开发与部署验收

本机开发使用 `./dev.sh` 或 `pnpm dev`，页面默认 18767、API 默认 18768；启动器自动同步 origin 与代理，数据仅位于 `.dev/`。详见 [本地开发](development.md)。生产默认将应用内部 3091 映射到宿主机 `127.0.0.1:18767`，tools 的 3092 只在容器网络中使用。可选 Caddy 对外提供 80/443。不得占用旧项目的 3080。

`pnpm test:entrypoints` 用干净公开源码构建临时镜像，验证已有 OpenResty 的共享网络反代、单端口网页/API/登录/SSE/附件、默认无 Caddy 的更新与失败恢复、可选 Caddy 的备份及模式切换。使用原创合成数据和本机随机 HTTP 端口，不调用付费模型。

先为当前源码构建测试镜像，再运行完整部署验收：

```bash
docker build -f deploy/Dockerfile.app -t pi-roleplay-app:qa .
docker build -f deploy/Dockerfile.tools -t pi-roleplay-tools:qa .
RP_APP_TEST_IMAGE=pi-roleplay-app:qa RP_TOOLS_TEST_IMAGE=pi-roleplay-tools:qa pnpm test:deployment
```

验收创建临时合成部署，验证真实三容器、Pi HTTP 协议、工具隔离、崩溃恢复、冷备份与空目录恢复，结束后删除测试容器和临时数据。它使用受控提供商响应和本机 HTTP，不证明公网证书签发、真实模型质量或 VPS 容量。证据写到本地 `docs/evidence/`；该目录不进入公开源码包。
