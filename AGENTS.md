# AGENTS.md

本工作区：**DSH（DeepSeek Harness）插件开发**，重点是前端。目录名 `DSH Plugin`。

工作顺序是：调研 → 设计判断 → 落地实现。下面的五节分别对应这几段的入口。

---

## 一、视觉一致性 —— 硬约束，先读这条

> **一旦涉及 DSH 的前端页面开发，必须先读参考项目的 UI 设计与四项必读 SKILL，然后照做。**

**不要从零重新设计前端。不要自主发挥 UI/UX。**

### 原参考项目的设计是既定设计

`reference/lobehub` 的前端界面、视觉风格、布局、组件、交互方式与设计语言，**一律视为既定设计，不得随意改变**。

### 新增页面怎么做

**严格复用**现有项目的设计系统、组件与视觉语言：

| 要复用什么 | 到哪找 |
|---|---|
| 语义 token、色板、排版、间距、圆角、阴影、动效 | `reference/lobehub/DESIGN.md`（+ `DESIGN.dark.md`）的对应章节 |
| 组件与组件行为 | `reference/lobe-ui/`（组件库本体） |
| 图标与品牌 logo | `reference/lobe-icons/` |
| 真实页面怎么组织、状态怎么流动 | `reference/lobehub/src/features/`、`reference/lobehub/src/components/` |

### 动手前的四份必读

| # | 读什么 | 为什么 |
|---|---|---|
| 1 | `skills/luzzy-roster-design/SKILL.md` | 基线五条：设计判断与流程纪律 |
| 2 | `skills/luzzy-roster-design-react/SKILL.md` | React 子项三条：本工作区是 React 场景 |
| 3 | `reference/lobehub/DESIGN.md` | 设计系统真源：token 与全部设计维度 |
| 4 | `reference/lobehub/DESIGN.dark.md` | Dark 值：两主题间只有颜色变 |

再配合第三节按场景补读对应的框架子项 skill。**找不到某个元素在现有设计里的对应物时，先问、先找，不要自己发明一个。**

---

## 二、参考区 `reference/` —— 前端设计的唯一参考

三个 lobehub 仓库，**完整克隆含全部历史**，克隆于 2026-09-19。

| 目录 | 仓库 | 分支 | 许可 |
|---|---|---|---|
| `lobe-ui/` | lobehub/lobe-ui | master | MIT |
| `lobe-icons/` | lobehub/lobe-icons | master | MIT |
| `lobehub/` | lobehub/lobehub | canary | **NOASSERTION** |

详细索引（每件套干什么、哪些文件最值得先读、重新克隆命令）见 [`reference/README.md`](reference/README.md)。

### 先读这两个

| 文件 | 为什么 |
|---|---|
| `reference/lobehub/DESIGN.md` | LobeHub 设计系统真源，201 行。Overview / Colors / Typography / Layout / Elevation & Depth / Motion / Shapes / Components / Voice & Content / Do's and Don'ts |
| `reference/lobehub/DESIGN.dark.md` | 同一套 token 名的 Dark 值。两主题之间只有颜色变，排版 / 间距 / 圆角 / 控件 / 动效 / 形状 / 语气完全一致 |

`DESIGN.md` 的硬纪律，做任何前端之前先遵守：

> 组件必须读**语义 token**（`cssVar` key `lobe-vars`），**不得硬编码**列表里的任何单值。

即：参考它的**方法**，不是它的**色值**。

### 三条边界

1. **`reference/` 不入版本控制**，已在 `.gitignore` 排除。体积大（1.42 GB），随时可重新克隆。
2. **`lobehub` 是 NOASSERTION**。自用参考没问题；**对外分发前必须单独确认条款**。`lobe-ui` 与 `lobe-icons` 是 MIT，可放心用（保留版权声明）。
3. **不要把工作目录切进 `reference/` 下的子目录再开工**。三个仓库各自带 `AGENTS.md` / `CLAUDE.md` / `.agents/` / `.claude/` / `.codex/` / `.cursor/`，那是**上游项目自己的** agent 约定。规范文件的读取范围只到当前工作区——cd 进去就会让上游约定变成「当前工作区约定」。

---

## 三、设计类 skill —— 工作区 `skills/`

本工作区自带四个设计 skill，从 [`LuzzyMeow/LuzzyPrompt`](https://github.com/LuzzyMeow/LuzzyPrompt) 拷贝（SHA256 已核）。

| skill | 版本 | 管什么 |
|---|---|---|
| `skills/luzzy-roster-design/SKILL.md` | 1.1.0 | **基线五条**：设计判断方法论 / 设计清单与提示 / 开放设计规范 / UI-UX 技能正文 / 动效与 UI 打磨纪律（emilkowalski） |
| `skills/luzzy-roster-design-react/SKILL.md` | 1.0.0 | React 子项三条：shadcn/ui、Vercel agent-skills、Anthropic 官方 frontend-design |
| `skills/luzzy-roster-design-vue/SKILL.md` | 1.0.0 | Vue 子项三条：vuejs-ai/skills、Nuxt UI、nuxt-skills |
| `skills/luzzy-roster-design-compose/SKILL.md` | 1.0.0 | Compose 子项三条：Android 官方 skills（theming / adaptive / migration）、compose-skill、material-3-skill |

### 什么时候读哪个

| 场景 | 读什么 |
|---|---|
| 纯视觉稿 / 判不出框架 | 只读 `luzzy-roster-design` 五条，回执写明「未命中框架子项」 |
| 写 / 改 **React** 组件与页面（`.tsx` / `.jsx` / React / Next 依赖） | 基线五条 **+** `luzzy-roster-design-react` 三条 = 8 条 |
| 写 / 改 **Vue** 组件与页面（`.vue` / Vue / Nuxt 依赖） | 基线五条 **+** `luzzy-roster-design-vue` 三条 |
| 写 / 改 / 评审 **Compose UI**（`.gradle.kts` 有 Compose 依赖） | 基线五条 **+** `luzzy-roster-design-compose` 三条 |
| **动效**任务 | 基线第五条重点用 emil 的 `animate` 与 `review-animations` 两个子技能正文 |

**基线五条与框架子项是叠加关系，不是二选一**——基线管审美判断，子项管这个框架怎么落地，缺哪一半都不完整。

**本工作区当前是 React 场景**（`docs/05` 已确认 DSH Web 前端是 React 18.3.1，插件插槽只准入 React），所以实际用的是 `luzzy-roster-design` + `luzzy-roster-design-react`。

### skill 与 reference 的分工

```
skills/      方法论层：怎么判断、按什么流程做、什么时候该停下来问
reference/   素材与实现层：别人实际是怎么写的、这个东西长什么样
```

判据：问「该怎么做、做到什么程度算好」→ 读 `skills/`；问「实际怎么写、长什么样」→ 读 `reference/`。

---

## 四、文档 `docs/`

本项目自己的调研与设计记录。**这是已确认结论的唯一落点，优先在那里追加，不新开平行目录。**

| 文件 | 内容 |
|---|---|
| [`docs/README.md`](docs/README.md) | 导航与来源分级摘要，**从这里进** |
| [`docs/01-插件模型与写法.md`](docs/01-插件模型与写法.md) | 插件是什么、三种形态、四个导出、工具 DSL、配置、事件系统、生命周期 |
| [`docs/02-组装安装与客户端插件.md`](docs/02-组装安装与客户端插件.md) | profile / bundle / patch 三层组装、安装分发、**§7 是 Web UI 插槽插件的入口** |
| [`docs/03-注意事项与来源核验.md`](docs/03-注意事项与来源核验.md) | 踩坑清单、安全边界、版本兼容、本机核验记录 |
| [`docs/04-服务与运行时.md`](docs/04-服务与运行时.md) | 核心服务总览、系统提示词组装、会话与上下文重建、模型调用、轮次骨架、工具执行流水线 |
| [`docs/05-前端技术栈与客户端插件机制.md`](docs/05-前端技术栈与客户端插件机制.md) | 前端是 Electron 壳 + Vite/React SPA、右侧栏选项卡两步注册、iframe 塞自有页面、框架准入边界 |
| [`docs/RESEARCH-DSH插件层可行性调研.md`](docs/RESEARCH-DSH插件层可行性调研.md) | 对照 AstrBot / HanaAgent / QwenPaw 的机制可行性矩阵 |
| [`docs/STATUS-LuzzyPage工作节点.md`](docs/STATUS-LuzzyPage工作节点.md) | **LuzzyPage 的进度与下一步**：当前状态、两个已知缺陷、失败史、验收清单、可复用脚本清单 |

**接手 LuzzyPage 时先读 `docs/STATUS-LuzzyPage工作节点.md`**——它是上下文压缩后的接续点，含未完成项与诊断手段。

**动手写客户端插件前，`docs/02` §7 与 `docs/05` 必读**——插槽注册、tab 机制、iframe 用法都在那里，并且都带本机可复现的证据位置。

---

## 五、已证伪的做法 —— 别再试这些

> 每一条都是**真实的崩溃/白屏换来的**，不是推测。下次碰 DSH 客户端插件时，先读这一节。

### 5.1 客户端插件的三条死路（按踩坑顺序）

| # | 做法 | 症状 | 根因 |
|---|---|---|---|
| 1 | 组件里 `require('react')` 后调 `useState` 等 hooks | **整页白屏**，界面上无任何报错 | 宿主渲染器用**它自己 bundle 内联的 React**；静态模块表里的 `react` 是**另一份**。第二实例的 hooks → **React #321 Invalid hook call** → 渲染器的 `SlotErrorBoundary` 把整页换成 `<div data-slot-error>` 空 div |
| 2 | 改用 hooks-free 组件 + `defineStore` 的 store share | **整页白屏** | `conversation.view` 条目的 props 里**没有** `useStore`/`actions`（实测 `TypeError: useStore is not a function`）。store share 到不了这个插槽 |
| 3 | 依赖框架注入的 `t` | 白屏 | `conversation.view` 的 render 调用只传 `viewRequest` / `openView` / `completeViewRequest`；**不要在组件签名里解构 `t`**（Chat 有 `t` 是因为它的**子插槽**有 locale 注入，不是 view 层） |

**唯一稳的做法：插槽条目渲染一个 `<iframe srcDoc={自包含文档}>`。**
帧内是纯 HTML + 原生 JS，零 React、零 hooks、零框架注入。数据用同源相对路径 `fetch('/__luzzy/...')` 取——这条路**已验证可达**。

### 5.2 宿主侧的两条死路

| # | 做法 | 症状 | 根因 |
|---|---|---|---|
| 1 | 在 `apply()` 或 setTimeout 里同步跑重活（如解压 200 个日志） | **DSH 无法启动**，`host-boot` 失败 | 宿主进程有 **profile admission 通道，RPC 超时 30 秒**。主线程被占 20 秒 → 通道饿死 → 引导失败 |
| 2 | 用 `setImmediate` 分块"让出"主线程 | **同样启动失败** | 实测单次停顿仍有 **5.9 秒**，让出不够。**必须用 `worker_threads`**（改造后停顿降到 2–7 ms） |

### 5.3 其他必须记住的硬事实

- **bundle 注册 id 必须等于 `package.json` 的 `name`**。写成 patch 层的 id → 整个 bundle 加载判定失败 → 插件崩溃。`tools/test-loader-contract.mjs` 守这条。
- **会话日志是追加式多帧 zstd**。`zstdDecompressSync` 只解第一帧并**静默返回截断结果**（1.9 MB → 222 字节，聚合全 0 且不报错）；流式解压器遇到下一帧报 `Unknown frame descriptor`。**必须按魔数 `28 B5 2F FD` 切分逐帧解**。
- **同一份用量在日志里记两遍**（`.data.usage` 与 `.data.stream[N].chunk.usage`）。**朴素相加多算约 1.64 倍**；正确口径是最终样本**替换**流式样本。
- **桌面版默认 `ordinaryBrowserEnabled = false`**，无凭据的浏览器请求一律 403。凭据是**每次启动随机生成的 token**，校验 `x-dsh-desktop-renderer` 头；渲染进程的 fetch 由 Electron 自动注入该头。
  - **推论：从进程外探测宿主路由永远拿不到有效信号**——带不带对错 token 都只是 403，与路由存不存在无关。想验路由，只能在渲染进程里验（帧内上报），或像 `tools/test-host-integration.mjs` 那样自己起一个真 webserver。
- **宿主路由不要只靠 `console.warn` 留证**——裸 console 不进 DSH 的日志文件。**写文件到 `~/.dsh/<plugin>-diag/`** 才可靠。
- **客户端半会热重载，宿主半不会。** 改 `lib/client.js` 后 DSH 里立刻生效（`patchReload: live`）；改 `lib/index.js`（宿主半）必须重启 DSH。**诊断时先分清是哪一半**。
  - **推论：每次改完客户端，「新客户端 + 旧宿主」就是常态**，直到重启。这不是异常状态，而是必然经过的一段时间。
  - **判据**：`~/.dsh/luzzy-page-diag/` 里有 `diag.jsonl` → 新宿主半；只有 `diag-*.json` 单文件 → 旧宿主半。
  - **协议一变，旧宿主就会给出「缺字段但不报错」的响应**。新客户端读不到 `windows` 时如果画个空图或写「还没有用量记录」，就把**版本不一致伪装成「你没有数据」**——这是最坏的一类错误，因为它对用户的事实陈述是错的。**现在会明确报「宿主半是更新前的版本，请重启 DSH」**，并且帧内上报 `usage-payload-stale`。

### 5.4 诊断纪律

**没有控制台就别改代码。** 前两轮我在看不见渲染进程报错的情况下"推理"病因，连错两次、浪费几十轮。正确姿势：**先装黑匣子，再动手**——客户端每个阶段上报、宿主侧 **diag 路由写文件**（不依赖日志管道）、激活时写 `routes-registered.json`（有无此文件即可二分「宿主半没激活」与「渲染侧没执行」）、组件内 try/catch 把错误**渲染到屏幕上**。

**iframe 内也要装**——帧是独立文档，它里面抛的错**不会**进宿主控制台。

**证据要看来源，别把测试的痕迹当应用的痕迹**：`routes-registered.json` 存的是**进程 pid 与端口**，要核对 pid 是否还活着。`test-host-integration.mjs` 曾把**测试进程的 pid 与临时端口**写进用户的真实 diag 目录，被当成「宿主在 50269」的证据，而那个 pid 早退出了。现在测试用 `LUZZY_DIAG_DIR` 指向临时目录，marker 里带 `source: host|test`。

### 5.5 布局与主题：iframe 的两条硬约束

- **iframe 是独立文档，CSS 自定义属性不跨文档继承。** 帧内写 `var(--dsw-*)` 会**全部静默回退到硬编码兜底值**——38 处引用、0 处定义，暗色模式下整页仍是浅色，且不报任何错。做法：帧自己定义两套 token（`:root` 与 `:root[data-theme='dark']`），父组件把当前主题**烘焙进文档**（`<html data-theme>`），再用 MutationObserver 跟随切换。
- **帧内 token 名必须在 DSH 前端 CSS 里真实存在。** `--dsw-alias-bg-skeleton` 是**凭空写的**，DSH 里根本没有（其余 9 个都在）。核对方法：在 `dsh-web-frontend/dist/**/*.css` 里搜 token 名。
- **整栏视图不要抄聊天区的行宽。** `.column { max-width: 748px }` 是从聊天内容宽度照抄的，放在整栏视图里等于右侧大片留白。`DESIGN.md` 的 Layout 说得很明确：*Center primary content and let side padding grow at wider breakpoints.*
- **数据密度决定网格**。活动阵列固定为**一个自然月**（28–31 格），所以 `repeat(auto-fit, minmax(14px, 1fr))` + `aspect-ratio` 就够；未来的空格是**空心虚线格**而不是填色的 0。它换过三次形态、每次都被数据密度打脸（摊平到 1150px → 22 格时成一排看不见的点；固定 14px 列流 → 174 格时溢出卡片；`auto-fill` 换行 → 能自适应但「格数随粒度变」本身就是错的设计）。**教训**：格数会随时间粒度在 22–174 之间晃，说明**它不该跟着那个粒度走** —— 定死语义（「当月每天」）比调 CSS 更根本。
- **轴上限别用粗阶梯**。1-2-5-10 会把峰值 10.8 亿抬到 20 亿，曲线只占下半张图；改成细密阶梯（1 / 1.25 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 6 / 8 / 10）后是 12.5 亿。

### 5.6 帧文档是模板字符串 —— 反引号必须转义（踩了三次）

`buildFrameDocument()` 返回一个 **JS 模板字符串**。在里面写**未转义的反引号**（哪怕只是在注释里写 `` `var(--x)` ``）会让模板提前结束，后面全部变成语法错误：症状是**空白帧**，且报错位置离真正的错误很远（指向模板中间某行）。我为此连续踩了三次，**其中两次是在给「上次踩坑」写注释的时候**。

**现在构建自己会拦**：`tools/build-font-css.py` 写完产物后用 node 解析一遍，**解析不过就退出非零**并给出可疑原因。别再靠肉眼找。同一条也适用于 `tools/render-frame-with-data.mjs` 里的 shim 模板——那里踩过一次，用 `node --check` 查。

### 5.7 验收要真的驱动交互，否则「验过」是假的

离线截图验收里，**只点标签页并不会改时间单位或图表模式**：

- `--unit hour` 与 `--unit day` 曾产出**逐字节相同**的截图（sha 一致）——等于根本没验小时档，而小时档正是有标签截断 bug 的那一档
- `--mode bar` 与折线的截图也曾逐字节相同
- 原因：帧总是从「天 / 折线」开始；而且**点单位会重新进入加载态、把内容重画成骨架屏**，所以模式按钮要**等第二次**才点得到

判据：**两张应当不同的截图如果有相同的 sha256，就是没验到**。`tools/render-frame-with-data.mjs` 现在会分两轮等待并分别点击，截图前请先核对 sha 确实不同。

### 5.8 平滑曲线必须**单调**，不能过冲

折线要做成平滑曲线时，第一反应会选 **Catmull-Rom**——它过冲。对非负数据（token 用量），过冲意味着**曲线画到轴下面**：日视图真的在 03:00–04:00 画出了负 token，而两张正数之间的曲线看着还很「顺」。

正解是 **Fritsch–Carlson 单调三次插值**（Monotone cubic）：曲线经过每个数据点、没有尖角，且**保证落在数据自己的范围内**——不高于最大值，不低于最小值。

**这类 bug 截图不一定看得出来**（曲线只是稍微鼓出轴外），所以要**采样断言**：`tools/test-chart-path.mjs` 把贝塞尔控制点读回来按 t 采样，断言不越界。凡「画出来的东西要满足某个几何性质」的，都该这么测。

### 5.9 渲染器/构建脚本里的模板字符串有两重雷

`tools/render-frame-with-data.mjs` 的注入 shim 是 **Node 侧的模板字符串**，于是：

- **`${...}` 会被求值**——写成 `${window}` 会去求 Node 里不存在的 `window`，抛 `ReferenceError`，症状只是「工具崩了」
- **反引号会终止字符串**——**连注释里都不行**

而且这两个雷**在给自己写「别踩这个坑」的注释时最容易踩**（我踩了）。写注释时不要复述字面量，用「windowName 而非浏览器全局名」这种**不带符号**的说法。改动后跑 `node --check`。

帧文档本身（`buildFrameDocument` 的返回值）同样如此，`tools/scan-frame-backticks.mjs` 专门扫它——注意扫描器要**用已知的结尾标记**定位模板终点，不能用「第一个未转义反引号」，否则遇到内部反引号会误判为正常结束、报出假的 PASS（这个假 PASS 我踩过）。

### 5.10 自然时间窗口 ≠ 「最近 N 个桶」

「今天的 24 小时 / 本周 7 天 / 本月各周」和「最近 24 个小时」是两回事：**未到的时段必须留空（`null`），不能填 0** —— 未来的小时不是「用量为零」，填 0 会凭空造出一段掉到轴上的塌方；**窗口内每一格都要输出**，哪怕没数据（安静的一天是真实的 0，x 轴要保持形状）；月窗口按**自然月切周**（1–7 / 8–14 / …），不是 ISO 周。逻辑写成**纯函数并注入 `now`**（`lib/usage-window.mjs`），边界才可断言：`tools/test-usage-window.mjs` 覆盖月首/月末/周一/周日/28 天月/31 天月。

### 5.11 多序列图要有上限，且**合并是求和不是丢弃**

窗口内模型数会超过可读范围（本机月视图 16 个），超过 8 个时把尾部合并成「其他模型（N 个）」。**合并必须求和**，否则图例数字加起来不等于总量，用量**静静地少算**。`tools/test-usage-window.mjs` 断言了「合并后的总和 == 真实总和」。

### 5.12 `srcDoc` 必须是稳定值 —— 它一变，整个 iframe 重载

**这是「一直卡在正在统计用量…」的真凶。** `srcDoc: buildFrameDocument(FONT_FACE_CSS, theme)` 每次渲染都新建一个 **394 KB 字符串**，React 按值比较 `srcDoc`，字符串一变就当作新文档**重新加载 iframe** —— 正在跑的 fetch 连同已解压的进度一起作废。黑匣子证据是 `frame-boot` **出现两次**。修法：文档**构建一次**成模块级常量（`FRAME_DOCUMENT`）；主题不再进这个字符串（写在帧的根属性上，见 §5.5）。**判据**：连续渲染两次，`srcDoc` 必须**逐字节相同** —— 对象身份检查抓不到，要比较字符串。

### 5.13 冷启动 20 秒：几乎全在解压，而结果只有 3 MB

本机 200 个日志、220 MB：解压 zstd 占 **18,012 ms**，解析占 2,378 ms，解析后只有 **3.1 MB**。`lib/usage-cache.mjs` 按 `(size, mtimeMs)` 缓存解析结果 —— **实测 20,889 ms → 144 ms（145 倍），逐位一致**。三条必须记住的：**① `modelRouting` 是 Map，而 `JSON.stringify` 把它变成 `{}` 还不报错** —— 读回来是普通对象 → worker 抛错 → 被 per-file catch 吞掉 → **整个文件算 skipped，数字全变 0**，必须显式转成条目数组。**② 缓存要带版本号** —— 解析逻辑一变，旧缓存格式合法但**内容是错的**。**③ 缓存必须 soft fail** —— 缺失/损坏/写不进去/版本不符一律退化成冷启动，**绝不能退化成错数字**。

### 5.14 预热是安全的 —— 前提是「在 worker 里」+「延后」

早期预热崩过 DSH 两次（§5.2），但**崩的原因是「在宿主主线程同步跑」**，不是「预热」本身。现在 `apply()` 里的预热：**在 worker 里**跑（最坏停顿 **19 ms**，旧的同步版是 5900 ms）、**延后 15 秒**、**可取消**（走 `ctx.effect`）、失败**只记录不抛**。**判据**：`tools/test-event-loop-responsiveness.mjs` 把预热也纳入预算 —— **预热和请求用同一个 1 秒停顿上限**，谁把它挪回主线程，测试会指名道姓报出来。

### 5.15 无头浏览器永远报 `prefers-reduced-motion: reduce`

**这一条差点让我去「修」一段完全正确的 CSS。** 动效验收脚本报「`data-animate` 在元素上，但 `animationName` 一直是 `none`」。实际是**无头 Edge 恒定报告 `reduce`**（实测 `matchMedia(...).matches === true`），帧里那条 reduce 媒体查询**按设计生效了** —— 「属性在、动画被抑制」不是 bug，是**无障碍分支被正确执行**。

三个连带的坑：**① `--force-prefers-reduced-motion` 不接受取值**——写 `=no-preference` 照样强制 reduce，那一轮标称 no-preference 却和 reduce 轮**产出逐字节相同的截图**（正是 §5.7 那条判据在起作用）。**② 想让动画真跑起来只能换实验设计**：把 reduce 块**从帧的副本里删掉**，其余一字不改 —— 删的是**另一个特性**（无障碍覆盖），不是被测对象。**③ 期望值不能写死**：报告必须**打印浏览器实际报告的值**再按它判定，写死的话浏览器默认值一变测试就开始撒谎。

现在 `tools/test-animation.mjs` 三个臂 **`as-is` / `reduce` / `motion`**，首行永远是实测值。`motion` 臂的证据是决定性的：mid-transition 采样到 `opacity=0 | anims=1` —— **说明动画正在跑**，不是仅声明。

**顺带修掉一个真 bug**：`data-animate` 原本**留在 DOM 上不清除**。清除用 `setTimeout` 而非 `animationend` —— **reduce 分支下动画是 `none`，`animationend` 永不触发，属性会被永久卡住**。

### 5.16 截图工具的四个静默失败

验收产物「看起来跑成功了、其实文件没写」有四种：**① `& msedge.exe` 立刻返回**（Edge 是 GUI 程序，PowerShell 不等它），下一行读文件就是「不存在」—— **必须 `execFileSync`**。**② 共用 `--user-data-dir`**：前一个 Edge 还没退干净，后一个撞 profile 锁→非零退出，而 **stderr 被 `stdio: 'ignore'` 丢掉**，看起来只是「截图没出现」—— 一个输出文件一个 profile。**③ Edge 会把启动移交给仍在退出的实例然后自己非零退出**：批量跑时随机少几张图，而**每一行输出都正常** —— 加一次重试。**④ 读完文件之后它才落盘**：同批命令里先截屏后算哈希，会算到旧文件或半写文件 —— **批量补图后要在新进程里复核哈希**。

现在的做法：`tools/shoot.mjs` 是唯一的截图步骤（`render-frame-with-data.mjs` 与 `render-hover-shot.mjs` 都调它），四个坑集中在那一处。**判据仍然是 §5.7**：一批应当互不相同的截图，哈希必须互不相同。

### 5.17 帧模板里的 `\n` 和反引号是同一族雷 —— 构建拦不住它

§5.6 讲的是**反引号**终止模板。**转义序列是同一个坑的另一半**，而且更隐蔽：

在 `buildFrameDocument()` 的模板字符串里写 `'…：' + x + '\n在左侧…'`，`\n` **先被模板字符串消费**，于是在**单引号串中间留下一个真实换行** —— `SyntaxError: Invalid or unexpected token`，整个帧脚本不执行，页面**只剩 tab 栏，内容全空**。

为什么比反引号更难查：

- `node --check` **看不到它**。帧脚本是**字符串**，构建只解析外层 bundle，帧内部的语法错误一路通关。`build-font-css.py` 报「bundle parses cleanly」是真的，只是它查的不是这里。
- 帧**自己的** `report()` 也报不出来 —— 语法错误发生在**定义 `report` 的那个脚本**里，整个脚本根本没跑。
- 宿主控制台什么也没有（帧是独立文档）。

**现在的三道门**：

1. `tools/scan-frame-backticks.mjs` —— 扫未转义反引号（已有）
2. `tools/check-frame-script.mjs` —— 把帧脚本抽出来编译一遍，**报出真实行号并打印上下文**（新增）
3. `tools/probe-frame-console.mjs` —— 真浏览器里跑，用覆盖层把帧的 `report()`、每个 `fetch` 结果、未捕获错误画在页面上

**判据**：改帧内一行 JS 之后，这三道都要过。只跑构建不算过。

### 5.18 这台机器上 `--dump-dom` 恒返回 0 字节 —— 别用它做无头断言

**实测**：本机以管理员身份运行，Edge 启动时打印 `Edge is running elevated: 1` 然后 `RunDeElevated: Started process` —— **启动器进程立刻退出**，真正渲染的是被降权的子进程。于是 `--dump-dom`（三种 headless 写法都试了）**恒返回 0 字符**，而 `--screenshot` 与 **CDP 完全可用**。

**正解**：证据走像素——`tools/probe-frame-console.mjs` 往预览文档注入覆盖层，捕获帧自己的 `report()`、每个 `fetch` 的状态与异常、以及 `window.onerror`，然后截图。本轮那个 `SyntaxError @1952:13` 就是这样一次定位到的（之前「推理」了半轮都没结果）。

#### 追加：限制只在 `--dump-dom` 这个开关，**不在无头模式**

**这条之前写得太强了**——那一版还写过「任何读 DOM 文本的无头脚本在这台机器上都会全部失败」，**不成立**。实测 `--remote-debugging-port=0` **会**写出 `DevToolsActivePort`，HTTP 与 WebSocket 端点都真实可连；所以**真实交互**（真鼠标、真键盘、console、未捕获异常、截图）在这台机器上**全做得到**。

`tools/cdp-driver.mjs` 即此路：Node 24 内置 `WebSocket`，**零依赖**。点击走 `Input.dispatchMouseEvent` 而非 `element.click()` —— 后者绕过命中测试，会漏掉被遮罩盖住的按钮，而那正是一个真实事故的形状。

**`agent-browser` 在本机起不来 Edge**（同样是降权导致的 `Chrome exited early without writing DevToolsActivePort`），连已运行的浏览器可以，但它自己的 daemon 在 Windows 上会挂住 —— 要驱动就自己写。

**teardown 必须走 CDP 的 `Browser.close`**：`spawn` 返回的那个进程**不是**真正持有 profile 的进程（它启动完就退出了），杀它等于没杀 —— 实测漏了 21 个 Edge 进程与两个删不掉的 temp profile。**端口文件被删掉时也别急着放弃**：用 `Get-NetTCPConnection -State Listen` 按 pid 反查监听端口，仍然能连上去优雅关闭。

### 5.19 无缓存读盘 > 带 stat 键的缓存（时间戳分辨率不够）

`luzzy-preset/lib/preset-store.mjs` 的提示词读取器曾经按 `(size, mtimeMs, birthtimeMs)` 做记忆化。**测完删掉了**：本机 NTFS 上 200 次「等长原地改写」，**144 次 stat 四元组完全相同**。一个字的修改（`猫` → `狗`）正好是这个形状：缓存把**旧提示词**送给模型，而页面显示的是新的，**任何地方都不报错**。

**判据**：正确性关键的小文件读取，不要建在时间戳分辨率上。成本是每次组装多读一次 ≤1 MB 的文件，可以忽略；而「安静地用错提示词」不可接受。（原子写会让 birthtime 变化，200/200 可区分 —— 但别依赖，它把正确性绑在了一个没写下来的耦合上。）

### 5.20 预设目录自成一体 —— 不要给它加 bundle 外壳

`~/.dsh/.agent-presets/<id>/` 里的组装**可以写同目录的相对路径行**（`name: ./lib/persona.mjs`），roster 按预设目录解析它。所以一个预设目录**不需要** `package.json`、**不需要** `cordis.patch.yml`、**不需要**注册进 profile 的 `dsh.profile.bundles`。

**证据**：本机 `liangshen` 预设用的就是 `./minimal-prompt.mjs` / `./tool-catalog.mjs`，而它的目录里**没有** package.json，profile 的 bundles 列表里也**没有**它 —— 它照样能跑。

我第一版给 `luzzy-preset` 配了完整的三件套（package.json + cordis.patch.yml + lib/index.js + profile 注册），对证之后删掉了：那些东西**只增加了一个会失败的安装步骤**。

### 5.21 `ctx.<service>` 会**抛异常**，不是返回 undefined —— 可选依赖必须走 `ctx.get()`

**这条让「预设」子页在真机上 100% 失败，而 4 个测试套件全绿。**

cordis 给每个 context 装了代理，`get` 陷阱对**调用方 fiber 没在 `inject` 里声明过**的服务名**直接抛**：

```
cannot get property "agents" without inject
```

`luzzy-page` 只声明了 `inject = ['webServer']`，所以 `ctx.agentPresets` / `ctx.agents` / `ctx.sessionProjections` **一读就抛**。更阴的是：

```js
// ✗ 这个守卫根本挡不住 —— 异常发生在「求值这个表达式」的时候
if (typeof ctx.agentPresets?.select === 'function') { … }
```

`?.` 只处理 `null`/`undefined`，**不处理 throwing getter**。于是「优雅降级」的代码路径一次都没走到，每个请求直接 500，页面上是 `预设读取失败 — {"error":"cannot get property \"agents\" without inject"}`。

**正解**：可选服务一律走 `ctx.get(name)` —— 它**返回 undefined**（cordis 自己的 session-controller 就是这么拿可选服务的）：

```js
function service(ctx, name) {
  try { return ctx.get?.(name) } catch { return undefined }
}
```

**为什么不写进 `inject`**：声明了就必须存在，缺一个整个插件拒绝加载。而一个没有 `agentPresets` 的部署，提示词编辑器**照样该能用**。

---

#### 更要紧的教训：**测试替身比被测系统宽松，就抓不到它该抓的缺陷**

4 个套件之所以全绿，是因为我的假 `ctx` 是**普通对象**，服务直接挂在上面 —— 比真实 cordis **宽松**。它在结构上不可能复现这个 bug。

现在两道测试都用**会抛的代理**（`test-preset-routes.mjs` 与 `test-host-routes.mjs`，后者跑的是**真的 `apply()`**），声明集合与插件的 `inject` 一致，抛出的文本与真实错误一字不差。

**判据**：凡是替身（stub / fake / mock）**比真实实现宽松**的地方，都是假绿区。写替身时先问「它哪里比真货宽容」，然后**把那个宽容收掉**。

同类可复用的形态：替身应当**复制真实实现的失败行为**，而不只是复制它的成功返回。

### 5.22 帧内**绝不能用原生 `alert` / `confirm` / `prompt`** —— 它们偷走窗口焦点且不还

**用户报的症状**：「点击后无反应，且输入框失效无法点击，我只能点击其他地方让 DSH 不处于第一窗口，再点回来才能激活输入框」。

**根因**：原生对话框是 **Electron 窗口的 OS 级模态框**，不是页面里的东西。关掉之后**键盘焦点不会还给 web contents** —— 从此点不动，直到用户切走再切回（那一步强制 OS 重新激活窗口）。**页面里没有任何办法修**：焦点从来就不在页面手上。唯一修法是**页面不使用原生对话框**。

做法：帧内自建对话框（`.dialogScrim` + `.dialog`），纯 DOM，因此**不可能**触发窗口级模态；继承帧主题、支持 Escape 与点遮罩关闭。三条细节：**关闭时显式 `document.body.focus()`**（原生对话框做不到的那一步，也是整个修复的落点）· **同时只留一个对话框**（否则两层遮罩叠着，下层按钮点不到）· **每条路径恰好 resolve 一次**（确认/取消/Escape/遮罩），否则调用方的 `.then` 永远挂着。

**判据（已写进 `tools/test-client-load.mjs`）**：帧模板里**任何** `alert(` / `confirm(` / `prompt(` 出现即失败 —— 这条断言故意做得很粗，因为一次疏忽就会退回这个 bug。`tools/probe-frame-console.mjs` 会真的驱动一次对话框往返，并打印对话框在文档内、焦点进了输入框、关闭后 `document.activeElement` 不是 NULL。

### 5.23 按钮要防「一次点击触发两次」

新会话按钮被点了一次，diag 日志里却有**两条** `preset-new-session-ok`（相隔约 5.7 秒），用户得到了两个会话。

**`disabled = true` 不足以防住**：它只在元素重渲染之后（或点击被拿去和状态比对时）才挡住指针事件，而**快速双击**或「点击 + 在已聚焦的按钮上按回车」能在任何重渲染发生之前**两次**进到处理函数里。

**做法**：模块级 in-flight 标志，进处理函数第一件事就是查它：

```js
if (newSessionInFlight) return
newSessionInFlight = true
// …完成后复位
```

凡「点了会产生一个东西」的按钮（新建会话 / 新建资源 / 提交），都该有这一道。

### 5.24 「新建会话」必须在**客户端**做 —— 宿主侧建出来的会话**不可能显示**

**症状**（用户原话）：「新建会话始终无法在 DSH 内显示该会话」。建成功了、有成功对话框，侧栏里就是没有。

**两个独立的结构性原因，缺一个都足以让它隐身：**

1. **`sessionController.create` 只从 `workspaceId` 挂工作区**（传 `cwd` 会建出一个不属于任何工作区的会话，不进 `sessionIds`）；而侧栏是**按工作区分组**列会话的。本机实测：那两个会话确实躺在正确目录下，却不在任何工作区里。
2. **空白会话只在「它是当前选中的那一个」时才渲染**（`sessionVisible` 要求 `!session.blank || id === current`）。新建的会话**按定义是 blank**。

**正解**：走应用自己的客户端路径，两步都做 —— 侧栏的「新会话」按钮就是这么工作的：`sessions.create({ workspaceId })` **然后** `sessions.open(id)`。框架（iframe）自己做不到（选中是客户端状态，帧没有导航句柄），所以帧通过 `postMessage` 请求宿主半执行。

配套三点：**工作区 id 要用 `ctx.workspaceRegistry.resolveByPath(cwd)` 解析**（会话身上只有目录没有 id）· **预设切换放创建之后**（会话预设是创建时定的，空白会话是唯一允许切的窗口）· **请求要有超时**（否则按钮永远禁用；5 秒后报「宿主半没有回应，重启 DSH」）。

**判据**：`test-client-load.mjs` 断言「客户端侧执行 create」+「create 之后必须 `sessions.open`」；`test-preset-routes.mjs` 断言「传 workspaceId **且不传 cwd**」（互斥）。

**可复用的诊断**：`tools/probe-workspace-attach.mjs` 直接读 `~/.dsh/storages/workspace.json`，列出每个工作区的路径与 `sessionIds`。**「会话建出来了但没显示」这类问题，从这里看是几秒钟的事** —— 注意记录在 `tables.workspaces` 下。

#### 追加：**整条 create 路径必须都在客户端**

第一版把工作区解析放在**宿主路由**，于是必然出现窗口期：客户端热重载、宿主不重载，页面调用了宿主**从没听过**的操作。**这不是「忘了重启」，是设计错误**。**判据**：凡是**客户端能拿到**的数据就别让宿主参与 —— 宿主参与意味着一次重启的耦合，而重启窗口期内页面是坏的。

#### 追加：一次 `postMessage` 里放了两种对话 → 会话 id 被清空

同一来源下有两种消息，帧的监听器**只按来源判断**，于是创建结果被读成「你的会话是 null」。**判据**：同一来源、同一 type 缺省的消息通道，等于没有协议。**每一条消息都要有 type，接收方逐个分派**。

### 5.25 AOCI：`Set-Content -Encoding UTF8` 的 BOM 会让它判 JSON 非法

给 AOCI 任何 JSON 输入文件时，**不要用 PowerShell 的 `Set-Content` / `Out-File -Encoding utf8`** —— 它们写 **UTF-8 BOM**（`EF BB BF`），而 AOCI 把带 BOM 的 JSON 判为非法：

```
Managed Scope 失败：managed_scope_candidate_set_invalid
```

**这个错误一个字都不提 BOM**，所以看起来像 schema 写错了，于是会去猜字段名——我为此连试了四种字段组合，全都被同一个 BOM 挡住。正确写法：

```powershell
[System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
```

同族的坑也出现在 `aoci-loop.mjs` 里（已修：读之前 `replace(/^\uFEFF/, '')`）。

**判据**：跨工具传 JSON 一律先验前三个字节。`Get-Content -Raw` 会**隐去** BOM，所以「读回来看着正常」完全不能证明文件里没有 BOM——必须 `[System.IO.File]::ReadAllBytes()` 看字节。

#### 追加：认知覆盖只能由人减少 —— 自动批准会被明确拒绝

要减少 AOCI 的索引覆盖（例如把 16 张截图移出 Index），**四条自动路径全部被挡**，而且理由各不相同：

| 路径 | 机器的回答 |
|---|---|
| `aoci_remove_entry` | `volume_read_only` —— 该工具不改 Volumes v1 正式认知 |
| `scope authorize`（policy_bound_auto） | `cognition_coverage_reduction_requires_independent_review, p0_or_p1` |
| `scope approve` | 要求在**真实 TTY** 里精确输入 `APPLY MANAGED SCOPE <plan_id>` |
| `curation stage` | 要机器签发的 `plan_id`，而 PNG 类特殊文件拿不到候选批次 |

**这不是障碍，是设计**：减少认知覆盖必须由独立的人复核。**不要试图绕过**（不要伪造 approval artifact、不要为了绕过而改 config）。正确做法是把命令和 plan_id 交给用户，由他在终端里确认。

**完整可复现的四步序列与那个 plan_id 在 `docs/STATUS-LuzzyPage工作节点.md` §十五** —— 那里有本仓库的真实值，**别在这里抄第二份**（会漂移）。两条只说一次的坑：**`scope preview` 是只读的**，它把完整 preview 打到 stdout，必须自己重定向到文件（`--preview-file` 在任何子命令里都是**输入**，把它当输出用只会拿到 `command_failed`）。

#### 追加：全局 MCP 绑的是**另一个仓库**

`~/.dsh/profiles/desktop/cordis.patch.yml` 把 AOCI MCP 的 `--repo` 写死成 `D:\.NekoTool\LuzzyRP`，所以会话里的 `aoci_*` 工具**全部作用在那个仓库上**（实测 `runtime_repository_root` 确认）。**别拿它给本仓建索引**，会写错仓库。

本仓走 `luzzy-page/tools/aoci-mcp-client.mjs`：用同一个二进制、`--repo` 指向本仓、另起一个 stdio 服务，**不改任何全局配置**。CLI 创作路径对 Volumes v1 不可用（报「该命令或兼容写入路径不支持修改Volumes v1正式认知」），所以 MCP 是唯一的写入面。

### 5.26 `lib/client.js` 是产物 —— 构建脚本坏掉时，**先修构建，不要绕过**

`python tools/build-font-css.py` 一度**必然失败**：

```
error: missing source font D:\.NekoTool\LuzzyRP\app\src\main\res\font\puhuiti_55_regular.ttf
```

LuzzyRP 的 `res/font` 里现在只剩三个 Alibaba Sans，两个普黑体 TTF 没了。**这个失败是静默的** —— 不改 `src/` 就没人会发现，而改了 `src/` 的人会看到 `lib/client.js` 没更新。

**处置**：该项目的资源树里同名 WOFF2 还在，且 **`pyftsubset` 能直接吃 WOFF2 输入**（实测）。构建加了兜底路径（`--fallback-font-dir`）—— **TTF 仍然优先**，原文件回来就自动用回它。兜底用的是**同一个字体的另一个文件名**（普黑体编号即字重：55 = Regular、85 = Bold），不是换了一个字体。

**判据**：`lib/client.js` 的 mtime 必须晚于 `src/client.js`。只改 `src/` 不重建，运行的就是旧代码。

#### 追加：给模板字符串改代码时，**连注释一起过扫描器**

这一轮我在**给「这里是正则不是函数」写解释性注释的时候**，用了一个裸反引号，构建当场拒绝：

```
error: the built bundle does not parse — Unexpected identifier 'marker'
```

与 §5.6 记录的两次**完全同型**（那两次也是在给坑写注释时踩的）。这不是巧合：**解释性文字里最自然地会引用代码字面量**，而反引号正是最顺手的引用符号。

所以：**改完帧内任何一行，跑 `node tools/scan-frame-backticks.mjs`**，不要等构建来告诉你 —— 构建只报第一处，扫描器一次列全。

#### 追加：iframe 的 `fetch` 拦不住 —— shim 必须注入帧文档内部

截图脚本第一版把 route stub 装在了**父窗口**，帧照样渲染出「预设读取失败 — Failed to fetch」。原因是 §5.5 那条的同一族：**iframe 是独立文档**，有自己的 `window`，父窗口覆盖 `window.fetch` 对帧内调用**毫无作用**。正解是把 shim 注入帧文档自己的 `<head>` 里。**判据**：任何「给帧提供假数据」的脚本，检查注入点是帧文档还是父文档 —— 装错位置时**没有报错**，只有页面上的一行错误状态。

#### 追加：断言错位置也会制造假失败

截图脚本曾报「预览没有渲染标题」，而当时是**编辑模式** —— 预览元素 `display:none`，断言它的内容等于检查一个用户看不见的面板。**判据**：一个「失败」先问「这个断言在当前的可见状态下是否成立」，再问代码有没有坏。假失败比真 bug 更费时间。

### 5.27 **参考里已经有对口组件时，「帧内实现不了」必须先当成待验证的假设**

给预设编辑器做 Markdown 工具栏时，我读了 `reference/lobehub/src/features/EditorCanvas/TypoBar.tsx` —— **它本身就是图标工具栏**，我甚至在测试里引用了它。**然后我交了另一个版本**：文字标签按钮，并在注释里论证「帧内没有图标集，标签是诚实版本」。

**那个论证是错的，而且从没验证过。** 用户发来参考截图后，我手写 13 个 SVG path、约 40 行、**零依赖**就做到了。§一 的原文已经写了答案：*找不到对应物时先问、先找，不要自己发明一个。*

**规则**：

1. **把「做不到」当假设去证伪**，不要当结论。最小验证通常 10 分钟。
2. **受限必须能说出具体失败**（哪个 API 不存在、哪行报什么错），不是「应该不行」。
3. **警惕一个正确结论顺手掩护一个错误决定**：「不给下划线按钮」是对的（Markdown 没语法 + 渲染器不放行裸 HTML），但我把它和「所以用文字标签」绑在同一段论证里 —— **前者为后者背书，让后者看起来也验证过了**。**独立结论分开论证。**

**判据**：写下「做不到」之前问一句「我试了吗，失败信息是什么」。答不上来就是猜测，而猜测的代价是把第一条硬约束整个绕过去。

### 5.28 **「实时预览」是渲染形态** —— 先看清参考里那个模式到底叫什么

**同一件事我连错两轮**，所以判据写死：**渲染面里不得出现任何 Markdown 标记字符**。

| 轮次 | 我做的 | 错在哪 |
|---|---|---|
| 一 | 左右分栏（左源码 / 右渲染） | **参考里没有分栏** —— 我发明的 |
| 二 | 单栏，但标记**保留只是变淡** | 那是上色，不是预览 |
| 三 | 单栏，标记**消失**，格式是真的 | ✔ |

**参考里的答案只有一行**（`agent/profile/features/EditorCanvas/index.tsx`）：

```ts
type PromptEditorMode = 'source' | 'visual'   // 默认 'visual'
```

**两个模式都是单面**：`visual` 是所见即所得（标记不出现），`source` 才看原始标记。**没有第三个「并排」模式。**

**规则**：需求里的名词**先到参考里找它的定义**。「实时预览」我按字面理解成「同时显示预览」，而它是**模式名**。**同一个词在参考里可能已有确定所指，别按字面自己发明一个。** 界面形态（分栏 / 单面 / 抽屉）尤其要先查 —— 参考里通常只有一个答案，而且往往有理由（分栏把正在写的东西宽度砍半）。

#### 追加：渲染面即可编辑面

contenteditable 的渲染面 + 源码模式的 textarea，**三种模式各只有一个面**（比「镜像层」简单也更对）。**真正的难点是回写**（HTML → Markdown 是唯一会损坏提示词的方向）：只在真实编辑时回写；只认渲染器自己产生的语义标签，未知元素降级为文本而不整块丢弃；粘贴强制纯文本；契约是**结构保真不是字节相同**。**已实测一个真丢内容 bug**：引用块是裸文本而序列化器只遍历元素子节点 → **整行引用被静默丢掉**；单元套件测不到（替身 DOM 恰好建出带文本子节点），**只有真装置抓得到**。

### 5.29 **合成事件证明不了「能操作」** —— 输入必须走真点击 + 真按键

**用户报的原文**：「实时预览可行了 却无法编辑，输入时始终顶格 无法编辑其他段落」。

**两个症状，一个原因。** 那一行是：

```js
document.querySelectorAll('[data-mode]')   // ✗ 把区域本身也选中了
```

而区域自己就带着这个属性（模式标签写在 `#presetArea` 上）。于是**在编辑器里点任何地方**，点击都冒泡到区域，触发它自己的**「切换模式」处理函数**：

```js
visual.innerHTML = renderMarkdown(promptText)   // 重渲染 → 光标没了
visual.focus()                                  // 重新聚焦 → 插入点在位置 0
```

**每次点击都把光标重置到文档开头** —— 打字永远顶格，也永远换不了段。修法：限定到 `.mdMenuItem[data-mode]`。

#### 真正的教训：**装置当时报 155/155 全绿**

原来那次「打字」是**合成的**：先 `focus()`、手工建 Range、`execCommand` 插入。**它跳过了真人做的每一步** —— 命中的点击、落下光标、真按键。**在一个用户根本打不进字的面上，合成插入照样成功**，所以它证明的是「这个函数能被调用」，不是「人能在这里打字」。

**判据：凡断言涉及「用户能不能操作」，就必须用真输入驱动**——真鼠标（`Input.dispatchMouseEvent`，坐标处先做命中测试）+ 真按键（`Input.dispatchKeyEvent`），**且中间不调 `focus()`**，那会毁掉正要测量的光标。

**并且断言位置，不只断言结果**：「有没有字符进来」太弱 —— 字符进到**错误的位置**同样是坏的。要断言**光标落在被点的那个段落**、**没有被拉回开头**、**第二次点击会换段**。

**反证是验收**：改回错的实现，新断言里 **4 条立刻失败**并报出用户原话。**不会失败的断言等于没写。**

#### 定位手段：**加对照组**，别先怀疑自己的工具

要区分「我的派发不对」还是「产品坏了」，**往同一个文档里插一个没有任何处理函数的可编辑块**，用**完全相同的派发方式**去点它：对照组光标落对 → **产品的问题**；对照组也落错 → **装置的输入有问题**，此时关于产品一个字都不能说。**没有对照组会走远路**：看到光标不对，第一反应是怀疑自己的 CDP 派发，而不是翻开页面代码。

#### 附带两个自伤（同一天）

探针第一版用**手写的 fetch stub**，提示词根本没加载、编辑器是空的 —— **「什么都编辑不了」和「什么都没加载」长得一模一样**，差点读成产品 bug。**给帧提供假数据要驱动真实的宿主路由**（起一个真 HTTP server），或至少**先把装载结果打出来**。

同一个 `apply()` 里的路由**注册在 `ctx.effect` 的回调里**。探针把 `effect` 写成空函数，于是**注册了 0 条路由**，页面报「预设读取失败 — no route」。**`ctx.effect` 替身必须真的调用回调**，否则插件在你的装置里根本没启动。

### 5.31 注入的消息**必须带 id**

少一个字段，**整个会话读不出来** —— harness 在**加载**日志时校验，一条没 id 就让整份日志作废。凡自己造消息对象，一律走**会铸 id 的构造函数**（核心插件用 `createUserMessage()` 就是这样）。守卫：`tools/test-goal-enforce.mjs` 断言 + `tools/prove-guard.mjs` 反证对照。**完整记录在 `docs/STATUS-LuzzyPage工作节点.md` §二十四。**

### 5.30 本轮纪律

六条（不存在的 token 比不写更糟 / 「工具说它拍的是 X」要自证 / 布局要量不要看 / 别把「只读了一半要求」记成「做不到」 / 验证「会失败」时要确认补丁真打上了、断言也可能空转 / cordis 的 `on`·`get` 是上下文自带方法不是服务）——**完整记录在 `docs/STATUS-LuzzyPage工作节点.md` 第二十二节**，那里没有字节预算。
---

## 六、动手前先确认

1. **前端页面不得重新设计、不得自主发挥 UI/UX**。参考项目的界面、视觉风格、布局、组件、交互方式与设计语言是既定设计；新增页面严格复用其设计系统与组件。动手前先完成 §一 的四份必读。
2. **插槽正文不要用宿主 React 的 hooks**——见 §5.1。要么 iframe，要么只用 `jsx`/`jsxs` 的纯渲染组件（无状态）。
3. **注册必须包在 `ctx.effect()` / `ctx.slots.inject()` 里**，否则卸载不回滚，热重载后残留。
4. **别把持久状态放右侧栏**——它只在内存里，刷新即失。
5. **读 `reference/` 里的东西是参考，不是引入**。把上游代码拷进本项目前，先过许可（见 §二 边界 2）。
6. **改完客户端代码必须重跑 `python tools/build-font-css.py`**——`lib/client.js` 是产物；只改 `src/` 不重建，运行的是旧代码（这个坑踩过一次）。

<!-- aoci:begin -->
## AOCI 仓库认知

AOCI 为本仓库维护一个稳定、可版本化、可增量更新的仓库级认知层，供模型跨任务复用对系统的理解。

`aoci.txt` 是面向模型的结构化认知索引。它以每个受管理文件、数据库表或其他受管理对象一条独立 Entry 的方式，用符号标签与 F/R/A/S 语义表达对象的核心职责、重要关系、对外契约，以及理解或修改系统时必须知道的非显然约束和设计决策。

Header、目录段和全部 Entry 共同组成完整仓库索引，可以覆盖前端、后端、配置、数据库结构及其他受管理内容。受管理内容发生变化时，通常只需维护受影响的认知条目，不需要重新生成整个索引。

AOCI 提供系统架构、对象职责、重要关系、对外契约和关键约束的高密度视图。

### 工作原理

AOCI 采用“模型生成、模型读取”的认知闭环。

Header、Entry 和 Curation 语义的创作只按当前机器签发的 Plan 与实时 Guide 执行；由 Host 模型基于当前绑定证据独立完成。

Entry 的语义必须来自模型对真实证据的理解。不得仅依据路径、文件名、扩展名、AST、符号列表、依赖扫描、正则、固定模板或规则引擎推导、预填、拼接或改写索引语义。

对 Fresh Bootstrap，只按当前机器签发的 Plan 和实时 Guide 执行。当它们要求创作时，Host 模型创作 Root、Meta、Tag 和 F/R/A/S，提供 authoring-run 声明，并把它绑定到 Plan、Evidence 与完整 Candidate。不得要求 AOCI 填写 `origin=host_model`、制造 Receipt 或把程序生成的 Framework 当作语义。本文件不自行重建 Onboarding 流程。内部批次不是用户决策；只有遇到既有批准边界或真实的安全、漂移、CAS、Recovery 条件才停止。

### 最小使用入口

- `aoci_rules`：取得当前AOCI版本的会话运行合同。
- `aoci_overview`：建立或恢复本仓库的完整认知。
- `aoci_maintain`：受管理对象达到最终稳定状态后检查认知是否需要维护。
- `aoci_update_entry`：提交与当前证据和源码摘要绑定的完整语义更新批次。
- `aoci_report`：仅当当前布局和工具状态支持时，在证据不足、无法可靠生成语义时登记待办，不猜写。

其他MCP工具、CLI命令、参数和专项流程，以当前工具说明、Guide和 `--help` 返回内容为准，不在本文件中重复完整手册。

本区块只规定仓库接入、认知使用和收尾原则。`aoci_rules` 承载当前会话合同，Guide实时输出承载当前Plan的执行顺序与停点，工具Schema、Spec和Validator承载机器结构与判据；Prompt、Description、README和静态文档不能覆盖这些机器事实。

### 建立、生成和恢复认知

1. 每个新的 Agent Run 开始时，应先判断：

   - 本仓库是否已经存在可用的完整AOCI索引；
   - 当前上下文中是否已有与本仓库根、当前索引版本和当前AOCI服务相匹配，并且模型仍可可靠使用的完整仓库认知。

2. 仓库已经存在可用的完整索引，但当前Run没有可靠完整认知时，先调用 `aoci_rules`，再调用 `aoci_overview`。

   完整认知仍可靠时直接复用。局部不确定本身不要求机械重读系统全貌。

   本Run从已知Host上下文压缩恢复时（包括宿主注入的压缩摘要），必须把此前模型认知视为不可靠。压缩handoff不得保留或摘要正式Whole-Index，也不得保留或摘要任何Overview Header、Entry、Chunk、Challenge或Attestation正文；只能保留安全续接所需的receipt身份、未完成write或Recovery状态，以及立即重载指令。复制进handoff的Whole-Index语义或receipt不能证明恢复后模型的当前认知可靠。若当前上下文已无法可靠保留运行合同，先调用 `aoci_rules`。继续业务任务前，使用 `refresh_reasons=["context_compaction"]` 和新的 `refresh_event_id` 调用普通完整Whole-Index `aoci_overview`（不设置 `check_only` 或设为false）；不得使用 `check_only` 或认知probe。原样跟随每个 `next_cursor` 直到 `completed=true`，确认交付，并且只基于新交付正文提交一次Attestation。完成这次新的完整传输后，即使Attestation为partial或fail也消费该generation，并按既有合同继续source-bound任务，不再自动调用第二次Overview。

   AOCI可以针对 `context_compaction`、项目 `cognition_refresh_threshold` 下的机器 `semantic_threshold` 或主要 `phase_transition` 提供checkpoint与认知状态事实。只需要这些紧凑事实时使用 `check_only=true`；这些事实只向Agent提供建议，不替模型决定是否需要系统全貌。

   Agent显式调用普通 `aoci_overview`（未设置 `check_only` 或为false）时，只要能形成一致的CognitionSet，AOCI必须完整交付请求scope。不得因为已有receipt、阈值未达到或没有待处理刷新原因而抑制正文。正式认知Dirty或Stale时仍交付正文，但必须标记不可靠。存在未决恢复或无法形成一致snapshot时失败关闭，不返回混合正文。

   普通Overview返回 `continuation_required=true` 时，必须原样提交 `next_cursor` 并自动继续到 `completed=true`。不得询问用户、开始业务任务或给出阶段性系统结论。Host截断、缺块、重复、乱序、cursor失败、Index变化或`chunk_tokens`变化时停止本次认知链。Attestation完成前不得用Memory、源码、Spec、`aoci.txt`、历史会话、scope、search或Entry读取修补或补充Whole-Index认知。Challenge ordinal是正式Entry序列中的1-based位置；Header内容、注释、空行、Section/Overview/Chunk Marker、Receipt与Metadata均不计数，Chunk Receipt ordinal使用同一序列。Attestation必须原样回绑本次Challenge发布的当前`index_sha256`、`entry_sequence_sha256`与`entry_count`；旧Index、旧Entry序列、旧数量或旧Attestation均无效。完整链结束后只正式提交一次既有模型认知Attestation；同一响应只允许一次不改变语义答案的JSON Schema或字段格式修正。对象、Tag或F不匹配即失败且认知吸收不确定，不得语义重试或旁路补答。首次认知失败时还不得执行Root/Meta、Migration、全局布局或其他未重新绑定的系统级决策。上下文压缩刷新若传输完整、认知身份不变、治理对齐且没有Recovery或第三方冲突，即使Attestation为partial或fail也消耗该refresh generation，并继续原任务，不再自动重读Overview。`system_mastery_percent`只自评系统框架——架构、职责、强关系、稳定外部契约以及高熵安全和维护约束——不表示完整实现或运行实况知识；机器索引覆盖率必须分开。默认只向用户输出由本次真实覆盖率、Challenge、块数、Token和掌握度生成的规定成功或失败一句话。Host截断时提示用户把 `overview_delivery.chunk_tokens` 设置为更小的合法值后重新开始，不得自动修改。

   加法认知等级必须与严格证明字段分开解释。`delivery_verified`表示已加载Index且Host交付已确认，但完整认知验证仍未完成；应表达为“已加载且交付已验证”，不得描述为“没有认知”或“没有理解系统”。`cognition_verified`要求Attestation通过（Challenge至少80%的ordinal完全正确且对象身份至多失手一处），`cognition_governed`还要求治理对齐。通用完整读取失败句只用于真实交付故障。

   当Overview响应包含可选`cognition-state/v2`投影时，必须分别解释各维度。其Level止于`model_cognition_usable`；`strict_attestation_verified`、`governance_aligned`与`current_system_cognition_reliable`都是独立状态，绝不参与该Level。ordinal、对象身份、Tag或核心F不匹配可以导致严格Attestation失败，而模型认知仍然可用；不得仅凭这种不匹配就宣称模型没有理解系统。只有`current_system_cognition_reliable=true`允许无保留地声称当前完整系统认知可靠。投影缺失时继续使用上述Legacy解释。

   普通的只读审计、分析、检查、不修改代码或不提交、不push，不自动等于严格零写入，也不改变上述认知有效性判断。Codex Memory和历史Skill只能辅助恢复经验、用户偏好与调查方向，不能替代与当前仓库根、索引摘要、AOCI服务身份和认知范围匹配的当前认知收据；项目AGENTS和当前AOCI身份在AOCI状态上优先于历史Memory。

   只有用户明确禁止Ledger、元数据、`.aoci`运行资产及任何文件写入时，才按严格零写入处理。若必要的认知建立与该边界冲突，必须报告冲突并请求用户裁决或建议使用隔离副本，不得静默以Memory替代当前仓库认知。

3. 仓库没有可用的完整索引，或当前只有最小骨架、Header不完整、Entries未完成、必要Curation尚未裁决时，如果需要建立正式完整AOCI索引，先取得 `aoci_rules`，然后进入当前AOCI Guide。由Guide依据仓库真实状态决定下一阶段并完成必要安全步骤。

   `aoci_maintain` 不替代索引建立流程。

   不在本文件中自行重建或硬编码完整索引生成状态机。

4. 在长程任务中，模型负责保留当前认知收据并正确使用刷新门禁：

   - Host报告上下文压缩或模型已知系统全貌丢失时，执行上述强制 `context_compaction` 重载规则；AOCI不能自行推断Host事件；
   - 进入真正的主要阶段时声明 `phase_transition`，不得把函数、测试运行或小步骤当作阶段；
   - 在有用的稳定检查点通过 `check_only=true` 取得机器语义计数；
   - 除已知压缩的强制重载外，由Agent判断当前任务是否需要再次显式获取指定scope或完整Overview；
   - 在维护和对齐完成前，保留AOCI报告的Dirty或Stale可靠性状态。

### 任务收尾与认知维护

5. 纯只读问答、分析、版本核验，或没有产生受AOCI管理对象变化的任务，不需要调用维护工具。当前AOCI版本是任意`aoci_overview` check_only或`aoci_maintain`响应里的`cognition_receipt.mcp_service_version`；二进制路径是项目`.mcp.json`里的`command`，CLI不必在PATH上。

6. 发生受AOCI管理对象变化时，待其达到本次任务的最终稳定状态后，只调用一次 `aoci_maintain`。不要在每次中间修改后逐文件维护。

7. 若维护结果返回真实语义候选，Host 模型必须基于每个候选绑定的对象和必要证据，独立创作完整标签与F/R/A/S更新。通过 `aoci_update_entry` 一次提交当前机器签发批次的完整候选集合，同时原样保留每项 `source_sha256`、`candidate_id` 与对应domain批次身份。`max_entries`只限制单次请求和原子事务，不限制logical plan、Whole-Index或Managed Scope。`remaining`非零时，在当前批次成功Apply后重新调用Maintain并从新preimage继续；绝不能为满足transport上限缩减Index覆盖或自行截取返回批次。

   没有足够证据且当前布局支持 `aoci_report` 时，使用它而不猜测、套用模板或为消除待办而生成缺乏证据的认知。

8. 必须遵守工具返回的结构化状态和安全边界：

   - `repair_required`：只修复明确命中的候选，再重新提交当前机器签发的完整批次；
   - `stopped`：结束当前写入尝试并检查 `failed_step`、错误、正式写入证据与Recovery。auto模式下，已证明零写入则记录closure并重新Plan；完整Intent和可证明postimage则Resume；策略要求Rollback且preimage可证明则精确恢复后重新Plan。只有证据不足、第三方正式字节冲突、需要审批或外部动作，或命中其他真实安全边界时，才停止整个用户任务；
   - 冲突、审批、人工裁决、权限和安全信号不得忽略；
   - 已经对齐后不得重复维护或重复写入；`refresh_ready_for_overview` 是checkpoint事实，由Agent决定是否为下一阶段请求普通完整Overview。

   维护完成后如果又修改了任何受管理对象，之前的维护结果失效，应在新的最终稳定状态重新完成收尾。

9. 用户只限制业务文件范围，但没有明确禁止仓库托管资产时，AOCI托管资产可以在收尾阶段为保持认知一致而更新，并应在审计和提交中与业务文件区分。

   用户明确禁止修改 `aoci.txt`、`.aoci`、元数据或任何额外文件时，以用户限制为准，不得写入，并如实报告剩余不一致。

### 专项流程

初始化、完整索引生成、Header生成、Entries生成、数据库结构索引、Curation、人工评审和故障恢复，只按当前AOCI Guide或工具在对应阶段返回的指令、命令和安全停点执行。

不预加载、不猜测，也不自行重建这些专项流程。平台调用方式、请求格式、批次上限、审批规则、索引格式细节和恢复步骤由对应Guide、工具说明、模型Prompt和CLI帮助按需提供。
<!-- aoci:end -->
