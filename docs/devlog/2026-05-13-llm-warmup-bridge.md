# LLM warmup bridge · 启动时自动刷新模型列表

**Date**: 2026-05-13
**Status**: ✅ 实施完成 · 待用户重启后 dogfood 验证
**Related**:
- 受影响文件：[useAppStore.ts](../../desktop/src/stores/useAppStore.ts)
- 复用 IPC 协议 + bridge spawn 基础设施，不改 IPC 契约

## Context

作者报告 bug：「修改 mykey.py 加新模型后重启 Workbench，**New Chat 的 LLM picker 看不到新模型**；但点进任意已有 session 之后，新模型就出现了。」

排查流程：

```
mykey.py（用户编辑）
  ──读取──▶ bridge 的 list_llms()
                │
                ▼
              ready event 含 availableLLMs
                │
                ▼
              desktop replaceLLMs(sessionId, llms)
                │
                ├─▶ runtime._runtimes[sessionId].llms 更新
                ├─▶ active session → state.llms 同步（projection）
                └─▶ 写入 prefs["llm_list"] 缓存

冷启动: hydrateFromDB() ──读 prefs──▶ state.llms = 上次缓存的列表
```

**关键约束**：bridge 是 lazy spawn 的，只有用户激活某个 session 才会启动。冷启动 → 还没激活任何 session → 没 bridge ready → state.llms 永远是 hydrate 时从 prefs 拿的**旧缓存**。点 New Chat 看到旧列表，点已有 session 才会触发 spawn → 新列表。

## Decisions

### 方案选择 · 启动时跑「warmup bridge」（讨论里的方案 A）

App 启动 hydrate 完成后，自动 spawn 一个**专门用于 list_llms** 的临时 bridge：

- 用特殊 sessionId `__warmup__`（不进 sidebar、不占 LRU 名额）
- 拿到 ready 事件 → 提取 availableLLMs → 写 `state.llms` + `prefs["llm_list"]` cache
- 立即 `shutdown` 该 bridge，不占资源
- 全程 ~2-3s 后台跑，不阻塞 UI

副作用解决两个痛点：

1. **冷启动后 EmptyState 的 LLM picker 立刻是新列表** —— 用户无感
2. 切换 gaConfig（比如指向另一个 GA 安装）时也自动重新跑一次 warmup

### 实施

**新增 store state**: `_warmupComplete: boolean`（dedupe 多次触发）

**新增 store action**: `warmupLLMList(): Promise<void>`

```python (伪代码)
async warmupLLMList():
  if _warmupComplete: return
  if !gaConfig.gaPath: return  # 预 onboarding 跳过
  set _warmupComplete = true   # 早设置防 re-entry

  client = await spawnBridgeProcess(
    { ...gaConfig, sessionId: "__warmup__" },
    { onEvent: 只处理 ready，提取 LLMs，写 state + cache，shutdown bridge }
  )
  setTimeout(15s, force shutdown if ready never came)
```

**两处触发点**：

1. `hydrateFromDB()` 末尾 → 冷启动后跑一次
2. `setGAConfig()` 改 gaPath/python/bridgeCwd 后 → 重置 `_warmupComplete` 并重跑一次

### Race condition 防护

`spawnBridgeProcess` 的 stdout listener 在 `command.spawn()` await **之前**就装好了。理论上 ready 事件可能在 client 变量赋值之前触发 → onEvent 里 client 还是 null。代码用 `pendingShutdown` flag 处理 deferred shutdown：

```ts
if (client) {
  void client.shutdown(5000);
} else {
  pendingShutdown = true;
}

// ... spawnBridgeProcess returns ...
client = await spawnBridgeProcess(...);
if (pendingShutdown) void client.shutdown(5000);
```

### 失败兜底

15s timeout：万一 ready 永不到（bad gaPath / mykey.py 语法错），自动 shutdown 子进程避免泄漏。`_warmupComplete` 保持 true，不会无限重试本次 app 实例 —— 用户重启 / 改 gaConfig 才会再触发。

## Rejected alternatives

讨论中考虑过 4 个方案：

**B · 用户点 LLM picker 时再 lazy 刷新**
否决理由：用户点开 picker 那一刻会有 2-3s spawn 等待时间，UX 不如 A 的「无感后台跑」。

**C · 加一个「刷新模型列表」按钮**
否决理由：需要用户发现 + 主动点。「我刚改了 mykey.py 凭什么还要手动刷新」是合理用户疑问；让 desktop 主动同步比让用户负责更对。

**D · 启动时跑独立 Python helper 脚本（绕开 bridge）**
否决理由：要写并维护一个跟 bridge 平行的 Python 入口。复用现有 bridge 基础设施成本更低，不增加技术债。

## Open questions

- **15s timeout 太长还是太短**？冷启动正常 ~2-3s，warmup spawn 在那之上再加 ~1-2s。15s 给了 ~3x 的余量，应该足够。如果用户反馈 timeout 太频繁触发，再调短。
- **warmup 期间用户活动怎么办**？如果用户在 warmup 跑的几秒内激活了已有 session，会同时有 2 个 bridge 子进程（warmup + 真 session）。两者不冲突（都只是 read mykey.py + emit ready），稍微多消耗。可以接受。
- **是否需要 UI feedback** 显示 warmup 进行中？目前完全静默。如果用户反馈「为什么 LLM 列表偶尔慢一点」可以加个小指示。当前选静默是因为 99% 情况下用户根本不会注意到。

## Next

- ✅ Commit + push
- ⏳ 用户重启 Workbench 验证：改 mykey.py 加模型 → 重启 → New Chat 的 picker 立刻看到新模型
- ⏳ DevTools console 看 `[warmup]` 日志确认它跑了
