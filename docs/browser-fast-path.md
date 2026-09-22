# The fast browser path: a reflex layer that is never a dependency

This note records how routine browser work became cheap without giving a second model any
authority over Shun, and which properties code review should refuse to trade away.

## Two layers, one fallback

```text
Main model (planning, world knowledge, ambiguity, text, verification)
        │
        │  browser_fast(goal, input)
        ▼
BrowserFastExecutor            src/main/browser-fast.ts
        │
        │  one DOM observation              one guarded action
        ▼                                        ▼
fast part of the extension                 the page's own guard
        │                                        │
        └──────────── decision client ───────────┘
                    (Jev over OpenRouter, or nothing at all)
```

The decision layer is reached through `DecisionClient` (`src/main/jev-client.ts`), which
answers typed questions — a yes/no judgment, or a choice with its full distribution — and
never writes prose. `BrowserFastExecutor` does not know what answers it: a local reflex model
is a new `DecisionClient` and nothing else changes.

The fast path is a **side road**, not a replacement:

| | General path | Fast path |
| --- | --- | --- |
| Observation | accessibility tree + visible text (+ screenshot) | one DOM pass: controls, state, text, scroll |
| Identity | `backendDOMNodeId` | an integer the page itself handed out |
| Per step | many round trips | observe, decide, guard-and-act, settle |
| Used when | always | only when a decision credential exists **and** the observation answers |

## The page-side half

`resources/browser-use-extension/fast-path.js` is loaded into the service worker with
`importScripts` and never runs there: its two functions are stringified into expressions the
page evaluates. Two consequences matter.

* **One call per question.** The whole observation — URL, title, viewport, scroll, visible
  text, every actionable control with its role, name, value, state and box, the frame count,
  and a fingerprint — comes back from a single `Runtime.evaluate`. An accessibility walk plus
  a screenshot per step is what it replaces.
* **No identity leaves the page.** The registry hands out small integers; a selector, an XPath,
  or a coordinate is never produced by Shun and never accepted from it. A caller can only name
  an integer the page issued, and the page resolves it.

Filtering is part of the observation, not a later step: only `enabled`, rendered, actionable
controls are enumerated, and password, file and credential-named fields are never enumerated at
all — so nothing a decision can name is a secret. Controls below the fold are enumerated too,
because a goal can name one and the guard scrolls it into view before it is used; they are
listed after the ones already on screen and marked `offscreen`, so a step that needs no
scrolling does not have to read past a page of controls it cannot see. Frames are counted
rather than guessed at — a control inside another frame would be reported at frame-relative
coordinates and clicked at viewport coordinates — so a page whose controls live in cross-origin
frames hands the work to the general path.

## The guard is the safety property

Every action carries the control's identity and goes through the page's own re-check before
anything happens:

connected · still rendered and enabled · same role · same name · same value and state (one
fingerprint over all of it) · brought back into view if it moved · still what a click at its
own centre would reach (`elementFromPoint`).

Anything else is **stale**: nothing is performed, and the loop observes again. Geometry is
deliberately not part of the fingerprint — a page whose own animation nudges a control by a
pixel must not read as a different control, while a page that renamed it must — and the hit
test is where geometry is checked, because that is where a click actually lands.

Two limits bound a page that keeps moving: a stale step spends a step and a decision, and a
few in a row hand the work to the main model.

## Properties that are not negotiable

* **At most once.** A browser action is never retried, anywhere. If what happened after it
  cannot be observed, the run hands back rather than replaying it. A read-only *decision* may
  be retried on backpressure (429/503/529) or a request that never produced a response.
* **No invented inputs.** The fast model cannot invent a selector, a coordinate, a URL, or a
  keystroke, and it never writes text. Values come from the caller through `input`; a field
  that needs a value the caller did not supply is reported back with the field's name.
* **The consequence boundary is deterministic too.** A control whose own name says what it does
  (send, submit, delete, publish, purchase, merge, authorize, …) is refused without
  authorization whatever the decision model concluded about intent. The model's own judgment
  is a second, independent check on controls whose names give nothing away.
* **`completed` is not success.** It means the delegated subgoal looks visibly satisfied. The
  main model — or a deterministic verifier — stays the authority on the task.
* **Absence is not failure.** No decision credential, an old extension build, a page that will
  not answer, a busy service, a stale control: every one of them leaves Browser Use exactly as
  it was. `browser_fast` registers only when acceleration resolves, and `metrics.observation`
  says which observation a run actually used.

## Failure modes and where control goes

| What happened | What Shun does |
| --- | --- |
| No credential, or acceleration off | `browser_fast` is not registered at all |
| Extension build without the fast path | The run falls back to the accessibility path and stays there |
| Decision service busy or unreachable | Retried twice, then the run hands back with an escalation |
| Unreadable or self-contradictory answer | No action is performed; the run escalates |
| Control changed since the observation | Nothing is performed, the loop observes again |
| Page keeps changing under the loop | The main model takes over |
| Controls inside cross-origin frames | The main model takes over |

## Verifying it

Every step writes a trace line — the goal, the state fingerprint, the offered candidates, the
chosen action and its probability, the latency of the decision and of the browser, whether the
page changed, and, for a step that did not act, the reason in the words the run reported. The
file is `<userData>/browser-use/browser-fast-traces.jsonl`, and it is also the corpus a local
reflex model would be trained on, so a step that escalated is worth as much as one that acted.

| What | Where |
| --- | --- |
| Page-side observation, guard, stubbing a real DOM | `src/main/browser-fast-path.test.ts` |
| Extension wiring: one evaluate, no click on a stale control | `src/main/browser-use-extension.test.ts` |
| Bridge: fast observation, guarded action, capability boundary | `src/main/chrome-browser.test.ts` |
| Loop: confidence, staleness, fallback, frames, value requests | `src/main/browser-fast.test.ts` |
| Decision client: retry policy, malformed probabilities | `src/main/jev-client.test.ts` |
| Real Chrome, real clicks | `npm run smoke:browser-fast-live` (add `--accessibility` to compare with the general observation) |

## Deliberately unbuilt

No planning inside the fast path, no vision, no browser world model, no speculative
execution, no long-term browser memory. The fast path picks one offered action at a time and
stops the moment the next step is not obvious. If a task needs reasoning, the main model is
already there.

### 可见性

注入的输入只会到达 Chrome 正在渲染的 tab：后台创建的 tab（`browser_open` 的默认）一出生就是 hidden，发往它的点击和按键会被静默丢弃，调用方只看到「页面从未变化」。扩展在投递输入前会检查一次，必要时把这个 tab 显示出来（只选中 tab，不抢窗口焦点），再做一次；仍然不可见就以 Shun 自己的话拒绝，而不是往空气里发事件。

| 情况 | 行为 |
| --- | --- |
| tab 被渲染 | 正常执行 |
| tab 未被渲染 | 显示它一次 → 再检查 → 成功则执行 |
| 仍然未被渲染 | 拒绝并说明；`blockedSteps` 计数；**只花一次决策**（重看一遍不可能改变关于 tab 的事实） |


## 基准（2026-09-22，真实 Chrome 153，真实 Jev）

`node --experimental-strip-types scripts/browser-fast-live.mjs [--accessibility]`，
同一批目标、同一个模型、同一台机器，只有观测层不同（`--accessibility` 走 accessibility 树）。
`cdp_calls` 是每个会话累计的协议往返次数（每个目标一个新会话）；`state` 是每次决策收到的
state 的输入 token 数。

| 目标 | 动作 dom / a11y | 决策 dom / a11y | CDP 调用 dom | CDP 调用 a11y | state dom | state a11y | wall ms dom / a11y |
| --- | --- | --- | --- | --- | --- | --- | --- |
| github.com/kyleslight/shun（真实页面） | 2 / 2 | 3 / 3 | 46 | 63 | 9309 | 7500 | 2531 / 2447 |
| open-settings | 1 / 1 | 2 / 2 | 20 | 27 | 1794 | 1883 | 1530 / 1536 |
| actions-general | 2 / 2 | 3 / 3 | 44 | 61 | 1793 | 1895 | 1525 / 1519 |
| search-repository | 2 / 2 | 3 / 3 | 67 | 92 | 2230 | 2559 | 1607 / 1570 |
| covered-after-dismiss | 4 / 2 | 3 / 2 | 120 | 143 | 1393 | 1280 | 2041 / 1077 |
| covered-refusal（被遮挡） | 0 / 0 | 3 / 2 | 140 | 165 | 1689 | 1747 | 2380 / 762 |
| covered-recovery | 4 / 4 | 4 / 4 | 182 | 223 | 1751 | 1853 | 2485 / 2397 |
| settings-by-plan | 2 / 2 | 1 / 1 | 206 | 257 | 617 | 729 | 854 / 803 |
| paged-by-plan | 3 / 3 | 3 / 3 | 239 | 303 | 589 | 679 | 1722 / 1705 |
| sustained-keyboard | 10 / 10 | 5 / 5 | 336 | 394 | 1746 | 1910 | 4097 / 3994 |

读法：

* **成功率两边一样**（10/10，真实页面上也都 completed），动作与决策数逐条相同——观测层
  的替换没有改变决策模型的选择。
* **协议往返少约 25–29%**（点击/输入类目标：open-settings 20→27、search-repository 67→92、
  github 46→63……），这是确定性的结构差异，也是这次改动真正可度量的收益。
* **墙上时间没有可测的差别**：一步约 1.3–2.5s，其中 ~400ms 是决策、~200ms 是稳定等待，
  观测层只占其中一小部分。观测层是二阶项，一阶项是决策延迟。
* **state 体积不是一边倒**：小页面上 DOM 观测小 5–12%，但在控件密集的真实页面上
  （github）反而大 24%（9309 vs 7500 token）——DOM 枚举把每一个可交互控件都列出来，
  而 accessibility 那一侧只保留有语义角色的节点。这是已知的、待收紧的地方。
* **键盘场景两者持平**（sustained-keyboard：336 vs 394 次调用，10 个动作）。

复跑方式：`OPENROUTER_API_KEY=... node --experimental-strip-types scripts/browser-fast-live.mjs [--accessibility]`。

## 基准发现并修掉的三处

1. **指纹漏掉等长文本变化**（本轮引入的回归，通用路径本来是对的）：指纹曾只带文本长度，于是计数器、价格、比分、状态行这类「变了但长度不变」的页面被读成「什么都没变」，循环在有进展时交回。现在同时哈希前 400 字符，与通用路径一致。
2. **Shun 自己的指针会让通用路径假拒绝**：落地检查的命中测试会命中 Shun 画的覆盖层（`pointer-events: none`，真实点击会穿透——实测指针停在按钮上时连点两次页面计数到 2）。命中测试现在忽略自己画的覆盖层，不再拒绝「它刚刚指过的那个控件」。
3. **控件密集的真实页面上 state 偏大**（github 上 9309 vs accessibility 的 7500 token）：名字从 160 收到 120，并且只有元素很少的控件才用文本作为名字——卡片式控件不再把它整段文字当成链接的名字。

### 修复后复测（真实 Chrome 153 + 真实 Jev）

github.com/kyleslight/shun，「Open the Issues tab of this repository.」：

| | 修复前 | 修复后 | accessibility 对照 |
| --- | --- | --- | --- |
| state（token/决策） | 9309 | **8148**（−12.5%） | 7500 |
| CDP 往返（整个目标） | 46 | **37–40** | 63–64 |
| 浏览器侧 p50 | 271–348ms | 256–265ms | 292–302ms |
| 任务结果 | 到达 /issues | 到达 /issues | 到达 /issues |

state 差额的来源是这次为「折叠线以下」加的两处标注（每个候选描述的后缀、每个元素行的
offscreen 标志），收紧后与 accessibility 侧只差 8.6%。这是**卫生**层面的修复，不是性能收益：
这两轮里决策 p50 反而在 1078–1271ms（服务本身波动很大，同一目标在不同轮次从 420ms 到 1450ms）。

另外两次复测里循环在一次点击后停下（`escalate`，但页面已经到达 /issues，`--expect` 校验通过），
修复前同样的目标会再点一次才停。这是完成判断本身的噪声，不能归因于 state 变小。

## tab 可见性：一条不能绕过的 Chrome 规则

注入的输入（点击、按键、滚轮）只会到达 **Chrome 正在显示的 tab**。这不是 Shun 的策略，而是 Chrome 的行为：

| tab 的来源 | `visibilityState` | 输入是否到达 |
| --- | --- | --- |
| `active:true` 创建（在前台打开过） | `visible` | ✅ 到达 |
| 同上，之后被别的 tab 取代选中 | `visible` | ✅ 仍然到达 |
| `active:false` 创建（从未显示过） | `hidden` | ❌ 一个事件都不到 |
| 后台被 `tabs.update({active:true})` 补救 | 只有窗口被聚焦时才生效 | 时好时坏 |

由此三条产品行为：

1. **`browser_open` 默认在前台打开**：一个要被驱动的 tab 必须先被显示过一次；这一次显示换来之后长期可驱动。
2. **`browser_show`**：claim 来的老 tab、或任何报告自己隐藏的 tab，可以显式显示一次而不必退出任何东西。
3. **诚实拒绝**：动作前发现 tab 未被渲染，就停下并以 Shun 自己的话说明，且**只花一次决策**——重看一遍不可能改变关于 tab 的事实。修复前这里会静默无效，然后循环报告「页面没有变化」。

## 重启之后：桥在，但没人连

服务重启后桥是通的，而扩展的 service worker 已休眠——而扩展只能被**浏览器事件**唤醒，不能被 WebSocket 消息唤醒。原先只有「UI 查询插件连接状态」会去戳它，于是「重启 Shun → 让它用浏览器」会得到一句 `Chrome Browser Use is not connected`，而没有任何东西去叫醒它。

现在：**任何浏览器调用在发现无人连接时，自己戳一次 Chrome**（后台打开那个循环地址，不抢焦点；由 `wakeChromeBrowserUse` 的 15 秒限流保护），再等最多 8 秒让 worker 醒来重连，然后继续原本的调用。叫不醒时仍然是同一句明确的话。

这条是实测出来的：重启后 `browser_open` 直接报未连接，而插件页没被打开过。
