# GA Baseline 升级 · cf65515 → 6bb3104

**Date**: 2026-05-13
**Status**: ✅ 升级完成 · 1 处 breaking change 已适配 · 80/80 tests pass
**Related**:
- [CLAUDE.md § GA Baseline](../../CLAUDE.md)
- [CLAUDE.md § Baseline Upgrade Workflow](../../CLAUDE.md)（同次新增）
- 受影响文件：`bridge/handlers.py`

## Context

距离上次升级（2026-05-12，cf65515）才一天，但 upstream 推了 5 个 commits 进 main，其中一个 (`3205f4a`) 改了 `BaseHandler.dispatch` 签名 —— 属 breaking change，需桥接层适配。同时这也是首次按新写的 [Baseline Upgrade Workflow](../../CLAUDE.md) 实跑一遍，验证流程本身是否可行。

## 5 个 commits 分类

| Hash | 类型 | 描述 | 接口表面影响 |
|---|---|---|---|
| 2468801 | feat | add tuiapp_v2.py — refined Textual frontend (#350) | ✓ 无（新文件，frontend） |
| d2840ae | docs | Evaluation — Five Dimensions section (EN & CN) | ✓ 无（仅 README） |
| 3205f4a | feat | dynamic tool_result maxlen based on parallel tool count | ⚠️ **breaking** — `BaseHandler.dispatch` 加 `tool_num=1` |
| 09cd857 | fix(tui) | avoid duplicate paste in tuiapp_v2 | ✓ 无（tui 自身） |
| 6bb3104 | fix(tui) | keep v2 output scrolled during stream updates | ✓ 无（tui 自身） |

只有 `3205f4a` 触及桥接层。

## 接口表面审计

按 CLAUDE.md「Baseline Upgrade Workflow」清单四项审计：

### 1. `BaseHandler` 三回调签名 + dispatch 生成器协议 — ⚠️ 变化

`agent_loop.py` line 18-22:

```diff
-    def dispatch(self, tool_name, args, response, index=0):
+    def dispatch(self, tool_name, args, response, index=0, tool_num=1):
         method_name = f"do_{tool_name}"
         if hasattr(self, method_name):
-            args['_index'] = index
+            args['_index'] = index; args['_tool_num'] = tool_num
```

`agent_runner_loop` 调用方变化：

```diff
-            gen = handler.dispatch(tool_name, args, response, index=ii)
+            gen = handler.dispatch(tool_name, args, response, index=ii, tool_num=len(tool_calls))
```

**用途**：upstream 用 `len(tool_calls)` 把并行工具数告诉 do_* 工具实现，让它们按数量等比缩减输出长度（`maxlen // tool_num`），避免一轮多工具调用时合并响应 blow up LLM context。

**对我们的影响**：`bridge/handlers.py` 的 `WorkbenchHandler.dispatch` 覆写 `BaseHandler.dispatch`，原签名 `(tool_name, args, response, index=0)` 不接受 `tool_num` —— 升级后 GA 会以 kwarg 形式传入，触发 `TypeError`。

**适配**：[bridge/handlers.py:178-217](../../bridge/handlers.py#L178) `WorkbenchHandler.dispatch` 加 `tool_num: int = 1` 参数 + 透传给 `super().dispatch(tool_name, args, response, index, tool_num)`。我们自己不读 `tool_num`，仅作直通，让下游 do_* 工具实现照常拿到 `args['_tool_num']`。

### 2. `agent._turn_end_hooks` 字典扩展点 + `hook(locals())` 调用约定 — ✓ 未变

`ga.py:572` 仍是 `for hook in getattr(self.parent, '_turn_end_hooks', {}).values(): hook(locals())`。我们 `_register_turn_end_hook` 走的这条路径完全没动。

### 3. `agentmain.GenericAgentHandler` 导入路径 — ✓ 未变

类定义还在 `ga.py:262`，agentmain 的 `from ga import GenericAgentHandler` 路径未变。

### 4. `llmclient.backend.history` 列表读写语义 — ✓ 未变

`llmcore.py` 此次没有改动。

## 内部行为变化（不影响桥接，记录备查）

`ga.py` 的 25 行改动除了引入 `_tool_num` 注入外，都集中在四个 do_* 工具实现的 `maxlen` 上：

- `do_code_run`: `maxlen = 10000 // tool_num`
- `do_web_scan`: `maxlen = 35000 // tool_num`
- `do_web_execute_js`: `maxlen = 8000 // tool_num`
- `do_file_read`: `maxlen = 20000 // tool_num`

并行调用越多，单个工具输出越短，合并后总 token 量受控。**对单工具串行调用零影响**（`tool_num=1` 时 maxlen 等于旧默认值）。

## 验证步骤（按 workflow 清单逐项执行）

```
1. cd ~/Documents/GenericAgent && git fetch upstream
   ✓ d2840ae..6bb3104  main → upstream/main

2. git log cf65515..upstream/main --oneline
   ✓ 5 commits listed above

3. 审计四个接口表面
   ✓ dispatch 签名变化 → 适配 bridge/handlers.py

4. git checkout upstream/main (detached HEAD) && .venv/bin/python -m pytest bridge/tests/
   ✓ 80 passed, 6 deselected in 0.15s
   ✓ mypy strict: clean
   ✓ ruff: clean

5. 更新 CLAUDE.md baseline 引用
   ✓ Hash: cf6551516fcc836f21dcdad592b07c703d09e1d8 → 6bb31046cc29981f3fd0ce0b22a6af8c9741e850
   ✓ Date: 2026-05-12 → 2026-05-13
   ✓ "92 commits since 6a3eecc" → "5 commits since cf65515"

6. 真跑测试
   ⏳ 待用户 dogfood 真实多步任务确认行为无退化（本次为流程演示，dogfood 通常会在下次启动 Workbench 时自然完成）

7. cd ~/Documents/GenericAgent && git checkout main
   ✓ 恢复用户主分支（仍 behind upstream/main by 3 commits，由用户自行决定何时 git pull）
```

## Workflow 本身的反馈（首次实跑后总结）

这是 [Baseline Upgrade Workflow](../../CLAUDE.md) 写完后**当天就实跑的第一次**，过程中验证了几件事：

- 7 步清单不冗余也不漏，每步都有明确输出
- 「四个接口表面」的 audit checklist 真的有用 —— 这次正好命中 dispatch 签名变化，没有这个清单可能要靠测试失败才能反查
- detached HEAD 切到 upstream/main 跑测试的姿势是对的，**不污染用户的 main 分支**
- e2e + handler tests 80/80 过，但不覆盖「dispatch 实际被新协议调用」的端到端 case —— 现有测试只用默认参数调 dispatch，没测过显式传 `tool_num`。**留个 TODO**：下次该补一条「显式传 tool_num 的 dispatch」测试，给未来类似的签名变化加一层 fail-fast 保护。

下次升级时这条 entry 是模板，照抄改 hash + 改 commits 表即可。

## Next

- ✅ Commit "Baseline upgrade cf65515 → 6bb3104: 5 commits (dispatch tool_num adapt)"
- ⏳ 用户下次启动 Workbench 时观察是否有行为退化
- ⏳ （可选）补一条「显式传 tool_num」的 dispatch 测试
- ⏳ 用户决定何时 `git pull upstream main` 把自己的 main 跟上（不需要立即做，但 Settings → Runtime → GA Version 会一直显示「你已自行升级」直到他 pull）
