# 「目标」子页 —— Goal-Driven Delivery

LuzzyPage 的第四个子页。它回答一个长任务里必须能回答的问题：

> 我要完成什么？什么条件满足才算完成？做到哪了？卡在哪？下一步是什么？凭什么说完成了？

## 一、它解决的是什么问题

DSH 已经有一个 goal：`ctx.goals` 持有每个会话的一个持久目标，带修订号、阶段与轮次预算。它**没有**验收标准、任务、证据、决策、当前焦点、下一步行动——而这些恰好是决定「完成了」这句话真不真的东西。

所以这个子页不是重写 DSH 的 Goal，而是给它加一层**交付计划**：

```
DSH 运行时 goal（objective / phase / revision / 轮次）
        +
交付计划覆盖层（验收标准 / 任务 / 证据 / 焦点 / 下一步 / 阻塞 / 决策）
        ↓
   一个页面 + 一份 goal.md + 一个完成门
```

两层在读取时汇合，各管各的：**运行时 goal 永远是权威**，覆盖层只补 DSH 没有的字段。

## 二、状态住在哪

| 状态 | 住哪 | 谁写 | 为什么 |
|---|---|---|---|
| 运行时 goal | 会话日志（`goal/change` 事件） | `dsh-goal`，通过 `update_goal` / `/goal` | 已有能力，不动 |
| 交付计划 | `$DSH_HOME/luzzy-goal/<sessionId>.json` | 这个插件 | DSH 没有字段存它 |
| `goal.md` | 会话工作目录下的 `.agent/goal.md` | 这个插件，**需用户开启** | 给人、给 git、给外部工具看的投影 |

**计划按会话分文件。** 会话 resume 后找得到自己的计划（这是 AC-009）；fork 不会继承——`dsh-agent` 给 fork 新会话 id，而一个 fork 不该自己复活旧目标。

## 三、三个不变量

### 1. 完成必须挣来

`update_goal(action=complete)` 在**到达 `ctx.goals` 之前**被拦下：

```
模型 → tools/pre-execute → [完成门] → ctx.goals.complete()
```

`tools/pre-execute` 在工具体之前运行，所以被拒的 `complete` **从未执行**——目标保持 active，拒绝理由作为那次调用的错误结果进入模型的上下文。

门的判据是**可判定**的：必须的验收标准全部 `verified`、每条都有存在的证据、没有未完成的必做任务、没有未解决的阻塞。至于「目标本身是否真的达成」——那是模型的判断，门不假装自己做得了这件事。

**Fail-closed。** 计划读不出来时，完成被拒绝而不是放行。「我没法检查」绝不能等于「放行」。

### 2. Agent 不能改写人类权威字段

`objective` / `scope` / 约束 / 必须满足的验收标准，Agent 只能**提议**：

```
Agent 调 proposeScope → 记一条提案 → 返回 GOAL_HUMAN_CONFIRMATION_REQUIRED
用户在页面上点「采纳」 → 才真的改
```

这不是一句承诺，是结构：`applyDeliveryOp`（Agent 可用的全部操作）与 `applyHumanOp`（人类操作）是**两个函数**，`adoptProposal` 只在前者里出现。没有代码路径能从 Agent 的调用走进那条分支，所以以后改代码也不会忘掉这个守卫。

### 3. 写入是 compare-and-set

每份计划带自己的 `revision`。写的时候必须带**读到的那个修订号**，对不上就拒绝并返回当前状态——输的那一方展示真相，而不是猜。

## 四、Agent 怎么用

新增一个工具 `goal_delivery`，与 `update_goal` **互补**：

| 工具 | 管什么 |
|---|---|
| `update_goal` | 运行时 goal：目标文本、阶段、轮次上限（DSH 的领域） |
| `goal_delivery` | 计划：验收标准、任务、证据、焦点、下一步、阻塞、决策 |

为什么是两个而不是给它加参数：`update_goal` 的 schema 每层 `additionalProperties: false`，参数在函数体之前校验；而 `tools/post-execute` 只能改写**结果**、不能改写**参数**，`tools/pre-execute` 又明确禁止改写 `exec.arguments`（那会让日志里的调用与实际执行的不一致）。所以计划有自己的工具，`update_goal` 保持原意。

`get_goal` 的结果被追加一个紧凑的 `delivery` 块——一次调用就能恢复工作状态，而不是让模型再问一次：

```json
{ "goal": { ... }, "activation": "armed",
  "delivery": {
    "health": "healthy",
    "acceptance": { "total": 6, "verified": 4, "pending": 2, "mandatory": 5 },
    "tasks": { "total": 12, "completed": 7, "active": 1, "blocked": 0 },
    "current_focus": "完成 Dashboard API 接入并验证三种状态",
    "next_action": ["接入 /api/tasks", "运行测试"],
    "artifact": { "path": ".agent/goal.md" },
    "can_complete": false,
    "completion_blocked_by": ["AC-004", "AC-006"]
  } }
```

用 `content` 而不是 `value` 替换：`value` 会拿 `get_goal` 自己的 schema 重新校验，而那个 schema 是 `additionalProperties: false`，多出来的块会被拒。

## 五、生命周期钩子——以及它们为什么长这样

四条来自 DSH 源码的事实决定了这里的形状，每一条都与直觉相反：

**① `agent/turn-stopping` 的返回值被丢弃。** `dsh-agent-loop` 调 `await this.dispatch.serial('agent/turn-stopping', …)` 然后**从不赋值**。唯一能让一轮继续的是往下一步收件箱里放东西——所以「提交屏障」是 `agent.steer(...)`，不是一个返回值。写成返回值会编译、会运行、什么也不做。

**② `agent/inject()` 不会唤醒驱动器。** 空闲 agent 上的注入会一直等别的唤醒。所以需要被注意到的东西一律 `steer`。

**③ 归因必须是 plugin。** `{ kind: 'user' }` 会清掉 job 的唤醒预算、重置重复提醒链。所以注入的消息带 `{ kind: 'plugin', plugin: 'dsh-luzzy-page' }`。

**④ 取消的那一轮不能被要求对账。** 循环在 turn-stopping 派发**之后**立刻 `throwIfAborted()`。所以在这一刻 steer 不只是没用——abort 会展开，steer 的消息留在 `next-step`，下一次机会被排干：模型被告知去对账一个被取消的轮次，而会话为此花掉了八次对账额度里的一次。两条钩子都在 `signal.aborted === true` 时直接返回。

于是四条钩子：

| 钩子 | 事件 | 作用 |
|---|---|---|
| 方向注入（preflight） | `agent/pre-step` | 每个有 goal 的轮次开头注入**紧凑**状态块（~740 字节） |
| 完成门 | `tools/pre-execute` | 拦下过早的 `complete`；**fail-closed** |
| 对账屏障 | `agent/turn-stopping` | 本轮真的动了工作区而计划没动时 steer 一次 |
| 结果增强 | `tools/post-execute` | `get_goal` 追加紧凑 delivery 块 |

两条独立的限流防止屏障变成循环——每轮最多一次、每会话最多 8 次。
### AC-001：长期任务该有目标，但「是不是长期任务」只有模型能判

方案书 §6 要求 harness 判断当前请求是否属于长期目标并建目标，而 §39 把「是否属于长期任务」明确放在**模型判断**那一列，不是确定性那一列。两者合起来是：

- **harness 提供确定性的一半** —— 会话日志显示**真的在做改动**（`observeTurn` 看到 mutating 工具）
- **模型做语义判断** —— 这算不算一个需要跨多轮、可恢复的长期目标

所以**这条路径不建目标**，它告诉模型「有真工作在跑、但没有目标」并请它自己判断。自动建会更糟：§6 点名「你好」「帮我解释一下 Promise」**不能**有目标，而一条只看工具调用的规则分不出它和一次重构。

**每会话只提示一次** —— 每步都提就是 §83 说的 token 浪费，而且模型第一次拒绝有它的理由。

### preflight 为什么是紧凑块而不是 artifact

方案书同时要求两件看起来矛盾的事，读全了就不矛盾：

| 出处 | 要求 |
|---|---|
| §10 / §46 | substantial turn 必须**观察** goal 状态才能开始工作 |
| §82 / §83 | 「Do not inject full goal artifact every turn」；orientation 保持 **small fixed overhead** |
| §68 方案 B | 被禁的是每轮把整份 Markdown 塞进 context |

**调和点**：观察是**必须且便宜**的（一个 ~740 字节的块），artifact 才是那个绝不能每轮注入的东西。模型需要完整文档时自己读 `goal.md`；它不该为这件事每轮付费。

**§13 定了「每轮」的含义**：trivial turn（「继续」）仍然必须 READ，只是不必 WRITE。所以 preflight 在**每个有 goal 的轮次**都会发生，成本由**步数间隔**控制（`preflightEverySteps`，默认 6），而不是靠跳过轮次。一个 12 步的长轮次注入 2–3 次，不是 12 次。

**读不出来时不阻塞**：preflight 读不到计划记为 miss 并跳过注入——门才是 fail-closed 的那一面，而拒绝一个模型本来可以做事的步骤是错的取舍。（对比 `tools/pre-execute`：那里读不出来**必须**拒绝。）

## 六、页面长什么样

优先是**概览**，不是 Markdown 编辑器：

- **目标** —— 目标文本、阶段、修订、轮次、健康度（离散状态，不是百分制分数）、四项计数
- **变更提案** —— 待确认的提议，带「采纳 / 不采纳」
- **验收标准 / 任务 / 证据** —— 两列，窄屏折成一列
- **焦点与下一步** —— 当前唯一该关注的事，与可执行的下一步
- **风险与阻塞 / 范围与约束 / 决策记录 / 完整性检查**
- **goal.md** —— 开启开关、立即写入、与状态是否一致
- **goal.md 原文** —— 高级视图，读的是磁盘上的字节

**状态永远带文字。** 每个状态徽标 = 颜色 + 内联 SVG 图标 + 一个词。只说颜色的状态对色盲读者不可读，而且违反设计规则。

页面**从不写运行时 goal**。采纳一个关于目标的提案只更新覆盖层里的镜像并记录决策——运行时的那一处仍要用户通过 `/goal` 改，页面就是这么说的，不假装已经改了。

## 七、goal.md 是投影，不是第二个数据库

```
交付状态 → renderGoalMarkdown() → .agent/goal.md
```

- **确定性**：同一份状态渲染出逐字节相同的结果（时间戳从记录里取，不读 `Date.now()`）。所以内容没变就**不重写**——否则每次打开页面都改 mtime，把一次空操作变成 git 里的改动。
- **落点来自会话头**，永远不来自请求体。请求体给路径等于让一个渲染器有权在磁盘任意位置写文件。
- **需要开启**。自动往别人的仓库里写文件是「先问再做」。

## 八、错误码

调用方按码分支，从不按消息分支（消息是给人看的，会变）：

```
GOAL_NOT_FOUND                  GOAL_STALE_REVISION
GOAL_COMPLETION_REJECTED        GOAL_MISSING_ACCEPTANCE
GOAL_MISSING_EVIDENCE           GOAL_SCOPE_VIOLATION
GOAL_INVALID_STATE              GOAL_RECONCILIATION_REQUIRED
GOAL_DRIFT_DETECTED             GOAL_AUTHORITY_REQUIRED
GOAL_HUMAN_CONFIRMATION_REQUIRED  GOAL_RUNTIME_UNAVAILABLE
```

## 九、路由

```
GET  /__luzzy/goal?sessionId=<id>[&artifact=1]   → 运行时 goal + 计划 + 完整性 + 漂移 + 产物状态
POST /__luzzy/goal                               → 一次改动，然后把整份状态返回
```

POST 返回**整份状态**：每次改动都会让客户端的副本不可信，返回全量意味着页面永远不会画出磁盘上从未存在过的组合。409 / 422 也带快照——输的一方展示真相。

```
400  客户端 bug（未知操作、请求体不是 JSON）
403  非 loopback 调用者
405  动词不对
409  计划读不出来（损坏 / 版本不认识）
413  请求体过大（排空而不是摧毁，否则客户端拿到 ECONNRESET 而不是理由）
422  部署拒绝（非人类权威字段、缺工作目录、采纳一个不存在的提案）
```

`sessionId` 缺失时回退到**有 goal 的最新会话**——iframe 拿不到自己的 session id 时，这比空白页有用。

## 十、文件

```
lib/
├── goal-domain.mjs    纯函数：规范化 / 完整性 / 完成门 / 漂移 / 健康度 / 变更 / Markdown
├── goal-store.mjs     CAS 持久化、原子写、goal.md 投影、开启标志
├── goal-enforce.mjs   四条生命周期钩子 + get_goal 增强 + 服务探测
├── goal-tools.mjs     goal_delivery 工具
└── goal-routes.mjs    /__luzzy/goal 的 GET/POST

tools/
├── test-goal-domain.mjs   纯逻辑（119）
├── test-goal-store.mjs    CAS / 原子写 / 投影 / 标志 / 可读性区分（77）
├── test-goal-enforce.mjs  四条钩子：完成门 / preflight / 屏障 / 增强（105）
├── test-goal-routes.mjs   真实 HTTP 契约（83）
├── test-goal-stress.mjs   边界载荷：取消 / 敌意会话 / 修订竞态 / fail-closed 穷举（37）
├── test-goal-lifecycle.mjs 真实 Session：compaction / resume / fork / 卸载（31）
├── probe-goal-layout.mjs  真实浏览器里量各视口的横向溢出
└── shoot-goal-tab.mjs     两个主题 + 真实 420px 的截图，比 sha
```

## 十一、验证

```
node tools/test-goal-domain.mjs
node tools/test-goal-store.mjs
node tools/test-goal-enforce.mjs
node tools/test-goal-routes.mjs
node tools/test-goal-stress.mjs      # 取消 / 敌意会话 / 竞态 / fail-closed 穷举
node tools/test-goal-lifecycle.mjs   # 真实 Session：compaction / resume / fork / 卸载
node tools/probe-goal-layout.mjs     # 真实浏览器，三个视口
node tools/shoot-goal-tab.mjs        # 两主题 + 窄屏，sha 必须互不相同
```

截图在 `docs/shots/goal-tab-*.png`。

### 明确未覆盖的（写在测试输出里，不是藏着）

**已覆盖**：`test-goal-lifecycle.mjs` 构造**真实的 `Session`**（从 DSH 安装里加载 `@deepseek-ai/dsh-session`）并追加真实事件，所以 compaction / resume / fork / 插件卸载这四条是对着真货验的，不是替身。它同时断言**四个钩子在卸载后全部移除**——孤儿监听器会在插件已经不在的情况下继续对账轮次，那是方案书 §78 点名的失败形状。钩子名收在 `HOOK_NAMES` 里，所以以后加钩子不可能绕过这条断言。

**仍未覆盖**：与 `dsh-goal-round-driver` 的集成（AC-012）只有源码级断言。「交付层从不调 `followup`」是**能做什么**的证明，不是**跑起来会怎样**的证明——它需要真实 DSH 会话加挂载 driver。

**一个声称覆盖了它从未跑过的场景的测试，比没有测试更糟**——它让那个问题被**退役**了。所以缺口是被说出来的，不是被略过的。清单见 `docs/STATUS-LuzzyPage工作节点.md` §二十二「还没做」。
