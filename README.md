# 短剧制作导演

> 想用 ComfyUI 免费做短剧，又不想学节点连线？这个项目把剧本、资产、视频提示词和 H3 工作流放进了 DeepSeek Harness 的创作台。

短剧制作导演是一个 **DeepSeek Harness / DSH Desktop 插件**，不是 DeepSeek 网页版功能，也不是通用 Agent 插件。它通过 Agent 调用本机或云端 ComfyUI，并在插件内提供资产库、分镜管理、视频提示词、MiniMax H3 转换和生成任务面板。

当前版本：`1.1.0`

## 它能做什么

- 从剧本整理人物、场景和道具资产，避免把盘点稿误识别为资产。
- 通过 ComfyUI 生成定妆照和资产图，不依赖按张购买的生图 API。
- 场景日夜、人物服装等变体必须从原资产走图像编辑，不允许用文生图重新造资产。
- 自动生成分集视频提示词，并把 `@人物`、`@场景`、`@道具` 绑定到具体资产版本。
- 将确认后的视频提示词转换为 MiniMax H3 中文格式。
- 支持本地 ComfyUI、云端 ComfyUI 和双端切换。
- 自动发现 ComfyUI、Python、模型和工作流位置，不写死安装盘符。
- 记录生成任务、候选视频和成片归档位置，任务面板刷新后重新从实例核对结果。

## 运行要求

- DeepSeek Harness / DSH Desktop，需兼容插件声明的 `0.2.0-rc.2` peer dependencies。
- 图片和视频生成需要本机或云端 ComfyUI。仅使用剧本、分镜、提示词和 H3 转换时，可以先不连接 ComfyUI。
- Windows 是目前完整支持本地实例启停和桌面安装的目标平台。其他系统仍可使用不依赖 Windows 启动器的功能。

## 安装

### 本地 ZIP

1. 在 GitHub Releases 下载插件包并解压。
2. 打开 DSH 的“插件管理”，选择安装本地插件。
3. 目标选择解压后的 `dsh-plugin-short-drama-director` 文件夹。
4. 启用组合包并按 DSH 提示完整重启应用。
5. 新建会话时选择“短剧制作导演”预设，或输入 `/drama` 切换短剧模式。

详细步骤见 [安装说明.md](安装说明.md)。

## ComfyUI 整合包

整合包不放进 Git 仓库。公开下载：

- [ComfyUI-Deploy-20261022](https://pan.quark.cn/s/9bdfb25e63dc?pwd=fv42)
- 提取码：`fv42`

部署技能会读取包内清单，扫描实际 ComfyUI、Python、模型和工作流目录。安装位置由用户自己决定，项目不附带作者机器路径。

安装后应向 Agent 说明：

```text
使用 comfyui-deploy 技能，检查我会话的文件沙箱权限。
先扫描我已经下载的 ComfyUI-Deploy-20261022 整合包和现有 ComfyUI，
再让我选择安装目录。不要写死路径，不要启动 GPU 生成任务。
```

## 项目结构

```text
.
├─ index.js                 Host 入口与工具注册
├─ client.js                左侧创作台
├─ cordis.patch.yml         Host 行与短剧导演预设
├─ lib/                     资产、分镜、H3、媒体、任务和工作流实现
├─ skills/                  随插件加载的 12 个技能
├─ vendor/adm-zip/          读取用户 .docx 的本地运行依赖
└─ scripts/package-plugin.mjs
```

## 数据与隐私

- 用户项目、资产、生成结果和本机路径不会提交到本仓库。
- 插件运行数据保存在用户自己的 `%DSH_HOME%` 或项目目录中。
- 仓库不包含 API Key、SSH 密码、云服务凭据或 ComfyUI 模型权重。
- 反馈问题时请先移除日志里的用户名、项目路径、实例地址和凭据。

## 许可与二次售卖

本项目采用 [Short Drama Director Source-Available License 1.0](LICENSE)。这是一份**源码公开许可，不是 OSI 定义的开源许可证**。

允许：

- 个人或团队使用、复制、修改源码。
- 使用本插件制作并商业化自己的短剧、广告或其他视频内容。
- 免费分享未修改或修改后的版本，但必须保留许可和署名。

禁止：

- 收费出售、出租、付费打包或以其他方式二次售卖插件本体。
- 把插件或修改版放进付费插件市场、付费课程资源包或按次收费的软件分发中。
- 移除版权和许可声明后重新发布。

插件生成的视频内容归内容制作者所有；ComfyUI、模型、工作流和其他第三方内容的授权仍按各自许可处理。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 反馈

请通过 GitHub Issues 报告可复现的问题。提交前先移除个人信息、凭据、项目资产和本机绝对路径。
