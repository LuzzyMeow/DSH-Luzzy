# frontend-v2-analysis · LuzzyPage 现状分析与重构范围

> 本文件是**动手改代码之前**的现状报告。所有数字与结论都来自实读，不是估计。
> 读取对象：`luzzy-page/src/client.js`（4274 行 / 229,463 字节）、`luzzy-page/lib/**`（宿主半）、
> `luzzy-page/tools/**`（41 个脚本）、`package.json`、`cordis.patch.yml`、
> `docs/STATUS-LuzzyPage工作节点.md`、`docs/05-前端技术栈与客户端插件机制.md`。
> 实测时间：2026-09-23。基线测试结果见 §六。

---

## 一、当前页面结构

### 1.1 一次渲染的完整链路

```
DSH 主界面（Electron + Vite/React SPA）
  └─ 右侧栏 conversation.view 插槽（list 类型，与「对话」「轨迹」并列）
       └─ 本插件注册的条目 id=luzzy-page，order=100
            └─ <iframe srcDoc={FRAME_DOCUMENT} className="luzzy-page-frame">
                 ├─ 帧文档 = 一个大模板字符串，含 <style> + <body> + <script>
                 ├─ 帧内 = 纯 HTML + 原生 JS，零 React / 零 hooks / 零框架注入
                 └─ 数据来自宿主路由： fetch('/__luzzy/…')
```

**iframe 是第三代架构，也是唯一能用的一代。** 前两代（React 组件带 hooks、hooks-free +
store share）都是整页白屏，根因记在 `AGENTS.md` §5.1：

| 代 | 做法 | 结果 | 根因 |
|---|---|---|---|
| 一 | 组件里 `require('react')` 后调 hooks | 白屏 | 宿主渲染器用它**自己 bundle 内联的 React**，静态模块表里的 `react` 是另一份 → React #321 → SlotErrorBoundary 换成空 div |
| 二 | hooks-free 组件 + `defineStore` store share | 白屏 | `conversation.view` 的 props 里**没有** `useStore`（实测 `TypeError: useStore is not a function`） |
| 三 | **插槽条目渲染一个 `<iframe>`** | ✅ | 帧内是独立文档，宿主 React 内部结构碰不到它 |

**一条硬约束由此而来**：`conversation.view` 的 render 调用只传 `viewRequest` /
`openView` / `completeViewRequest`，**没有 `t`**。往组件签名里解构 `t` 就是白屏。

### 1.2 当前四个子页

帧内有四个 tab，由一个 `data-tab` 属性集合驱动：

| tab | 中文名 | 渲染函数 | 数据来源 | 行数（约） |
|---|---|---|---|---|
| `readme` | 说明 | `render()` 内联分支 | `GET /__luzzy/readme` | 30 |
| `usage` | 用量 | `render()` 主体 | `GET /__luzzy/usage` | 500 |
| `preset` | 预设 | `renderPreset()` | `GET/POST /__luzzy/preset` | 1600 |
| `goal` | 目标 | `renderGoal()` | `GET/POST /__luzzy/goal` | 580 |

四个页面**共享一套顶部 tab 栏**（`.tabs.topbar` + `.segment[role=tablist]`），
下面是一个 `.scroll > .column#content` 容器，`render()` 按 `state.tab` 分派。

### 1.3 数据获取方式

**全部是帧内直接 `fetch` 同源相对路径**，宿主半注册 `ctx.webServer.register({kind:'exact', …})`。
这条路径**已验证可达**（帧内上报为证），且是本机唯一通路：

- 桌面版默认 `ordinaryBrowserEnabled = false`，无凭据的浏览器请求一律 403。
- 凭据是**每次启动随机生成的 token**，校验 `x-dsh-desktop-renderer` 头，由 Electron 自动注入。
- **推论**：从进程外探测宿主路由永远拿不到有效信号（带不带对错 token 都只是 403）。

现有路由一览（**本次重构要原样保留**）：

| 方法 | 路径 | 文件 | 返回 |
|---|---|---|---|
| GET | `/__luzzy/usage` | `lib/index.js` | totals + models + 三个窗口 + 活动阵列 |
| GET | `/__luzzy/readme` | `lib/index.js` | 插件 README 文本 |
| POST | `/__luzzy/diag` | `lib/index.js` | 帧内黑匣子上报 |
| GET/POST | `/__luzzy/preset` | `lib/preset-routes.mjs` | 预设名单 / 提示词 / 会话事实 |
| GET/POST | `/__luzzy/goal` | `lib/goal-routes.mjs` | 运行时 goal + 交付计划 + 完整性 + 漂移 + 产物 |

### 1.4 CSS 注入方式（两套机制，必须分清）

**(A) 父文档侧**：`injectStyles()` 往宿主 `document.head` 插一个
`<style data-plugin-css="luzzy-page">`，内容只有 `FRAME_CSS` 两个规则（给 iframe 高度）。
**它不含任何设计 token。**

**(B) 帧文档侧**：帧自己定义两套 token（`:root` 与 `:root[data-theme='dark']`），
因为 **iframe 是独立文档，CSS 自定义属性不跨文档继承**。父组件把当前主题**烘焙进文档**，
再用 MutationObserver 跟随切换。

> **这条踩过**：帧内曾写 38 处 `var(--dsw-*)`、**0 处定义**，全部静默回退到硬编码兜底值，
> 暗色模式下整页仍是浅色，且不报任何错。

**帧内 token 名必须在 DSH 前端 CSS 里真实存在。** 实测已修的：`--dsw-alias-bg-skeleton`
是**凭空写的**（DSH 里根本没有）；`--dsw-alias-label-{error,warning,success}` 三个也都不存在
（实测计数 0）。真实存在的是 `--dsw-alias-state-{success,warn,error,business}-primary`。

### 1.5 主题跟随

| 环节 | 机制 |
|---|---|
| 读主题 | 父组件 `readTheme()`：`<html data-theme>` → `class="dark"` → `prefers-color-scheme` |
| 烘焙 | 帧文档**只构建一次**（`FRAME_DOCUMENT` 模块级常量），主题不进字符串 |
| 运行期切换 | `followTheme(ctx)` 用 MutationObserver + document `load` + matchMedia 三条监听，把 `data-theme` 写到**帧的 documentElement** |

> `srcDoc` **必须是稳定值**：曾写成 `buildFrameDocument(FONT_FACE_CSS, theme)`，每次渲染
> 新建 394 KB 字符串，React 按值比较即判定为新文档 → **重载 iframe** → 正在跑的 fetch 作废。
> 黑匣子证据是 `frame-boot` 出现**两次**，症状是永远停在「正在统计用量…」。

---

## 二、当前组件结构

### 2.1 `src/client.js` 的分层实况

文件是**两级嵌套**：外层是给 DSH 模块加载器的 bundle（`window.__ModuleLoader__.load({...})`），
内层是帧文档的模板字符串。两级的代码风格与作用域完全不同：

```
src/client.js
├─ 外层（约 640 行）
│   ├─ ping() / readTheme() / LuzzyPage(props) / injectStyles()
│   ├─ FRAME_CSS、FRAME_DOCUMENT、FRAME_LENGTH
│   ├─ followTheme(ctx) / followSession(ctx)
│   ├─ createSessionForFrame(source, request)   ← 客户端建会话（必须在这一半）
│   ├─ presetPostViaHost(sessionId) / apply(ctx)
│   └─ 常量 NS / zh / en 字典
└─ 内层帧文档（约 3630 行，全在一个模板字符串里）
    ├─ <style> 约 900 行 CSS
    ├─ <script> 约 2700 行原生 JS
    └─ body 结构：topbar（tab 栏）+ .scroll > .column#content + goalNoticeBar
```

### 2.2 帧内 107 个顶层声明的分组

| 组 | 数量 | 代表 |
|---|---|---|
| 黑匣子 | 3 | `report()`、error/unhandledrejection 监听、`frame-boot` |
| 通用格式化 | 7 | `esc` `formatTokens` `formatExact` `formatStamp` `niceMax` `levelOf` `COLORS` |
| Markdown 渲染 + 序列化 | 3 | `renderMarkdown` `serializeMarkdown` `paintMarkdown` |
| 图表 | 7 | `CHART` `smoothPath` `trendChart` `chartTipHtml` `wireChartHover` `activityGrid` `modelDonut` |
| 状态与分派 | 5 | `state` `render()` `statusBlock` `metricsCard` `loadUsage` |
| 预设子页 | 48 | `renderPreset` `editorHtml` `applyMarkdownTool` `MD_ICONS` `MD_GROUPS` … |
| 目标子页 | 24 | `goal*Card` ×12、`renderGoal` `wireGoal` `loadGoal` `goalPost` |
| 帧内对话框 | 6 | `showDialog` `showMessage` `showConfirm` `showPrompt` `dialogLine` |
| 会话握手 | 3 | `askForSession` `message` 监听、`sessionId` |

### 2.3 组件复用的实况：**没有组件层**

所有"卡片"都是**返回 HTML 字符串的函数**，靠字符串拼接组合：

```js
function goalSection(title, body, count) {
  return '<section class="card"><div class="cardHead"><h3>' + esc(title) + '</h3>' + … + '</div>' + body + '</section>'
}
```

**后果**（这是本次重构要解决的核心问题）：

| 症状 | 具体表现 |
|---|---|
| 同一个概念有多个实现 | 「卡片」至少有 `.card` 手写、`goalSection`、metricsCard 三种写法 |
| 状态展示不统一 | 目标页有 `chip(state,label)`（颜色+图标+文字），预设页另有一套 `.saveState[data-kind]`，用量页又是 `.callout[data-kind]`；三套各自定义颜色 |
| 空状态散落 | `emptyLine()` 只服务目标页；用量页是 `statusBlock()`；预设页是内联文字；**没有统一空状态组件** |
| 间距字号各写各的 | 21.7 节的收敛记了「字号 28 处、圆角 7 处、间距 32 处」→ 收到 14→5 种字号；但**没有 token 层**，靠人肉维持 |
| 页面逻辑与数据解析混在一起 | `renderGoal()` 直接读 `snapshot.delivery.acceptance[].status` 等**后端原始字段**，状态到文案的映射（`GOAL_STATUS_CHIP`）就在渲染函数旁边 |

### 2.4 宿主半结构（本次**不动**）

```
lib/index.js            宿主半入口：usage / readme / diag 路由 + 预热 + 装配
lib/usage-*.mjs         用量：聚合门面 / worker / 纯核 / 窗口 / 缓存
lib/preset-*.mjs        预设：store / ops / routes
lib/goal-*.mjs          目标：domain / store / enforce / tools / routes
```

---

## 三、存在问题

按严重性排序，每条都指明**证据**与**后果**。

### P0 · 架构类

| # | 问题 | 证据 | 后果 |
|---|---|---|---|
| 1 | **单文件 4274 行** | `src/client.js` 实测 4274 行 / 229 KB | 任何改动都要在一个含 900 行 CSS + 2700 行 JS 的模板字符串里定位；改一行要看全局 |
| 2 | **HTML / CSS / JS 三层混在一个模板字符串里** | `buildFrameDocument()` 返回巨型字符串 | 反引号与转义序列是**地雷**：累计踩了 8 次反引号、3 次转义，每次都表现为**空白帧**且报错位置远离真凶 |
| 3 | **没有组件层** | 卡片/状态/空状态各有 2–3 套实现 | 同一个状态在三个页面长得不一样；新增页面必然再造一套 |
| 4 | **页面直接消费后端字段** | `renderGoal()` 读 `snapshot.delivery.*` | 后端字段一变，所有页面都要改；无法对页面做数据层替换测试 |

### P1 · 一致性类

| # | 问题 | 证据 | 后果 |
|---|---|---|---|
| 5 | **三套状态色各自定义** | `.chip[data-state]` / `.saveState[data-kind]` / `.callout[data-kind]` | 状态语义不统一；暗色下曾整片失效 |
| 6 | **没有间距/字号 token 层** | 21.6 是"收敛到 5 种字号"，靠断言白名单守 | 白名单是**事后检查**，不是事前供给；新代码想加字号没有约束来源 |
| 7 | **空状态没有统一形态** | `emptyLine` / `statusBlock` / 内联文字 | 「暂无记录」在不同页面长得不同，且有的页面**直接空白** |
| 8 | **中英文混排** | tab 名是中文，但 `goalRawCard` 标 `Markdown`、`artifact` 区出现 `goal.md`、错误里出现 `HTTP 404` | 不是错，但**没有统一的"哪些词保留原文"的规则** |

### P2 · 可用性类

| # | 问题 | 证据 | 后果 |
|---|---|---|---|
| 9 | **首屏不回答"Agent 在做什么"** | 默认 tab 是 `readme`（插件说明） | 打开 Luzzy 第一眼看到的不是 Agent 状态 |
| 10 | **没有总览页** | 四个页各自为政 | 「当前目标/做到哪/下一步/为什么/完成了没」要翻两个页面拼 |
| 11 | **执行过程不可见** | 无轮次、无工具调用记录、无生命周期 | 用户不知道 Agent 怎么工作的 |
| 12 | **系统信息缺失** | 无版本、无插件状态、无 Token 总量入口（只在用量页） | 排查时无处可查 |

### P3 · 工程类

| # | 问题 | 证据 | 后果 |
|---|---|---|---|
| 13 | `review-preset-chain.mjs` 有 1 条既存 FAIL | 实测：`no handler for: /__luzzy/goal` | 路由审计脚本比后端落后一步（后端已有 goal 路由）——**本轮顺手修** |
| 14 | 测试断言散落在字符串匹配 | `test-client-load.mjs` 121 条里大量 `source.includes('…')` | 断言与实现措辞耦合，重构会大量假失败——**重构时必须同步更新** |

---

## 四、重构范围

### 4.1 目标形态

```
LuzzyPage = 插件功能展示页面
        ↓
Luzzy 控制台 = Agent 目标、状态、执行、交付管理中心
```

### 4.2 新目录结构（本次落地）

```
luzzy-page/src/
├── client.js              ← 外层 bundle（保持现状结构，只改 FRAME_DOCUMENT 的拼装）
├── app/
│   ├── router.js          ← tab 路由：状态、分派、切换
│   └── app.js             ← 应用外壳：启动、刷新调度、帧内对话框、事件委托
├── pages/
│   ├── overview.js        ← 页面一：总览（新默认页）
│   ├── goal.js            ← 页面二：目标中心（最高优先级）
│   ├── runtime.js         ← 页面三：执行状态（新增）
│   ├── agent.js           ← 页面四：Agent 配置（替代「预设」）
│   └── system.js          ← 页面五：系统信息（含原用量图表）
├── components/
│   ├── Card.js            ← 统一卡片 + 分区标题 + 计数
│   ├── StatusBadge.js     ← 状态徽标（颜色 + 图标 + 文字，三者齐备）
│   ├── Progress.js        ← 计数/比例条（含 tally 形态）
│   ├── Timeline.js        ← 时间线（最近动态、生命周期、变更记录）
│   ├── TreeView.js        ← 可展开收起的树（任务拆解）
│   └── EmptyState.js      ← 统一空状态
├── services/
│   ├── goal-service.js    ← /__luzzy/goal → 目标视图模型
│   ├── runtime-service.js ← /__luzzy/runtime → 执行视图模型
│   └── agent-service.js   ← /__luzzy/preset + 会话事实 → Agent 视图模型
└── styles/
    ├── tokens.css         ← 设计变量（明暗两套）
    ├── layout.css         ← 页面骨架、栅格、滚动
    └── components.css     ← 组件样式
```

### 4.3 关于 `src/` 是**多文件** —— 一个必须说清的技术决定

方案要求目录结构，但**帧文档必须是自包含的单文档**（`srcDoc` 不能有外部请求）。
两者并不冲突，做法是：

```
src/**.js  ──[build-font-css.py 拼接]──▶  帧文档内的单个 <script>
```

即：**源码是多文件（可读、可测），产物仍是单文档（自包含、零请求）**。
拼接顺序由 `src/app/manifest` 显式声明（不靠 glob，避免顺序意外），
每个文件导出到帧内的一个命名空间对象，**不使用 `import/export` 语法**
（帧脚本是 `new Function` 编译的经典脚本，ESM 语法会直接语法错误）。

> **为什么不让每个文件 `export`**：帧脚本由 `check-frame-script.mjs` 用 `new Function`
> 解析。`new Function` 体内不允许 `export` / `import`。所以帧内模块采用
> **IIFE 挂载命名空间**的形态，语义等价、语法合法。这是**帧内**约定，
> 外层 `client.js` 保持不动。

### 4.4 页面归属的调整（已与用户确认）

| 原页面 | 去向 | 理由 |
|---|---|---|
| 说明（README） | 降为**次要入口**，不再是默认页 | 默认页必须是"Agent 当前在做什么" |
| 用量（图表） | **并入系统信息**的「使用统计」 | 方案要求系统信息含 Token 消耗/工具调用次数/执行时间；图表整体搬过去，零功能损失 |
| 预设（提示词编辑） | → **Agent 配置** | 方案指定 |
| 目标 | → **目标中心**（保持并重组） | 方案指定为最高优先级 |

**用量页的图表渲染、悬停浮窗、单调平滑曲线、入场动画、活动阵列全部保留**，
只是挂在系统信息页下。`README` 的 markdown 渲染器保留，作为次要入口。

---

## 五、保留部分 / 删除部分

### 5.1 保留（一行不改或只改接线）

| 项 | 说明 |
|---|---|
| **iframe 隔离方案** | 帧是独立文档，零 React、零 hooks、零框架注入 —— 三代里唯一能用的一代 |
| **DSH Host 集成方式** | `apply(ctx)` + `ctx.slots.inject('conversation.view', …)` + `ctx.effect` 回滚 |
| **全部宿主路由** | `/__luzzy/{usage,readme,diag,preset,goal}` **原样保留**，签名与状态码不变 |
| **Goal Runtime 数据结构** | `goal/change` 事件、`goal-domain.mjs` 的字段、`HUMAN_OPS` / `applyDeliveryOp` 分工 —— **零改动** |
| **`srcDoc` 稳定性契约** | 文档构建一次成模块级常量；主题不进字符串 |
| **主题跟随三条监听** | MutationObserver + 文档 load + matchMedia |
| **帧内黑匣子** | `report()`、error 监听、`/__luzzy/diag` 上报 |
| **帧内对话框** | 自建 `.dialogScrim`，**绝不用原生 alert/confirm/prompt**（会偷走窗口焦点且不还） |
| **postMessage 会话握手** | `want-session` / `session` / `create-session` / `session-created` 四种带 type 的消息 |
| **客户端建会话路径** | `sessions.create({workspaceId})` + `sessions.open(id)`，必须全在客户端 |
| **图表全部能力** | 单调平滑（Fritsch–Carlson）、悬停浮窗、动效与 reduce 分支、活动阵列 |
| **Markdown 编辑器** | 三模式单面（实时预览 = 渲染面即可编辑面）、图标工具栏、序列化回写 |
| **构建门禁** | `build-font-css.py` 解析不过即非零退出；字体子集与内联 |
| **宿主半 worker 架构** | 重活必须在 worker 里（主线程同步跑会饿死 30 s admission 通道，已崩两次） |

### 5.2 删除 / 改写

| 项 | 处置 | 理由 |
|---|---|---|
| 单文件 4274 行的组织方式 | **拆成 src/ 下 20 个文件** | 本方案的核心 |
| 三套状态样式 | **收敛到 `StatusBadge` + `tokens.css` 的状态色** | 一状态一表达 |
| `emptyLine` / 内联空文案 | **收敛到 `EmptyState`** | 每个页面同一形态 |
| 手写 `.card` 字符串拼接 | **收敛到 `Card`** | 一处改样式全局生效 |
| 默认 tab = `readme` | **改为 `overview`** | 首屏必须回答"Agent 在做什么" |
| 21.6 的字号/圆角/间距白名单断言 | **保留断言，但改为断言 tokens.css 的值** | 从"事后检查"升级为"事前供给 + 检查" |

**不删除**：任何宿主路由、任何测试能力、任何已修 bug 的守卫。

### 5.3 明确不做（本次范围外）

1. **不改 DSH Core**（方案禁止）
2. **不删 iframe**（方案禁止）
3. **不引入大型 UI 框架**（方案禁止；帧内零依赖是既成事实，也是唯一稳的做法）
4. **不改后端 Goal 数据结构**（方案禁止）
5. **不制造假数据**（方案禁止）—— 每个展示字段都必须有真实数据源，见 §七
6. **不用英文 UI 文案**（方案禁止）
7. **不把页面做成普通后台管理系统**（方案禁止）—— 判据：不做左侧导航 + 顶部面包屑 + 表格三件套

---

## 六、基线证据（改动前实测）

`node tools/*.mjs` 全套 24 个，实测结果：

```
ok    test-loader-contract               PASS — 6 assertions
ok    test-client-load                   PASS — 121 assertions
ok    render-frame-preview               PASS — frame document is structurally complete
ok    scan-frame-backticks               PASS — no raw backticks inside the frame template
ok    test-chart-path                    PASS — 15 assertions (chart path geometry)
ok    test-usage-window                  PASS — 60 assertions (trend windows)
ok    test-usage-cache                   PASS — 27 assertions (parsed-log cache)
ok    test-preset-store                  preset-store: 72 checks passed
ok    test-preset-parity                 preset-parity: 29 checks passed
ok    test-preset-routes                 preset-routes: 99 checks passed
ok    test-preset-markdown               PASS — 119 checks (markdown toolbar + preview)
ok    test-preset-persona                preset-persona: 30 checks passed
ok    test-host-routes                   PASS — 41 assertions (host routes, real HTTP)
ok    test-host-integration              PASS — 15 assertions (host integration, real server)
ok    test-goal-domain                   PASS — 119 assertions (goal-domain)
ok    test-goal-store                    PASS — 77 assertions (goal-store)
ok    test-goal-enforce                  PASS — 143 assertions (goal-enforce)
ok    test-goal-routes                   PASS — 96 assertions (goal-routes)
ok    test-goal-stress                   PASS — 37 assertions (goal-stress)
ok    test-goal-lifecycle                PASS — 42 assertions (goal-lifecycle)
ok    test-installed-preset              installed-preset: 22 checks passed
ok    test-preset-assembly               PASS — 27 assertions (real renderPrompt, real persona row, real store)
FAIL  review-preset-chain                — every fetched path is registered — no handler for: /__luzzy/goal
ok    test-event-loop-responsiveness     — aggregation and warmup keep the event loop responsive
```

**基线：23 绿 + 1 既存 FAIL**（P3 #13，本轮顺手修）。

构建链实测（`python tools/build-font-css.py --dry-run`）：

```
scanned 2 file(s) -> 752 non-ASCII chars (729 CJK)
note: puhuiti_55_regular.ttf is absent; using AlibabaPuHuiTi-3-55-Regular.woff2 from the fallback dir
note: puhuiti_85_bold.ttf is absent; using AlibabaPuHuiTi-3-85-Bold.woff2 from the fallback dir

face                                   woff2      base64
Luzzy PuHuiTi 400 (subset)              114K        152K
Luzzy PuHuiTi 700 (subset)              113K     151K
Luzzy Sans 400 (whole)                   40K         54K
Luzzy Sans 700 (whole)                   42K         56K
total                                   309K        412K
```

**注意**：构建脚本目前只扫 `src/client.js` 一个文件（`collect_chars` 的 `targets` 取
`src_dir`），拆成多文件后必须改为**扫整个 `src/` 树**，否则新页面用到的汉字不在子集里，
**会静默回退到系统字体**。

---

## 七、新页面字段的数据源核查（防假数据）

方案要求五个页面展示若干字段。**每一个字段在动手前先确认有没有真实来源**，
实测脚本：`tools/probe-runtime-events.mjs`（直读 `~/.dsh/sessions/**/*.jsonl.zstd`，
只读，不写会话目录）。它先把事件类型全量列出来，再逐个 dump 出真实载荷。

本机会话日志实测（225 个日志，抽样 10 个）的事件类型：

```
    4708  tool/result        4618  tool/call          3995  step/start
    3994  step/end           3993  assistant/message    248  user/message
      91  compaction/prune     44  request/header        38  todo/write
      36  turn/start           35  turn/end              17  system/message
      16  session/title        11  goal/change           10  session
       9  compaction/start      9  compaction/summary     9  compaction/end
       8  command/run           8  command/done           8  plan/mode
       2  agent-preset/selected
```

字段级核查结果：

| 页面 | 要展示 | 真实来源 | 状态 |
|---|---|---|---|
| 总览 | 目标名称 / 状态 / 完成度 / 当前阶段 | `GET /__luzzy/goal` 的 `goal.objective` / `goal.phase` / `summary.acceptance.{verified,total}` / `goal.roundsStarted` | ✅ 已有 |
| 总览 | 当前正在处理 / 下一步 | `delivery.focus` / `delivery.next[]` | ✅ 已有 |
| 总览 | 最近动态时间线 | `delivery.changes[]`（带 `at` / `action` / `actor` / `detail`）+ `goal/change` 事件 | ✅ 已有 |
| 目标中心 | 目标概览 / 验收 / 任务 / 证据 / 决策 / 历史 | `delivery.{acceptance,tasks,evidence,decisions,changes}` | ✅ 已有 |
| 目标中心 | 任务树 | 由 `tasks[].dependsOn` + `acceptance[]` 关系推导 | ✅ 可推导（纯函数） |
| **执行状态** | 当前轮次 | `turn/start` / `turn/end` 的 `data.turn`（实测存在） | 🆕 需新路由 |
| **执行状态** | 生命周期五步 | `step/start`→`step/end`→`tool/call`→`tool/result`→`turn/end`（实测齐全） | 🆕 需新路由 |
| **执行状态** | 工具调用记录 | `tool/call` 的 `data.name` + `data.step`/`data.turn`（实测 4618 条） | 🆕 需新路由 |
| **执行状态** | 上下文状态 | `request/context` 的 `{provider, model, contextWindow}` + `goal/change` + `compaction/*` | 🆕 需新路由 |
| **系统信息** | 运行状态 / 版本 / 插件状态 | `package.json` 版本 + `lib/index.js` 的 routes-registered 事实 | 🆕 需新路由 |
| **系统信息** | Token 消耗 / 请求次数 | `GET /__luzzy/usage` 的 `totals` / `attempts`（已有） | ✅ 已有 |
| **系统信息** | 工具调用次数 / 执行时间 | `tool/call` 计数 + `turn/start`→`turn/end` 时间差 | 🆕 需新路由 |
| Agent 配置 | 名称 / 角色 / 当前模型 | `GET /__luzzy/preset` 的 `activeAgentId` + `model/selection` 事件 | ✅ 已有 |
| Agent 配置 | 行为策略 / 工具能力 / 上下文策略 | `goal-enforce` 的 `DEFAULT_ENFORCE_OPTIONS`（**真实配置值，非编造**） | ✅ 已有 |

**结论**：只有「执行状态」与「系统信息」的部分字段需要新数据源，
其余全部可从既有路由取得。因此新增**一个只读路由** `/__luzzy/runtime`，
它**不修改**任何既有路由与 Goal 数据结构。

> **反假数据的具体纪律**：新路由读不到会话时**返回 `null` 并说明原因**，
> 页面显示具名空状态（「暂无执行信息」+ 为什么），**绝不填 0 冒充"没有活动"**。
> 这和 §5.3 那条「`windows` 缺失时不能说'你没有数据'、必须说'宿主半是旧版'」是同一条纪律。

---

## 八、本轮风险与已知取舍

| # | 风险 | 处置 |
|---|---|---|
| 1 | 拆分后帧内语法错误**构建拦不住** | 三道门全跑：`scan-frame-backticks` → `render-frame-preview` → `check-frame-script`；每改一行都跑，不等构建 |
| 2 | 拆成多文件后**字体子集漏字** | 构建改为扫 `src/` 整棵树；`verify-font-css.py` 复核产物覆盖率 |
| 3 | 121 条 `test-client-load` 断言大量按**措辞**匹配 | 重构同步更新断言；**新断言优先断言结构（存在什么、行为如何），少断言措辞** |
| 4 | 宿主半改动**不热重载** | 新路由落在 `lib/`，**需要重启 DSH 才生效**；客户端半仍热重载。这个窗口期是常态，页面必须对旧宿主给出**具名**提示而不是空白 |
| 5 | 五页 × 明暗 × 三宽度截图数量大 | 复用 `tools/shoot.mjs`（已集中四个静默失败的处置）；判据仍是**应不同的截图 sha 必须不同** |
| 6 | 新增路由与 Goal 路由的职责边界 | `/__luzzy/runtime` **只读**，不写任何状态；写路径仍只有 `/__luzzy/goal` 一条 |

---

## 九、下一步

按方案指定顺序实施：

```
分析现状 ✅ 本文件
   ↓
建立 UI 基础        tokens.css / layout.css / components.css + components/
   ↓
重构页面架构        app/router.js + app/app.js + services/
   ↓
优先完成目标中心    pages/goal.js（六节全做）
   ↓
完成执行状态        pages/runtime.js + 宿主半 /__luzzy/runtime
   ↓
完成 Agent 配置     pages/agent.js      完成系统信息  pages/system.js
   ↓
整体视觉优化        去调试感、中文化、层级
   ↓
验收                三道门 + 全套件 + 五页×明暗×三宽度截图
```

迁移映射、数据层契约与验证命令见 `docs/frontend-v2-migration.md`。
