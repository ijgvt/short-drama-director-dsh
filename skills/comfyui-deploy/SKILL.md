---
name: comfyui-deploy
description: 完整复制/部署 ComfyUI 到本机 Windows、云端 Linux 或双端，含自备文件扫描、路线推荐、夸克包校验、Linux 节点合并、模型补齐、自检、VBS 一键连接和创作台全局运行端初始化。用户要"安装 ComfyUI""部署云端 ComfyUI""两端都装""连不上 ComfyUI"时使用。
---

# ComfyUI 部署

本技能的权威步骤是同目录下的 `DEPLOY.md`。开始前用文件工具完整读一遍，并逐条执行；`PROMPT.md` 是旧版资料，不得覆盖 `DEPLOY.md` 的路线选择、SSH、VBS 和全局配置规则。

## 先扫描，再推荐，最后让用户选

先做只读检查，不安装、不启动、不连接云端：

```text
comfy_install action=check
comfy_launch action=status
```

同时检查用户自备的 `ComfyUI-Deploy-20261022`、`ComfyUI-aki-v3.2.rar`、`models`、`loras`、`workflows/local`、`workflows/cloud_linux`、`custom_nodes_windows.zip`、`custom_nodes_linux.tar.gz`、`connect_*cloud*.bat`、`*.vbs`。已有文件优先复用，不重复下载。

如果扫描不到可复用的整合包或补丁，再使用公共夸克分享；不要把下载放在扫描之前：

```text
分享：ComfyUI-Deploy-20261022
链接：https://pan.quark.cn/s/9bdfb25e63dc?pwd=fv42
提取码：fv42
```

下载后先读取包内 `MANIFEST.txt` / `README_必读.txt`，按实际目录区分本机主程序、Linux 节点/工作流和模型；不要按旧分享的目录名猜测。校验不通过就重下。

新版分享包的实际结构是绘世整合部署包：

```text
ComfyUI-Deploy-20261022/
├─ README_必读.txt
├─ MANIFEST.txt
├─ INSTALL_PROMPT.md
├─ ComfyUI/ComfyUI-aki-v3.2.rar
├─ models/
├─ loras/
├─ custom_nodes/custom_nodes_windows.zip
├─ custom_nodes/custom_nodes_linux.tar.gz
├─ workflows/local/
└─ workflows/cloud_linux/
```

新版云端部署直接使用包内 Linux 节点包、`workflows/cloud_linux`、`models` 和 `loras`，由本技能按实际 SSH 实例合并；不存在单独的云端补丁入口。

报告 GPU 型号、**总显存**、磁盘空间、已有安装/部署包、运行状态和云端脚本，再推荐：

| 路线 | 适用条件 | 用户必须提供 |
|---|---|---|
| **A 本地** | Windows、NVIDIA、磁盘足够；16GB 是本地视频推荐线，低于时仍可由用户选择本地 | 无 SSH |
| **B 云端** | 本地显存不足、没有本地安装，或用户选择云端 | **SSH 主机、端口、密码** |
| **C 双端** | 本地可做图片，云端做视频；或用户要本地+云端冗余 | **SSH 主机、端口、密码** |

本地 `<16GB` 时不要把本地视频作为默认推荐，先建议云端或双端；但不要禁用本地选项。给用户三选一，等用户明确选择后才进入部署。用户明确选择本地视频时，按低显存方案降分辨率、Chunks 和步数。

新版分享包固定是绘世/Aki 整合布局：

- `ComfyUI-aki-v3.2.rar`：主程序压缩包。
- `models`：并入 `<安装目录>\ComfyUI\models`。
- `loras`：并入 `<安装目录>\ComfyUI\models\loras`。
- `custom_nodes_windows.zip`：Windows 节点。
- `workflows/local`：Windows 本地工作流。

其他来源的包仍要先区分两种布局：

- `ComfyUI_windows_portable`：便携包，通常由 `run_nvidia_gpu.bat` 或安装后复制到父目录的 `启动ComfyUI.bat` 启动。
- `ComfyUI-aki-v3.2`：绘世/Aki 整合包，根目录有 `绘世启动器.exe`，程序在 `ComfyUI\main.py`，解释器在 `python\python.exe`。

绘世包由插件的 `comfy_launch start_local` 直接调用内置 Python 启动，保留 `--user-directory` 指向它自己的 `ComfyUI\user`。不要让 Agent 等待绘世 GUI，也不要要求或生成盘符根目录下的 `启动ComfyUI.bat`；该 BAT 不是绘世包的一部分。

已有安装目录不要求移动或改名。它可能位于任意数据盘的 `ComfyUI-aki-v3.2`、`comfyui专属\ComfyUI-aki-v3.2` 或其他自选目录；以 `comfy_install` 和实际标记文件发现的位置为准，路径不同不等于部署失败，不要为了匹配新版包结构迁移整套环境。

已有云端实例可能仍使用自定义名字或修改过的超分工作流。若功能、节点和输入契约正常，保留原工作流，不要仅为了匹配新包文件名覆盖它；只有新建实例或确认旧流失效时才使用新版默认文件名和校验哈希。

选择云端或双端却拿不到 SSH 主机、端口、密码时，立即暂停。密码只写入本机 `pw.txt`，不得回显、记日志或上传网盘。

拿到 SSH 后再确认是“**从零开始**”还是“**从用户镜像实例开始**”。镜像实例只合并缺的节点、工作流和模型，不删除现有环境。

云端必须检测 `/cloud` 和 `/Cloud`，并用 `findmnt`/`df -h` 判断是否为真实云储存。没有检测到时必须暂停询问：

- 先不开通云储存、继续部署：明确告知加载模型会明显更慢，用户同意后才使用 `/root/ComfyUI/models`
- 等用户开通并挂载云储存后继续

不能静默创建普通 `/cloud` 目录冒充云储存。

## 两条铁律（最容易做错的）

1. **模型目录看真实云储存挂载**：检测 `/cloud` 或 `/Cloud`，确认是独立挂载后把模型放进去；备份旧 models 再建软链。没有云储存时必须询问用户，不能直接继续或伪造目录；用户选择继续才使用 `/root/ComfyUI/models`。不要直接 `rm -rf` 用户现有目录。
2. **不要全量 pip install**：`requirements_freeze.txt` 里的 `" @ file:///"` 行要先过滤掉，只补装缺的包（用清华源）。

## 云端/双端必须生成一键连接

在运行 DSH 的 Windows 电脑上生成：

```text
_deploy/connect_h3_cloud.bat
_deploy/一键连接云端ComfyUI.vbs
_deploy/pw.txt
```

`一键连接云端ComfyUI.vbs` 只负责无黑框调用同目录 BAT。BAT 用 `plink -pwfile` 建立 `127.0.0.1:8888 -> 云端 127.0.0.1:8188` 隧道，并轮询 `/system_stats`。主机指纹必须由用户确认后写入 `RHOSTKEY`；`pw.txt` 用 ACL 限制当前用户可读，不允许进入分享包。
插件自动启动时会设置 `DSH_NONINTERACTIVE=1`；BAT 必须使用不依赖控制台 stdin 的等待方式（例如 PowerShell `Start-Sleep`），不能再直接执行 `timeout /t`。

## 部署后初始化创作台运行端

先读取同目录 `references/default-workflow-profile.json`。它只保存语义默认值和工作流文件名模式，不保存任何本机绝对路径。部署后必须用 `comfy_install`、`comfy_launch`、`storyboard action=global-config configAction=read configProbe=true` 和实际文件扫描，把清单解析成当前机器的真实路径。

工作流按以下语义解析：

```text
text-to-image     → Krea2 文生图
image-edit        → Qwen Image 2.1 图像编辑+生图
upscale-image     → 独立 VOSR2 图像超分
upscale-video     → 独立 VOSR2 视频超分
video-generation  → 当前可运行的 MiniMax H3 参考生视频
```

新装包优先使用清单里的默认文件名；已有实例允许保留同名能力的自定义文件。图像超分和视频超分不能回退到历史合并流作为默认值。

部署后必须调用：

```text
storyboard action=global-config configAction=read configProbe=true
```

以返回的 `globalConfig.settings` 为基础，补齐当前路线对应的 `tasks`：

```text
tasks.local / tasks.cloud:
  text-to-image
  image-edit
  upscale-image
  upscale-video

settings.video.local / settings.video.cloud:
  workflow
  model
  modes.drama
  modes.action
  writeMode
```

视频默认优先 `minimax_h3_hybrid_fl2va_ref2va_b20-49-int8.safetensors`，但必须先核对该模型在当前实例的模型列表中；不存在时选该实例实际可运行的首个 H3 模型，不得把本机模型名生搬到另一台实例。

按 `default-workflow-profile.json.videoDefaults` 设置默认采样：

```text
文戏: 总步数 12 / 一采 8 / 二采 4
武打: 总步数 14 / 一采 10 / 二采 4
writeMode: drama
```

完成五项 endpoints：

```text
text-to-image
image-edit
upscale-image
upscale-video
video-generation
```

本地路线全 `local`；云端和双端路线全 `cloud`，**有云端优先走云端**。然后用 `storyboard action=global-config configAction=save` 保存并重新读取验证。只把最终解析出的绝对路径写入当前用户的 `state.json`，不要写回插件包或技能文件。

## 装完必须自检

- 云端：`curl -s http://127.0.0.1:8188/system_stats` 返回 JSON；日志无致命错误；必须存在可运行的独立图像超分和视频超分流。新装包使用 `▶▷VOSR2-图像放大.json` 与 `▶▷VOSR2-视频放大.json`；已有实例若用自定义名字且实际可运行，可保留原文件。逐个核对关键模型文件并确认 Linux 节点能导入。
- 本机：启动日志没有 `ModuleNotFoundError` / `ImportError`；5 份默认工作流没有红色缺节点；跑一次最小的 `▶▷Krea2-文生图` 能出图。
- 云端或双端额外检查：VBS/BAT 存在，隧道能到达 `http://127.0.0.1:8888/system_stats`，并实际打开一次浏览器。
- 三种路线装完都用 `comfy_inventory` 验证连通（云端用隧道地址 `http://127.0.0.1:8888`），把 GPU、队列、模型清单和最终 endpoints 报给用户。

## 何时用本技能

- 用户在 `short-drama-director` 主流程第 1 步选了"要安装 ComfyUI"。
- 用户单独要求装 ComfyUI、装模型、修 ComfyUI。
- `comfy_inventory` 探测不到可用实例而用户想解决。

## 禁止事项

不要 `pip install -r requirements` 全量硬装；不要改用户网盘里的文件；不要删除/覆盖已有 `/cloud/models`，只补缺；双端/云端必须保留用户 SSH 密码私密性。自研插件（TE_MAN / TE-Speed-* / Goohaitools-comfyui / ComfyUI_MiniMaxH3_Director / YZ_*）GitHub 上没有，不要 `git clone`。
