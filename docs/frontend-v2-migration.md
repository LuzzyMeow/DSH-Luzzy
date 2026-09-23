# frontend-v2-migration · 迁移映射与验收记录

> 配套 [`frontend-v2-analysis.md`](./frontend-v2-analysis.md)（动手前的现状报告）。
> 本文件是**迁移映射、数据层契约、构建链变更与验证命令**。
> 实测时间：2026-09-23。所有数字来自实跑，不是估计。

---

## 一、一句话概括这次改了什么

| | 之前 | 之后 |
|---|---|---|
| 源码 | `src/client.js` 单文件 4274 行，HTML/CSS/JS/页面逻辑全在里面 | `src/` 下 28 个文件（3 份 CSS + 23 个 JS 模块 + 帧模板 `frame.html` + 顺序清单 `manifest.json`） |
| 页面 | 四个子页（说明 / 用量 / 预设 / 目标），默认页是「说明」 | 五个控制台页面（总览 / 目标中心 / 执行状态 / Agent 配置 / 系统信息），默认页是「总览」，另有两个次要入口（预设 / 插件说明） |
| 数据 | 页面直接读后端字段 | 页面只吃**视图模型**，全部转换在 `services/` |
| 组件 | 卡片有三套写法，状态有三套样式，空状态散落各处 | `components/` 六个共享组件，一套样式 |
| 设计变量 | 没有 token 层，靠人肉维持白名单 | `styles/tokens.css` 单一真源，明暗两套，间距 4px 阶梯 |
| 产物 | 单文件模板字符串，反引号是地雷 | 帧文档由构建拼接后以 JSON 字符串字面量嵌入，**结构上消除**该地雷 |

**没改的**：iframe 隔离、DSH Host 集成方式、五个既有后端路由的签名与状态码、
Goal Runtime 数据结构（`goal/change` 事件与 `goal-domain.mjs` 字段零改动）。

---

## 二、迁移映射（旧 → 新）

### 2.1 页面

| 旧（`src/client.js`） | 新 | 说明 |
|---|---|---|
| `render()` 的 `readme` 分支 | `pages/readme.js` | 保留全部渲染，降为次要入口 |
| `render()` 的用量主体 + `metricsCard` `activityGrid` `trendChart` `modelDonut` | `pages/system.js`（呈现）+ `components/Chart.js`（渲染） | 图表能力零损失，整体并入系统信息 |
| `renderPreset()` + 48 个配套函数 | `pages/preset.js` | **原样搬运**，逻辑一行未改（见 §2.4） |
| `renderGoal()` + 24 个 `goal*Card` | `pages/goal.js` | 重组为六节 + 七节支撑信息 |
| — | `pages/overview.js` | 新增：回答「Agent 在做什么」的五个问题 |
| — | `pages/runtime.js` | 新增：轮次 / 生命周期 / 工具调用 / 上下文 |

### 2.2 组件（新抽取）

| 新文件 | 吸收了哪些旧实现 |
|---|---|
| `components/Card.js` | 手写 `.card` 字符串、`goalSection()`、`metricsCard()`、`emptyLine()`、`statusBlock()`、`chip()` 的容器部分 |
| `components/StatusBadge.js` | `chip(state,label)`（目标页）、`.saveState[data-kind]`（预设页）、`.callout[data-kind]`（用量页）——**三套合成一套** |
| `components/Progress.js` | `tally(done,total)` |
| `components/Timeline.js` | `goalHistoryCard` 的时间线、新增生命周期形态 |
| `components/TreeView.js` | 新增：任务拆解树 |
| `components/EmptyState.js` | `emptyLine()`、`statusBlock()`、加载骨架 |

### 2.3 原样搬运的模块（逻辑一行未改）

| 新文件 | 来源 | 为什么不能重写 |
|---|---|---|
| `components/Format.js` | `esc` `formatTokens` `formatExact` `niceMax` `levelOf` `COLORS` | `test-chart-path.mjs` 按名字与签名直接抽取 `niceMax` / `smoothPath` |
| `components/Markdown.js` | `renderMarkdown` `serializeMarkdown` `applyMarkdownTool` `activeToolsFor` `MD_*` | `test-preset-markdown.mjs` 119 条断言直接抽取这三个函数；HTML→Markdown 是唯一会损坏提示词的方向 |
| `components/Chart.js` | `smoothPath` `trendChart` `chartTipHtml` `wireChartHover` `modelDonut` `CHART` | 单调插值、悬停钳制、未来时段为 null 都是踩出来的 |
| `app/dialog.js` | `showDialog` `showMessage` `showConfirm` `showPrompt` `dialogLine` | 帧内自建对话框——原生对话框会偷走窗口焦点且不还 |

搬运由 `tools/extract-legacy-modules.mjs` 完成，**按签名花括号配平逐字切出**，不是重打一遍。
它同时撤销帧模板的转义（`\\` → `\`、`` \` `` → `` ` ``），并断言产出里没有 `${`——
那说明模板插值过，而这是没法还原的。

### 2.4 预设编辑器的搬运（单独一个脚本）

`tools/extract-preset-module.mjs` 把 1164 行编辑器搬进 `src/pages/preset.js`，
只做**边界适配**，每条替换都计数并打印：

| 替换 | 次数 | 为什么 |
|---|---|---|
| `renderMarkdown(` → `LZ.Markdown.render(` | 2 | 渲染器移入模块 |
| `serializeMarkdown(` → `LZ.Markdown.serialize(` | 1 | 同上 |
| `applyMarkdownTool(` → `LZ.Markdown.applyTool(` | 1 | 同上 |
| `showMessage/confirm/prompt/dialogLine` → `LZ.Dialog.*` | 22 | 对话框移入模块 |
| `content.` → `contentNode().` | 3 | 容器改为访问器 |
| `state.tab === 'preset'` → `onPresetTab()` | 18 | 页面局部的判断收成一处 |
| `render()` → `LZ.App.render()` | 18 | 渲染入口归外壳 |
| `statusBlock(` → `LZ.EmptyState.statusBlock(` | 1 | 该函数**根本不在搬运范围内**，漏了会在渲染期抛错 |
| 删除 `MD_*` 与三个纯函数的**重复定义** | 7 | 见下 |

**去重是必须的**：`applyMarkdownTool` / `serializeMarkdown` / `activeToolsFor` 与四个工具栏表
原本落在搬运区间的**内部**，于是两个文件各得一份。两份 120 行的函数正是这次重构要消灭的漂移源，
所以保留 `Markdown.js` 的版本、删掉 `preset.js` 的副本——所有调用点已经改走命名空间了。

脚本末尾有三道断言：**没有任何未适配的帧全局引用残留**、九个关键功能（编辑器渲染 / 名单渲染 /
事件接线 / 页面渲染 / 工具栏接线 / 修订守卫 / 拖拽排序 / 归档而非删除 / 双击守卫）都在。

---

## 三、数据层契约

### 3.1 分工

```
后端响应（wire shape）
   ↓  services/*-service.js      ← 唯一知道后端字段名的地方
视图模型（view model）
   ↓  app/app.js buildPageState  ← 唯一把视图模型装配成「某一页的投影」的地方
页面（pages/*.js）               ← 只读投影，纯函数（视图模型进，HTML 出）
```

**判据**：页面里出现 `payload.` / `snapshot.` / `readError` / `LZ.App.state` 任一个，就是越界。
`tools/test-view-models.mjs` 逐页断言这件事——它当场抓出 `pages/system.js` 直读 usage 响应，
修法是在 `buildPageState` 里投影，**而不是放宽断言**。

> **一条曾经写错的断言**：第一版把 `delivery.acceptance`、`goal.roundsStarted` 也列为「后端字段」，
> 于是两个页面因为读 `view.delivery.acceptance` 被报成越界。那是错的——视图模型**故意**暴露
> `delivery` 与 `goal`，读它们正是页面该做的事。一条分不清「原始形状」与「转换后形状」的断言会
> 把正确的代码报成坏的，而读者照它改只会把页面改得更差。

### 3.2 三个服务的产出

| 服务 | 输入 | 产出 |
|---|---|---|
| `goal-service.js` | `GET /__luzzy/goal` | `{ goal, delivery:{acceptance,tasks,evidence,decisions,blockers,proposals,changes,focus,next,scope,constraints}, counts, tree, integrity, drift, artifact, health… }` |
| `runtime-service.js` | `GET /__luzzy/runtime` | `{ currentTurn, turnsCompleted, steps, toolCalls, toolGroups, recentCalls, steps5, contextItems, elapsedLabel… }` |
| `agent-service.js` | `GET /__luzzy/preset` + 上面两个 | `{ info, behavior, context, toolRows, agents, active… }` |

**纯函数留在服务里而不是页面里**，因为它们必须只写一遍。两个页面对同一个目标给出不同答案，
比任何一处布局问题都严重。

| 纯函数 | 契约 |
|---|---|
| `taskTree(tasks)` | 由 `dependsOn` 推导树；**依赖成环不删节点**；悬空依赖仍是根节点；不丢节点是唯一不可让步的性质 |
| `counts(view)` | 计数在这里算一次，页面只显示——两处各算一次必然漂 |
| `progressOf(view)` | 回答五个问题（在做什么 / 下一步 / 为什么 / 完成了没 / 凭什么）；**没有必须的验收标准时说「无从判定」而不是猜** |
| `toolGroups(list)` | 归类后合计必须等于原始总计数 |
| `duration(ms)` | 0 读成 `—` 而不是「0 秒」 |

### 3.3 新路由 `/__luzzy/runtime`（只读）

| 项 | 值 |
|---|---|
| 文件 | `lib/runtime-routes.mjs` |
| 动词 | 仅 `GET`（其他返回 405） |
| 范围 | 仅 loopback（否则 403） |
| 数据源 | `~/.dsh/sessions/**/*.jsonl.zstd`，**只读**，读不出来的日志记为 unreadable 而不是 0 |
| 字段 | 全部来自实测存在的事件：`turn/start` `turn/end` `step/start` `tool/call` `tool/result` `request/context` `compaction/*` `goal/change` |

**为什么单独一条而不是塞进 `/__luzzy/goal`**：goal 路由是**写**面，契约是「一次改动 + 返回整份状态」。
把原始日志的读取混进去，等于在一个写端点的背后塞第二条读路径。分开之后写路径仍然只有一条。

**「项目规则」的检测条件是两个而非一个**：必须是读形状的工具（名字以 read/glob/grep/list 开头）**且**
文件名出现在该次调用的参数里。只看参数会全部误报——文件名也会出现在 `write`/`edit` 的**文件内容**里，
而一份提到 CLAUDE.md 的文档不等于会话读过它。实测：加工具过滤后，40 个日志里有 11 个检出真实读取。

---

## 四、构建链变更

### 4.1 从「单文件模板字符串」到「拼接 + JSON 字面量」

| | 旧 | 新 |
|---|---|---|
| 帧来源 | `src/client.js` 里的一个巨型模板字符串 | `src/app/frame.html` + `manifest.json` 声明的模块 |
| 转义 | 手写：反引号必须转义，踩了 4 次白屏 | `json.dumps` 机械转义，**结构上安全** |
| 顺序 | 天然（只有一个文件） | `manifest.json` 显式声明，构建**校验依赖顺序** |
| 字体 | 单文件扫描 | 扫描整个 `src/` 树（29 个文件），否则新页面的汉字会漏进子集并静默回落 |

### 4.2 构建的四道门（全部在 `build-font-css.py` 里）

| 门 | 查什么 | 为什么必须有 |
|---|---|---|
| `verify_module_order` | 顶层读的 `LZ.X` 必须在定义它的模块之后 | 顺序错了是 `undefined`，iframe 里什么都不报。**只查赋值深度为 1 的读**——函数体里的读是调用时才求值，不算依赖；把赋值当读会让每个模块报「依赖自己」 |
| `verify_frame_script` | 帧脚本能否**编译** | 帧是字符串，外层 bundle 编译通过什么也说明不了 |
| `verify_frame_modules_evaluate` | 帧脚本能否**运行**（pragma 在内） | 见下 |
| `verify_bundle_parses` | 外层 bundle 能否编译 | 反引号截断的老门 |

**`verify_frame_modules_evaluate` 是这轮最有价值的一条**，它抓到两个真 bug：

1. **模块拼接缺分号** → `(A)(B)` 被解析为「用 B 调用 A 的返回值」。首个模块之后的所有命名空间
   从未定义，而它是**语法合法**的，解析器一个字都不报。
2. **`'use strict'` 没有分号** → 后随模块的 `(function (LZ) {` 被解析为**调用字符串**，
   `TypeError: "use strict" is not a function`。同样是合法语法。

第二条还有一层教训：**这道门的第一版把 pragma 从被求值的源码里切掉了**，理由是
「那是 harness 的 bug，不是帧的 bug」。结果它永远看不见这个缺陷——**绕着可疑代码走，
和不测它是一回事**。现在它从 `<script>` 标签一直求值到 `LZ.App.start()` 之前，pragma 在内。

### 4.3 「新鲜度」判据换了

旧的 `review-preset-chain.mjs` 用**字节偏移**比对 `src/client.js` 是否原样出现在产物里。
多文件拼接之后这个判据不成立了，而它会把一个正确的构建报成「stale」——**最贵的一种假警报，
因为它让读者去重跑一次已经跑过的构建**。

新判据是属性的：**`lib/client.js` 的 mtime 必须晚于每一个喂给它的源文件**（按 manifest 枚举）。
同一条性质，不依赖产物的形状。

---

## 五、验证命令

### 5.1 全套回归（28 个套件）

```bash
cd luzzy-page
python tools/build-font-css.py          # 构建（含四道门）
node tools/test-loader-contract.mjs     # bundle id 必须等于包名
node tools/test-client-load.mjs         # 注册契约 + 帧结构（122 条）
node tools/render-frame-preview.mjs     # 帧结构（58 条）
node tools/scan-frame-backticks.mjs     # 帧完整性（9 条）
node tools/check-frame-script.mjs       # 帧脚本可运行（从产物编译）
node tools/test-view-models.mjs         # 视图模型边界与纯函数（58 条）
node tools/test-runtime-routes.mjs      # 只读路由 + 真实日志（26 条）
node tools/probe-unstyled-classes.mjs   # 类名使用与样式定义的差分
node tools/review-preset-chain.mjs      # 跨产物链审计（25 条）
# …以及 test-chart-path / test-usage-* / test-preset-* / test-goal-* / test-host-* 等
```

**实测：28 / 28 全绿**（基线是 23 绿 + 1 个既存 FAIL，本轮把它修好并新增 4 个套件）。

### 5.2 真浏览器验收

```bash
node tools/shoot-console.mjs --theme light          # 七个页面，1280px
node tools/shoot-console.mjs --theme dark           # 深色
node tools/shoot-console.mjs --theme light --width 720
node tools/shoot-console.mjs --theme light --width 420
node tools/shoot-console-scroll.mjs --page goal --theme light --scroll 1500
node tools/probe-narrow-tabbar.mjs                  # 窄屏 tab 条是滚动还是被裁切
```

**实测结果**：

| 项 | 结果 |
|---|---|
| 页面渲染 | **7 / 7**（总览 / 目标中心 / 执行状态 / Agent 配置 / 系统信息 / 预设 / 插件说明） |
| 控制台报错 | 0（明暗两套各自干净） |
| 横向溢出 | 1280 / 720 / 420 三个宽度下 `scrollWidth === innerWidth` |
| 截图 | **30 张，30 个互不相同的 sha256**（判据：应当不同的两张图哈希相同＝没验到） |
| 目标中心 | 3104px 高、13 节、任务树 5/5 节点可见、3 层深度 |

### 5.3 窄屏那个「溢出」是怎么定案的

420px 下 `.segment` 与 `BUTTON` 报溢出。**不猜是哪种**，而是量出来：

```
viewport innerWidth: 492     document scrollWidth: 492  → page does not scroll
.tabs:    left=16 right=468 width=452 scrollW=546 clientW=452 overflow-x=auto
.segment: left=16 right=562 width=546 scrollW=546 clientW=546 overflow-x=visible
last tab right before scroll=558, after scrolling to 94px=464
→ the last tab IS reachable by scrolling the tab bar: contained, intended
```

**结论：不是缺陷。** 文档不横向滚动，tab 条是 `overflow-x: auto` 且最后一个 tab 确实可达。
「页面不滚动」也可能是「有东西被裁掉了」——那是另一种缺陷，所以把两层数字都打出来。

---

## 六、本轮在浏览器里抓到的真 bug（测试全绿时它们都存在）

这五个都是**单元套件看不到、只有真浏览器或真运行才暴露**的，记在这里因为它们各自代表一类：

| # | 症状 | 根因 | 教训 |
|---|---|---|---|
| 1 | 帧完全空白 | 模块拼接缺分号 → `(A)(B)` 解析为函数调用，首个之后的命名空间全未定义 | **合法语法不等于正确行为**；解析门拦不住，必须求值 |
| 2 | `TypeError: "use strict" is not a function` | pragma 后无分号 → 被当成调用 | 编译测试对 ASI 问题毫无价值，答案只在运行时存在 |
| 3 | 切页即崩 | `Router.render` 把**整个应用状态**传给页面，而页面按自己的契约读投影 | 分派依据与内容分开传，两者会不一致；投影自带 `tab` 才是结构上安全 |
| 4 | 系统信息页空 | `LZ.Activity.level` **是我编的**，真实函数是 `LZ.Format.levelOf` | 名字写错在渲染期炸，不在加载期；`probe-unbound-names.mjs` 就是为了扫这类 |
| 5 | 预设页空 + `MD_ICONS is not defined` | 搬运时只改了调用点，没给模块加绑定 | 十三个引用点分布在图标/分组/模式；**局部绑定**比逐点替换安全 |

另外两个是**真 UX 缺陷**，也只有在看截图时才发现：

| # | 症状 | 根因 |
|---|---|---|
| 6 | 任务树只显示 1 行（五个任务里） | 默认展开只看**直接子节点**；一条「父已完成、孙还在做」的链被判成全完成而收起 |
| 7 | 预设页写着 `undefined` | 编辑器是**命令式**的（自己写 DOM 并返回 undefined），而外壳用 `innerHTML = html` 覆盖了它 |

以及两个**迁移遗漏**（都是静默的）：

| # | 症状 | 根因 |
|---|---|---|
| 8 | 53 个 CSS 类没有样式 | v2 重写了新页面的样式，**悄悄漏掉旧页面仍在用的部分**（整个预设编辑器 + 图表部件）。修法：从 git HEAD 逐字取回 114 条规则，不重写 |
| 9 | 预设页渲染期抛 `statusBlock is not defined` | 该函数不在两个搬运区间的任何一个里，两头都没接住 |

> 第 8 条的工具留下来了：`tools/recover-legacy-css.mjs`（干跑/应用）与
> `tools/probe-unstyled-classes.mjs`（差分）。**少一条选择器不报错，只是没样式**，
> 只有类名差分能发现。

---

## 七、明确未覆盖的（说出来，不藏着）

1. **宿主半需要重启才生效**。`lib/runtime-routes.mjs` 与 `lib/index.js` 的接线属于宿主半，
   它不热重载。在重启前，执行状态页与系统信息的执行统计会显示「读不到」并说明原因——
   这正是设计要的行为，但**真机端到端仍待用户在重启后确认**。
2. **真 DSH 里的视觉未由我确认**。本轮的浏览器验收是在隔离装置里跑的（真浏览器 + 真帧 +
   真路由 stub），因为进程外访问 DSH 的宿主路由恒得 403（凭据每次启动随机生成）。
   用户在 DSH 里看到的观感需要他自己过一眼。
3. **`pages/system.js` 的图表交互（悬停浮窗、切窗口动效）没有单独的动态断言**。
   本轮验的是「渲染出来了、不溢出、无报错」；`test-chart-path.mjs` 管曲线几何，
   `render-hover-shot.mjs` 与 `test-animation.mjs` 仍在，但它们针对的是旧入口。
   **迁移后这两个工具未重跑**——它们依赖旧渲染器的提取方式。
4. **AOCI 索引未收敛**。本仓库的认知索引停在 v2 之前（受管范围内 `src/` 只有一个文件），
   且那 19 张截图的策展裁决仍待人工。本轮**没有**伪造批次或绕过那道门。

---

## 八、下一次接手时先看什么

```bash
cd luzzy-page
python tools/build-font-css.py     # 必须先过；四道门会拦下大部分结构性错误
node tools/shoot-console.mjs --theme light   # 七页一次性渲染 + 量溢出
```

- 改**页面** → 改 `src/pages/*.js`；改**样式** → `src/styles/*.css`；改**数据** → `src/services/*.js`
- 改完**必须重跑构建**：`lib/client.js` 是产物，只改 `src/` 运行的是旧代码
- **不要改 `lib/client.js`**：它每次构建都会被覆盖
- 帧内代码用 `LZ.*` 命名空间，**不用 `import`/`export`** —— 帧脚本是经典脚本
- 帧内**绝不使用** `alert` / `confirm` / `prompt`（会偷走窗口焦点且不还）
- 两个搬运脚本（`extract-legacy-modules.mjs` / `extract-preset-module.mjs`）是**一次性**的，
  它们从 git 的 v2 之前版本取源码；日常开发不需要它们
