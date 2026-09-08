# 第三方代码、依赖与素材

## 迁入代码

本项目保留来自 dsh-roleplay 的纯领域算法与测试。原项目版权声明为 `Copyright (c) 2026 dsh-roleplay contributors`，采用 MIT License；完整许可文本保留在根目录 [LICENSE](LICENSE)。迁入源文件、来源修订和迁入时校验值见 [来源清单](docs/source-provenance.json)。清单记录迁移时的状态，后续项目修改不必与原始校验值相同。

## npm 依赖

各依赖继续适用自己的许可证，根目录 MIT 许可不替代依赖许可。`package.json` 和 `pnpm-lock.yaml` 决定实际安装版本；[许可证元数据快照](docs/dependency-licenses.json) 记录本次本机已安装且存在于锁文件中的包，不覆盖未安装的平台可选包、容器中的操作系统组件，亦不代替各包的完整 LICENSE / NOTICE。

主要依赖包括 Pi、React、Fastify、TanStack、Radix、Motion、Lucide、Vite、Tailwind CSS、Sharp、better-sqlite3 和 node-pty。依赖文件由包管理器安装，公开源码包不打包 node_modules；Docker 生产包保留依赖自身附带的许可文件，并附带本说明。

需要单独留意的许可：

- Lightning CSS 的相关包声明 MPL-2.0。发布包含它的程序时，按实际分发内容保留许可说明和对应源码获取方式，详见 [Mozilla MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)。
- Sharp 自身声明 Apache-2.0，其预编译 libvips 包另声明 LGPL-3.0-or-later；不能统一写成 MIT。分发二进制或镜像时应核对具体平台包内的许可和源码信息，详见 [Sharp 许可说明](https://sharp.pixelplumbing.com/install/#licensing) 与包内许可文件。
- Docker 基础系统中的 Bash 等组件另有各自许可。当前入口在用户机器上构建镜像；若以后公开分发预构建镜像，应按实际镜像内容补齐对应的许可、NOTICE 和源码交付材料。

这份文档记录技术盘点结果，不代表对所有分发方式作出的法律结论。

## 供应商 Logo

模型连接向导使用来自 [OpenCode 供应商图标集](https://github.com/anomalyco/opencode/blob/dev/packages/ui/src/components/provider-icons/sprite.svg) 的 14 个 SVG Logo（2026-09-07 获取），本地文件为 `apps/web/src/assets/provider-logos.svg`。只提取使用的符号并重命名 ID，图形保持原样；随前端打包，不从外部加载。品牌名称和标志属于各自权利人，用于标识对应服务。

OpenCode 源码采用以下 MIT 许可证：

```text
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 背景与测试资料

随应用提供的三张氛围背景及其缩略图使用图像生成工具生成，没有使用第三方参考图片。完整提示词见 [背景来源记录](docs/background-prompts.json)，文件说明见 [内置背景](apps/server/src/backgrounds/README.md)。源码打包器只允许校验值已登记的这六个 WebP 文件；增加或替换图片需要重新审查来源。

公开测试使用原创合成故事或内联构造的协议数据。用户上传的角色卡、聊天记录、附件、个人截图、自定义 Skills 与真实模型验收输出不随项目分发。社区资料和用户数据的权利不由项目许可证授予。
