# ComfyUI 部署与创作台初始化

你的任务是把用户现有的 ComfyUI / 模型 / 工作流部署到本机、云端或双端，并在部署完成后初始化创作台全局配置。不要先入为主地下载整套文件；用户很可能已经自备安装、部署包和模型。

执行原则：**先扫描，再推荐，最后让用户选。**

## 一、先扫描，不修改任何东西

先执行：

```text
comfy_install action=check
comfy_launch action=status
```

检查并记录：

- 现有 ComfyUI 安装和部署包路径
- Windows/Linux、Python、NVIDIA 驱动
- GPU 型号、**总显存**、当前可用显存
- 目标盘剩余空间
- 本地实例是否正在运行
- 云端隧道脚本、`connect_*cloud*.bat`、`*.vbs`
- 用户自备的 `ComfyUI-Deploy-20261022` 及其 `README_必读.txt`、`MANIFEST.txt`、`ComfyUI/ComfyUI-aki-v3.2.rar`、`models`、`loras`、`custom_nodes/custom_nodes_windows.zip`、`custom_nodes/custom_nodes_linux.tar.gz`、`workflows/local`、`workflows/cloud_linux`

把搜索过的地方和发现结果告诉用户。已有安装、部署包、模型或节点时优先复用，不要重复下载。

## 二、据实推荐，再让用户选择

推荐规则：

1. 本地已有可用 ComfyUI，NVIDIA 总显存 `>=16GB`，磁盘足够：优先推荐本地图片和 H3 视频。
2. 本地总显存 `<16GB`：**不默认推荐本地 H3 视频，但不禁用**。优先推荐云端；本地仍可做图片时推荐双端。用户明确选本地时，先降分辨率、Chunks 和步数。
3. 本地没有 NVIDIA 或没有可用 ComfyUI：推荐云端。
4. 用户已有完整本地文件但没有云端：推荐本地，并说明视频是否达到 16GB 推荐线。
5. 用户已有云端包或连接脚本但没有本地安装：推荐云端。

推荐必须带原因，例如：

```text
本机 RTX 3060 Laptop 6GB：图片可在本地，H3 视频低于 16GB 推荐线，默认建议双端或云端；用户仍可手动选择本地并降配尝试。
```

然后只问一次：

```text
A. 只部署本地
B. 只部署云端
C. 本地和云端都部署
```

用户选择 B 或 C 后，再确认云端实例来源：

```text
D. 从零开始（云机上还没有可用 ComfyUI）
E. 从我的镜像实例开始（已有 ComfyUI、节点或模型）
```

即使扫描 `/root/ComfyUI` 已经能看出像镜像实例，也要让用户确认一次。镜像实例只允许补缺和合并，不允许直接覆盖现有用户环境。

## 三、SSH 凭据规则

用户选择 B 或 C 时，必须先拿到：

```text
SSH 主机
SSH 端口
SSH 密码
```

缺一项就暂停。不得猜主机、端口或密码。

- 选择 A 时不要索要 SSH。
- 密码只写入本机 `pw.txt`，使用 `plink -pwfile`。
- 不要把密码写进提示词、VBS、BAT 命令行、日志、部署报告或网盘分享。
- 首次连接必须让用户确认主机指纹，再把确认后的指纹写入 `RHOSTKEY`。
- 不自动接受未知主机。

## 四、复用用户文件

按优先级：

1. 已有可运行 ComfyUI：直接使用，不安装第二份。
2. 已有部署包但未安装：按包内 README/MANIFEST 部署，不再下载。
3. 已有模型/工作流/节点但版本不同：缺什么补什么，不覆盖无关文件。
4. 什么都没有：再使用下面的公共夸克分享或用户提供的安装包：

```text
分享：ComfyUI-Deploy-20261022
链接：https://pan.quark.cn/s/9bdfb25e63dc?pwd=fv42
提取码：fv42
```

下载后按包内 `MANIFEST.txt`、`README_必读.txt` 和对应安装说明识别实际目录、本机包、云端补丁与模型来源；不要按旧分享目录名猜测，也不要跳过校验直接部署。

新版分享包固定为绘世整合部署包，当前结构是：

```text
ComfyUI-Deploy-20261022/
├─ README_必读.txt
├─ MANIFEST.txt
├─ INSTALL_PROMPT.md
├─ ComfyUI/ComfyUI-aki-v3.2.rar
models/
loras/
├─ custom_nodes/custom_nodes_windows.zip
├─ custom_nodes/custom_nodes_linux.tar.gz
├─ workflows/local/
└─ workflows/cloud_linux/
```

先读 `README_必读.txt`、`MANIFEST.txt` 和 `INSTALL_PROMPT.md`。主程序只支持绘世/Aki 布局，不要套用 Portable 包的根目录启动 BAT。该包不包含单独的云端补丁或现成云存储快照。

当前清单声明：

- 本地 `workflows/local`：7 个有效工作流。
- 云端 `workflows/cloud_linux`：9 个有效工作流。
- `▶▷VOSR2-图像放大.json` SHA256：`69CDC2DFB662D3019361C3F84A42579D858D79608C71B70126BD1BC30B1E3BBC`
- `▶▷VOSR2-视频放大.json` SHA256：`25CE10678F0414F336CDB8C81258C143DD17B514327140BEE6B36682576D2B8D`

图像超分和视频超分必须分别使用这两条独立工作流；`▶▷VOSR2-图像+视频放大.json` 只作为历史兼容候选。

已有云端实例可能把两条超分流命名为 `▶▷VOSR2-图像超分（云端）.json`、`▶▷VOSR2-视频超分（云端）.json`，或带有实例自己的兼容修改，因此哈希与新版基线不同。只要图像/视频超分能力、输入契约和实际运行都正常，就保留原文件并继续使用，不要为了匹配新包名或哈希而覆盖。只有新部署或确认旧流不可用时，才替换为新版独立工作流。

## 五、本机 Windows 部署

本地 H3 视频推荐线：**总显存 >=16GB**。低于 16GB 不是禁用条件，只改变默认推荐和风险提示。

先判断本地包类型：

| 包类型 | 识别文件 | 启动方式 |
|---|---|---|
| 绘世/Aki 整合包 | `绘世启动器.exe`、`python\python.exe`、`ComfyUI\main.py` | `comfy_launch start_local` 直接调用内置 Python；人工兜底可开绘世启动器 |
| Portable 便携包 | `ComfyUI_windows_portable\run_nvidia_gpu.bat`、`python_embeded\python.exe` | 运行 `run_nvidia_gpu.bat`，或安装后父目录的 `启动ComfyUI.bat` |

盘符根目录下的 `启动ComfyUI.bat` 只属于本仓库的 Portable 包，不是绘世包文件。绘世包没有它也不代表部署失败；不要为了“补齐启动器”创建这个 BAT。

1. 选择空间足够的非系统盘 `$TARGET_DRIVE`，不要假定盘符。
2. 解压 `ComfyUI\ComfyUI-aki-v3.2.rar` 到 `$TARGET_DRIVE\ComfyUI\ComfyUI-aki-v3.2`。最终必须存在 `绘世启动器.exe`、`python\python.exe`、`ComfyUI\main.py`。
3. 合并包根目录 `models` 到 `ComfyUI-aki-v3.2\ComfyUI\models`，保持子目录结构。
4. 合并包根目录 `loras` 到 `ComfyUI-aki-v3.2\ComfyUI\models\loras`。
5. 备份后解压 `custom_nodes\custom_nodes_windows.zip` 到 `ComfyUI-aki-v3.2\ComfyUI\custom_nodes`；同名节点先备份，不整目录删除。
6. 复制 `workflows\local` 到 `ComfyUI-aki-v3.2\ComfyUI\user\default\workflows`。
7. 核对独立图像/视频超分工作流及其 SHA256；历史合并超分流只作为兼容候选，不设为默认。
8. 用整合包自带 Python 启动。不要全量 pip install，不要另装 Python。
9. 确认工作流无红节点，跑一次最小 Krea2 文生图。

已有安装可以位于任意数据盘的自选目录（包括名为 `comfyui专属` 的父目录），不要求迁移到 `ComfyUI-aki-v3.2` 的标准示例路径。先通过 `comfy_install` 和实际标记文件确认已有安装；路径不同但启动器和 Python 正常时，直接复用。

如果用户选择本地但总显存 `<16GB`，可以初始化本地视频 endpoint，但必须明确提示可能爆显存，并建议先降低分辨率、Chunks 和步数。只有在用户要求自动配置时，才优先把默认 endpoint 设为云端；用户手动保存的本地选择必须保留。

## 六、云端 Linux 部署

拿到 SSH 后，先区分“从零开始”和“从用户镜像实例开始”：

```bash
nvidia-smi
ps -eo pid,args | grep '[m]ain.py' || true
pid=$(pgrep -f 'python.*main.py' | head -n 1)
[ -n "$pid" ] && readlink "/proc/$pid/exe" || true
ls -ld /root/ComfyUI
for dir in /cloud /Cloud; do [ -d "$dir" ] && echo "FOUND=$dir"; done
findmnt -T /cloud 2>/dev/null || true
findmnt -T /Cloud 2>/dev/null || true
df -h /cloud /Cloud 2>/dev/null || true
```

不要把登录 shell 的 `python`/`python3` 当作 ComfyUI 实际解释器。已有实例必须优先读取正在运行的 `main.py` 进程和 `/proc/<pid>/exe`，使用该环境检查依赖；系统 Python 与 ComfyUI 环境版本不同并不等于部署错误。

### 从镜像实例开始

- 保留现有 `/root/ComfyUI`、节点、模型和工作流。
- 只合并本次缺少的节点、工作流和模型。
- 合并前备份同名的 `custom_nodes` 或工作流，不要整目录删除。
- 若镜像已经配置好云储存，沿用它的实际挂载路径。

### 从零开始

- 安装与实例 CUDA 兼容的 ComfyUI 和 Python 环境。
- 再合并新版包的 `custom_nodes_linux.tar.gz`、`workflows/cloud_linux`、`models` 和 `loras`。
- 不允许把 Windows 的 `.pyd` 节点复制到 Linux；Linux 使用 `custom_nodes_linux.tar.gz`。

### 云储存探测

必须检查 `/cloud` 和 `/Cloud`，并结合 `findmnt`、`df -h` 判断是否真的是独立云储存挂载，而不是普通目录。

检测到云储存时：

1. 使用检测到的 `/cloud/models` 或 `/Cloud/models`。
2. 先备份原 `/root/ComfyUI/models` 为 `models.local-backup-时间`，再建立指向云储存模型目录的软链。
3. 只补缺模型，不覆盖云储存已有文件。

没有检测到云储存时，必须暂停并询问用户：

```text
没有检测到 /cloud 或 /Cloud 云储存挂载。
继续使用云机本地磁盘可以运行，但加载模型会明显更慢，尤其是 H3 和 VOSR2。
请选择：
F. 先不开通云储存，继续部署
G. 暂停，等我开通并挂载云储存后继续
```

用户选择 G 时停止，等云储存准备好后重新检测。用户选择 F 才使用 `/root/ComfyUI/models`；不要把普通 `/cloud` 目录伪装成云储存。

其余步骤：

1. 合并 `custom_nodes_linux.tar.gz` 到云端 `custom_nodes`，保留 Linux `.so` 和修改。
2. 复制 `workflows/cloud_linux` 到云端 `user/default/workflows`。
3. 只补装缺失依赖，不全量安装 requirements。
4. 自检 `/system_stats`、`/queue`、关键节点和模型文件。

不要删除用户现有模型或无关节点。需要替换目录时先备份。

## 七、云端/双端一键连接

在运行 DSH 的 Windows 电脑上建立 `_deploy` 目录：

```text
_deploy/
├─ connect_h3_cloud.bat
├─ 一键连接云端ComfyUI.vbs
└─ pw.txt
```

### VBS

`一键连接云端ComfyUI.vbs`：

可直接使用本技能 `references/一键连接云端ComfyUI.vbs` 作为模板；目标目录中的文件名必须保持为 `一键连接云端ComfyUI.vbs`，并与 `connect_h3_cloud.bat` 放在同一目录。

```vbscript
Option Explicit
Dim sh, fso, q, d, target
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)
d = fso.GetParentFolderName(WScript.ScriptFullName)
target = d & "\connect_h3_cloud.bat"
sh.CurrentDirectory = d
sh.Run q & target & q, 1, False
```

### BAT

`connect_h3_cloud.bat` 必须：

- 设置 `LPORT=8888`、用户提供的 `RHOST`、`RPORT` 和已确认的 `RHOSTKEY`
- 设置 `PLINK=...plink.exe`
- 用 `-pwfile "%~dp0pw.txt" -batch -N -L %LPORT%:127.0.0.1:8188 root@%RHOST%`
- 检查 8888 端口是否已被占用
- 轮询 `curl.exe http://127.0.0.1:%LPORT%/system_stats`
- 成功后打开 `http://127.0.0.1:%LPORT%/`
- 失败时输出 `tunnel_err.log` 并停止残留 `plink`

生成后实际运行一次，确认云端 ComfyUI 通过 8888 可访问。VBS 只是无黑框启动器，真正隧道仍由 BAT 建立。

## 八、双端

双端需要：

1. 本地安装完成并可作为图片备用。
2. 云端安装完成。
3. VBS/BAT/`pw.txt` 生成并验证。
4. 本地 DSH 能读取云端提交所需的工作流 JSON；必要时把 `workflowsDir` 指向本地保存的云端工作流目录。

有云端时默认所有阶段优先云端。

## 九、初始化创作台全局配置

先确保本地 DSH 能读取工作流：

- 本地：`workflows/local` 复制到本地 ComfyUI 工作流目录。
- 云端：`workflows/cloud_linux` 复制到本地 DSH 可读取的工作流目录；云端执行仍使用这些本地 JSON 提交。
- 双端：两套都保留。
- 全局配置读不到时，设置插件 `workflowsDir` 后重试。

先读：

```text
storyboard action=global-config configAction=read configProbe=true
```

以 `globalConfig.settings` 为基础，同时读取 `references/default-workflow-profile.json`，从本次扫描返回的 `environmentWorkflows` 中解析当前机器的实际文件：

| 任务 | 新装默认 | 已有实例允许 |
|---|---|---|
| `text-to-image` | `▶▷Krea2-文生图.json` | 同名能力的自定义 Krea2 流 |
| `image-edit` | `▶▷Qwen-image21-图像编辑+生图流（整合）.json` | 同名能力的 Qwen 编辑流 |
| `upscale-image` | `▶▷VOSR2-图像放大.json` | `▶▷VOSR2-图像超分（云端）.json` 或已验证独立图像超分流 |
| `upscale-video` | `▶▷VOSR2-视频放大.json` | `▶▷VOSR2-视频超分（云端）.json` 或已验证独立视频超分流 |
| `video-generation` | `YZ金鱼-MiniMax H3 终极篇-文武双全.json` | 已验证可运行的 H3 参考生视频流 |

不要按文件名盲选。必须用实际扫描项的能力、节点可运行性、输入契约和当前实例模型列表复核。解析出的绝对路径只写入当前用户状态，不写回技能包。

按路线补齐任务：

- 本地：填写 `tasks.local` 的 `text-to-image`、`image-edit`、`upscale-image`、`upscale-video`。
- 云端：填写 `tasks.cloud` 的同四项。
- 双端：两套都填写，保留各自真实路径。

视频配置按 `videoDefaults` 补齐 `video.local` 和/或 `video.cloud`：

- 优先模型 `minimax_h3_hybrid_fl2va_ref2va_b20-49-int8.safetensors`；当前实例没有时必须改选实例实际可运行的 H3 模型。
- 文戏默认 `12 / 8 / 4`，武打默认 `14 / 10 / 4`，调度器优先 `beta`；实例没有该调度器时选实际可用值。
- `writeMode` 默认 `drama`。

本地路线：

```json
{
  "text-to-image": "local",
  "image-edit": "local",
  "upscale-image": "local",
  "upscale-video": "local",
  "video-generation": "local"
}
```

云端或双端路线：

```json
{
  "text-to-image": "cloud",
  "image-edit": "cloud",
  "upscale-image": "cloud",
  "upscale-video": "cloud",
  "video-generation": "cloud"
}
```

保存：

```text
storyboard action=global-config configAction=save configProbe=true generationConfig=<替换 endpoints 后的 settings>
```

保存后重新读取，核对五个 endpoints、当前路线四项 tasks、视频 workflow、模型、调度器和步数。图像与视频超分必须是两条独立能力；历史合并流只在用户明确选择时作为回退，不能成为默认。视频超分目标清晰度由面板传 `targetResolution`，不是固定倍率。云端任务必须有可用的本地 workflow 路径；没有就修复后再保存，不能留空。

## 十、最终自检和用户报告

必须核对：

```text
所选路线：本地 / 云端 / 双端
本地 GPU 型号与总显存
本地视频是否达到 16GB 推荐线（低于时给出风险提示，不锁死本地）
本地安装路径
云端 SSH 主机和端口（密码不显示）
云端 /system_stats
VBS 路径和隧道自检
5 个 endpoints
当前路线 4 项 task workflow 的真实路径
video-generation 的 workflow、模型、调度器和两套步数
缺失模型
缺失节点
遗留问题
```

如果选择双端，明确告诉用户：

> 创作台默认五项全部优先走云端，本地保留为备用。

部署完成不等于结束；只有全局配置保存并在读回时显示正确 endpoints，才算完成。
