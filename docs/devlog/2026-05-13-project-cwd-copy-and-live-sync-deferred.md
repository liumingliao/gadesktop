# Project 绑定文件夹 hint 文案 + 已有对话 live-sync cwd 暂存

**Date**: 2026-05-13
**Status**: 文案改完 · live-sync feature deferred 等真实需求
**Related**:
- [CreateProjectDialog.tsx:142](../../desktop/src/components/screens/project/CreateProjectDialog.tsx#L142)
- [EditProjectDialog.tsx:167](../../desktop/src/components/screens/project/EditProjectDialog.tsx#L167)
- [PRD.md §7.3 Projects](../PRD.md) B 项 cwd 语义

## Context

Project 创建 / 编辑两个 dialog 里项目文件夹字段的 hint 文案漏满了内部架构术语：

- Create: `"可选 · 设置后，该项目下的 session 会以此目录作为 GA 子进程的 cwd"`
- Edit: `"改 rootPath 后，该 project 下 session 下次启动才会用新目录（已运行的 bridge 不受影响）"`

「cwd」「GA 子进程」「rootPath」「project」「bridge」「已运行的 bridge」全是给写代码的人看的，不是给用户看的。**对照 CLAUDE.md「不要让用户思考」原则两条都失败了** —— 用户得先理解 4-5 个内部架构概念才能看懂这两行 hint 在说什么。

Edit 的 hint 还有一个深层问题：背后假设了用户可以「重启对话」这个操作，但 V0.1 里**没有这个 UI 动作**（每个 session 的 GA 进程一旦 spawn，cwd 就定死了；要换 cwd 只能让进程死掉重生，而能让它死掉重生的途径只有重启整个 Workbench / LRU 淘汰 / GA 崩溃）。原文案「下次启动」措辞含糊，用户看了不知道该做什么动作。

## Decisions

### 文案落地

- **Create hint**: `"可选 · 项目里的对话以此文件夹为工作区"`
- **Edit hint**: `"修改后已有对话需重启 Workbench 后生效"`

两条都做到：
- 0 个内部架构术语（cwd / 子进程 / bridge / rootPath / project 全去掉）
- 用「工作区」一词建立对用户友好的心智模型（VS Code / Cursor 都用这个词，不熟悉的人也猜得到）
- Create 和 Edit 措辞结构对齐（都基于「工作区」概念）

### Edit hint 的关键 reframing

最初我提的 Edit 候选都是「修改后对新对话生效；已有对话保留原路径」类型 —— focus 在 default behavior（新对话用新路径）。

作者 push back：**「新开对话用新路径」是任何设置项的天然默认预期，不需要 hint 浪费字解释。Hint 应该花在「反直觉」的部分**。

落到这里反直觉的部分是：**已有对话不会自动跟上**。专门给它一行字：「修改后已有对话需重启 Workbench 后生效」。default behavior 留给用户脑补。

这个 reframing 通用得多 —— 以后写任何设置项的 hint，都该问「反直觉的部分是什么」而不是「全部行为是什么」。

### Edit hint 接受的现实

「需重启 Workbench 后生效」这个说法承认了 V0.1 当前实现的一个不优雅之处：用户改了项目路径，要让已有对话也用新路径，没有「重启此对话」的 UI 入口，只能重启整个应用。

讨论过几个 alternative，全部否决（见下）。**接受这是个能跑但不优雅的现状，靠诚实文案盖过去**，等真实用户反馈再决定要不要真去修。

## Rejected alternatives

### 文案层面

**「修改后对新开的对话生效；已有对话保留原路径」**
否决理由：花字解释了「新对话生效」这个 default 预期，让用户怀疑「为什么要强调？是不是有什么暗坑？」。Hint 应解释反直觉，不重复 default。

**「修改后只对新对话生效；要让正在跑的对话使用新路径，请退出 Workbench 后重新打开」**
否决理由：太长，且「退出再打开」其实跟「重启」是同义的，啰嗦。

**完全不提已有对话**（最初我的 B-mini-2: 「修改后，新对话以此目录为工作区」）
否决理由：1% 的边缘 case 用户踩到时会困惑，省略不是好的折衷 —— 作者 push back 正中这一点。

### 功能层面

**右键菜单加「重启此对话」**
否决理由：99% 的用户看到这个选项第一反应是「这是干嘛的？我什么时候该用？」。把内部架构（每 session 一个独立 Python 进程，cwd 启动时定死）漏给了用户。

**保存项目路径后自动 shutdown + 重 spawn 所有该 project 下的 alive bridge**
否决理由：用户可能正在跑一个长任务，自动 kill bridge 会丢失任何 in-flight 状态。**任何「自动毁掉用户当前工作」的行为都比 honest 文案差**。

**编辑路径后弹 toast「X 个对话仍在旧路径 [应用到所有]」**
否决理由：toast 本身是 UI 复杂度，且「应用到所有」按钮按下去仍然要 kill + respawn，本质同上一条。改善了「问用户」的姿态但没解决问题。

## Future path · IPC `set_cwd` + `os.chdir`

如果 beta / 公测中「改完路径要重启 Workbench 才生效」真的成了痛点，正解是：

1. **Bridge 加 IPC 命令** `set_cwd { path: string }`
2. Bridge 收到后调 `os.chdir(path)` —— 这个是 OS 级 API，Python 进程的 cwd 真的就能改掉
3. 之后 GA 调 `file_read("a.txt")` / `code_run("git status")` 时，Python 解析相对路径 + subprocess 继承 cwd，**自动用新路径**，不需要重 spawn
4. Workbench 端：用户保存项目 rootPath 时，**自动给该 project 下所有 alive bridge 发 `set_cwd`**

效果：「修改保存 → 立刻全员生效」，无 UI 操作、无内部架构泄漏、无 in-flight 状态丢失。

为什么现在不做：
- 工程成本：bridge 加新 IPC 命令 + ipc.py 加 dataclass + ipc-protocol.md 文档 + bridge 测试 + 在 desktop store 的 updateProject 里自动派发 + 边缘 case（`os.chdir` 在某些路径不存在 / 权限不够时的错误处理）。大概 200-300 行。
- 现状容忍度未知：作者 dogfood 中没真把这定位为「天天踩」的问题；可能改完路径就直接重启 Workbench 也没多大成本。

触发条件：beta / 公测有人反馈「改完路径要重启 app」是高频痛点。

## Open questions

- `os.chdir` 在 GA 跑 tool 中途被调用会出什么问题？
  - 已知：`open()` 解析路径在 call 时，`subprocess` 继承 cwd 也在 spawn 时 → 已在 flight 的操作不受影响，新操作用新 cwd。理论上安全。
  - 未知：GA 内部某些工具可能 cache 启动时的 cwd（比如 ga.code_run 之类的 in-process state），具体情况要看 GA 代码 audit 一遍。
- `os.chdir` 失败（路径不存在 / 权限不够）的反馈链路：bridge emit error event → desktop 提示「目录无效」+ 回滚 project rootPath 到旧值？还是只 toast warning？
- live-sync 触发时机：用户改 path 字段每次输入都 chdir？还是 save 按钮按下后才发？后者明显更对。

## Next

文案改完即可 ship。live-sync feature 留 backlog，定期回看本条 entry，beta / 公测有真实痛点反馈再启动实施。
