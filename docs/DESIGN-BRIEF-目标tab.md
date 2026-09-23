# 目标 tab · 设计规格（build spec）

**范围**：在 LuzzyPage 的 4-tab 条（说明 / 用量 / 预设 / **目标**）里新增「目标」tab。
**目标产物**：`luzzy-page/src/client.js` 内 `buildFrameDocument()` 模板字符串里的 vanilla HTML + CSS + 原生 JS。
**依据**：`reference/lobehub/DESIGN.md`、`DESIGN.dark.md`、`skills/luzzy-roster-design`（基线五条）、`skills/luzzy-roster-design-react`（React 子项三条）、`luzzy-page/src/client.js`、`docs/DESIGN-REVIEW-LuzzyPage.md`。
**读法**：`DESIGN.md` 的 § 名按原文标题引用。凡标「**项目既有**」的，来自本仓已实施的读数，不是 DESIGN.md 原文。

> **一处必须先读的边界**：`luzzy-roster-design-react` 的三条子项产物（shadcn/ui、Vercel `web-design-guidelines`、Anthropic `frontend-design`）全是 **React/JSX/Tailwind 专属**——它们讲的是组件组合、`className` 工具类、JSX 约束。本 tab 是 iframe 里的纯 HTML+CSS，**三条整体不适用**：无 JSX、无 className 工具链、无组件树。它们唯一能借的是一条通用原则——「用系统既有的东西，别现造」。**不要为了让 React 规范「落地」而在帧里造组件抽象层。**

---

## A. 对新 tab 生效的硬规则（纯 HTML+CSS / iframe 语境）

| # | 规则 | 出处 | 对这个 tab 的具体含义 |
|---|---|---|---|
| A1 | **读语义 token，不硬编码任何单值** | `DESIGN.md §Do's and Don'ts`「Don't hard-code hex values from this file」；`DESIGN.md` frontmatter「components must read the semantic tokens」 | 帧里**已经**这么做了（`var(--dsw-*, 兜底)` 模式）。新 tab 每一条颜色都走 `var(--dsw-alias-*, 兜底)`，兜底值只是 fallback，不是来源。**例外**：本仓 `docs/DESIGN-REVIEW-LuzzyPage.md §三` 记录过违规前例——`#c084fc` 是「唯一来源」而非兜底，被点名为必须删。别复现。 |
| A2 | **两套主题各自定义 token**（iframe 硬约束，DESIGN.md 未覆盖） | **项目既有**：`AGENTS.md §5.5`、`client.js:95-128` 注释 | CSS 自定义属性**不跨 iframe 文档边界**。新 tab 用到的每个 token 必须在 `:root` **和** `:root[data-theme='dark']` 两块里都有值。少一个 = 该 token 静默回退到兜底，暗色下整块还是浅色，**不报任何错**。 |
| A3 | **token 名必须在 DSH 前端 CSS 里真实存在** | **项目既有**：`AGENTS.md §5.5`（`--dsw-alias-bg-skeleton` 是凭空写的） | 新增 token 前，到 `dsh-web-frontend/dist/**/*.css` 里搜名字。**已核实的现存名单**（本机 `index-DPX2bQLO.css`）见 §D 表。`--dsw-alias-bg-skeleton` 确实**存在**于主题层 `dsh-client-ui-theme/lib/client.js`（`#0000000a` / `#ffffff14`），但**不在**前端 dist 的可用面里——按 A3 一律不引入。 |
| A4 | **四态齐全：空 / 加载 / 错误 / 成功** | `DESIGN.md §Do's and Don'ts`「Don't ship only the happy path」；`DESIGN-REVIEW §四` 把四态列为「值得保留的」 | 目标 tab 必须有四态。帧已有 `.status`（空/错误/加载）与 `.skeleton`（加载）词汇，**直接复用**。 |
| A5 | **状态不能只靠颜色** | `DESIGN.md §Do's and Don'ts`「Don't signal state with color alone — pair it with an icon or label」 | 目标状态（已确认 / 待处理 / 受阻）必须是**颜色 + 文字**。只染个色 = 违规。 |
| A6 | **一个视图一个 primary** | `DESIGN.md §Components`「one primary (`colorPrimary` fill) per view」；`DESIGN-REVIEW §5.2` 第二层第 8 条 | 目标 tab 里 `.btnPrimary` 最多一个，且是「最重要的那个动作」。帧的 `.btnPrimary` 是 DeepSeek 蓝实底（`--dsw-static-deepseek-500`），不是 `colorPrimary`——**沿用帧的既有做法**，别另造。 |
| A7 | **`:focus-visible` 必须有可见焦点环** | `DESIGN.md §Do's and Don'ts`「show a visible `:focus-visible` ring」；`§Components` | 帧的统一环是 `outline: 2px solid var(--dsw-static-deepseek-500); outline-offset: 1px`。新 tab 每个可交互元素都要有，**别漏**（`.rosterGroupDel` 那种悬停才出现的按钮也算）。 |
| A8 | **WCAG AA：正文 4.5:1** | `DESIGN.md §Do's and Don'ts` | 暗色下状态色要实测对比度。**项目既有警告**：`DESIGN-REVIEW §二 L4` 记录暗色下 `已保存` 的绿（`#287`）在 `#0d0d0d` 上对比度偏低——新 tab 别重复这个错。 |
| A9 | **`colorBg*`（表面）与 text/`colorFill` 尺度不互换** | `DESIGN.md §Do's and Don'ts`「Don't swap a surface token for a text token」 | 卡片底用 `--dsw-alias-bg-layer-1`，文字用 `--dsw-alias-label-*`。悬停洗色用 `--dsw-alias-interactive-bg-hover`。三者别混用。 |
| A10 | **圆角不混用** | `DESIGN.md §Do's and Don'ts`「Don't mix rounded and sharp corners」；`§Shapes` | 见 §E。 |
| A11 | **四态与两主题都要验** | `DESIGN.md §Do's and Don'ts`「Don't treat mobile or dark as an afterthought」 | 验收要出**浅/暗 × 四态**的截图，且**哈希必须互不相同**（**项目既有**：`AGENTS.md §5.7`——两张应当不同的截图 sha 相同就是没验到）。 |
| A12 | **不加说不出理由的动效** | `DESIGN.md §Motion`「Motion clarifies change; it is never decoration」；本仓 §14.2「动效要有理由」 | 有理由才动，且 ≤300ms + reduce 分支。见 §E。 |
| A13 | **帧内绝不用原生 `alert`/`confirm`/`prompt`** | **项目既有**：`AGENTS.md §5.22` | 目标 tab 若要确认对话框，走帧自建的 `.dialogScrim` + `.dialog`（帧里已有）。`tools/test-client-load.mjs` 有断言扫描这三个词，**写了就直接失败**。 |
| A14 | **`srcDoc` 必须是稳定值** | **项目既有**：`AGENTS.md §5.12` | 新 tab 的 HTML 是 `buildFrameDocument()` 的一部分。**别把「目标」的运行时状态烘焙进 `srcDoc`**——那会每次渲染都重载整个 iframe，正在跑的 fetch 全作废。状态只能在帧内 JS 里变。 |
| A15 | **模板字符串里的反引号与 `\n` 都要转义** | **项目既有**：`AGENTS.md §5.6 / §5.17 / §5.26` | 给新 tab 写 CSS 注释时**最容易踩**——注释里引用 `var(--x)` 用了裸反引号会让模板提前结束。改完跑 `node tools/scan-frame-backticks.mjs` + `node tools/check-frame-script.mjs`。 |
| A16 | **改完必须重建** | **项目既有**：`AGENTS.md §六 第 6 条`、`§5.26` | `lib/client.js` 是产物。改 `src/client.js` 后跑 `python tools/build-font-css.py`，否则运行的是旧代码。判据：`lib/client.js` 的 mtime 晚于 `src/client.js`。 |
| A17 | **不新造系统已有的东西** | `DESIGN.md §Components`「Don't rebuild a component the system already provides」 | 帧内已有 `.card` / `.note` / `.status` / `.skeleton` / `.segment` / `.btn` / `.btnPrimary` / `.callout` / `.metric`。**优先复用**，只加列表与状态徽标真正缺的。 |
| A18 | **文案纪律** | `DESIGN.md §Voice & Content` | 动词 + 名词命名动作（`Create Goal` 而不是裸 `Confirm`/`OK`/`Submit`）；同义词不漂移；进行中用现在分词 + 省略号（`Generating…`）；**确认结果要指名具体变的是什么**，不用「successfully」和最高级。每条消息告诉用户下一步。 |
| A19 | **不引入依赖 / 不发网络请求** | 本 tab 的硬约束；`DESIGN-REVIEW §5.3`「不引入组件库——帧内是纯 HTML + 原生 JS」 | 零依赖、零 CDN、零新字体。图标自绘内联 SVG（**项目既有**：`AGENTS.md §5.27`——13 个 SVG path 约 40 行、零依赖即可，别用文字标签替代图标）。 |

---

## B. 排版阶梯

**真源**：`DESIGN.md §Typography` + frontmatter `typography`。**单位**：全为**无单位数值**，即 `px` 当量；lobe-ui 用 px 数值 token，非 rem。**两主题完全一致**（`DESIGN.dark.md` frontmatter 逐行相同）。

| 用途 | 字号 | 字重 | 行高 | token 名 | 备注 |
|---|---|---|---|---|---|
| 页面主标题 | 38 | 600 | — | `fontSizeHeading1` + `fontWeightStrong` | 本帧**不用**（整栏视图没有 38px 标题） |
| 区块标题 | 30 / 24 | 600 | — | `fontSizeHeading2` / `fontSizeHeading3` | 本帧 24px 是「说明页大标题」档 |
| 小标题 | 20 | 600 | — | `fontSizeHeading4` | `DESIGN-REVIEW §二 L5 / §5.2` 第三层建议补这一级，填 16→24 的跳档 |
| **卡片标题** | **16** | 600（`fontWeightStrong`） | 1.4（**项目既有**） | `fontSizeHeading5` / `fontSizeLG` | `DESIGN.md §Typography`：标题对 `fontWeightStrong` (600)；**帧现用 700**，与 token 不符，但属既有读数——新增标题**跟帧**用 700，或按 token 改 600 并接受与旧卡片不一致。**选一个，别在同一 tab 混**。 |
| **正文** | **14** | 400 | **1.5714**（≈22px @14） | `fontSize` / `lineHeight` | 帧 `body` 已是 `14px / 1.5714`，继承即可 |
| 次要 / 说明文字 | 12 | 400 | 1.6667（≈20px @12） | `fontSizeSM` / `lineHeightSM` | 帧 `.note` / `.metricLabel` / `.chartAxis` 已是 12px |
| 强调 / 大控件 | 16 | — | — | `fontSizeLG` | |
| 大数字 | 20 | 700 | 1.3（**项目既有**） | `fontSizeXL` | 帧 `.metricValue` 已是 `20px / 700 / tabular-nums` |
| **等宽 / 代码** | 正文 0.92em、pre 12px（**项目既有**） | 400 | 1.6（pre） | `fontFamilyCode` | 帧现用 `ui-monospace, Consolas, monospace`（**不是** Geist Mono——帧不依赖网络，没有 Geist Mono 字体文件）。**沿用帧的字体栈**。 |

**硬性纪律（`DESIGN.md §Typography` 原文）**：

- body/label 阶梯是 **12 / 14 / 16，没有 13px token**；「Some legacy UI hard-codes `fontSize={13}`… treat that as drift and round to 12 or 14」；「Don't introduce new off-scale sizes」。
- 层级**用 `colorText*` 的深浅拉开，不用中间字号**。
- **项目既有验收**：`DESIGN-REVIEW §5.4` 规定帧内字号种类 **≤ 6**（12/14/16/20/24 + 1 个必要例外）。新 tab **只能从这 5 档里取**。
- 数字要对齐时用 `font-variant-numeric: tabular-nums`（`DESIGN.md §Typography`：「prefer tabular figures when numbers must align」）。帧已在 `.metricValue` / `.chartAxis` / 各 `*Value` 上用。

**响应式**：`DESIGN.md` 的排版阶梯**没有**响应式分支（无 clamp、无断点字号）。帧的响应式只在**间距**上（见 §C）与**网格列数**上（`.metrics` 900/560px 断点）。**新 tab 的排版不应随宽度改变字号。**

---

## C. 间距与布局

**真源**：`DESIGN.md §Layout`（含「The four-pixel scale governs gaps, padding, and margins」段）。

**阶梯（4px 基准）**：`XXS` 4 · `XS` 8 · `SM` 12 · base 16 · `MD` 20 · `LG` 24 · `XL` 32。

**节奏规则（`§Layout` 原文）**：「tight space inside a group (8px), more between groups (16px), most between sections (24–32px)。」

**卡片 padding**：`§Layout`：「Cards use 16–24px padding」。帧 `.card` 现为 `16px 20px`（在范围内）。

**stacked card 之间的 gap**：帧 `.column` 为 `gap: 16px`——**正好落在「groups 之间 16px」**。新 tab 的卡片插进同一列即自动继承，**别另设 gap**。

**不在 4px 阶梯上的东西（`§Layout` 明确排除）**：

- **radius 是独立尺度**（含 6px 步进）——「never reuse a radius value as spacing」
- **图标像素尺寸**（12 / 14 / 16 / 18 / 20）与 **1px 发丝边框**——「are dimensions, not spacing」
- 离阶值（6、10、13…）是 drift，round 到最近台阶；只有「genuine optical tuning」才允许一次性离阶，且**不能当默认**。
- **项目既有验收**：`DESIGN-REVIEW §5.4` 规定帧内间距**只出现 4px 阶梯**，1–2px 仅用于描边/光学微调。

**内容行宽（measure）——这条最容易做错**：

- `DESIGN.md §Layout` **没有**给 ch 数值。它只给一条布局原则：「**Center primary content and let side padding grow at wider breakpoints.**」
- measure 的判据在本仓：**项目既有** `client.js:1529-1532` 注释与 `.prose { max-width: 72ch }`——「running a paragraph the full 1280px would put ~150 characters on a line, which is roughly double what is readable; **the design system asks for 50–75**」。`DESIGN-REVIEW §二 M6` 复述为 **65–75ch**，`§5.2` 第二层第 11 条定为 **72ch**。
- **结论（可直接抄判据）**：**散文类内容 `max-width: 72ch`；结构化/数据类内容占满列宽。**「说明」tab 已经是这个形状（`.prose` 限文字不限卡片），新 tab 如果是说明性段落，照抄 `.prose`；如果是状态列表/清单，占满列即可。
- 用 `ch` 不用 `px`——**项目既有**理由：`ch` 随字体走，不随缩放级别走。

**列宽上限**：

- 帧 `.column { max-width: 1280px }`——**整栏视图用它，不要抄聊天区行宽**。**项目既有**：`AGENTS.md §5.5` 记录过 `748px` 是从聊天内容宽度照抄的，放在整栏视图里等于右侧大片留白。

**grid vs 单列（`§Layout` 能给的全部）**：DESIGN.md **没有**规定「何时用 grid、何时用单列」。它只给：

1. 「Layouts must work across appearances and form factors」（每个面都要有桌面与移动变体）
2. 「Center primary content and let side padding grow at wider breakpoints」
3. `DESIGN.md §Overview`：「Every surface is designed for both light and dark appearance and for desktop and mobile」

**判据只能从数据密度来，不能从「看起来高级」来**。**项目既有**（`AGENTS.md §5.5`）：格数会随时间粒度在 22–174 之间晃，说明它不该跟着那个粒度走——**定死语义比调 CSS 更根本**。新 tab 若做网格：

- 列数由**数据密度**决定，给出**固定的列数台阶**并写清断点（帧的做法：`.metrics` 6 列 → ≤900px 3 列 → ≤560px 2 列；`.presetLayout` 320px+1fr → ≤860px 单列）
- 单列在**窄容器**下是默认退路（`.presetLayout` 的注释：320px 轨道 + 编辑器在窄面板里放不下，横向滚动比堆叠更糟）
- **网格不得为「填充」而存在**——`AGENTS.md §5.5` / `DESIGN-REVIEW §一`：等高三栏 / 六列等宽被点名为「没有自己的判断」的典型形态（`M8`：指标卡改不等宽，让大数有呼吸）

---

## D. 颜色与状态语义

### D.1 两套体系的分工（先读这条，否则 §D.2 与 §D.3 会打架）

本仓实际有两套语义 token：

| 体系 | 谁定的 | 帧内现状 |
|---|---|---|
| **LobeHub / lobe-ui**（`colorText*` / `colorBg*` / `colorBorder*` / `colorSuccess`…） | `DESIGN.md §Colors` 的**真源** | **不适用**——帧内没有任何 lobe-ui 组件 |
| **DSH `--dsw-*`** | DSH 前端自己 | **帧实际用的**，且名字与 LobeHub 一一对应 |

`DESIGN.md §Colors` 明确：「**Build against token names, not values**」——**照它的方法，不照它的色值**（`AGENTS.md §二`：「参考它的**方法**，不是它的**色值**」）。帧里 `--dsw-alias-label-primary/secondary/tertiary` 与 `colorText/colorTextSecondary/colorTextTertiary` 是**同一个角色**。所以：**新 tab 继续用 DSH token 名，角色映射照 `DESIGN.md §Colors` 走。**

### D.2 LobeHub 语义角色（Light / Dark 值）—— `DESIGN.md` frontmatter + `DESIGN.dark.md` frontmatter

| 角色 | token 名 | Light | Dark |
|---|---|---|---|
| 主文字 / 图标 | `colorText` | `#080808` | `#ffffff` |
| 次要文字、标签 | `colorTextSecondary` | `#666666` | `#aaaaaa` |
| 占位、说明、元信息 | `colorTextTertiary` | `#999999` | `#6f6f6f` |
| 禁用 | `colorTextQuaternary` | `#bbbbbb` | `#555555` |
| 页面画布 | `colorBgLayout` | `#f8f8f8` | `#000000` |
| 卡片 / 面板主表面 | `colorBgContainer` | `#ffffff` | `#0d0d0d` |
| 次级微表面 | `colorBgContainerSecondary` | `#fbfbfb` | `#070707` |
| 浮层（弹窗/菜单） | `colorBgElevated` | `#ffffff` | `#1a1a1a` |
| 提示条 | `colorBgSpotlight` | `#dddddd` | `#2d2d2d` |
| 强边框 | `colorBorder` | `#e3e3e3` | `#202020` |
| 默认分隔 / 弱边框 | `colorBorderSecondary` | `#eeeeee` | `#1a1a1a` |
| hover 洗色 | `colorFillTertiary` | `rgba(0,0,0,0.03)` | `rgba(255,255,255,0.06)` |
| active 洗色 | `colorFillQuaternary` | `rgba(0,0,0,0.015)` | `rgba(255,255,255,0.02)` |
| 最重要动作 / 焦点 / 链接 | `colorPrimary` | `#222222`（默认单色近黑） | `#eeeeee`（默认单色近白） |
| 成功 | `colorSuccess` | `#379d4a` green | `#c4f042` **lime** |
| 警告 | `colorWarning` | `#ee9e0b` gold | `#ffb224` gold |
| 危险 | `colorError` | `#ec5e41` volcano | `#f4416c` **red** |
| 信息 | `colorInfo` | `#0072f5` geekblue | `#60b1ff` **blue** |

**两条容易漏的**：

1. **暗色下功能色换了色相**（`DESIGN.dark.md §Colors`：「Dark draws `colorError` from `red` and `colorInfo` from `blue`（Light uses `volcano` and `geekblue`），and `colorSuccess` brightens to `lime`. This is intentional — **read the token, not a fixed hue**」）。
2. **每色还有派生斜坡**（`DESIGN.md §Colors`）：`color{Name}` / `Hover` / `Active` / `Bg` / `Border` / `Text` / `Fill*`——**可以做着色底、着色边、着色文字，不用挑原始色值**。

### D.3 DSH 实际可用的 token（**已核实**：`:root` 定义于 `dsh-client-ui-theme/lib/client.js`，帧已镜像）

帧 `client.js:105-128` 已镜像的 10 个（**新 tab 直接用，无需改主题块**）：

| token | Light | Dark |
|---|---|---|
| `--dsw-alias-label-primary` | `#080808` | `#ffffff` |
| `--dsw-alias-label-secondary` | `#666666` | `#aaaaaa` |
| `--dsw-alias-label-tertiary` | `#999999` | `#6f6f6f` |
| `--dsw-alias-border-l2` | `#eeeeee` | `#1a1a1a` |
| `--dsw-alias-border-l4` | `#dddddd` | `#2a2a2a` |
| `--dsw-alias-bg-layer-1` | `#ffffff` | `#0d0d0d` |
| `--dsw-alias-bg-layer-2` | `#f5f5f5` | `#1a1a1a` |
| `--dsw-alias-interactive-bg-hover` | `rgba(0,0,0,0.04)` | `rgba(255,255,255,0.06)` |
| `--dsw-alias-markdown-code-block` | `rgba(0,0,0,0.04)` | `rgba(255,255,255,0.06)` |
| `--dsw-static-deepseek-500` | `#4d6bfe` | `#6b83ff` |

> 注意 Light 的 `--dsw-alias-bg-layer-1` 是纯 `#ffffff`（LobeHub 的 `colorBgContainer` 也是 `#ffffff`，对得上）；Dark 是 `#0d0d0d`（同样对得上）。**这套镜像与 §D.2 是同一套角色的两种命名。**

### D.4 ⚠️ 目标 tab 最可能踩的坑：状态色**当前在暗色下失效**

**实测结论（本机 DSH 前端 dist + 主题层核验）**：

- 帧里 **`--dsw-alias-label-error`（5 处）、`--dsw-alias-label-warning`（2 处）、`--dsw-alias-label-success`（2 处）从未被定义过**——既不在帧的两套 token 块里，**也不存在于 DSH 前端 dist CSS 的任何一个 `--dsw-*` 名里**。
- 帧里引用它们的 9 条规则（`.btnDanger` / `.saveState[data-kind]` ×3 / `.callout[data-kind]` ×3 / 另一处 danger）**全部静默回退到硬编码兜底** `#d44` / `#a60` / `#287`——**两主题一模一样**。
- 这三条规则全在**预设** tab（`saveState` / `callout`）。**「目标」tab 天然要表达状态**，如果照抄这个模式，会**把预设页那处暗色缺陷复制一遍**（`DESIGN-REVIEW §二 L4` 已经点过「暗色下 `已保存` 的绿偏暗，对比度偏低」）。

**DSH 里真实存在的状态 token（用它，别用 `label-error` 那三个）**：

| 角色 | token 名 | Light 值 | Dark 值 | 出现在 |
|---|---|---|---|---|
| 成功 / 已完成 | `--dsw-alias-state-success-primary` | `--dsw-static-green-500` = **`#22c55e`** | 同（`green-500`） | `Tag` / `StateDot` / `DiffBlock` / `ConnectionIndicator` |
| 警告 | `--dsw-alias-state-warn-primary` | `--dsw-static-amber-500` = **`#f59e0b`** | 同 | `Tag` / `StateDot` |
| 危险 / 出错 | `--dsw-alias-state-error-primary` | `--dsw-static-red-600` = **`#ec1313`** | `--dsw-static-red-400` = **`#f25a5a`** | 原生 UI / `Tag` / `StateDot` |
| 进行中 / 信息 | `--dsw-alias-state-business-primary` | `--dsw-static-deepseek-500` = **`#4176e6`** | `--dsw-static-deepseek-400` = **`#679efe`** | `Tag` / `Markdown` |
| 空闲 / 未开始 | `--dsw-alias-label-tertiary` | `#999999` | `#6f6f6f` | `StateDot[data-state=idle]` |
| 警告文字（比 primary 深，用于**文字**而非填充） | `--dsw-alias-state-warn-label` | `--dsw-static-amber-600` = `#dd8629` | 同 | — |

**给「目标」tab 的取值表（可直接用；`:root` 与暗色块各写一份）**：

```css
/* :root —— 已核实：值来自 dsh-client-ui-theme/lib/client.js 的 :root */
--dsw-alias-state-success-primary: #22c55e;
--dsw-alias-state-warn-primary:    #f59e0b;
--dsw-alias-state-error-primary:   #ec1313;
--dsw-alias-state-business-primary:#4176e6;

/* :root[data-theme='dark'] */
--dsw-alias-state-success-primary: #22c55e;   /* green-500，两主题同 */
--dsw-alias-state-warn-primary:    #f59e0b;   /* amber-500，两主题同 */
--dsw-alias-state-error-primary:   #f25a5a;   /* red-400 —— 暗色换成亮红，这是重点 */
--dsw-alias-state-business-primary:#679efe;   /* deepseek-400 */
```

### D.5 状态怎么表达——`DESIGN.md` 的规定 + 帧/DSh 既有的徽标形态

**`DESIGN.md` 的直接规定（只有三条，别扩写）**：

1. `§Colors`：「Functional color is **reserved for meaning**」——功能色不能当装饰。
2. `§Do's and Don'ts`：「Don't signal state with **color alone** — pair it with an **icon or label**」。
3. `§Do's and Don'ts`：「Do keep solid `colorPrimary` for the **single most important action** and for state. Don't spread brand color as decoration.」

**`DESIGN.md` 里没有** badge / chip / tag 组件的形态定义——`§Components` 只提了 `Tag` 的 `color` prop 缺 `primary` 这一处**props 细节**，没给形状。**形状取本仓两处既有实现**：

**① DSH 自己的 Tag（`dsh-client-ui-primitives/lib/Tag.module.css`）——胶囊 + 色调**

```
display: inline-flex; align-items: center;
border-radius: 999px; corner-shape: round;
padding: 1px 8px; font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap;
```

色调（**注意：填充色是「自身色 10% 混入透明」，文字是自身色**，一个 token 同时驱动两者）：

| tone | 填充 | 文字 |
|---|---|---|
| `outline` | 无（`0.5px solid var(--dsw-alias-border-l4)`） | `--dsw-alias-label-tertiary` |
| `neutral` | `--dsw-alias-bg-module-platform` | `--dsw-alias-label-secondary` |
| `quiet` | 无 | `--dsw-alias-label-tertiary` |
| `solid` | `--dsw-alias-label-primary` | `--dsw-alias-bg-layer-3` |
| `success` | `color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)` | `--dsw-alias-state-success-primary` |
| `info` | `color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)` | `--dsw-alias-state-business-primary` |
| `warning` | 同色 **12%**（`warn-primary`） | `--dsw-alias-state-warn-primary` |
| `danger` | 同色 **10%**（`error-primary`） | `--dsw-alias-state-error-primary` |

> 源码注释解释了为什么 warning 是 12% 而其余 10%：「matching it is what makes this a pure consolidation」——**是历史继承，不是设计理由**。新 tab 统一用 **10%** 即可。

**② DSH 的 StateDot（`StateDot.module.css`）——「同色光环 + 实心核」**

```
外层 ::before { inset: 0;   border-radius: 50%; background: currentColor; opacity: 0.1 }
内层 ::after  { inset: 20%; border-radius: 50%; background: currentColor }
```

状态 → `currentColor`：`done` → `state-success-primary`｜`warning` → `state-warn-primary`｜`error` → `state-error-primary`｜`idle` → `label-tertiary`。

源码注释给了一条**可直接搬给「目标」tab 的语义判断**：「**Idle is the absence of activity, not a fourth outcome: it stays on the tertiary label color so it recedes beside the three outcome colors.**」

**③ 帧内的既有徽标近似（`.rosterItem` 计数徽标）**

`client.js:481-483`：`background: color-mix(in srgb, var(--dsw-static-deepseek-500) 22%, transparent); color: var(--dsw-static-deepseek-500); font-size: 12px; font-weight: 700;`

**给「目标」tab 的处方**：

- 状态徽标 = **胶囊（`border-radius: 999px`）+ 10% 自身色填充 + 自身色文字（`font-size: 12px`）+ 一个内联 SVG 图标**
- 三态语义：**已确认** → `state-success-primary`｜**待处理** → `state-business-primary`（不用 warn，未开始不是异常）｜**受阻** → `state-error-primary`
- **空闲 / 无状态** → `label-tertiary`（照 StateDot 的「idle 是缺席而非第四种结局」）
- **颜色 + 图标 + 文字三者齐备**（A5 硬要求）。形状用**胶囊 999**，与帧里 `4/6/8/12` 的方角尺度**分开记**（`DESIGN.md §Shapes`：「Reserve fully round (`9999px`) for pills, avatars, and circular icon buttons」——胶囊是这条规则的合法用法）。

---

## E. 形状、高度、动效

**真源**：`DESIGN.md §Shapes` / `§Elevation & Depth` / `§Motion`。**圆角、阴影、动效在两主题间完全一致**（`DESIGN.dark.md`：「For elevation, motion, shapes… see DESIGN.md — they apply unchanged in dark」）。

### 圆角（`§Shapes`）

| 值 | token | 用途 |
|---|---|---|
| **4px** | `borderRadiusXS` | tags, chips |
| **6px** | `borderRadiusSM` | inputs, small controls |
| **8px** | `borderRadius` | **默认**——buttons, cards |
| **12px** | `borderRadiusLG` | menus, modals, large surfaces |
| **9999px** | — | pills, avatars, circular icon buttons |

- 原文：「Radii stay soft but tight, and **one family per view**」；「**Don't mix rounded and sharp corners in one view**」。
- **`DESIGN.md` 与帧的差异（必须知道）**：帧 `.card` 用 **12px**、`.segment` 容器 8px / 内部 button 6px、`.btn` 8px。即帧把 `borderRadiusLG` 用在了卡片上，而 `§Shapes` 写的是「8px 默认——buttons and cards / 12px——menus, modals, large surfaces」。**新 tab 沿用帧现状（卡片 12px）**，因为同一视图里混用两个卡片圆角比偏离 token 用途更糟（`DESIGN-REVIEW §5.4` 的验收是「只出现 4/6/8/12/999」，12 合法）。
- **项目既有验收**：圆角只出现 **4 / 6 / 8 / 12 / 999**（`DESIGN-REVIEW §5.4`）。

### 边框宽度

- `DESIGN.md` **没有** border-width token。帧统一用 **`0.5px`**（`.card` / `.segment` / `.statusDetail code` / `.chartTip` / `.markdown pre` 等）。
- 唯一例外：`rosterItem[aria-selected='true']` 用 `border-color` 变色而非加粗；`.markdown input[type=checkbox]` 用 1.5px。
- **新 tab 用 `0.5px solid var(--dsw-alias-border-l2)`**（默认分隔）/ `--dsw-alias-border-l4`（更强边缘）——与 `DESIGN.md §Colors` 的「`colorBorderSecondary` 日常分隔 / `colorBorder` 更强边缘」角色一致。
- `§Layout` 明确：**1px 发丝边框是「dimensions, not spacing」**——不要往 4px 阶梯里折算。

### 阴影 / 高度（`§Elevation & Depth`）

| 层级 | token | 值 | 用途 |
|---|---|---|---|
| 0 | — | **无阴影，只有 `colorBorderSecondary` 边** | **大多数卡片属于这一层**（原文：「most cards need none, just a `colorBorderSecondary` edge」） |
| 1 | `boxShadowTertiary` | `0 3px 1px -1px rgba(26,26,26,0.06)` | 抬起的卡片 / 面板 |
| 2 | `boxShadowSecondary` | `0 8px 16px -4px rgba(0,0,0,0.2)` | 弹出层、菜单 |
| 3 | `boxShadow` | `0 20px 20px -8px rgba(0,0,0,0.24)` | 模态、对话框 |

**原文两条硬纪律**：

1. 「**Hierarchy comes from tonal surfaces and borders first**, so shadows stay subtle. Lift only what genuinely floats.」
2. 「**prefer a border over a shadow when both would read.**」

**帧的现状与差异**：帧 `.card` 有 `box-shadow: 0 1px 2px rgba(0,0,0,0.04)` + `backdrop-filter: saturate(150%) blur(10px)`（注释称来自 lobe-ui customStylish 的玻璃配方，**该引用经 `DESIGN-REVIEW §三` 核实为真**）；`.segment button[aria-selected='true']` 有 `0 1px 2px rgba(0,0,0,0.06)`。
> **给新 tab**：**照帧走**（复用 `.card` 即可，不要自己加阴影）。**但不要再引入新的阴影值**——`DESIGN-REVIEW §一 H5/M2` 记过帧里尺度失控的代价；新增一层自定义阴影是典型的「AI 生成感」来源（§H）。
> **项目既有验收口径**：`DESIGN-REVIEW §5.2` 第二层第 9 条——「玻璃只留给悬浮层；卡片改 `colorBgContainer` 实底 + `colorBorderSecondary` 描边」。若新 tab 造新卡片样式，**实底 + 描边**是更接近 `§Elevation & Depth` 的写法。

### 动效（`§Motion`）

| 项 | 规定 |
|---|---|
| 状态变化 / 弹出层 | **约 100–200ms** |
| 覆盖层 / 模态 | **最长约 300ms** |
| 禁止 | 「Avoid long, **looping**, or attention-grabbing animation」 |
| 加载 | 「prefer the system's purpose-built loaders (skeletons, `NeuralNetworkLoading`) over ad-hoc spinners」 |
| 降级 | 「**Honor `prefers-reduced-motion` by dropping nonessential animation**」 |
| 原则 | 「Motion clarifies change; it is **never decoration**」 |

**缓动**：`DESIGN.md` **没给** easing token。帧统一用 `cubic-bezier(0.23, 1, 0.32, 1)`（≈ ease-out-quint，emil 纪律里的「ease-out 优先」），时长 120–300ms；`.skeleton` 用 `ease-in-out`。**沿用帧的这条曲线**。

**reduce 分支**：帧已在 `.chartWrap[data-animate]` / `.chartDot` / `.skeleton` 三处做了 `@media (prefers-reduced-motion: reduce) { animation: none }` / `{ transition: none }`。
**两条项目既有陷阱（必读）**：

- `AGENTS.md §5.15`：**无头浏览器恒定报告 `prefers-reduced-motion: reduce`**——动画「不跑」不是 bug，是分支被正确执行。
- 同一节：`data-animate` 属性**必须用 `setTimeout` 清除，不能用 `animationend`**——reduce 分支下动画是 `none`，`animationend` 永不触发，属性会永久卡住。

**新 tab 的处方**：默认**不加动画**。若要加，只能是「状态徽标从待处理 → 已确认的 160ms 颜色过渡」这种**能说出传达了什么**的（`§Motion` 的「clarifies change」），且必须带 reduce 分支。

---

## F. Do's and Don'ts

### F.1 `DESIGN.md §Do's and Don'ts` 逐条原文（共 10 条）

1. 「Read semantic tokens (`cssVar.colorText`, `cssVar.colorPrimary`, …); they adapt to the user's theme and to light/dark. **Don't hard-code hex values from this file.**」
2. 「Rank information with the text-opacity scale (`colorText` → `colorTextTertiary`). **Don't signal state with color alone — pair it with an icon or label.**」
3. 「**Do** keep solid `colorPrimary` for the single most important action and for state. **Don't** spread brand color as decoration.」
4. 「**Do** design all four data states — empty, loading, error, success. **Don't** ship only the happy path.」
5. 「**Do** build light + dark and desktop + mobile for every surface. **Don't** treat mobile or dark as an afterthought.」
6. 「**Do** keep `colorBg*` (surfaces) and the text/`colorFill` scales distinct. **Don't** swap a surface token for a text token.」
7. 「**Do** reach for `@lobehub/ui/base-ui` first, then `@lobehub/ui`. **Don't** rebuild a component the system already provides.」
8. 「Hold WCAG AA contrast (4.5:1 for body text) and show a visible `:focus-visible` ring.」
9. 「**Don't** mix rounded and sharp corners.」

> 第 7 条对本 tab **不适用**（本机是 DSH 不是 LobeHub，帧内零依赖）——它的**原则**转译为 A17「优先复用帧内既有 `.card`/`.status`/`.segment` 等，别新造」。

### F.2 本 tab 最相关的 5 条推论

1. **状态色的暗色分支必须实测。** §D.4 已证明帧现在的 `--dsw-alias-label-*` 状态三兄弟**在暗色下静默失效**（回退到 `#d44`/`#a60`/`#287`，两主题同色）。新 tab 若走同一条路，就是把 `DESIGN-REVIEW §二 L4` 的缺陷复制一遍，并直接违反 F.1 第 1 条与第 8 条。**改用 `--dsw-alias-state-*-primary`，并给暗色块单独写 `#f25a5a` / `#679efe`。**
2. **「目标已达成」不是第四种状态色，是 `colorSuccess` 的用途本身。** F.1 第 3 条把功能色留给「state」——目标完成/受阻正是 state。但别用它当装饰（比如给整张卡染绿底）。
3. **`srcDoc` 稳定 = 状态必须活在帧内。** F.1 第 1 条的「adapt to the user's theme」在本 tab 只能靠帧自己的两套 token 实现（A2/A14）。把状态烤进 `srcDoc` 会让整个 iframe 重载，四态里的「加载」永远走不完（`AGENTS.md §5.12` 的 `frame-boot` 出现两次就是这么来的）。
4. **四态不是锦上添花，是 F.1 第 4 条的原话。** 目标 tab 尤其需要：空（还没有目标）、加载（正在读）、错误（读不出来 + 重试 + 可折叠诊断）、成功（有目标且状态明确）。帧的 `.status` + `.statusDetail` 已经就是这个形状（`statusBlock(文案, canRetry, detail)`）。
5. **一个 primary。** F.1 第 3 条的「single most important action」——目标 tab 里如果同时出现「新建目标」「标记完成」「删除」，**只有一个是 `.btnPrimary`**，其余 `.btn`，删除用文本按钮（`DESIGN-REVIEW §5.2` 第二层第 8 条：「危险降为文字按钮，让保存独占强调色」）。

---

## G. Tab / 分段控件

**先说结论：`DESIGN.md` 与 `DESIGN.dark.md` 里没有任何关于 tabs / segmented control / view switcher 的段落。** 逐节核对：`§Overview` 无、`§Colors` 无、`§Typography` 无、`§Layout` 无、`§Elevation & Depth` 无、`§Motion` 无、`§Shapes` 无、`§Components` 无（只提 Tag / Select / Modal / DropdownMenu / ContextMenu / Popover / ScrollArea / Switch / Toast / FloatingSheet，**没有 Segmented**）、`§Voice & Content` 无、`§Do's and Don'ts` 无。**别把任何 tab 规格当成「DESIGN.md 规定」。**

可用的依据只有三处，全部来自本仓：

**① 帧现有的 tab 条（权威——新 tab 必须与它一字不差地对齐）**，`client.js:166-186` + `:820-825`：

```html
<div class="tabs topbar">
  <div class="segment" role="tablist">
    <button type="button" role="tab" data-tab="readme" aria-selected="true">说明</button>
    <button type="button" role="tab" data-tab="usage"  aria-selected="false">用量</button>
    <button type="button" role="tab" data-tab="preset" aria-selected="false">预设</button>
  </div>
</div>
```

- 容器 `.segment`：`inline-flex` `gap: 2px` `padding: 2px`、`border: 0.5px solid var(--dsw-alias-border-l2)`、`border-radius: 8px`、`background: var(--dsw-alias-bg-layer-2)`
- 按钮：`height: 28px` `padding: 0 12px` `border-radius: 6px` `font-size: 14px`、静息色 `label-secondary`、`transition: background-color 160ms cubic-bezier(0.23,1,0.32,1)`
- **选中态**（`[aria-selected='true']`）：`background: var(--dsw-alias-bg-layer-1)` + `color: var(--dsw-alias-label-primary)` + `box-shadow: 0 1px 2px rgba(0,0,0,0.06)`
- 悬停：只改文字色到 `label-primary`
- 焦点：`outline: 2px solid var(--dsw-static-deepseek-500); outline-offset: 1px`
- **只增不改**：新 tab 就是 `<button type="button" role="tab" data-tab="goal" aria-selected="false">目标</button>`，插在现有三个之后（或按产品顺序）。**标签用文字，不用图标**——现有三个全是纯文字中文标签，混入图标会破坏一屏一套形态。

**② lobe-ui 的 Segmented（`reference/lobe-ui/src/base-ui/Segmented/style.ts`）——设计意图的旁证，不是本 tab 的规格**

| 维度 | lobe-ui 的值 |
|---|---|
| 外层 | `border-radius: borderRadiusLG`(12) · `padding: 3px` · `gap: 4px` · `variant=filled` → `1px solid colorFillQuaternary` + `background: colorBgLayout`；`outlined` → `1px solid colorBorderSecondary` + 透明底 |
| 滑块 | 独立 `indicator`：`background: colorBgElevated` + `box-shadow: boxShadowTertiary` + `border-radius: borderRadius`(8) |
| 滑块动效 | `transition-property: inset-inline-start / block-start / width / height`，**240ms**，`motionEaseOut`；`@media (prefers-reduced-motion: reduce) { transition-duration: 0s }` |
| 项 | `font-weight: 500` · 静息 `colorTextSecondary` · hover / `[data-pressed]` → `colorText` · `:active` → `transform: scale(0.98)` · `border-radius: borderRadius`(8) · `gap: 6px`（图标与文字之间） |
| 尺寸 | `small` 26px / padding-inline 10 / **12px** · `middle` 32px / 12 / **13px** · `large` 36px / 16 / **14px** |

> **两处差异值得知道，但都不要照搬**：(a) lobe-ui 的中号项字号是 **13px**——`DESIGN.md §Typography` 明确说 13px 是 drift；帧用 14px 是对的。(b) 帧的 28px 与 lobe-ui 的 `controlHeightSM`(28) 一致，`DESIGN.md §Components` 称之为「default control height 是 36px；`controlHeightSM` 28px」。**帧的 28px 有出处。**

**③ DSH 自己的分段控件形态（`dshmarket/src/client/Market.module.css`，可作为「DSH 里 tab 长什么样」的第二证据）**

- `.tab`：`font-size: 13px`、`padding: 7px 12px`、`border-bottom: 2px solid transparent`（**下划线式**，选中时下边框上色）
- `.setSegBtn` / `.viewBtn`：`font-size: 12px`、`padding: 3px 10px`、`border-radius: 6px`、静息 `color: label-secondary`；**选中 `.setSegOn` / `.viewOn`：`background: var(--dsw-alias-bg-layer-2)` + `color: var(--dsw-alias-label-primary)` + `font-weight: 600`**
- `.pill`（`Pill.module.css`）：`height: 24px`、`padding: 0 8px`、`border-radius: 12px`、`font-size: 12px`、`background: bg-layer-2`；`.active` → `bg-layer-2` 换 `button-ghost-active-fill` + `box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border)`

**可提炼的三条（跨三处一致）**：

1. **选中态 = 抬起的表面 + 主文字色**，不是换一个彩色底。
2. **未选中 = 次要文字色，无边框、无填充。**
3. **形状要么是「容器内嵌小块」（帧/lobe-ui/Pill），要么是「下划线」（DSH market tab）——选一种，不混。**

---

## H. 会让它看起来「AI 生成」的东西

### H.1 显式禁令（原文）

| 出处 | 原文 |
|---|---|
| 本仓 `AGENTS.md §三`（转 `§14.2` 反 AI 味纪律） | 「**禁默认款**：AI 紫渐变、居中 hero + 深色网格、三张等高卡片、满屏 glassmorphism、到处无限循环动效」 |
| 同上 | 「**禁假数据**：假 logo 墙、编造的统计数字（`92%`、`4.1×`）、假的用户评价——要么用真的，要么留明确占位符」 |
| 同上 | 「**禁手画 SVG 冒充实物**：品牌任务里的 logo、产品图必须用真资产；拿不到就**停下问用户**，不要用色块顶替」 |
| 同上 | 「**禁 div 拼假截图**：假仪表盘、假终端窗口一律不要」 |
| 同上 | 「**动效要有理由**：说不出「这个动效传达了什么」，就删掉它」 |
| 同上 | 「**配色与圆角成套**：一页一个强调色、一套圆角规则，不在页面中途换风格」 |
| `DESIGN.md §Motion` | 「Avoid long, **looping**, or attention-grabbing animation.」 |
| `DESIGN.md §Elevation & Depth` | 「**most cards need none**, just a `colorBorderSecondary` edge」；「prefer a border over a shadow when both would read」 |
| `DESIGN.md §Do's and Don'ts` | 「Don't spread brand color as decoration」；「Don't mix rounded and sharp corners」 |

### H.2 本仓已实测的「AI 味」清单（`docs/DESIGN-REVIEW-LuzzyPage.md`）

这些是**在这个帧上真实发生过的**，所以优先级最高：

| # | 现象 | 报告原话 |
|---|---|---|
| H2-1 | **紫色径向光晕** | `§二 H1`：`#c084fc` 硬编码径向渐变；`§三`：「一违反 §14.2「禁 AI 紫渐变」，二违反 DESIGN.md「不得硬编码任何单值」，三它把整页染上一层淡紫」 |
| H2-2 | **满屏 glassmorphism** | `§三`：「真正的问题是**满屏都是**（每张卡都玻璃 + 背后还有光晕），落进了「满屏 glassmorphism」。保留玻璃，但去掉光晕、并让玻璃只出现在真正悬浮的层」 |
| H2-3 | **无法自证的光晕** | `§三`：`blur(24px)` 光晕说不出传达了什么 → 删。判据原文：「**说不出它传达了什么**」 |
| H2-4 | **字号失控** | `§二 H4`：帧内曾用 **14 种**字号（9.5 到 24）；13px 用了 13 次。DESIGN.md 明写阶梯是 12/14/16，**没有 13px** |
| H2-5 | **圆角失控** | `§二 H5`：曾用 **8 种**圆角（2/3/4/6/8/10/12/999） |
| H2-6 | **间距不成阶** | `§二 M2`：padding/gap 曾出现 **16 种**值 |
| H2-7 | **等高等宽卡片** | `§二 M8` + `§一`：「六列等宽」被点名；`§一` 原话：「**干净，但"干净得没有设计"**……**读起来像一份设计系统的样例，而不像这个产品自己的界面**——几乎每个决定都可以在任何 AI 工具里看到同样的做法（紫蓝光晕、玻璃卡片、等高三栏指标）」 |
| H2-8 | **裸动词命名** | `§〇`：按钮只写「删」；DESIGN.md Voice 明写用「动词 + 名词」（`Delete Session`） |
| H2-9 | **危险色常驻** | `§〇`：「危险色（`colorError`）应留给**破坏性动作本身**，不是装饰性常驻。分组一多就是一片红点，视线全被拽走」 |
| H2-10 | **把 JS 异常抛给用户** | `§二 H3`：`用量统计失败 — Cannot read properties of undefined` → 违反 DESIGN.md「每条消息告诉用户下一步做什么」 |
| H2-11 | **13px 的 `.note`** | `§二 L2`：应为 12px |

### H.3 给「目标」tab 的 5 条推论

1. **零装饰背景。** 不要为新 tab 的画布加任何渐变、光晕、`filter: blur`、`body::before`。`client.js:130-140` 那段注释就是这条裁决的记录——「ornament that cannot justify itself is removed」。
2. **不要第三套圆角/阴影语言。** 复用 `.card`。若非造新容器不可，只用 `--dsw-alias-border-l2` 描边 + `4/8/12` 其中一档圆角；**不要** `border-radius: 10px`、不要自定义 `box-shadow`。
3. **状态色只在状态上。** 一个「已达成」的绿胶囊是 state；「目标」tab 的**标题、图标、卡片底**都不能染成那个绿。`DESIGN.md §Colors`：「Functional color is **reserved for meaning**」。
4. **不要为了「丰富」加空卡或假占位。** 目标 tab 的空态应该是**一句人话 + 一个动作**（帧 `.status` 的形状），不是三张骨架卡摆样子。`DESIGN.md §Voice & Content`：每条消息告诉用户下一步做什么。
5. **图标要么真画，要么不要。** §D.5 要求的那个状态图标用内联 SVG path（**项目既有**：`AGENTS.md §5.27` 证明 13 个 path 约 40 行零依赖可做）；**不要**用 emoji、不要用「✔ / ● / ▲」这类字符顶替图标（`AGENTS.md §5.27` 记录过用文字标签替代图标的错误论证）。

---

## 验收清单（新增，供实作者自查）

- [ ] 新 tab 的每个 token 都同时存在于 `:root` 与 `:root[data-theme='dark']`（A2）
- [ ] 没有引用 `--dsw-alias-label-{error,warning,success}`（§D.4；改用 `--dsw-alias-state-*-primary`）
- [ ] 状态徽标 = 色 + 图标 + 文字（A5）
- [ ] 字号只取 12 / 14 / 16 / 20 / 24（B；`DESIGN-REVIEW §5.4`）
- [ ] 圆角只取 4 / 6 / 8 / 12 / 999（E）
- [ ] 间距只取 4px 阶梯，1–2px 仅描边/光学（C）
- [ ] 卡片 padding 16–24，卡片间 gap 16（继承 `.column`）（C）
- [ ] 说明性段落在 `.prose`(72ch) 内；数据/列表占满列（C）
- [ ] 一个 `.btnPrimary`，危险动作为文字按钮（A6 / F.2-5）
- [ ] 四态齐全（空 / 加载 / 错误 / 成功），错误态是「人话 + 重试 + 可折叠诊断」（A4 / F.2-4）
- [ ] 每个可交互元素有 `:focus-visible` 环（A7）
- [ ] 无新增动画；若有，≤300ms + reduce 分支 + 能说出理由（A12 / E）
- [ ] 零依赖：无 CDN、无网络字体、无外部 CSS（A19）
- [ ] 帧内无 `alert(` / `confirm(` / `prompt(`（A13）
- [ ] 未把运行时状态烤进 `srcDoc`（A14）
- [ ] `node tools/scan-frame-backticks.mjs` + `node tools/check-frame-script.mjs` 通过（A15）
- [ ] `python tools/build-font-css.py` 已跑，`lib/client.js` mtime 晚于 `src/client.js`（A16）
- [ ] 浅/暗 × 四态截图已**亲眼看**，且**哈希互不相同**（A11）
