> 旧版下载提示词，已同步到 `ComfyUI-Deploy-20261022`。权威安装流程仍以同目录 `DEPLOY.md` 为准；本文件只补充下载包结构和路线摘要。

# ComfyUI 整合部署包提示词

你的任务是把新版绘世整合包部署到用户选择的本机 Windows、云端 Linux 或双端，并在部署完成后写入创作台全局配置。

## 分享包

```text
分享：ComfyUI-Deploy-20261022
链接：https://pan.quark.cn/s/9bdfb25e63dc?pwd=fv42
提取码：fv42
```

下载后先读取：

```text
README_必读.txt
MANIFEST.txt
INSTALL_PROMPT.md
```

实际结构：

```text
ComfyUI-Deploy-20261022/
├─ ComfyUI/ComfyUI-aki-v3.2.rar
├─ models/
├─ loras/
├─ custom_nodes/custom_nodes_windows.zip
├─ custom_nodes/custom_nodes_linux.tar.gz
├─ workflows/local/
└─ workflows/cloud_linux/
```

这是绘世/Aki 整合包，不是 `ComfyUI_windows_portable`。不要再套用旧版云端补丁流程或旧分享口令。

## 路线

先扫描现有安装和部署包；有可复用内容就不要重复下载。然后让用户选择：

```text
A. 只部署本地
B. 只部署云端
C. 本地和云端都部署
```

选择 B/C 时再收集 SSH 主机、端口、密码。密码只写本机 `pw.txt`，不得写入提示词、日志、分享包或命令行。

## 本机 Windows

1. 选择空间足够的非系统盘，记为 `$TARGET_DRIVE`。
2. 解压 `ComfyUI\ComfyUI-aki-v3.2.rar` 到 `$TARGET_DRIVE\ComfyUI\ComfyUI-aki-v3.2`。
3. 合并 `models` 到 `<安装目录>\ComfyUI\models`。
4. 合并 `loras` 到 `<安装目录>\ComfyUI\models\loras`。
5. 备份后把 `custom_nodes_windows.zip` 解压到 `<安装目录>\ComfyUI\custom_nodes`。
6. 把 `workflows\local` 复制到 `<安装目录>\ComfyUI\user\default\workflows`。
7. 用整合包自带 Python 启动，不另装 Python、不全量 pip install。
8. 验证独立图像/视频超分工作流和一次最小 Krea2 文生图。

绘世包不需要盘符根目录的 `启动ComfyUI.bat`。人工启动可打开 `绘世启动器.exe`；插件启动使用内置 Python 调 `ComfyUI\main.py`。

## 云端 Linux

1. 探测 `/root/ComfyUI`、GPU、Python、`/cloud`/`/Cloud` 和真实挂载。
2. 已有镜像实例只补缺，不覆盖现有节点、模型和工作流。
3. 合并 `custom_nodes_linux.tar.gz`，保留 Linux `.so`。
4. 复制 `workflows/cloud_linux` 到云端 ComfyUI 工作流目录。
5. 合并 `models` 和 `loras`；有真实云储存时使用 `/cloud/models`，没有时先暂停询问。
6. 不执行旧版 Cloud-Patch 脚本，不把 Windows `.pyd` 节点复制到 Linux。
7. 自检 `/system_stats`、队列、Linux 节点和关键模型。

## 工作流校验

本地 7 个、云端 9 个有效工作流。独立超分流必须保留：

```text
▶▷VOSR2-图像放大.json
SHA256 69CDC2DFB662D3019361C3F84A42579D858D79608C71B70126BD1BC30B1E3BBC

▶▷VOSR2-视频放大.json
SHA256 25CE10678F0414F336CDB8C81258C143DD17B514327140BEE6B36682576D2B8D
```

`▶▷VOSR2-图像+视频放大.json` 仅作历史兼容，不作为默认超分流。

## 完成后

按 `DEPLOY.md` 和 `references/default-workflow-profile.json` 解析当前机器的真实工作流路径，补齐对应环境的四项 tasks、video-generation workflow、模型与采样参数，再初始化五个 endpoints。重新读取验证；只有本机/云端实际可访问、工作流无红节点、任务路径、视频配置和 endpoints 回读正确，才算部署完成。
