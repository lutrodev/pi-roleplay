# Google Cloud Vertex AI

在 **设置 → 模型 → 添加服务连接** 中选择 **Google Cloud Vertex AI**，粘贴服务账号密钥 JSON，或选择本地 `.json` 文件导入。

1. JSON 必须是 Google Cloud 下载的 `service_account` 密钥，包含 `project_id`、`client_email` 和 RSA `private_key`。不接受 OAuth 用户凭证或外部身份配置。
2. 项目 ID 会从 JSON 自动填写，也可以改成服务账号已获授权的其他项目。
3. 区域默认 `global`，可改为模型支持的区域，例如 `us-central1`。
4. 填写该项目、区域当前可用的 Google 模型 ID，每行一个；`google/` 前缀可省略。此入口使用手动添加模型，不查询项目的部署模型列表。
5. 添加后使用 **测试模型** 发送简短请求，确认访问权限，再按需设为默认模型。测试会消耗少量模型额度。

项目需要启用 Vertex AI API，并具备相应计费和模型访问权限。服务账号应获得调用模型所需的权限；具体要求见 [Google Cloud 认证说明](https://cloud.google.com/vertex-ai/generative-ai/docs/start/gcp-auth)。区域和模型可用性以 Google Cloud 文档为准。

应用使用 [Google 官方的 OpenAI 兼容接口](https://cloud.google.com/vertex-ai/generative-ai/docs/start/openai)，通过 Google 认证库在服务端将 JSON 凭证换成 OAuth 访问令牌，并在过期前刷新。文本、图片和工具调用继续使用 Pi 的 Chat Completions 适配器。模型能力优先匹配项目锁定的 Pi 目录，未识别的模型可在高级设置中补充；思考参数默认交给服务，可按渠道支持范围手动配置。

服务账号私钥加密存储于应用数据库，设置接口只返回已配置状态。编辑连接时留空保留当前凭证，粘贴或导入新 JSON 可替换，也可以移除当前密钥。私钥不写入临时明文文件，不传给 Pi 或工具容器；OAuth 访问令牌只在应用内存中缓存。

恢复备份时，必须同时恢复原 `session_key`，否则加密凭证无法解密。JSON 文件最大 32 KB，端点限定为与项目、区域匹配的 Google Cloud 官方地址。

## 通过部署配置初始化

也可以参考 [models.vertex.example.json](../deploy/models.vertex.example.json)。`auth` 设置为 `google-service-account`，`keyEnv` 指向包含服务账号 JSON **内容**的环境变量，而不是 JSON 文件路径。配置文件不包含私钥。

`global` 地址使用 `https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/endpoints/openapi`；区域地址使用 `https://REGION-aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/REGION/endpoints/openapi`。请替换示例中的项目和模型，并只将凭证环境变量提供给应用服务。模型文件用于初始化目录；已保存的连接通过网页管理。
