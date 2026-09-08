# 内置氛围背景

这三张背景于 2026-09-07 使用 OpenAI 图像生成工具生成，未提供第三方参考图片。生成提示词见 [来源记录](../../../../docs/background-prompts.json)。它们不是用户上传的角色卡或第三方下载素材。

| 背景 | 画面 | 正图 | 缩略图 |
| --- | --- | --- | --- |
| 炉火酒馆 | 炉火与暖灯照亮的木石酒馆，室内空间安静、无人 | lantern-tavern.webp | lantern-tavern.thumb.webp |
| 雾野远山 | 晨雾中的山谷、松林与溪流，中央保留开阔层次 | misty-highlands.webp | misty-highlands.thumb.webp |
| 雨夜归港 | 蓝调海港、湿石码头和零星暖窗，水面留白 | rainy-harbor.webp | rainy-harbor.thumb.webp |

正图为 1672×941 WebP，缩略图为 360×225 WebP。正图合计 318,140 字节，缩略图合计 19,680 字节。仅进行格式压缩与缩略图导出，没有改变生成图的构图或色调；原始 PNG 保存在本地 `output/imagegen/backgrounds/`。

它们是图库中的「推荐背景」，使用稳定 ID，不自动替换用户背景、不占 24 张上传额度，也不提供重命名或删除。应用中的强度控件决定实际显示透明度。`scripts/build-server.mjs` 将本目录复制到服务端部署包；图片通过已有的登录保护接口读取，不复制进模型附件或工具工作区。
