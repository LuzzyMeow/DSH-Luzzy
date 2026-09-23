# STATUS · LuzzyPage 工作节点

> 更新时间：2026-09-22（第十一轮 · 续）
> 用途：上下文压缩后的接续点。含**当前状态**、**失败史**、**下一步**。
> 配套：`AGENTS.md` §五「已证伪的做法」是防错清单（已扩到 5.29），本文件是进度与计划。
> 本轮新增：**「目标」子页 —— Goal-Driven Delivery 交付层**（第二十二节，末尾）。含四条生命周期钩子（方向注入 / 完成门 / 对账屏障 / 结果增强）、Agent 权威限制、CAS、goal.md 投影。**宿主半已改，需要重启 DSH 才生效。**

---

## 一、当前状态

### 已达成

| 项 | 状态 |
|---|---|
| 插件安装 | ✅ `~/.dsh/profiles/desktop` 已装，bundles 含 `dsh-luzzy-page` |
| 标签 | ✅ 「LuzzyPage」在「对话」「轨迹」右侧 |
| 架构 | ✅ iframe `srcDoc` 自包含文档（第三代，唯一能用的一代） |
| README 子页 | ✅ 渲染正确，**且已占满左右** |
| 用量子页 | ✅ 真机实测可取数（帧内上报为证） |
| **性能** | ✅ **缓存重启 144 ms（原 20,889 ms，145 倍）**；后台预热使常态首屏 **0 ms** |
| 暗色主题 | ✅ 已修（iframe 不继承 CSS 变量） |
| 活动阵列 | ✅ 一个自然月、每格一天；**已过的日期按深浅表示用量，未到的留白**（空白格，非虚线框） |
| 模型趋势图 | ✅ 按模型的多序列**单调平滑曲线**；窗口 日/周/月，**无小时视图** |
| 窗口切换 | ✅ 按钮只作用于趋势图；切换**不发请求** |
| **周标签带日期区间** | ✅ `第1周 8.31 - 9.6` … `第5周 9.28 - 10.4`，**自然跨月** |
| **悬停浮窗** | ✅ 移到点上显示该格 token 数与各模型分行（线图、条形图都可用） |
| **切换交互动画** | ✅ 切窗口 / 切模式时曲线与柱子入场；**首次渲染不动画**；`prefers-reduced-motion` 下自动关闭 |
| 预设子页 | ✅ 提示词编辑（三显示模式 + 图标工具栏）、名单增删改排序、会话切换 |
| **目标子页** | ✅ 验收标准 / 任务 / 证据 / 焦点 / 下一步 / 阻塞 / 决策 / 完整性 / 提案 / goal.md |
| **取消安全** | ✅ 被取消的轮次不会被要求对账（会让 steer 排干到下一轮） |
| **AC-001** | ✅ 无 goal 但已动工作区 → **提示一次**问模型「这是长期任务吗」（不自动建） |
| **生命周期** | ✅ compaction / resume / fork / 卸载，对着**真实 `Session`** 验（`test-goal-lifecycle.mjs`） |
| **完成门** | ✅ `update_goal(action=complete)` 在到达 `ctx.goals` 之前被拦；fail-closed |
| **方向注入** | ✅ `agent/pre-step` 每个有 goal 的轮次注入 ~740 字节的紧凑状态块（AC-002） |
| **Agent 权威限制** | ✅ objective / scope / 约束 / 必须的验收标准只能**提议**，人类操作是另一个函数 |
| **CAS** | ✅ 每份计划带 revision，写入必须带读到的那个 |
| 数据正确性 | ✅ Node/Python 双实现在冻结快照上逐位一致；**缓存路径与冷读路径也逐位一致** |
| 测试 | ✅ **25 个套件全绿（1211 条断言）** + 字体 / 帧脚本 / 无第二 React 三个校验器 |
| 构建门禁 | ✅ 产物解析不过则非零退出；专用反引号扫描器 + 帧脚本编译门 |
| 离线截图 | ✅ `docs/shots/` 含两主题 + **真实 420px** 的目标页 |

### 架构

```
插槽条目 → 一个 <iframe srcDoc={自包含 HTML 文档}>
              ↓ 帧内
           纯 HTML + 原生 JS（零 React / 零 hooks / 零框架注入）
           自带两套主题 token + markdown 渲染器 + 图表 + 黑匣子 report()
              ↓ 数据
           fetch('/__luzzy/usage')  ← 一次返回：totals + models + 三个窗口 + 活动阵列
           fetch('/__luzzy/readme')
           fetch('/__luzzy/preset') ← 名单 + 提示词 + 会话事实
           fetch('/__luzzy/goal')   ← 运行时 goal + 交付计划 + 完整性 + 漂移 + 产物状态
           POST /__luzzy/diag       ← 帧内上报，宿主写文件

宿主半另装（不属于任何一个子页）：
  · tools/pre-execute       → 完成门：过早的 complete 被拒
  · agent/turn-stopping     → 对账屏障：本轮真的改了工作区而计划没动，steer 一次
  · tools/post-execute      → get_goal 结果追加紧凑的 delivery 块
  · goal_delivery 工具      → 计划自己的写入口
```

### 关键文件

```
luzzy-page/
├── src/client.js           ← 手写源（界面）。改这里
├── lib/client.js           ← 构建产物（625 KB，含内联字体）。不要手改
├── lib/index.js            ← 宿主半：/__luzzy/{usage,readme,diag} + 装配下面这些
├── lib/usage-*.mjs         ← 用量：聚合门面 / worker / 纯核 / 窗口 / 缓存
├── lib/preset-*.mjs        ← 预设：操作 / 路由 / 磁盘真源
├── lib/goal-domain.mjs     ← 目标：纯逻辑（完整性 / 完成门 / 漂移 / Markdown 投影）
├── lib/goal-store.mjs      ← 目标：CAS 持久化 + goal.md 投影 + 开启标志
├── lib/goal-enforce.mjs    ← 目标：三条生命周期钩子
├── lib/goal-tools.mjs      ← 目标：goal_delivery 工具
├── lib/goal-routes.mjs     ← 目标：/__luzzy/goal
├── docs/GOAL-交付层.md      ← 目标子页的完整设计说明
├── tools/                  ← 41 个脚本，见 README 的文件树
│   └── shoot.mjs           ← 唯一的截图步骤（两个渲染器都调它）
└── README.md               ← 同时是字体子集的取样源（改了要重建）
```

**改 `src/client.js` 或 `README.md` 后必须重跑 `python tools/build-font-css.py`。**

---

## 二、已完成的历次需求

### 第三轮 · 三项

#### 1. 活动阵列：以天为一格，自然月为总格数

**做法**：`lib/usage-window.mjs` 的 `monthActivity()` 输出当月每一天（28–31 格）的用量，未来日期带 `isFuture`。前端把未来的格子渲染成**空白格**（占位、无填色、`aria-hidden`），不是「0 用量」的填色格。

**为什么不是「按当前单位分桶」**：格数会随粒度在 22–174 之间晃，这个网格换过三次形态都被数据密度打脸（见 §五 5.5）。定死语义（当月每天）比调 CSS 更根本。

#### 2. 去掉小时视图，窗口按钮移到趋势图上方

**做法**：窗口改为 `[['day','日'],['week','周'],['month','月']]`，按钮放进趋势卡的**标题栏**（只影响那张图）。原来的单位按钮在页面顶部，影响整页，现在没有了。

**一并简化**：`GET /__luzzy/usage` **不再接受 unit 参数**，一次返回全部三个窗口。切换窗口是纯前端渲染，不发请求、不会和刷新赛跑。同时干掉了 `usage-aggregate.mjs` 里那个按 unit 分键的 inflight 机制（不再需要）。

#### 3. 折线改平滑曲线；日=当天小时 / 周=自然周 / 月=自然月各周；未到的留空

**做法**：
- 窗口 = **自然时间单位**：今天的 24 小时 / 本周 7 天（周一起）/ 本月各周
- **未到的时段是 `null`**，曲线在那里**断开**——不是画 0（画 0 会造出一段掉到轴上的塌方）
- 曲线用 **Fritsch–Carlson 单调三次插值**（不是 Catmull-Rom，见 §四）
- 多序列：每个模型一条曲线 + 图例（含窗口内合计），超过 8 个模型把尾部合并成「其他模型（N 个）」

### 第五轮 · 四项

#### 1. 月视图的周标签要带日期区间，且自然跨月

x 轴副标题直接由 `monthSlots()` 的 `range` 字段渲染，**没有在前端拼字符串**——区间是数据的一部分，这样「跨月的那一周」不需要特判。

实测（`docs/shots/usage-month-line.png`）：`第1周 / 8.31 - 9.6`、`第2周 / 9.7 - 9.13`、`第3周 / 9.14 - 9.20`、`第4周 / 9.21 - 9.27`、`第5周 / 9.28 - 10.4`。

**第5周从 9 月跨到 10 月是自然发生的**：切周按天推进，不按「当月第几个星期−几」。悬停浮窗里也带同一份区间（`第3周 · 9.14 - 9.20`）。

#### 2. 切换时间视图 / 切换图表模式的交互动画

**做法**：`.chartWrap` 上挂 `data-animate`，由 `@keyframes chartIn`（透明度 + 6px 上浮，260/300 ms）驱动；曲线与柱子分别动画。

两条纪律：

- **首次渲染不动画**：`animateChart = lastChartKey !== null && lastChartKey !== chartKey`——只在图表的**身份真的变了**（窗口或模式变了）时入场。刷新拿回同一张图的新数据不重放动画，否则每次刷新都像闪一下。
- **属性是临时的**：动画结束（400 ms 定时器）后移除 `data-animate`。用定时器而不是 `animationend`，因为 **`prefers-reduced-motion` 下动画是 `none`，`animationend` 永不触发**，属性会被永久卡住。

**验收**：`tools/test-animation.mjs`（见 §八）。静态截图证明不了动画——**必须在动画进行中采样**才能区分「动画在跑」和「动画没生效」。

#### 3. 活动阵列未到的日期留白

未来的格子渲染成 `<div class="cell cellFuture" aria-hidden="true">`：**占据网格轨道**（所以 30 天的月恒有 30 格），但**不填色**。像素采样实测：`2026-09` 表头 `已过 20/30 天`，横向扫描得到**恰好 20 个有色格**，其余与页面背景同色（即真空白）。

#### 4. 折线图悬停浮窗

移到某个点上（或某组柱子上）显示该格的 `标签 · 合计` 与**各模型分行**（从大到小，无用的零行省略）。配指引线、放大点；浮窗贴边时自动翻到另一侧。

实测（`docs/shots/hover-week-bar.png`）：`9/17 · 11.62亿 tokens` + 3 行模型；月视图（`hover-month-bar.png`）：`第3周 · 9.14 - 9.20 / 34.34亿 tokens` + 6 行，各行相加 = 34.35亿 ≈ 表头值。

---

## 三、缺陷 1「用量页停在 loading」—— 已结案：不是 bug

帧内黑匣子上报的实测数据（来自运行中的 DSH，非离线渲染）：

| unit | 耗时 | attempts | buckets |
|---|---|---|---|
| day | 675 ms | 19,812 | 22 |
| hour | 317 ms | 19,814 | 174 |
| week | 540 ms | 19,815 | 4 |
| month | 379 ms | 19,816 | 2 |

**8 次 start → 8 次 ok，全部 < 700 ms。**

原因是**首次冷启动约 20–30 秒**（解压 200 个日志、220 MB），而页面上**没有任何进度反馈**——看着就是卡死。已修：加载态显示已用秒数、写明「首次约 20–30 秒」、加 90 秒超时兜底、帧内三阶段上报。

---

## 四、修掉的其他真问题

| # | 问题 | 根因 | 修法 |
|---|---|---|---|
| 1 | **暗色模式下整页仍是浅色** | iframe 是独立文档，CSS 变量**不跨文档继承**。帧内 38 处引用、**0 处定义**，全部静默回退 | 帧自带两套 token；父组件把主题**烘焙进文档**；MutationObserver 跟随切换 |
| 2 | 骨架屏颜色令牌不存在 | `--dsw-alias-bg-skeleton` 是**凭空写的**，DSH 里没有 | 换成真实存在的 `--dsw-alias-interactive-bg-hover` |
| 3 | **切单位可能拿到上一个单位的数据** | `inflight` 是单个未分键的槽位 | 改 `Map` 分键（本轮进一步简化为不再需要） |
| 4 | 活动阵列两难 | 22 格摊平看不清 / 174 格溢出卡片 | 定死语义为「当月每天」 |
| 5 | 折线图浪费半张图 | `niceMax` 用粗阶梯 1-2-5-10，10.8 亿被抬到 20 亿 | 细密阶梯，现在 12.5 亿 |
| 6 | 标题重名且贴错位置 | 页面级与卡片标题都叫「Token 趋势」 | 页面级标题取消，卡片改「模型趋势」 |
| 7 | **测试污染诊断证据** | 测试调 `apply()` 把**测试进程的 pid 与临时端口**写进真实 diag 目录，被当成「宿主在 50269」的证据 | 测试用 `LUZZY_DIAG_DIR`；marker 带 `source: host\|test` |
| 8 | diag 一次一文件 | 累积 348+ 个小文件 | 改成 `diag.jsonl` + 2 MB 轮转 |
| 9 | **曲线画到轴下面** | Catmull-Rom **过冲**：两个正数之间鼓到零以下，日视图真的画出了负 token | 换 **Fritsch–Carlson 单调插值** + 采样断言（`test-chart-path.mjs`） |
| 10 | **离线验收是假的** | `--unit` / `--mode` 只点标签页，不驱动帧内控件；hour 与 day 的截图**逐字节相同** | 渲染器分两轮等待分别点击；判据「sha 相同就是没验到」 |
| 11 | 构建不拦语法错误 | 帧文档是模板字符串，未转义反引号会让它提前结束，症状是空白帧 | `build-font-css.py` 写完产物后解析，不过就非零退出；另加 `scan-frame-backticks.mjs` |
| 12 | **测试断言过期** | 断言了已删除的 `bucketLabel`，把能跑的构建报成失败 | 改为断言现行契约 |
| 13 | **`data-animate` 永久留在 DOM 上** | 入场属性设了不清除，等于宣示「这张图一直在动画」 | 400 ms 定时器移除；**不用 `animationend`**——reduce 分支下动画是 `none`，该事件永不触发，属性会被永久卡住 |
| 14 | **动效验收假阴性，差点误改正确的 CSS** | 无头浏览器恒定报 `prefers-reduced-motion: reduce`，媒体查询**按设计**关掉了动画；而测试的期望值写死了「应该是 chartIn」 | 三个臂 `as-is`/`reduce`/`motion`，报告**打印实测偏好**再按它判分支（详见 `AGENTS.md` §5.15） |
| 15 | **截图工具的四种静默失败** | GUI 程序不等待、profile 锁、Edge 移交后非零退出、文件落盘晚于读取 | 统一到 `tools/shoot.mjs`：`execFileSync` + 一文件一 profile + 一次重试；批量补图后**在新进程里复核哈希**（`AGENTS.md` §5.16） |

---

## 五、失败史（供复盘）

| 轮 | 做法 | 结果 | 根因 |
|---|---|---|---|
| 1 | React 组件 + `require('react')` 的 hooks | 白屏 | 第二份 React → #321 |
| 2 | hooks-free + `defineStore` store share | 白屏 | `conversation.view` 不注入 `useStore` |
| 3 | **iframe 自包含文档** | ✅ | 三代里唯一能用的 |
| — | 宿主 `apply()` 里跑 20 秒同步聚合 | **DSH 起不来** | admission 通道 30 秒超时被饿死 |
| — | `setImmediate` 分块「让出」 | **同样起不来** | 实测单次停顿仍有 5.9 秒 |
| — | **`worker_threads`** | ✅ 停顿降到 2–7 ms | 正解 |
| — | `zstdDecompressSync` 解多帧日志 | 静默返回截断结果，聚合全 0 | 只解第一帧 |
| — | 朴素相加 usage 与 stream chunk | 多算 **1.64 倍** | 同一份用量的两种记法 |
| — | 帧文档里写未转义反引号 | 空白帧（**四次**） | 模板字符串提前结束 |
| — | Catmull-Rom 平滑 | **曲线画到轴下面**（负 token） | 过冲 |
| — | 只点标签页的离线验收 | 「验过」但**逐字节相同** | 没驱动帧内控件 |
| 5 | 用 `--force-prefers-reduced-motion=<值>` 去「允许动画」 | 开关不接受取值，**照样强制 reduce**；那一轮与 reduce 轮截图**逐字节相同** | 把「没换变量」当成「验过了」 |
| 5 | 拿静态截图证明动画存在 | 动画早已结束，**与没有动画逐像素相同** | 必须**在动画进行中采样** |
| 5 | `& msedge.exe … --screenshot=` 后立刻读文件 | 「文件不存在」/ 读到**半写的文件**（同一个已完成文件的哈希会变） | Edge 是 GUI 程序，PowerShell **不等它** |

**方法论教训**：

1. 前两轮在看不见渲染进程报错的情况下「推理」病因，连错两次。**先装黑匣子再动手**。
2. 黑匣子**装在帧外等于没装**——帧是独立文档，它里面抛的错不会进宿主控制台。
3. **「验过」要看证据强度**：两张应当不同的截图 sha 相同 = 没验到；曲线该有的几何性质要用采样断言，不是「看着挺顺」。
4. **给自己写「别踩这个坑」的注释时最容易踩这个坑**（反引号事故里有两次是这样发生的）。
5. **「现象与期望不符」时，先怀疑期望，再怀疑实现。** 第五轮那次动效假阴性，如果先去改 CSS，就会把一段正确的无障碍实现改坏。**测试必须打印它观测到的环境事实**（这里是 `prefers-reduced-motion` 的实测值），否则环境一变它就开始撒谎。

---

## 六、下一步

### P0 · **重启 DSH**

宿主半不热重载。**重启后 `diag.jsonl` 里应出现 `cache` 字段**（`hits`/`misses`）——那是本轮性能修复生效的标志。

重启后请确认：

- [ ] **用量页秒开**（首次除外；之后 `hits` 应接近 200、`misses` 只随新会话增长）
- [ ] 标签在「轨迹」右侧，进入默认显示说明子页
- [ ] README 子页**左右占满**
- [ ] **活动阵列是当月 30/31 格**，**已过的格子按深浅填色、未到的留白**（真空白，不是虚线框）
- [ ] **切「日 / 周 / 月」**：x 轴变成 24 小时 / 7 天 / 本月各周，且**未来时段留空、曲线断开**
- [ ] **月视图的周标签带日期**（`第1周 8.31 - 9.6` … `第5周 9.28 - 10.4`，最后一周自然跨到 10 月）
- [ ] **切窗口 / 切「折线 / 条形」时有入场动画**，而**进页面时不动画**
- [ ] **移到点上出现浮窗**：表头是 `标签 · 合计`，下面是各模型分行（条形图也要能出）
- [ ] **折线是平滑曲线**，且**不穿到零轴以下**
- [ ] 切「折线 / 条形」生效（条形按模型分组并排）
- [ ] 模型 > 8 个时出现「其他模型（N 个）」
- [ ] **切换 DSH 浅色/暗色主题，页面跟着变**
- [ ] 在系统里开启「减少动态效果」后，**切换图不再有动画**（无障碍分支）
- [ ] 切回「对话」「轨迹」无样式污染
- [ ] 浏览器控制台无报错
- [ ] 数字与 `node tools/dump-usage-data.mjs` 一致

重启后查黑匣子：

```bash
tail -30 ~/.dsh/luzzy-page-diag/diag.jsonl
```

`usage-fetch-ok` 现在带 `ms` / `attempts` / `windows` / `series`；出现 `usage-payload-stale` 说明宿主半仍是旧版。

### P1 · 技术债

| 项 | 说明 |
|---|---|
| 缓存失效粒度 | 整个缓存文件重写（3 MB，8 ms）。单文件更新更省，但当前代价可忽略 |
| 缓存上限 | 64 MB；超过就不写（正常 3 MB） |
| 帧内 markdown 渲染器 | 覆盖 README 实际用到的语法，无链接与引用块——README 若加这些需扩展 |
| 条形图模型数多时 | 8 条并排会偏细；若需要可改为「堆叠」 |
| 旧 diag 小文件 | `diag-*.json` 是旧格式残留，已归档到 `archive-old-format/`，可自行清理 |
| 旧结构 payload 渲染器 | `render-stale-payload.mjs` 与 `render-stale*` 截图是上一轮的诊断产物，宿主半升级后可删 |

---

## 七、性能：从「45 秒」到「瞬时」（本轮）

用户反馈「这也太慢了」——页面卡在「正在统计用量… 已用时 45 秒」。拆成两个独立问题查，**两个都是真 bug**。

### 问题一：帧被反复重载（45 秒的直接原因）

`srcDoc: buildFrameDocument(FONT_FACE_CSS, theme)` **每次渲染都新建 394 KB 字符串**。React 按值比较 `srcDoc`，一变就重载 iframe —— 正在跑的 fetch 作废，从头再读 220 MB。

黑匣子证据（`diag.jsonl`）：`frame-boot` **出现两次**（13:50:00 / 13:51:10），而 `usage-fetch-start` **从没等到过 `-ok`**。

**修法**：文档构建一次成 `FRAME_DOCUMENT` 常量；主题不再进文档（写在帧的根属性上）。

### 问题二：冷启动 20 秒几乎全在解压，而结果只有 3 MB

| 阶段 | 耗时 |
|---|---|
| 解压 zstd → jsonl（553 MB） | **18,012 ms** |
| 解析 jsonl → attempts | 2,378 ms |
| 冷读合计 | 20,390 ms |
| 缓存文件 | **3.1 MB** |
| 读缓存 + 解析 | **16 ms** |

**修法**：`lib/usage-cache.mjs` 按文件缓存解析结果，键 `(size, mtimeMs)`，带版本号，**全程 soft fail**。

### 实测效果

```
1. no cache (cold)        20889 ms   {"hits":0,   "misses":200, "saved":true}
2. after restart (cached)   144 ms   {"hits":200, "misses":0,   "saved":false}
   attempts: 20085 -> 20085    totals: 6627259780 -> 6627259780
```

**145 倍，结果逐位一致。** 另加**延后 15 秒的后台预热**（在 worker 里跑，最坏停顿 19 ms），使「重启后打开页面」也接近瞬时。

### 现在的首次显示耗时

| 场景 | 耗时 |
|---|---|
| 预热完成后打开（常态） | **0 ms** |
| 预热进行中打开 | ~21 s（**加入同一次运行**，不重复读） |
| 完全没有缓存 | ~21 s |

---

## 八、可复用的资产

### 测试（10 个套件全绿，约 240 条断言）

| 脚本 | 断言 | 查什么 |
|---|---|---|
| `tools/test-loader-contract.mjs` | 6 | bundle id 必须等于包名 |
| `tools/test-client-load.mjs` | 59 | 插槽/iframe/主题契约、**srcDoc 稳定性**、过期宿主检测 |
| `tools/render-frame-preview.mjs` | 30 | 帧文档结构 |
| **`tools/test-usage-window.mjs`** | **60** | **自然窗口边界、未来为 null、序列上限求和、活动阵列的已过/未到划分** |
| **`tools/test-chart-path.mjs`** | **15** | **曲线几何：单调不过冲（采样贝塞尔）** |
| **`tools/test-usage-cache.mjs`** | **27** | **缓存往返（Map！）、版本、损坏、写不进去、过期判定** |
| `tools/test-host-routes.mjs` | 28 | 路由行为（405 / 缓存） |
| `tools/test-host-integration.mjs` | 15 | 真实 webserver 包 + 真实 HTTP |
| `tools/test-event-loop-responsiveness.mjs` | — | 聚合**与预热**都不阻塞主线程 |
| `tools/scan-frame-backticks.mjs` | — | 帧模板未转义反引号 |
| `tools/verify-no-hooks.cjs` / `verify-font-css.py` | — | 无第二 React / 字形零缺失 |

**动画不在上表的静态检查里**——它由下面的三臂实验单独验，因为静态断言只能证明「规则在」，证明不了「动画在跑」。

### 动效与悬停的专项验收

| 脚本 | 查什么 |
|---|---|
| **`tools/test-animation.mjs [as-is\|reduce\|motion]`** | 三个臂分别验：reduce 下动画必须被抑制、motion 下必须真的在跑（采样到 `opacity=0` 与 `anims=1`）、首次渲染不动画、结束后 `data-animate` 已清除。报告首行永远打印**实测的** `prefers-reduced-motion` 值 |
| `tools/render-hover-shot.mjs` | 真实指针事件驱动浮窗并截图（`--window` / `--mode` / `--shot`） |
| `tools/render-anim-shot.mjs` | 在动画**进行中**截图 |

> 无头浏览器恒定报 `prefers-reduced-motion: reduce`，而 `--force-prefers-reduced-motion` **不接受取值**。想验「动画真的在跑」，只能把媒体查询块从帧副本里删掉——理由与三个臂的判据见 `AGENTS.md` §5.15。

### 性能与诊断

| 脚本 | 用途 |
|---|---|
| `tools/probe-cache-bench.mjs` | 冷 vs 缓存重启，**冻结快照**后逐位比对 + 计时 |
| `tools/probe-first-paint.mjs` | 三种打开时机的首次显示耗时 |
| `tools/probe-extract-cost.mjs` | 拆解冷读各阶段耗时与缓存体积 |
| `tools/probe-warmth.mjs` | 冷 / 结果缓存 / 重新分桶 三段对比 |
| `tools/probe-aggregate.mjs` | 单独跑聚合，隔离「worker 坏了」与「路由坏了」 |
| `/__luzzy/diag` + 帧内 `report()` | 渲染进程与 iframe 的黑匣子 → `diag.jsonl` |
| `routes-registered.json` | 宿主半激活标记，带 `source: host\|test` |

### 离线验收

```bash
node tools/dump-usage-data.mjs                                   # 导出真实数据
node tools/render-frame-preview.mjs                              # 帧结构校验（30 项）
node tools/render-frame-with-data.mjs --tab usage --window month --mode bar --shot out.png
node tools/render-hover-shot.mjs --window month --mode bar --shot hover.png
node tools/test-animation.mjs motion                             # 动画真的在跑
node tools/test-animation.mjs reduce                             # 减少动态效果时它必须停
```

`--shot` 直接出图（走 `tools/shoot.mjs`，内含一文件一 profile 与一次重试）。

截图在 `docs/shots/`。**判据：应当不同的两张图若 sha256 相同，就是没验到**；批量补图后**要在新进程里复核哈希**——同一批命令里刚截完就读，可能读到旧文件或半写的文件。

### 数据正确性（核心结论）

- 同一份用量记两遍，**朴素相加多算 1.64 倍**（正确 61.8 亿 vs 错算 101.3 亿）
- 正确口径：最终 `assistant/message` 样本**替换**同次尝试的流式样本
- 模型归属取 `request/header` 的 `config.{provider,model}`
- 四档单位在**冻结快照**上对账一致；**缓存命中路径与冷读路径逐位一致**（145 倍提速下）

---

## 九、环境事实

| 项 | 值 |
|---|---|
| DSH Desktop | 2.0.11 |
| profile | `~/.dsh/profiles/desktop`，bundles 含 `dsh-luzzy-page`，`patchReload: live` |
| 宿主端口 | **每次不同**——别硬编码，从 `routes-registered.json` 读，且要核对 pid 是否还活着 |
| 客户端热重载 | ✅ 生效（`lib/client.js` 改动立刻可用） |
| **宿主热重载** | ❌ **不生效**（`lib/index.js` 等改动必须重启 DSH） |
| Node | v24.18.1（Electron 内）/ v24.11.1（外部） |
| Python | 3.13.11 + fontTools 4.64.0 + brotli |
| 源字体 | `D:\.NekoTool\LuzzyRP\app\src\main\res\font\`（普惠体 3.0 + Alibaba Sans） |
| 字体子集 | 606 CJK 字形，全内联无外部请求 |
| 会话日志 | `~/.dsh/sessions/**/*.jsonl.zstd`，200 个，**220 MB**（解压后 553 MB） |
| 解析缓存 | `~/.dsh/luzzy-page-diag/extract-cache.json`，**3.1 MB** |
| 准入机制 | 每次启动随机 43 字符 token，校验 `x-dsh-desktop-renderer`——**进程外探测无意义** |

---

## 十、给下一个会话的第一句话

> 先读 `AGENTS.md` §五（已证伪的做法，5.1–5.16）——三次白屏、两次启动崩溃、四次反引号事故、两次假验收、一次曲线穿轴、**一次 srcDoc 重载**、**一次 20 秒冷启动**、**一次差点误改正确 CSS 的动效假阴性**的根因都在那里。
> 然后看本文件 §一（当前状态）与 §六（下一步：重启后验收）。
> **改客户端代码后记得 `python tools/build-font-css.py` 重建**（构建会自己拦语法错误）。
> **遇到问题先装黑匣子取证，不要推理病因**——而且黑匣子必须装进 iframe 里。
> **「看起来对」不算验收**：该不同的截图比 sha，该有的几何性质采样断言，动画要在进行中采样，性能改动要在**冻结快照**上验「更快且逐位一致」。
> **现象与期望不符时先怀疑期望**：测试要打印它观测到的环境事实（如 `prefers-reduced-motion` 的实测值），否则环境一变它就开始撒谎。

---

## 十一、「预设」子页 + LuzzyMode 预设（第六轮）

### 需求

1. 用户可自定义 system prompt；新增 `LuzzyMode` 预设选项；启用插件时自动选它；选中它时提示词走**子页面设置的**，而不是预设内部的。
2. 可切换智能体、可分组、可手动排序；不同智能体各自有提示词；选中 LuzzyMode 后**手动切换激活智能体即实时换 system prompt**，无需新开会话。

### 结论：三条都成立，但机制与最初设想有三处不同

| 原设想 | 实际机制 |
|---|---|
| 插件启用时自动选预设 | **做不到插件级**。预设是**会话创建时**按 `settings.yaml` 的 `agent-presets.default` 定的。可做的是：改那个默认值（全局、对下一个会话生效）、或新建会话时带 `agentPreset`。**已在产出过内容的会话换不了预设**（DSH 硬规则） |
| 提示词「不走预设内部」 | ✅ 真的可行，而且是字面意义上的：组装里 persona 那一行换成插件行，段的文本是**固定引用** `{{luzzy_persona}}`，取值来自一个**每次都读盘的变量 provider** |
| 切智能体即实时换提示词 | ✅ 可行。换的是**被读取的文件**，不是预设——预设锁管不到它。`assemble()` 每步都跑，所以**下一次请求**就生效 |

### 为什么是变量而不是段文本

`renderPrompt` 对**段文本**做 `{{...}}` 插值，**未知引用直接抛异常**。用户提示词里出现一对花括号（写示例很常见）就会让每次请求失败。**变量的取值不会被再次扫描**，原样送入 —— 这让任意用户文本安全。

### 交付物

```
luzzy-preset/                     ← 新目录，自成一体（无 package.json / 无 bundle 注册）
├── preset.yml                    name: LuzzyMode, order: 9
├── agent.cordis.yml              随包 standard 全部行，只换 identity 那一段
├── lib/persona.mjs               注册 deployment:persona-prefix(= {{luzzy_persona}}) + 变量 + 后缀
├── lib/preset-store.mjs          读盘（与 luzzy-page 的副本逐字节相同）
├── lib/default-prompt.md         兜底
└── README.md

luzzy-page/
├── lib/preset-store.mjs          同上（副本，parity 测试锁住）
├── lib/preset-ops.mjs            名单操作 + 会话预设判断 + 新建会话 + 读单个提示词
├── lib/preset-routes.mjs         GET/POST /__luzzy/preset
├── lib/index.js                  ← 唯一改动的现有文件：+2 行（import 与 registerPresetRoutes(ctx)）
├── src/client.js                 +第三个 tab、+预设子页（新函数，不改现有函数体）
├── tools/install-preset.mjs      安装脚本（默认 dry run）
├── tools/test-preset-{store,persona,parity,routes}.mjs
├── tools/check-frame-script.mjs  帧脚本能否解析（补上构建门禁漏掉的另一半）
├── tools/probe-frame-console.mjs 帧内黑匣子的可视化版（见下）
└── tools/find-frame-error.mjs / extract-frame-script.mjs   定位帧语法错误
```

### 本轮踩到并修掉的真问题

| # | 问题 | 根因 | 处置 |
|---|---|---|---|
| 1 | 帧内 `SyntaxError`，**整页空白**（tab 栏在，内容是空的） | 我在帧模板里写了 `'\n在左侧…'`——`\n` 被**模板字符串**吃掉，在单引号串里留下真实换行。与反引号事故同一族 | 去掉转义；新增 `tools/check-frame-script.mjs`（`node --check` 看不到帧脚本，因为它是字符串） |
| 2 | 提示词缓存会**悄悄送回旧提示词** | 实测本机 NTFS：**200 次等长原地改写，144 次 stat 四元组完全相同**。一个字的修改正是这个形状 | **删掉缓存**。读取成本是一次小文件读取，正确性不该建在时间戳分辨率上 |
| 3 | `ensureStore` 报 500 | 用了 `readFileSafe` 却没 import | 补 import；该套件当场抓到 |
| 4 | 超大请求体导致 `ECONNRESET` + libuv 断言 | `req.destroy()` 让客户端拿不到 413 | 改为**读完再答 413**（内存仍受上限约束） |
| 5 | `?sessionId=`（空串）被当成真实会话 | 空串落进 `readSessionFacts` | 空串按「未提供」处理 |
| 6 | 缺 `op` 报「未知操作 ""」 | 空 op 走了未知分支 | 单独给出「缺少 op」 |
| 7 | 预设包带了一整套**用不上的** bundle 机制 | 以为 `./lib/persona.mjs` 需要包注册 | 拿本机 `liangshen` 预设对证：它用相对行且**无 package.json、无 bundle 注册**。删掉 package.json / cordis.patch.yml / lib/index.js —— 少一个会失败的安装步骤 |

### 帧内诊断：这台机器上 `--dump-dom` 恒返回 0 字节

**这是本轮最重要的环境事实。** 该机器以管理员身份运行，Edge 会**自我降权**（`RunDeElevated: Started process`），启动器进程立刻退出，真正干活的是子进程 —— 于是 `--dump-dom` 什么都拿不到（三种 flag 组合实测均为 0 字符），**包括页面完全正常的时候**。而 `--screenshot` 成功，因为子进程自己写文件。

所以 `tools/probe-frame-console.mjs` 把证据走到**唯一还通的那条路**：注入一个覆盖层，捕获帧自己的 `report()`、每个 `fetch` 的结果、以及未捕获错误，然后截图。空白页因此变成可诊断现象——本轮那个 `SyntaxError` 就是这样定位到的（覆盖层直接打出 `SyntaxError @1952:13`）。

### 会话 id 拿不到（已解决）

`conversation.view` 的条目默认只注入 `viewRequest` / `openView` / `completeViewRequest`，**没有 `sessionId`**。而帧是 `about:srcdoc` 文档，`window.location` 是**父页面的 URL**，`srcDoc` 又压过 `src` —— 所以「往 iframe 的 URL 里塞 sessionId」这条路根本不通。

正解：条目加 `inject: (sessionId) => ({ sessionId })`（`dsh-client-ui-trajectory` 用的就是这个机制）→ 组件把值存进模块级变量 → 帧通过 `postMessage` **问一次**，宿主答一次。

**核心功能不依赖它**：激活的智能体是全局指针，换它对所有会话的下一次请求都生效。拿不到 sessionId 只是让「这个会话能不能切到 LuzzyMode」显示为「未知」。

### 验收

- **13 个测试套件全绿**（原 10 个 + 新增 4 个，减去已合并的计数）：`test-preset-store` 72、`test-preset-routes` 74、`test-preset-persona` 30、`test-preset-parity` 29
- `test-client-load` 扩到 **75 条断言**（新增 tab 存在、无 hooks、`srcDoc` 仍逐字节稳定、会话握手、不做 URL 取 sessionId）
- **四页截图 sha256 互不相同**：readme / usage / preset-light / preset-dark（§5.7 的判据）
- 明暗两套主题各自看过渲染结果（§14.1）
- 用量页与说明页**渲染无变化**（截图目视 + 现有测试全过）

### 还没做（需要重启后）

- [ ] 重启 DSH，确认 `LuzzyMode` 出现在预设选项里
- [ ] 装预设：`cd luzzy-page && node tools/install-preset.mjs`（先看 dry run）
- [ ] 真机验收：改提示词 → 保存 → **同一条会话**发消息 → 看轨迹里的 system 节点已换
- [ ] 切激活智能体 → 同一会话再发消息 → 提示词随之变化
- [ ] 重启 DSH → 设置与提示词仍在
- [ ] 黑匣子里出现 `preset-fetch-ok` / `preset-save-ok` / `preset-switch-ok`，且无 `-failed`

### 已知边界（设计如此，不是缺陷）

| 边界 | 说明 |
|---|---|
| 老会话换不了预设 | DSH 硬规则（`agent-preset/locked`）。页面给「新建 LuzzyMode 会话」按钮，并写清真原因，不假装成功 |
| 激活的智能体是**全局**的 | 因为 `conversation.view` 拿不到 per-session 上下文。若要「每会话各一个」，得改走右侧栏 `sidebar.right.pane.tab` 插槽（那里有 sessionId），是另一套 UI 落点 |
| 提示词读取**故意无缓存** | 见上表第 2 条 |
| 预设目录与页面插件各带一份 store 模块 | 两边不能互相 import（预设被拷进 `.agent-presets/` 后只能解析同级文件）。靠 `test-preset-parity` 锁住「字节相同 + 行为相同」 |
| `LuzzyMode` 不是默认预设（默认仍是 `luzzy`） | 改默认是全局行为变更，需要用户决定：`node tools/install-preset.mjs --apply --set-default` |

---

## 十二、真机首跑暴露的问题（深度审查）

真机截图暴露 5 个缺陷，全部已修并加测试锁住。**其中 4 个是「测试全绿但真机错」**——原因见 `AGENTS.md` §5.21。

| # | 症状 | 根因 | 修法 | 锁它的测试 |
|---|---|---|---|---|
| 1 | `新建会话失败：preset "luzzy-mode" not found` | 预设**根本没装**——上一轮只跑了 dry run | 执行 `install-preset.mjs --apply` | `test-installed-preset`（未安装时会明说「run --apply first」） |
| 2 | **`预设读取失败 — cannot get property "agents" without inject`** | cordis 代理对未声明的服务名**抛异常**；`?.` 挡不住 throwing getter | 可选服务一律走 `ctx.get(name)` | 两个套件改用**会抛的代理**；`test-host-routes` 跑真 `apply()` |
| 3 | **种子提示词没生效**：120 KB 提示词躺在磁盘上没人读，会话跑的是 239 字符兜底 | installer 把种子写进了**预设目录**（`~/.dsh/.agent-presets/luzzy-mode/agents/`），而读取器看的是 **store**（`~/.dsh/luzzy-preset/agents/`）。两棵树只差一层，且**全程不报错** | 种子改写进 store；测试改为断言「解析出的文本 == 种子文件**逐字节相同**」而不只是「非空」 | `test-installed-preset` + 「预设目录内不得出现 agents/」 |
| 4 | 页面写着「已用一份默认名单起步」，**下面却列着「还没有智能体」** | `readSnapshot` **不播种**（只有 `ensureStore` 播种），警告文案却在声称已播种 | 改成与事实一致的措辞；断言「警告不得包含'默认名单'」且必须说明名单为空 | `test-preset-routes` |
| 5 | 删除对话框承诺「提示词文件会一起删掉，不能撤销」 | ① `removeAgent` **根本不删文件** ② 而自由 id 可被复用，`suggestId` 只看当前名单——**新智能体会静默继承被删者的提示词** | 文件改为**移入 `archive/`**（可找回，合 §7.6「可逆优先」）；对话框照实说；`archived` 结果回传，失败也照实报 | `test-preset-routes`：文件离开 `agents/`、内容存活于 archive、同 id 重建**不继承**旧提示词 |

### 还有两个「静默失效」的守卫

| # | 问题 | 为什么严重 | 修法 |
|---|---|---|---|
| 6 | **没有任何名单写入带 `revision`** —— 宿主那条 `409` 并发检查是**死代码** | 两个窗口同编一份名单会**互相覆盖**，输的那次改动悄悄消失，全程无错 | 在 `presetPost` **集中**附加 revision（不靠每个调用点记得）；`409` 时立即采用宿主回传的快照 |
| 7 | 帧内 `SyntaxError`（`\n` 被模板字符串吃掉） | §5.17 同族；**整页空白，只剩 tab 栏** | 去掉转义；`check-frame-script` 门禁当场抓到并打印行号 |

### 本轮新增的可复用资产

| 文件 | 作用 |
|---|---|
| `tools/test-installed-preset.mjs` | **验证装出来的预设真能加载**：从 `~/.dsh/.agent-presets/luzzy-mode/` 导入行、注册段落、断言解析出的提示词与种子文件逐字节相同；顺带查「预设目录内没有残留 agents/」和「store 副本没过期」 |
| `tools/check-frame-script.mjs` | 抽出帧脚本并编译，**报真实行号 + 上下文**。补上「构建只查外层 bundle」的漏洞 |
| `tools/probe-frame-console.mjs` | 真浏览器里跑帧，用覆盖层把 `report()` / 每个 fetch / 未捕获错误**画在页面上**再截图——因为本机 `--dump-dom` 恒返回 0 字节（§5.18） |

### 一个必须守住的约束

**预设挂载失败会让会话直接失败**：`dsh-agent-presets` 的 `mountPreset()` 抛 `agent-preset/invalid`，**不降级**。所以**不要把没验证过的预设设成默认**——`test-installed-preset` 就是为此存在的。`--set-default` 是单独开关，目前**没有执行**（默认仍是 `luzzy`）。

### 验收状态

- **14 个套件全绿**（新增 `test-installed-preset`）
- 帧三道门全过：反引号扫描 / 文档结构 / **脚本可解析**
- 「预设」子页明暗两套主题都亲眼看渲染结果，sha 互异
- 用量页、说明页未受影响
- 真机待办：**重启 DSH** 后确认子页出名单、改提示词下一次请求即生效

---

## 十三、输入框失焦：原生对话框（深度审查第二轮）

### 用户报的症状

> 「点击后无反应，且输入框失效无法点击，我只能点击其他地方 DSH 不处于第一窗口 然后再点回来 才能激活输入框 输入文字」

### 根因

帧里用了 **19 处原生 `alert` / `confirm` / `prompt`**。它们是 **Electron 窗口的 OS 级模态框**，不是页面里的元素 —— 关掉之后**键盘焦点不还给 web contents**，底部输入框从此点不动，直到用户切走再切回（那一步强制 OS 重新激活窗口）。

**页面里没有修法**：焦点从来不在页面手上。所以唯一的修法是**页面不使用原生对话框**。

### 处置

帧内自建对话框（`.dialogScrim` + `.dialog`），19 处调用点全部替换：

| 原调用 | 替换 |
|---|---|
| `alert(msg)` | `showMessage(title, body)` |
| `confirm(msg)` | `showConfirm(title, body, label)` → `Promise<boolean>` |
| `prompt(label, init)` | `showPrompt(title, init, label)` → `Promise<string\|null>` |

三条实现细节（都写进了注释与测试）：

1. **关闭时显式 `document.body.focus()`** —— 原生对话框做不到的那一步，也是整个修复的落点
2. **同一时刻只留一个对话框**（新开的先关旧的），否则两层遮罩叠着、下面那层的按钮点不到
3. **每条路径恰好 resolve 一次**（确认 / 取消 / Escape / 点遮罩），否则调用方 `.then` 永远挂着

`confirmDiscard()` 因此从同步变异步，两处调用点改成 `.then`。

### 真浏览器实测（`probe-frame-console.mjs` 现在会驱动一次往返）

```
dialog open in-frame: true (in document: true)
dialog title: 新智能体的名字
dialog has an input: true
focus inside the input: true
dialog closed: true
activeElement after close: BODY      ← 原生对话框在这里会是 NULL
```

### 顺带修掉的第二个 bug：新建会话按钮触发两次

diag 日志里 **两条** `preset-new-session-ok`（相隔约 5.7 秒），用户得到两个会话。

`disabled = true` **不足以防住**：它只在元素重渲染之后才挡指针事件，而快速双击或「点击 + 在已聚焦按钮上按回车」能在任何重渲染之前两次进到处理函数里。加了模块级 in-flight 标志（`newSessionInFlight`）。

### 本轮新增的防回归断言（`test-client-load.mjs`，共 92 条）

- **帧里任何 `alert(` / `confirm(` / `prompt(` 出现即失败** —— 故意做得很粗，一次疏忽就会退回这个 bug
- 对话框在文档内、关闭时 `document.body.focus()`、支持 Escape 与点遮罩、第二个取代第一个
- 新会话按钮有 in-flight 守卫
- `confirmDiscard` 是 Promise 形态（不再假定同步）

---

## 十四、新建会话不显示：两个结构性原因（深度审查第三轮）

### 用户报的症状

> 「新建会话始终无法在 DSH 内显示该会话」

有成功对话框，会话也确实建出来了，侧栏里就是没有。

### 根因（两个独立原因，缺一个就足以隐身）

**① `sessionController.create` 只从 `workspaceId` 挂工作区**

```js
if (request.workspaceId !== void 0) workspace = ctx.workspaceRegistry.get(request.workspaceId)
...
if (workspace !== void 0) await workspace.attachSession(sessionId)   // ← 传 cwd 时这行不执行
```

我传的是 `cwd`，于是建出一个**不属于任何工作区**的会话。侧栏按工作区分组列会话，它进不去。

**本机实测证据**（`~/.dsh/storages/workspace.json`）：那两个会话确实躺在正确目录
`sessions/--C-Users-Administrator-Desktop-DSH~0020Plugin--/` 下，却**不在任何工作区的 `sessionIds` 里**。

**② 空白会话只在「它是当前选中的那一个」时才渲染**

```js
// dsh-client-ui-workspace 的 sessionVisible
return session.origin !== "subagent" && !archived.has(session.id)
       && (!session.blank || session.id === current)
```

新建的会话**按定义是 blank**。所以即便挂载了，不选中仍然什么都看不到。

### 处置

改走**应用自己的客户端路径**——侧栏「新会话」按钮就是这么做的（`connectWorkspace`）：

```js
const id = await sessions.create({ workspaceId })   // 挂载
sessions.open(id)                                   // 选中 → 这才可见
```

**帧做不到**（选中是客户端状态，帧没有导航句柄），所以帧用 `postMessage` 请求宿主半执行，宿主半持有 `ctx.sessions`（`inject` 加了 `'sessions'`）。配套三件事：

- **工作区 id 先解析**：会话身上只有目录。宿主用 `ctx.workspaceRegistry.resolveByPath(cwd)` 解析（同一套 realpath canon），新增 `resolveWorkspace` 操作
- **预设切换放在创建之后**：会话预设是创建时定的，本插件不依赖自己是默认预设，所以创建后立刻切（空白会话是唯一允许切预设的窗口）；切换失败照实报——会话已建好且可见，只是预设还需再点一下
- **请求带 5 秒超时**：没有回应时按钮不能永远禁用，明确报「宿主半没有回应，重启 DSH」

### 新的诊断工具

`tools/probe-workspace-attach.mjs` —— 直接读 `~/.dsh/storages/workspace.json`，列出每个工作区的路径与 `sessionIds`，并回答「某个目录归谁管」。这类问题从这里看是几秒钟的事。

（**坑**：记录在 `tables.workspaces` 下，不在 `entities` / `data`。我第一版扫错了键，得到一个「所有工作区都没有路径」的假报告 —— 探针看不见数据比没有探针更糟，因为它看起来像个答案。）

### 遗留：两个孤儿会话

`session-7810f58b-…` 与 `session-ad0a5e5b-…` 仍在磁盘上（各 1 B，空会话），**没有挂到任何工作区**。它们就是本 bug 的产物，内容为空，可直接忽略；要清理由用户决定，我不代为删除。

### 追加：第一次修复踩了两个新坑（真机报 `未知操作 "resolveWorkspace"`）

**坑一：把「本来不需要宿主」的查询放进了不重载的那一半。**

第一版让客户端请求宿主路由 `resolveWorkspace`。于是出现一个**必然**的窗口期：客户端半热重载、宿主半不重载 —— 页面调用了运行中的宿主**从没听过**的操作。

**这不是「忘了重启」，是设计错误。** 客户端的 `workspaces` 服务自己就带着 `workspaceId` 与 `path`（wire schema 实测：`items[] = {workspaceId, path, title, sessionIds}`），解析完全可以在客户端做：

```js
const owner = items.find((i) => i.path.toLowerCase() === cwd.toLowerCase())
```

现在**整条 create 路径都在客户端**，没有版本偏斜可言。宿主侧的 `resolveWorkspace` 仍保留（供诊断与将来使用），但页面不再依赖它。

**坑二：一次 `postMessage` 里放了两种对话。**

`luzzy-page-host` 来源下有两种消息：**会话回答**与**创建结果**。帧的监听器只按来源判断，于是创建结果（没有 `sessionId`）被读成「你的会话是 null」。

**diag 日志里的证据**：真实 id 在创建失败后 **1 毫秒**变成 `null`，页面接着去为一个不存在的会话拉取状态 —— 截图上的「未拿到会话标识」就是这么来的。

修法：**每条消息都带 type，接收方按 type 分派**。

| 消息 | 方向 | 用途 |
|---|---|---|
| `want-session` | 帧 → 客户端半 | 问「我是哪个会话」 |
| `session` | 客户端半 → 帧 | 回答（只有它能改 `sessionId`） |
| `create-session` | 帧 → 客户端半 | 请求新建并选中 |
| `session-created` | 客户端半 → 帧 | 创建结果（**不得**影响 `sessionId`） |

### 当前状态

**客户端半已修好并热重载**；宿主半未改动这条路径，**无需重启**。刷新页面点「新建 LuzzyMode 会话」应该能建出可见的会话并切换过去。

---

## 十五、动态交互审查与全项目索引（第七轮）

> 本轮目标：① 对「预设」子页做完整动态交互审查；② 给全项目建索引。
> 结论先说：**功能链已闭环验证，且验证装置能抓住历史上那两个真实事故**；索引 95 条已建，但收敛到 `aligned` 被 **16 张截图的人工策展裁决**挡住。

### 15.1 「完整动态审查」能做到哪一步 —— 四通道实测

| 通道 | 实测结果 |
|---|---|
| 驱动**正在运行的 DSH GUI** | ✗ **做不到**。43120 对非渲染进程一律 403（令牌每次启动随机生成、只存在主进程内存）；正在跑的渲染进程也没开调试端口 |
| 用 `DSH_HOME` + `--user-data-dir` 起**隔离实例** | ✓ 机制成立（单实例锁按 user-data-dir 隔离，CDP 能挂上），但会停在 setup wizard，还需再解一层 profile 标记 |
| **真宿主路由 + 真帧**，同 origin，CDP 驱动 | ✓ **本机主路径**，全部能力验证通过 |
| 无依赖 CDP 驱动（Node 24 内置 WebSocket） | ✓ 可行，`tools/cdp-driver.mjs` 即此 |

**修正一条旧结论**：`AGENTS.md` §5.18 说「无头断言在这台机器上全废」——**那句太强了**。真实限制只在 `--dump-dom` 这个开关（Edge 降权后启动器先退出，输出 0 字节）；`--screenshot` 与 **CDP 一直可用**。已按此修正 §5.18。

`agent-browser`（skill 清单里点名的替代方案）**在本机起不来 Edge**：同样是降权导致的「Chrome exited early without writing DevToolsActivePort」。连上已运行的浏览器可以，但它自己的 daemon 在 Windows 上会挂住 —— 所以驱动是手写的。

### 15.2 本轮新增的四个装置

| 装置 | 规模 | 做什么 |
|---|---|---|
| **`tools/review-preset-chain.mjs`** | 27 断言 | **静态跨产物审计**：op 集合、postMessage 协议、路由路径、快照字段、修订守卫、产物新鲜度、预设变量接线 |
| **`tools/cdp-driver.mjs`** | 库 | 零依赖 CDP 驱动：起 Edge、建目标、**真实鼠标与键盘**、console、截图、干净的 teardown |
| **`tools/review-preset-rig.mjs`** | 81 断言 | **动态端到端**：真帧 + 真宿主路由 + 真浏览器，跑完交互矩阵与边界 |
| **`tools/test-preset-assembly.mjs`** | 27 断言 | 用 DSH **安装目录里真的 `renderPrompt`** 驱动真的预设行，证明「提示词必须走变量」这条设计前提 |
| `tools/aoci-mcp-client.mjs` + `aoci-loop.mjs` + `aoci-validate-entries.mjs` | — | 本仓的 AOCI 驱动（见 §15.5） |

**装置的有效性用故障注入验过**，不是「跑绿了就算」：

| 注入的故障 | 装置的反应 |
|---|---|
| 宿主停止处理页面会发的 op | 链审计报「host would answer 400 未知操作 —— 这正是 resolveWorkspace 事故的形状」 |
| 预设注册名与 section 引用名不一致 | 链审计报「assembly would throw on an unknown reference」 |
| 删掉 `data.type !== 'session'` 守卫 | 装置报出**一次不带 sessionId 的 GET** —— 即会话 id 被清空的确切签名 |
| 宿主不落盘 `setPrompt` | 装置报「saving wrote the new text to disk」失败 |
| 提示词写到错的智能体文件 | 同上，逐字节比对抓住 |

### 15.3 动态装置覆盖了什么

真交互驱动（`Input.dispatchMouseEvent`／真实键盘，**不是** `element.click()`）：名单渲染与「当前」徽标对账、选智能体载入磁盘全文、编辑并保存**写进磁盘**、未保存改动切换时弹帧内对话框、Escape 取消 vs 确认放弃、激活改 `activeAgentId`、**解析出的提示词随激活智能体变化**（功能的核心）、删除把提示词**移进 `archive/`** 且如实报告、无原生对话框、无 console 错误。

**明确未覆盖**：会话/预设切换需要 DSH 活的 `agentPresets` 与 `sessionController`，装置里是**缺席**而非伪造 —— 所以它验的是页面的**诚实降级**（能力按钮禁用并说明原因），真机路径仍只能靠你验收。这一条写在装置的文件头里，不假装验过。

### 15.4 装置自身的四个坑（都踩过）

1. **`</script>` 在 JS 字符串里也会终止 `<script>`** —— 帧文档含一个 `</script>`，嵌进 harness 的脚本标签后提前截断，`srcdoc` 从未赋值，装置报「帧没启动」而**没有任何报错**。修法是标准转义。
2. **点后测量坐标会读到遮罩** —— 一个**打开对话框的按钮**，成功之后必然被对话框盖住，于是「点击是否落在它上面」永远为假。要在**点击前**测。
3. **`waitInFrame` 返回首个真值，而 `'luzzy'` 也是真值** —— 等待「徽标变成 editor」时首个轮询就命中旧值并通过。谓词必须比较目标值并返回布尔。
4. **重渲染后坐标全都失效** —— 缓存过的元素坐标会点到别的智能体，而失败长得像产品缺陷。每次点击都要重新测量。

### 15.5 全项目索引（AOCI）现状

**绑定在哪**：全局 MCP 配置把 `--repo` 写死成 `D:\.NekoTool\LuzzyRP` —— 所以会话里的 `aoci_*` 工具**全部作用在另一个仓库上**（实测 `runtime_repository_root` 确认）。本仓走 `tools/aoci-mcp-client.mjs` 另起一个 `--repo` 指向本仓的 stdio 服务，**不改任何全局配置**。CLI 创作路径对 Volumes v1 不可用（报「该命令或兼容写入路径不支持修改Volumes v1正式认知」），所以 MCP 是唯一写入面。

**范围**：`init` 之后 `.gitignore` 对它**无效**（`reference/` 曾按普通源码计入 29014 个文件）。用一条显式 scope 规则排除后收敛到 **99 个文件**。

| 项 | 值 |
|---|---|
| 已建条目 | **95**（覆盖全部可索引文件） |
| 每条都带 S 约束 | 95 / 95（`S:-` 为 0） |
| 带显式 R 关系 | 91 |
| `verify` | `structure_valid: true` |
| **`governance_aligned`** | **false** ← 唯一的阻塞 |

**唯一阻塞**：`docs/shots/` 的 **16 张 PNG** 需要人工 include/exclude 裁决。**这不是猜的——机器给出了明确理由**：

```
managed_scope_auto_authorization_blocked:
cognition_coverage_reduction_requires_independent_review, p0_or_p1
```

即：**减少认知覆盖必须由独立的人工复核**，任何自动授权路径都会被拒。这是设计好的门，不该绕过。

**好消息是：这 16 张是全部**。实测本仓库范围内**只有 `.png` 一种二进制类型**（没有 svg / ico / 字体 / 音视频需要同样处理），而 PNG 全部只出现在 `docs/shots/`。所以**一次批准就收敛**，不会有第二波。

另外 `95 + 16 = 111` 正好等于 `code_source_count` —— 换句话说**所有可作者化的源码都已建条目**，剩下的 16 条机器明确表示**不可作者化**（`code_plan.candidates` 对它们恒为 0，只出现在 `orphan_remove_candidates` 里，标为 `pending_curation`）。它们不是「漏掉的」，是**另一种处置方式**。

**仓库当前留在「等你裁决」的中性状态**：规则没有加、`.aoci/scope-change/` 已清空。下面这段是完整可复现的序列（我逐条跑通过，只有第 3 步必然需要你的终端）。

```powershell
cd "C:\Users\Administrator\Desktop\DSH Plugin"
$aoci = "C:\Users\Administrator\.aoci\bin\aoci.exe"

# 1. 加规则（已加好；若已被回滚就重跑这行）
& $aoci scope rule add exclude-binary-images --action exclude `
    --pattern "**/*.png" --pattern-kind glob --order 20 `
    --reason "图片素材与验收截图：认知由引用它们的代码或文档条目承载，逐张写条目会稀释索引信号。"

# 2. 生成预览（必须无 BOM —— PowerShell 的 Set-Content 默认会加 BOM，那会让工具判定为非法输入）
[System.IO.File]::WriteAllText("$PWD\.aoci\scope-change\candidates.json",
    '{"version":"managed-scope-candidate-set/v1","entries":[],"dispositions":[]}',
    (New-Object System.Text.UTF8Encoding($false)))
& $aoci scope preview --candidate-file ".aoci/scope-change/candidates.json" --json |
    Out-File ".aoci/scope-change/preview.json" -Encoding utf8

# 3. 批准 —— 这一步会在真实终端里要求你精确输入下面这一串
& $aoci scope approve --preview-file ".aoci/scope-change/preview.json" `
    --actor "$env:USERNAME" --out-file ".aoci/scope-change/approval.json"

# 4. 应用
& $aoci scope apply --preview-file ".aoci/scope-change/preview.json" `
    --approval-file ".aoci/scope-change/approval.json"
```

第 3 步会问你：

```
你正在批准一次 Managed Scope 变更：16 个文件失去 Index 覆盖。
请精确输入：APPLY MANAGED SCOPE 6302da37c6caff08f6f7c99ad802f097f190c9eeb45d3038efee57cb01672798
```

做完后 `governance_aligned` 即为 `true`，索引收敛。**不接受这个变更也完全可以**——那 16 张图就一直算「缺失条目」，索引其余 95 条照常可用，只是 `verify` 会一直报这一条。

**踩过的坑（值得记）**：`Set-Content -Encoding UTF8` 在 Windows PowerShell 上**会写 BOM**，而 AOCI 把带 BOM 的 JSON 判为非法输入，报的是 `managed_scope_candidate_set_invalid` —— 一个完全不提 BOM 的错误。同一族的坑在 `aoci-loop.mjs` 里也踩过并已修（那里做了 BOM 剥离）。**给 AOCI 写 JSON 一律用 `UTF8Encoding($false)`。**

### 15.6 本轮的验收状态

| 项 | 状态 |
|---|---|
| 18 个既有套件 | ✅ 全绿（`test-client-load` 105 断言等） |
| 3 个帧门 | ✅ 全过 |
| 新装置 | ✅ 链审计 27/27、装置 81/81（10 张截图互不相同）、组装 27/27 |
| 视觉验收 | ✅ 亲眼看过多张截图，含暗色与对话框 |
| 协作边界 | ✅ 用量页相关文件一行未动（`usage-*.mjs` / `README.md` / `shoot.mjs` / `test-animation.mjs` 仍是 09-20） |
| 工作区 | ✅ 无散落临时文件；本轮新增 4 个工具 + 3 个 AOCI 工具 |

**真机验收仍在你手上**：刷新页面（客户端半热重载，无需重启）→ 点「新建 LuzzyMode 会话」→ 在预设页切激活智能体 → 发一条消息确认用的是该智能体的提示词。


## 十六、预设编辑器的 Markdown 工具栏与预览（第八轮）

### 16.1 需求与交付

> 「支持预设内容 Markdown 工具栏、Markdown 格式预览」

两条都做了，落在「预设」子页的 system prompt 编辑器上：

| 交付 | 内容 |
|---|---|
| Markdown 工具栏 | 10 个按钮：加粗 / 斜体 / 标题 / 引用 / 列表 / 有序 / 行内代码 / 链接 / 分割线 / 清除标记，外加右侧「预览 ⇄ 编辑」切换 |
| Markdown 预览 | 就地替换 textarea 渲染，覆盖标题 / 粗体 / 斜体 / 行内代码 / 无序列表 / 有序列表 / 引用块 / 链接 / 分割线 / 表格 / 围栏代码 |

### 16.2 按钮集合是**量出来的**，不是拍出来的

对着本机真实提示词文件（57.2 KB 的 `agents/luzzy.md`）数了一遍 Markdown 构件的实际用量：

```
heading  111    bold **x** 861    italic *x* 2      inline code  0
bullet   365    ordered    91    blockquote  17    link         2
hr        18    table row 157
```

这个分布直接决定了取舍：

- **原有的 `renderMarkdown` 只认标题 / 粗体 / 行内代码 / 无序列表 / 表格 / 分割线**（它当初只为 README 写的，`analyze-readme.cjs` 是那份判据）。**有序列表、引用块、链接、斜体全都不认** —— 861 处粗体和 157 行表格背后，是 17 处引用和 91 条有序列表会被渲染成一坨纯文本。所以这四样是**补进渲染器**的，不是可选项。
- **不提供下划线 / 高亮 / 对齐按钮**：Markdown 没有可靠语法，渲染器也不会兑现，做出来就是一个「点了没反应」的按钮。工具栏只列渲染器真的能渲染的东西。

### 16.3 三个测试才挖得出来的行为

`applyMarkdownTool` 做成了**纯函数**（传入 value + start + end + id，返回新值和新的选区），因此可以不启浏览器直接断言。它覆盖了三件手搓工具栏常错的事：

1. **往返**：对已经加粗的文字再点一次「加粗」会**去掉**标记。只会加不会减的工具栏，等于让用户手动去删星号。
2. **空选区**：不选中任何东西时产生四个星号并把光标放在中间，而不是留一对要用户自己去找位置分开的标记。
3. **按行前缀**：标题 / 引用 / 列表作用于**选区触及的每一行**，且当这些行**全都**已带该标记时整体取消。

### 16.4 本轮踩到并修掉的坑

| # | 坑 | 症状 | 处置 |
|---|---|---|---|
| 1 | **注释里写了裸反引号** | 构建直接拒绝：`Unexpected identifier 'marker'` | §5.6 的老坑。**讽刺的是，我是在写「这里是正则不是函数」的解释性注释时踩的** —— 与 §5.6 记录的「两次都在给坑写注释时踩」完全同型。已用 `scan-frame-backticks.mjs` 全量揪出并转义 |
| 2 | **`prefixLines` 把正则当函数用** | `TypeError: test is not a function` | 参数名叫 `test`，结果写成 `test(line)` —— 实际要 `marker.test(line)`。**新测试套件第一次运行就抓到了**，没进到浏览器 |
| 3 | **预览可见性有两个真源** | 潜在：切到预览后再点一次预览，DOM 属性与 wrapper 属性会各说各话 | 收敛成**只看 wrapper 的 `data-mode`**。`hidden` 属性在每次重渲染后会被覆盖，留着就是等着两边打架 |
| 4 | **测试脚本读 textarea 太早** | 报 `no-textarea`，看起来像页面坏了 | 点标签页只是**开始**一次 fetch，编辑器要等 payload 回来才渲染。改成轮询等待 —— **假失败比真 bug 更费时间**，因为它指着一个没坏的地方 |
| 5 | **route shim 装在了父窗口** | 帧渲染出「预设读取失败 — Failed to fetch」 | iframe 是**独立文档**，父窗口的 `fetch` 覆盖拦不到它。shim 必须注入帧文档内部（与 §5.5 的 token 不跨文档同源） |
| 6 | **`--dump-dom` 那条判断过宽**（旧账） | —— | §5.18 第七轮已修正：限制在 `--dump-dom` 这个开关，不在无头模式 |

### 16.5 构建链修复：字体源消失（**本轮修掉的既有故障**）

`python tools/build-font-css.py` 之前**必然失败**：

```
error: missing source font D:\.NekoTool\LuzzyRP\app\src\main\res\font\puhuiti_55_regular.ttf
```

LuzzyRP 的 `res/font` 目录里现在**只剩三个 Alibaba Sans**，两个普黑体 TTF 没了。而 `lib/client.js` 是产物 —— **不重建就等于运行旧代码**（AGENTS.md §六 第 6 条踩过）。

处置：该项目的资源树里同名 WOFF2 还在（`AlibabaPuHuiTi-3-55-Regular.woff2` 等），且 `pyftsubset` **能直接吃 WOFF2 输入**（已实测）。给构建加了一条**兜底路径**，TTF 仍然优先 —— 原文件回来就自动用回它，这里不用再改。

### 16.6 验收

| 项 | 状态 |
|---|---|
| 新套件 `test-preset-markdown.mjs` | ✅ **59/59**（工具栏 20 项 + 渲染器 14 项 + 静态接线 25 项） |
| 动装置 `review-preset-rig.mjs` | ✅ **110/110**（新增 S14：真鼠标点按钮、真渲染预览、真往返） |
| 全部套件 | ✅ **16/16** |
| 三道帧门 | ✅ 全过（结构 30 项 / 脚本 2031 行 / 无反引号） |
| 视觉验收 | ✅ **亲眼看过 4 张截图**（浅色 + 暗色 × 编辑 + 预览），sha256 **四张互不相同** |
| 产物新鲜度 | ✅ `lib/client.js` 晚于 `src/client.js` |
| 协作边界 | ✅ 用量页相关文件仍全是 09-20，一行未动 |

**本轮新增 3 个工具**：`test-preset-markdown.mjs`（新套件）、`shoot-preset-markdown.mjs`（浅/暗双主题截图）、`review-preset-rig.mjs` 增补 S14。

**真机验收仍在用户手上**：刷新页面 → 预设子页 → 选中一个智能体 → 用工具栏点几下 → 点「预览」看渲染 → 保存。

### 16.7 索引收尾（AOCI）

本轮改了 8 个受管对象，收尾时一次维护、一次提交：

```
applied 8/8   status=applied   remaining=16（全是那 16 张 PNG）
最终：source 113 | entries 97 | stale 0 | unbaselined 0 | orphan 0 | tokens 11785
```

**遗留一条已知不准确**：`shoot-preset-markdown.mjs` 的条目我写的 E 位是 `S`（<200 行），实际 268 行应属 `M`。机器在 `audit.warnings` 里指出了这一点。它不是漂移类别（`stale`/`missing` 都不计它），而提交后该对象已对齐、`maintain` 不再返回它为候选，所以**这一处暂时改不动** —— 下次该文件再有实质变更时顺手改对。**不为了改一个标签去空碰文件**。

**另**：本轮误建了一个 `luzzy-page/maintain.json`（`aoci-loop.mjs status` 的默认输出路径，我把工作区参数写成了字面量 `status`），已删除并重新取批次。它一度出现在候选清单里 —— 那是**真候选**（确实多了一个未索引文件），不是误报。


## 十七、按参考稿重做编辑器：图标工具栏 + 三种显示模式（第九轮）

### 17.1 用户给的参考稿

一张编辑器截图：顶部一行**图标**按钮、按发丝分隔线分组；右下角一个**模式选择器**（实时预览 ✓ / 源码模式 / 阅读模式）；左下角字符数。**默认实时预览。**

### 17.2 我上一轮做错了什么，以及为什么

上一轮我交的是**文字标签**按钮（「加粗 / 斜体 / 标题 / 引用…」）加一个「预览 ⇄ 编辑」toggle，还在注释里把它论证成「帧内没有图标集，标签是诚实版本」。

**那个论证是错的，而且错在一个我已经读过的地方。** AGENTS.md §一 明写：

> 参考项目的界面、视觉风格、布局、组件、交互方式与设计语言，是**既定设计**，不得随意改变。
> 找不到某个元素在现有设计里的对应物时，**先问、先找，不要自己发明一个**。

我已经读过 `reference/lobehub/src/features/EditorCanvas/TypoBar.tsx` —— **它本身就是图标工具栏**（`BoldIcon` / `ItalicIcon` / `ListIcon`…），`FloatActions` 渲染成 `ChatInputActions`。我甚至在测试里引用了它。**然后我写了一个跟它不一样的版本，并为此编了一套理由。**

**真正的教训不是「要有图标」**，而是：**当参考里已经有对口的组件时，「帧内实现不了」必须先当成待验证的假设，而不是结论。** 这一轮验证的结果是——手写 SVG path 完全可行，零依赖，40 行以内。

**同类风险**：`no underline` 这个决定本身是对的（Markdown 没语法 + 渲染器不放行裸 HTML），**保留**；但当时把它和「用文字标签」绑在一起论证，让一个正确结论顺便掩护了一个错误决定。

### 17.3 交付

| 项 | 内容 |
|---|---|
| 工具栏 | **16 个按钮**，7 组，发丝线分隔：粗/斜/删除线 ｜ 行内代码/清除行内格式 ｜ H1/H2/H3 ｜ 无序/有序/任务 ｜ 代码块/引用 ｜ 表格/分割线 ｜ 链接 |
| 图标 | `MD_ICONS` 手写 SVG path（24×24，stroke 2，圆头），**零依赖**；H1/H2/H3 与「T」用文字图标（15px 下比任何标题图形都清楚，参考稿同样如此） |
| 三种模式 | 实时预览（**默认**）/ 源码 / 阅读，右下角菜单，**向上弹出** |
| 实时预览 | 左右并排双栏；窄于 1180px 自动改上下堆叠 |
| 状态行 | 左下角 字符数，右下角模式选择器 |
| 新增渲染 | 删除线、任务列表、h4–h6（原来 clamp 到 h3） |

### 17.4 三个测试才挖出来的真问题

1. **H1/H2/H3 曾把标题删掉。** 我把三个等级实现成同一个 `prefixLines` 的三种前缀，而它的语义是「全部已带前缀 → 整体去掉」。于是 `## x` 上按 H3 得到 `x` —— **标题消失了**，正是按钮承诺的反面。改成 `setHeading(level)`：**换级是替换，同级的再次按下才是取消**。
2. **「清除行内格式」曾经连结构一起删。** 上一轮的 `clear` 会剥掉标题/引用/列表标记。但按钮叫**行内**格式，删掉文档结构是用户没要求的事。
3. **代码块曾把围栏粘在正文里**（`` ```x``` `` 挤在段落中间），改成围栏独占行。

三条都是**纯函数测试先抓到**，没有进到浏览器。

### 17.5 本轮踩的坑

| # | 坑 | 处置 |
|---|---|---|
| 1 | **裸反引号（第五次）** | 构建拒绝三次：`Unexpected identifier 'live'` / `'title'` / `'marker'`。**三条都在注释里** —— 一条是写「`live` 是默认值」、一条写「`title` 与 `aria-label`」、一条写「` ```x``` `」。§5.6 那条规律再次成立：**解释性文字最容易引用代码字面量** |
| 2 | **一次 edit 削掉了半行** | `prefixLines` 的首行被我的编辑吃掉，`lineStart` 变成未定义。读到编译错误后当场补回 —— **改大块时先在读回里核对边界** |

### 17.6 验收

| 项 | 状态 |
|---|---|
| 新套件 `test-preset-markdown.mjs` | ✅ **94/94**（原 59；新增等级替换、删除线、任务列表、代码块、表格、行内清除语义） |
| 动装置 `review-preset-rig.mjs` | ✅ **124/124**（原 110；S14 改为驱**真实菜单**切三种模式，并断言各自该显示哪些面板） |
| 全部套件 | ✅ **16/16** |
| 三道帧门 | ✅ 全过（结构 / 2264 行 / 无反引号） |
| 视觉验收 | ✅ **亲眼看 8 张截图**：浅暗 × 三种模式 = 6 张，菜单展开 2 张；**sha256 8 张互不相同** |
| 菜单不被裁切 | ✅ 断言实测 `top=884 bottom=990 inViewport=true`（它在页面底部向上弹，正是最容易被裁的位置） |
| 协作边界 | ✅ 用量页文件仍全是 09-20，一行未动 |
| 产物新鲜度 | ✅ `lib/client.js` 晚于 `src/client.js` |

**本轮新增 1 个工具**：`shoot-preset-menu.mjs`（菜单展开态截图 —— 它是唯一不在其他截图里出现的部件，不单独拍就等于「只靠读代码交付」）。

**真机验收仍在用户手上**：刷新页面 → 预设子页 → 点工具栏 → 右下角切三种模式看差异 → 保存。


## 十八、单栏实时预览：推翻双屏（第十轮）

### 18.1 用户指出两处错

> 「不要双屏 就是要实时可编辑和预览 markdown 格式，具体可以参考 lobehub 开源项目他们是怎么做到在提示词编辑内实时预览编辑 markdown 文本的」

两条都成立：

1. **双屏是我自己发明的。** 参考里**没有**分栏。我上一轮做的「左右并排」既不是参考的做法，也不是用户要的。
2. **「实时预览」的含义我搞错了。** 我把它理解成「旁边有个渲染面板」，实际是**边打字边看到格式**。

### 18.2 lobehub 到底怎么做的（读源码得到的答案）

`src/routes/(main)/agent/profile/features/EditorCanvas/index.tsx`：

```ts
type PromptEditorMode = 'source' | 'visual'   // ← 两个模式，默认 'visual'
```

**`visual` 是 WYSIWYG**：**一个面**，你编辑的是格式化后的文本，Markdown 只是**存储格式**。渲染侧用 `@lobehub/editor`（Lexical 内核 + `ReactToolbarPlugin`），工具栏就是 `TypoBar`。`source` 才切到 CodeMirror 看原始 Markdown。

**关键结论：参考里从头到尾没有分栏。** 两个模式都是单面。

### 18.3 本帧怎么做（没有编辑器内核）

帧内没有打包器、没有网络，装不了 Lexical。用户选了**单栏实时样式预览**（推荐项）：标记保留、变淡，结构上色。

做法是**三层叠在同一个盒子里**：

| 层 | 作用 |
|---|---|
| `.mdMirror`（底） | 用 `paintMarkdown()` 把**同一份文本**上色；`pointer-events: none`，绝不挡点击 |
| `textarea`（顶） | 真正的输入；文字 `transparent`、`caret-color` 可见 |
| `.mdPreview` | 阅读模式的渲染结果，只在阅读模式显示 |

三种模式**各只有一个面**：实时 = textarea + 镜像；源码 = 只有 textarea（文字可见）；阅读 = 只有渲染结果。

### 18.4 对齐是这门技术的全部

镜像和 textarea 是**同一字符串的两次渲染**。只要有一个字符的差异，两层就换行不同，光标所在的行与它下面的样式文字**错位**，1374 行的提示词会整个错开。

所以铁律三条：

1. **`paintMarkdown` 的字符契约**：输出必须**逐字符等于**输入，只允许**包裹**，不允许增删改。标记保留（只是变淡），不替换成项目符号。
2. **一切影响换行的度量必须两层一致**：同字体、同字号、**固定 `line-height: 20px`**、同 padding、同 `white-space: pre-wrap`。
3. **粗细用画的，不用真的**：`font-weight: bold` 的字形推进更宽，长段落里镜像会**提前一个字符换行**。改用 `text-shadow: 0.4px 0 0 currentColor` 伪造字重 —— **颜色不改变度量**。标题也同理，只上色不放大。

**判据**：`scrollHeight` 两层必须相等。测试套件、装置、截图脚本三处都断言了它。

### 18.5 测试抓到的四个真 bug

| # | bug | 症状 | 根因 |
|---|---|---|---|
| 1 | **引用块完全不上色** | `> x` 没样式 | 上色发生在 `esc()` **之后**，`>` 已经变成 `&gt;` 实体，而我的正则还在找裸 `>` —— **静默不匹配** |
| 2 | **``` 里的内容被上色** | 代码块里的 `**x**` 显示成粗体 | 只排除了**围栏那一行**，没排除**围栏之间**。`inFence` 必须是跨行状态 |
| 3 | **源码模式字形重叠** | —— | 源码模式下镜像没关，文字可见的 textarea 上还盖着一层镜像，**每个字渲染两遍** |
| 4 | **阅读模式底下露出源码** | —— | 隐藏规则里写的是已删除的 `.mdPaneEdit`，textarea 没被隐藏 |

第 3、4 条是**装置**发现的（它驱真实模式切换），第 1、2 条是**纯函数测试**发现的。**四个都改对了**：1、2 改 `paintMarkdown`，3、4 改 CSS 的按模式隐藏。

### 18.6 本轮踩的坑

**转义序列（§5.17 的第二次）**：新写的 `paintMarkdown` 里 `/\\r\\n/g` 写成了 `/\r\n/g`。构建**过了**（外层 bundle 合法），但 `check-frame-script` 与套件都炸：`Invalid regular expression: missing /`。**原因是模板字符串先消费了 `\r` 和 `\n`**，到帧文档里就成了正则里的**真换行**。已在 `\\r\\n` 修好，并顺手把该函数里所有转义都核对一遍。**注意构建拦不住这一类** —— 是后两道门拦住的。

**注释里的实体**：在注释里写 `&gt;` 来说明「实体而非裸字符」，结果 `&gt;` 在**模板字符串里被解析成 `>`**，注释里出现裸 `>` 无害——但我写的是**反引号包着**的，于是反引号 + 实体一起炸。第三次栽在这类「解释性文字引用代码字面量」上（§5.6/§5.26 同型）。

**Windows 瞬时文件锁**：`ReplaceFileW EIO (Win32 1175)` 出现两次，重试即过。不是代码问题。

### 18.7 验收

| 项 | 状态 |
|---|---|
| 套件 `test-preset-markdown.mjs` | ✅ **119/119**（新增镜像字符契约 21 项 + 布局契约 12 项） |
| 动装置 `review-preset-rig.mjs` | ✅ **136/136**（新增**对齐断言**：60 行真实换行内容下两层 `scrollHeight` 相等） |
| 全部套件 | ✅ **16/16**，三道帧门全过，链审计 PASS |
| 视觉验收 | ✅ **亲眼看 6 张**（浅暗 × 三模式），sha256 **6 张互不相同** |
| 单面对齐实测 | ✅ 截图脚本每次运行都断言 `heightMatches: true` |
| 协作边界 | ✅ 用量页文件仍全是 09-20 |

**真机验收**：刷新页面 → 预设子页 → 直接打字（默认就是实时预览，格式当场出现）→ 右下角切「源码模式」看原始标记。


## 十九、实时预览 = 渲染形态，可编辑（第十一轮）

### 19.1 用户第三次纠正

> 「不对啊 实时预览就该是markdown形态啊」

**我前两轮都理解错了，而且错法不同**：

| 轮次 | 我的做法 | 错在哪 |
|---|---|---|
| 第九轮 | 左右分栏：左 textarea、右渲染 | 发明了参考里没有的分栏 |
| 第十轮 | 单栏，但**标记保留只是变淡** | 「预览」被做成了「上色」 |
| 本轮 | **单栏，标记消失，格式是真的** | ← 这才是「Markdown 形态」 |

第十轮我甚至写了 §5.28 说「实时预览是模式名」，但**仍然把它实现成标记变淡** —— 因为我把 `visual` 想象成「源码加高亮」。实际 `visual` 是**所见即所得**：标记根本不出现，标题就是标题。

### 19.2 现在的做法：渲染结果本身就是编辑面

```
.mdVisual[contenteditable]  ← 渲染后的文档，直接在上面打字
textarea.mdLayer            ← 源码模式的原始 Markdown
```

三种模式各只有一个面：

| 模式 | 显示 | 可编辑 |
|---|---|---|
| **实时预览**（默认） | 渲染后的文档 | **是** |
| 源码模式 | 原始 Markdown | 是 |
| 阅读模式 | 渲染后的文档 | 否 |

**这比上一轮更简单也更对**：没有镜像层，**没有「两层必须逐字对齐」的约束**，因为**只有一层**。标题可以用真正的字号与字重，粗体可以用真正的 `font-weight`。

### 19.3 真正难的那一半：回写

`HTML → Markdown` 是**唯一会损坏提示词的方向**，所以：

1. **只在真实编辑时回写**（绑 `input` 事件）。**光是打开页面或切模式，绝不把文档过一遍 HTML** —— 这才保护了序列化器没建模的写法。
2. **只认 `renderMarkdown` 自己产生的语义标签**；**未知元素降级为文本，不整块丢弃**。
3. **粘贴强制纯文本** —— 否则浏览器会塞进序列化器不认识的样式。
4. **契约是结构保真，不是字节相同**：`render(serialize(render(md)))` 必须等于 `render(md)`。浏览器不可能承诺字节相同（它会规范化空白），但**不能丢内容或结构**。

### 19.4 测试抓到的一个真丢内容 bug

**引用块整行消失。**

`renderMarkdown` 产生的是 `<blockquote>quote</blockquote>` —— **裸文本，没有 `<p>` 包裹**。而 `blocksOf()` 只遍历**元素**子节点，于是返回空数组，**那一行的文字被静默丢掉**。

**这个 bug 只在装置里暴露**：单元套件用的是替身 DOM，我自己 `h('blockquote', ['quote'])` 建出来的结构恰好带文本子节点，**测不到**。装置驱动**真实浏览器渲染**才把它抓出来。

修法：`blocksOf` 增加**裸文本回退** —— 容器没有元素子节点时，用它自己的 inline 内容。同一个 bug 类影响**任何裸文本块**，所以修在通用位置而不是单给 blockquote 打补丁。

### 19.5 本轮踩的坑

| # | 坑 | 处置 |
|---|---|---|
| 1 | **CSS 里的 `\200b` 在模板字符串里是八进制转义** | 构建报 `Octal escape sequences are not allowed`。改成 `\\200b` |
| 2 | **注释里的反引号 ×4** | 又是 §5.9 那个族。写「`div.markdown`」这类说明时第四次踩 |
| 3 | **`document.createElement` 让函数无法被 lift** | 单测直接从 bundle 取函数运行，而那里没有 DOM。改成浅包装对象 |
| 4 | **`serializeMarkdown` 的参数名与函数体不一致** | 参数叫 `root`、函数体写 `node` —— 单测立刻抓到 |
| 5 | **装置在错误时机断言** | 它在种子数据之前就断言「表格渲染出来了」。**断言必须放在被测状态真的存在之后** |
| 6 | **工具栏按钮点在隐藏的 textarea 上** | 实时模式下 textarea 是 `display:none`，`.focus()` 落不下去。**工具栏检查改到源码模式跑** —— 那是 textarea 真正可见的模式 |

第 5、6 条都是「断言/驱动放在错的模式或错的时机」，与 §5.26 追加那条同型。

### 19.6 验收

| 项 | 状态 |
|---|---|
| 套件 `test-preset-markdown.mjs` | ✅ **108/108**（含往返保真：12 个样例 `render→serialize→render` 逐字符相同） |
| 动装置 `review-preset-rig.mjs` | ✅ **150/150**（新增：渲染面**真的可编辑**、**标记真的消失**、**打字真的回写**、**四个块全部保住**） |
| 全部套件 | ✅ **16/16**，三道帧门全过，链审计 PASS |
| 视觉验收 | ✅ **亲眼看 6 张**（浅暗 × 三模式），sha256 互不相同 |
| 截图脚本断言 | ✅ 每次运行都验：渲染面无标记、八种格式齐全、`contenteditable` 该真该假 |
| 协作边界 | ✅ 用量页文件仍全是 09-20 |

**真机验收**：刷新页面 → 预设子页 → 默认就是**渲染形态**，直接在标题/粗体/列表上打字 → 切「源码模式」看标记 → 切回来看改动还在。


## 二十、编辑不了的真凶：点击冒泡到「模式切换」（第十二轮）

### 20.1 用户报的原文

> 「实时预览可行了 却无法编辑，输入时始终顶格 无法编辑其他段落」

**两个症状，一个原因。**

### 20.2 根因：一行选择器

```js
document.querySelectorAll('[data-mode]')   // ✗ 也选中了区域本身
```

而**区域自己就带这个属性**（`#presetArea` 上写着当前模式）。于是**在编辑器里点任何地方**，点击都会冒泡到区域，**触发它自己的「切换模式」处理函数**：

```js
visual.innerHTML = renderMarkdown(promptText)   // 重渲染 → 光标没了
visual.focus()                                  // 重新聚焦 → 插入点在位置 0
```

**每次点击都把光标重置到文档开头** —— 所以打字永远顶格，也永远换不了段。

修法：**只让菜单项切换模式**（限定到 `.mdMenuItem[data-mode]`）。

### 20.3 「150/150 全绿」是怎么骗过我的

装置里那次「打字」是**合成的**：先 `focus()` → 手工建 Range → `execCommand` 插入。

**它跳过了真人做的每一步**：命中的点击、落下光标、真按键。**在一个用户根本打不进字的面上，合成插入照样会成功** —— 所以它证明不了「能编辑」。

**这是验证的洞，不是产品的洞**，但它让一个完全不可用的编辑器拿到了绿色报告。

### 20.4 修完装置：真点击 + 真按键

现在装置**只用真实输入**：**真鼠标点击**（坐标处先做命中测试）+ **真按键**，且**中间不调 `focus()`** —— 那会毁掉正要测量的光标。

新增 5 条断言，全部针对**位置**而不只是「有没有字符进来」：

| 断言 | 抓的是什么 |
|---|---|
| 点击点在段落本身 | 命中测试 |
| **光标落在被点的那个段落** | 用户报的「无法编辑其他段落」 |
| **光标没有被拉回最开头** | 用户报的「始终顶格」 |
| **打进去的字落在被点的段落** | 上面两条的合并后果 |
| **第二次点击会挪到另一段** | 换段能力 |

**并且做了反证**：把那行选择器改回错的，**这 5 条里有 4 条立刻失败**，报出的正是用户的原话。**断言真的会抓，不是装饰。**

### 20.5 定位手段：对照组

要区分「是装置的输入不对」还是「是产品坏了」，**加一个对照**：

- **对照组**：往**同一个帧文档**里插一个**没有任何处理函数**的可编辑块
- **被试组**：真的渲染面

**用同样的派发方式**。对照组光标落对（打字进了第二段），被试组落错（跑到标题开头）——**结论明确：产品的问题，装置的输入是好的。**

**没有对照组就会走错方向**：看到光标不对，第一反应是怀疑自己的 CDP 派发，而不是去看页面代码。

### 20.6 本轮验收

| 项 | 状态 |
|---|---|
| 动装置 | ✅ **155/155**（真点击 + 真按键 + 5 条位置断言） |
| 反证 | ✅ 改回错的实现 → **4 条断言失败**，报出用户原话 |
| 全部套件 | ✅ **16/16**，三道帧门全过，链审计 PASS |
| 视觉验收 | ✅ **亲眼看**：字真的落在被点的段落里 |
| 协作边界 | ✅ 用量页文件仍全是 09-20 |

**真机验收**：刷新页面 → 预设子页 → **点第二段打几个字**（应落在点的位置）→ **点第三段再打**（应换过去）。


## 二十一、全面视觉升级（第十三轮）

### 21.1 起因与两处认知纠正

用户问「为什么这里始终有一个『删』」+「视觉是不是不达标」。

**第一处纠正：那个「删」是你自己建的分组。**查真实存储 `~/.dsh/luzzy-preset/settings.json`：`groups:[{id:"default",name:"默认"}]`。它**不是内置兜底**，是普通分组，所以删除按钮**该有**。我第一版报告写「默认分组不显示删除」是错的，已撤回。

> 两个「默认」：顶部**「默认提示词」**才是内置兜底（本就无删除按钮）；**分组「默认」**是用户建的。

**第二处纠正：「图例显示 0」不是产品 bug。**`windowTotal` 是真实字段（`lib/usage-window.mjs:250`），是截图脚本的假 payload 漏了它。已从报告撤回。

### 21.2 做了什么（按计划四组）

| 组 | 内容 | 结果 |
|---|---|---|
| **A 去装饰** | 删掉 `body::before` 紫蓝光晕（含 `blur(24px)`） | `radial-gradient` 归零 |
| **B 秩序收敛** | 字号 28 处、圆角 7 处、间距 32 处 | **字号 14→5 种**、**圆角 8→5 种**、间距收敛到 4px 阶梯 |
| **C 结构** | C1 分组行重做 / C2 空编辑器提示 / C3 错误态改人话 / C4 按钮层级 / C5 可读行宽 / C6 指标卡不等宽 | 见下 |
| **D 打磨** | 状态文案统一主语（「改动」/「提示词」/「内容」混用 → 统一说提示词） | 完成 |

### 21.3 C1：那个「删」怎么改的

**问题不在"能不能删"，在"怎么呈现"** —— 三个独立缺陷：

1. **位置歧义**：「默认 1 删」读起来像「删掉默认」，而它删的是**分组**
2. **裸动词**：DESIGN.md 要求「动词 + 名词」（`Delete Session`）；且和底部「删除」按钮重名，两者做的是不同的事
3. **危险色常驻**：每个分组一个红点，列表像一排告警

改法：图标按钮 + `aria-label="删除分组 默认"` + **悬停/聚焦才出现** + 危险色只在 hover 时上色。

**用真实鼠标验过三个状态**：

| 状态 | opacity | 颜色 |
|---|---|---|
| 静止 | `0`（隐藏） | — |
| 悬停行 | `1` | 中性 `rgb(153,153,153)` |
| 悬停按钮 | `1` | **危险 `rgb(221,68,68)`** |
| 移开 | `0` | — |

`@media (hover: none)` 下常显 —— 触屏没有 hover，不能做成幽灵按钮。

### 21.4 C2：空编辑器提示 —— 一个必须绕开的陷阱

**现象**：编辑器为空时输入框一片空白（截图确认）。

**根因**：提示写在 `textarea::placeholder`，而**实时预览模式下 textarea 是 `display:none`** —— 提示在看不见的那一层。

**修法用生成内容（`::before`），不是元素**，理由是硬的：

> **CSS 生成内容不在 DOM 里，`serializeMarkdown` 读 `childNodes` 永远拿不到它。**真实占位元素就得手工排除，而**忘记排除的那天，提示会被写进用户的提示词**。

**踩到的第二个陷阱**：焦点处理器会种一个空段落给光标落脚，于是容器**不再 `:empty`** —— 用 `:empty` 选择器的话，**框一被聚焦提示就永久消失**。所以改由渲染器维护 `data-empty` 标记。

**真实验证**（选中空智能体 → 打字 → 退格）：

```
空        → flag:true,   content:"在这里写这个智能体的 system prompt…"
打一个 X  → flag:false
退格      → flag:true,   renderedText:""   ← 提示没有进入文档
```

**顺带修掉一个我自己引入的回归**：我把 `syncVisual` 放进 `if` 块里，而工具栏处理器在块外 —— 用 `typeof` 守卫会**静默跳过重绘**。改为在块外声明，并把三处直接 `innerHTML =` 全部收拢到 `syncVisual`（现在只剩一处，已断言）。

### 21.5 新增 14 条断言，把设计系统钉住

写进 `test-preset-markdown.mjs`（105 → **119 条**）：

- **字号白名单** 12/14/16/20/24
- **圆角阶梯** 4/6/8/12/999
- **间距 4px 阶梯**（1/2px 留给描边与光学微调，40px 是断点内边距 —— 都在白名单里并写明理由）
- 无 `radial-gradient`
- 空提示是生成内容且由标记驱动
- 分组删除有动词名词名、非常显、悬停揭示
- 失败文案是人话、机器细节走 disclosure
- **每次重绘都走 `syncVisual`**（直接赋值只允许一处）

**这些断言当场抓到了我自己的两次漂移**：`.btnText` 我写了 `padding: 6px 8px`（6 不在阶梯上），以及 `.prose` 注释里的「prompt (提示词)」被原生对话框守卫误判 —— 前者改了值，后者改了措辞。

### 21.6 验收

| 项 | 状态 |
|---|---|
| 套件 | ✅ **16/16**，`test-preset-markdown` 从 105 → **119** |
| 动装置 | ✅ **155/155** |
| 三道帧门 | ✅ backticks / frame-script（2610 行）/ frame-preview 全 PASS |
| 视觉 | ✅ **亲眼看 6 张**（浅暗 × 三页）+ 悬停三态实拍 |
| 字号 | ✅ **5 种**（12/14/16/20/24） |
| 圆角 | ✅ **5 种**（4/6/8/12/999） |
| 协作边界 | ✅ 用量页**逻辑文件**仍全是 09-20 |

**真机验收**：刷新 → 预设子页应看到：① 页面**没有紫色了** ② 分组行**没有红「删」了**（鼠标移上去才出现）③ 空智能体的输入框**有灰色提示** ④ 右下角「删除」是灰字（悬停才变红）⑤「已是当前」是灰底徽标。

### 21.7 本轮踩的坑（第 6–8 次反引号）

**在给坑写注释时又踩了两次反引号**（`backdrop-filter`、`if`），加上 `.prose` 注释触发守卫误判，一共三次。**这个族已经踩到第八次** —— 判据不变：**改完帧内任何一行，先跑 `scan-frame-backticks.mjs`**，别等构建。












---

## 二十二、「目标」子页 —— Goal-Driven Delivery 交付层（第十一轮）

### 需求

把 DSH 的 Goal 变成**强制执行**的交付控制面：目标 → 执行 → 验证 → 交付的闭环，而不是只改 System Prompt 让模型「记得调用 Goal」。

用户选择的范围：**展示层 + 完整交付层**——建在 LuzzyPage 里，不动 agent-loop，不接管任何轮次。

### 交付

四个新模块（全部宿主侧）+ 帧内第四个 tab：

| 文件 | 职责 |
|---|---|
| `lib/goal-domain.mjs` | 纯函数：规范化 / 完整性 / **完成门** / 漂移 / 健康度 / 变更 / Markdown 投影 |
| `lib/goal-store.mjs` | CAS 持久化、原子写、`goal.md` 投影、开启标志 |
| `lib/goal-enforce.mjs` | 三条钩子 + `get_goal` 增强 + 可选服务探测 |
| `lib/goal-tools.mjs` | `goal_delivery` 工具（16 个 action 一个 enum） |
| `lib/goal-routes.mjs` | `GET/POST /__luzzy/goal` |

完整设计见 [`GOAL-交付层.md`](../luzzy-page/docs/GOAL-交付层.md)。

### 三条来自 DSH 源码的事实，决定了实现的形状

每一条都与直觉相反，且都在写代码之前从源码里读出来的：

**① `agent/turn-stopping` 的返回值被丢弃。** `dsh-agent-loop` 里是 `await this.dispatch.serial('agent/turn-stopping', …)`，**从不赋值**。唯一能让一轮继续的是往下一步收件箱里放东西——所以「提交屏障」实现成 `agent.steer(...)`。写成返回值会编译、会运行、什么也不做。

**② `agent/inject()` 不唤醒驱动器。** 空闲 agent 上的注入会一直等别的唤醒。需要被注意到的用 `steer`。

**③ 归因必须是 plugin。** `{ kind: 'user' }` 会清掉 job 的唤醒预算、重置重复提醒链（`dsh-tool-jobs` / `dsh-repeat-tool-reminder` 里读的就是这个）。插件注入必须带自己的 source。

### 完成门为什么能拦住

`complete` 是工具调用，没有 waterfall 夹在模型和 `ctx.goals.complete()` 之间——**拦不住服务调用，但拦得住调用本身**：`tools/pre-execute` 在工具体之前运行，被拒的 `complete` 从未执行，目标保持 active，拒绝理由作为那次调用的错误结果进入模型的上下文。

判据是可判定的（必须的验收标准全部 verified、每条都有存在的证据、无未完成必做任务、无未解决阻塞）。「目标本身是否真的达成」是模型的判断，门不假装自己做得了。**Fail-closed**：读不出来时拒绝，而不是放行。

### Agent 权威限制是结构，不是承诺

`applyDeliveryOp`（Agent 可用的全部操作）与 `applyHumanOp`（人类操作）是**两个函数**，`adoptProposal` 只出现在后者里。没有代码路径能从 Agent 的调用走进那条分支——所以以后改代码也不会忘掉这个守卫。测试断言的是**操作清单本身**（`setScope` 不在 Agent 的 op 列表里），不是行为。

### 本轮踩到并修掉的真问题

**一、`ctx.on` 不在测试替身的「总是可用」集合里**

`test-host-routes.mjs` 用会抛的代理复现「未 inject 的服务抛异常」，很对。但它把 `on` 也算成了服务——而 `on` 是 **cordis 的上下文自带方法**，任何插件都能注册监听器而不声明任何东西。于是 `apply()` 一加钩子，这个既有套件就崩了。修法是把 `on`/`effget`/`emit` 一类放进 always-available 集合，**服务名的严格性一点没放松**。

**二、状态色在暗色下是坏的 —— 顺带修掉一个既有缺陷**

帧里 9 处引用 `--dsw-alias-label-{error,warning,success}`。查了 DSH 主题包注入的样式表与前端 dist：**这三个 token 一个都不存在**（实测计数 0），全部静默回退到硬编码的 `#d44`/`#a60`/`#287`——**两个主题同一套颜色**。暗色下那个绿特别暗。

真实存在的是 `--dsw-alias-state-{success,warn,error,business}-primary`，而且**暗色下换的是色相不只是明度**：

| token | 浅色 | 暗色 |
|---|---|---|
| `state-success-primary` | `#22c55e` | `#22c55e` |
| `state-warn-primary` | `#f59e0b` | `#f59e0b` |
| `state-error-primary` | `#ec1313` | **`#f25a5a`** |
| `state-business-primary` | `#4176e6` | **`#679efe`** |

**命名一个不存在的 token 比不命名更糟**：它看起来是 token 化的，其实不是。9 处引用全改了，预设页那 3 处也一起修了。

**三、`const sessionId` 自我引用 —— 黑匣子抓到的**

我写了 `const sessionId = goalSnapshot === null ? sessionId : goalSnapshot.sessionId`。这行在**自己的初始化器里引用自己**，抛 `Cannot access 'sessionId' before initialization`，页面永远停在骨架屏。

**读代码没看出来，探针一秒钟就报出来了**——`probe-frame-console.mjs` 的覆盖层直接打出了 `Uncaught ReferenceError: ... @2740:45`。又一次印证 §5.4：**先装黑匣子，再动手**。

**四、`--window-size` 给不出窄视口（假信号，骗过一轮）**

窄屏截图看起来右侧被切掉。真去量才发现：**Windows 有最小窗口宽度**，`--window-size=420,900` 实际得到 `innerWidth 492`，然后**裁切成 420px 的图**。页面按 492px 排版、图只有 420px 宽——看起来就是溢出。

实测证据：

```
--window-size=420,900  =>  innerWidth 492, outerWidth 516
```

`probe-goal-layout.mjs` 在**真实**布局视口下量：三个宽度（420/720/1280）全部 `scrollWidth === innerWidth`、0 个越界元素、`goalGrid` 在 ≤900px 折成一列。`shoot-goal-tab.mjs` 改用 CDP 的 `Emulation.setDeviceMetricsOverride`，并且**每次截图都断言 `innerWidth` 就是请求的宽度**——截图工具必须自证它拍的是它声称的那张。

**五、Edge 的截图比进程退出得晚**

`execFileSync` 返回、退出码 0，PNG 还没落盘。第一版立刻 `existsSync` 就报「没有写出 PNG」——**一个假失败**，会让下一个人去查页面的 bug。修法是等到文件**存在且不再增长**。

**六、提案里的 `current` 显示成了一坨 JSON**

范围提案的「当前」字段渲染出 `{"included":[],"excluded":[]}`——给人看的字段显示的是数据结构。改成 `describeScope()` 产出「包含：a；不包含：b」。

**这条也补了断言，并且验证过它会失败**：把实现改回 `JSON.stringify`，3 条断言立刻红并打出那段 JSON。**不会失败的断言等于没写**——第一次验证时我改错了文件位置，套件照样全绿，差点留下一条假断言。

### 测试与验收状态

| 套件 | 断言 | 查什么 |
|---|---|---|
| `test-goal-domain.mjs` | **119** | 完成门、Agent 权威（断言的是 op 清单）、漂移、Markdown 确定性、规范化丢行 |
| `test-goal-store.mjs` | **70** | CAS、原子写、轨迹（traversal 拒绝）、投影幂等、开启标志、损坏/未来版本 |
| `test-goal-enforce.mjs` | **71** | 完成门真的拦住调用、fail-closed、`get_goal` 增强、屏障是 steer 且有限流 |
| `test-goal-routes.mjs` | **83** | 400/403/405/409/413/422、整份状态返回、产物落点在会话 cwd |
| `probe-goal-layout.mjs` | — | 真实浏览器三个视口，零横向溢出、每枚徽标都有图标 |
| `shoot-goal-tab.mjs` | — | 两主题 + 真实 420px，三张 sha 互不相同 |

**全套 25 个套件全绿（1211 条断言）。**

**§91 Definition of Done 全项通过**：13 项实现类逐条对代码核过；10 项测试类各有运行级证据（compaction / resume / fork / cancellation / concurrent / round-driver / completion-rejection / no-bypass / no-scope-widen / regression）。

**真机端到端已验**：宿主半 01:28 重启加载，preflight 注入逐字对得上源码、goal_delivery 可调用并落盘、完成门在真实 update_goal(action=complete) 上返回 GOAL_COMPLETION_REJECTED。

### 本轮补齐的三条验收标准

上一轮我只顺着「压力测试」那条线记进度，**没有回头核对 AC-001..014 全表** —— 于是漏报了三条：

| AC | 上一轮的状态 | 现在 |
|---|---|---|
| **AC-001** 长期任务建目标 | **完全没实现**（`lib/*.mjs` 里搜 `create_goal` 一处都没有） | ✅ 无 goal 但已动工作区 → **提示一次**问模型 |
| **AC-002** preflight | 我把它记成「与 §82/83 冲突」搁置 | ✅ `agent/pre-step` 注入紧凑块 |
| **AC-012** round driver 不重复 | 只有源码级 grep | ✅ 在**派发链**里验 |

**AC-001 为什么不是自动建**：§39 把「是否长期任务」明确放在**模型判断**那一列；§6 又点名「你好」「帮我解释一下 Promise」**不能**有目标。自动建会更糟 —— 只看工具调用的规则分不出它和一次重构。所以 harness 只提供确定性的一半（日志显示真的在改工作区），语义判断还给模型。

**AC-012 差点写成空转断言**：第一版把 waterfall 顺序弄反（driver 在外），那样插件在 goal round 里**根本不会运行** —— 什么都不会出错，也就什么都没测到。是「先确认补丁真的会失败」这条纪律逼出来的。

### AOCI 收尾实况：`stopped` / `blocked`，卡在截图策展（本轮新增 3 张）

跑了一次 `aoci_maintain`（用本仓自己的 `tools/aoci-mcp-client.mjs`），**它拒绝收敛**，且拒绝是对的：

| 事实 | 值 |
|---|---|
| `status` / `result` | **`stopped` / `blocked`**，`aligned: false` |
| `next_action` | `explicit_orphan_remove_or_resolve_blocker` |
| 候选 | 20 个（8 update + 12 create） |
| 孤儿候选 | **19 个**，全是 `docs/shots/*.png` |
| 受管源 / 条目 | 136 / 98 |

**19 = §十五 那 16 张 + 本轮新加的 3 张目标 tab 截图**（`goal-tab-light/dark/narrow-light.png`）。也就是说**这轮把 3 张图加进了那个待裁决集合**，没有解开它。

**为什么我不自己去解**：这正是 §5.25 记过的那道门 —— **减少认知覆盖必须由人独立复核**，四条自动路径全被明确挡回（`aoci_remove_entry` 答 `volume_read_only`；`scope authorize` 答 `cognition_coverage_reduction_requires_independent_review`；`scope approve` 要在真 TTY 里输入精确口令；`curation stage` 要机器签发的 `plan_id`，而 PNG 拿不到候选批次）。

`scope status` 另说：**策略本身已对齐**（`策略已对齐 true`、`observe 待复核 0`）。所以卡住的**只是**这 19 条截图的策展裁决，不是 scope 配置。

**这不解锁任何东西，也不阻塞本项目**：§十五 已经写明「不接受这个变更也完全可以 —— 那 16 张图就一直算『缺失条目』，索引其余条目照常可用」。本轮 §91 的 27 行验收**没有一行依赖 AOCI 收敛**。

**待人工**（本机真实值，别在别处抄第二份）：命令见 §十五 那段，`plan_id` 可能因本轮 3 张新图而**已经过期** —— 重新生成后再批准。

### AOCI 索引的现状：goal 交付层**不在受管范围内**

本轮想收尾时把索引维护对了一遍，结论是**不能由我单方面改**：

| 事实 | 值 |
|---|---|
| 索引形态 | Volumes v1 —— `aoci.txt` 是清单，真正的 Entry 在 `aoci.code.txt` |
| Entry 数 | **90 条**（我一开始用错正则数成 0，实际有） |
| 受管文件 | **117 个**，其中 `luzzy-page/` 68 个 |
| **受管范围内的 `goal-*` 文件** | **0 个** |
| 变更策略 | `observe_change_policy: **review_required**` |

也就是说：**整条 goal 交付层（domain / store / enforce / tools / routes、四个测试套件、`verify-on-machine.mjs`）从建成起就不在索引里** —— 索引是在它们之前建的，之后再没扩过范围。

**为什么我不直接补**：`review_required` 意味着**扩大或改变受管范围要人裁决**，这正是 §5.25 记过的那条设计（减少认知覆盖必须独立复核）。而且按 AOCI 的规矩，**候选批次必须由机器签发**，不能我自己挑文件往里塞。

**顺带发现一条真的过期**：`aoci.code.txt` 里 `AGENTS.md` 那条写的是「§5.1–5.29」，而文件现在有 **§5.30**（本轮加的六条纪律）。这一条属于「受管对象变了、认知没跟上」—— 正是收尾维护该处理的，但它同样要等一次机器签发的批次。

**结论**：如实记在这里，**不伪造批次、不改 config 绕过**。下次有真实维护窗口时，`aoci_maintain` 会按新 preimage 重新签发候选。

### 这一条后来被补上了：真的点了一次「目标」tab

上一节说「帧从未成功拉过 goal 路由，只能由用户点一下」。**这个结论当时是对的，但它不是终点** —— 我把能试的通道重新排了一遍，发现前一次判断漏了一条：

| 通道 | 重新实测 |
|---|---|
| 进程外请求 `43120/__luzzy/goal` | 仍然 403（安全边界，绕不过也不该绕） |
| 驱动**真实 DSH** | `DevToolsActivePort` 是陈的，pid 303344 名下只有 43120 —— **确实不通** |
| **自己起 web server + 自己起浏览器** | ✅ **通了** |

第三条才是正解：**不需要借用户的 DSH**。`registerGoalRoutes` 是纯函数，喂它一个真 ctx 就能挂到自己的 HTTP server 上；帧文档用项目自己的 `render-frame-preview.mjs` 抽出来；浏览器用 `tools/cdp-driver.mjs`。

新增 `luzzy-page/tools/test-goal-live-frame.mjs`，**14 条断言全绿**，四件事都是真的：

1. **真 HTTP server + 真 `registerGoalRoutes`**，计划经**真 store** 落盘
2. **真 `lib/client.js` 帧文档**（606 KB），同源伺服
3. **真浏览器**（CDP），**真鼠标点击** `[data-tab="goal"]`（命中测试，非 `el.click()`）
4. 断言渲染出的文本：objective / current focus / AC / task 全在，且**验证分数 `1 / 3` 是从落盘计划算出来的**

**可证伪**：把「切到目标 tab 就 `loadGoal`」那一行（`src/client.js:4149`）改成 `false` → **6 条断言变红**；恢复后 14/14。

写这个测试时踩了三个**假失败**，都值得记：

- **`deps` 键名写错**（`storePaths` 而非 `paths`）→ 页面诚实报「目标状态读不出来」。**harness 的错看起来完全像产品的错**。
- **没喂 `ctx.agents`** → 路由答「这个会话不在当前进程里」。少一个服务就换一种错误文案，而两种都长得像产品缺陷。
- **计划没落盘** → 页面正确渲染 `0 / 0`。差点读成「页面不会数数」。

还有一条**自己造的**：这个测试清理时删掉了共享的 `luzzy-frame-preview.html`，而 `render-frame-with-data.mjs` 与 `probe-goal-layout.mjs` 把它当**前置输入**读 —— 两个工具立刻报 ENOENT，看起来像「目标布局坏了」。已改为**不删**。

### 一条必须说清的边界（当时成立）：页面**从未**成功加载过 goal 路由

> **本轮把三条可能的自证通道都试完了，全部不通** —— 结论是这一条**只能由用户点一下**。

| 通道 | 试的结果 |
|---|---|
| 从进程外请求 `127.0.0.1:43120/__luzzy/goal` | **403** —— 桌面版要 `x-dsh-desktop-renderer` 头，凭据是**每次启动随机生成**的（实测源码：`randomBytes(32).toString('base64url')`），**不落盘**，只有 Electron 渲染进程的 fetch 会被自动注入 |
| 驱动真实 DSH（CDP） | `%APPDATA%\DSH Desktop\DevToolsActivePort` 里有 `9333`，**但那个文件是陈的** —— `Get-NetTCPConnection -LocalPort 9333` 空，pid 303344 名下**只有 43120 一个监听**。它没有 `--remote-debugging-port`，这是上一次带该开关运行时留下的 |
| 直接读宿主日志找 token | 源码里 token 只在内存里由 `createDesktopBrowserAccess()` 持有，**没有落点** |

所以 §5.3 那条推论在这里咬到了自己：**「从进程外探测宿主路由永远拿不到有效信号」**，而我这轮想验的正是「帧能不能拉到」—— 它天然只能从渲染进程内部观测。

**这不是设计缺陷，是安全边界**（浏览器请求默认 403 是为了不让任意进程读你的会话）。它只在**验收**时变成不便。

翻遍 diag 日志，`goal-fetch` 一共只有 **2 条记录**，都在 14:58（重启之前）：

```
14:58:48  goal-fetch-start
14:58:48  goal-fetch-failed      ← 当时宿主半是旧的，路由还不存在
```

**`goal-fetch-ok` 从未出现过。** 重启后帧一次都没再拉过。

所以要把三件事分开：

| 已经验过的 | 怎么验的 |
|---|---|
| 路由**注册了** | diag 里 `apply-entered` → `registered`（01:28），且 `registerGoalRoutes` 在 `apply()` 里无条件调用 |
| 路由**返回的是运行时状态** | `test-goal-routes.mjs` 断言 goal.id/objective 就是运行时那一份；把路由换成常量 → 2 条断言变红 |
| **页面真的拉到过数据** | ❌ **从未观测** —— 需要打开一次「目标」tab |

**这一条不写成 "已验证"。** 前两条证明「代码对」，第三条才是「用户真的看得到」。前者我能自证，后者我不能替用户点那一下 —— 而且这台机器上宿主路由对进程外请求一律 403（实测），**根本没有从外部探活的通道**（§5.3 的推论）。

`node tools/verify-on-machine.mjs` 现在只报一条 FAIL，措辞就是这个事实：`the frame has not retried since the host restarted (last attempt …14:58, host started …01:28)`。

### 本轮：用 goal 系统管自己的 goal（提交屏障真的触发了）

这一轮最值得记的不是代码，是**那条对账屏障在真机上对着我自己开了一炮**。

我改了工作区（补 AC-001 的提示、加证据计数器、修两个假信号），但**没有同步 goal 计划** —— 于是 `agent/turn-stopping` 直接拦下并注入了对账要求。这是 §11 提交屏障的**首次真机触发**，而且拦的正是它该拦的场景：有实质工作、计划没动。

随后用 `goal_delivery` 把这轮的真实状态写进计划：

| 写进去的 | 内容 |
|---|---|
| 14 条验收标准 | AC-001..AC-014，逐条对应方案书 §81 |
| 12 条证据 E-001..E-012 | 每条注明是真机（runtime）还是套件（test） |
| 3 个任务 | 两个 completed、一个完成 |
| 2 条决策 D-001/D-002 | preflight 为什么是紧凑块；AC-001 为什么**不**自动建目标 |

**关键取舍**：`can_complete` 已经变成 `true`（14/14 验证、3/3 任务），但我**没有标记完成** —— 因为有一件事从头到尾**没被观测过**：重启后「目标」tab **还没重新拉过一次 `/__luzzy/goal`**。路由注册了（`apply-entered` → `registered` 在 01:28），帧的 fetch 却没发生。**「代码对」和「页面真的加载过」是两件事**，后者我不能替用户点那一下。

所以目标保持 active，焦点就写着这一条。

### 本轮又抓到两个「假绿 / 假红」—— 都是同一族

**一、`test-host-routes.mjs` 跑了真的 `apply()`，却只断言三条旧路由。** 这是**唯一**走真实装配路径的套件，而它从没检查过 `/__luzzy/goal`、`goal_delivery` 工具、或那四个钩子。**从 `lib/index.js` 删一行，整个特性就不会注册，而其它 1170 条断言照样全绿。**

补上之后验证过两边都会红：删 `installEnforcement` → 4 条钩子断言失败；删 `registerGoalRoutes` → 路由断言失败（exit 1）。

> 顺带发现假信号：`node ... | Select-String` 让 PowerShell 报了 `exit code: 1`，而套件**实际退出码是 0**。差点读成失败。

**二、`verify-on-machine.mjs` 把「重启前的失败」当成「现在的失败」。** 重启后它仍报 `goal-fetch-failed`，但那条记录的时间戳是 **14:58**，而宿主是 **01:28** 启动的 —— 拿**上一个宿主**的失败当**这个宿主**的证据。这跟「marker 里的 pid 已经死了还算数」是同一个错误（§5.4）。

现在只统计**重启之后**的记录，并且在没有新记录时把两个时间戳都打出来。修完那句话变成：`the frame has not retried since the host restarted (last attempt …14:58, host started …01:28)` —— **这才是诚实的当前状态**，不是假红。

### 本轮拿到真机端到端证据 —— 三个「脚本证明不了」的全部证伪

DSH 在 01:28 被重启，**宿主半加载成功**。然后这一轮的对话本身就是证据：

**一、preflight 真的注入了。** 我自己的每一轮 prompt 里都出现了 `<goal_state>` 块，且**逐字对得上源码**：

| 注入的行 | 源码位置 |
|---|---|
| `目标："DSH Goal 强制驱动…"` | `goal-enforce.mjs:376` |
| `阶段：active（续行已启用）· 修订 4 · 轮次 4/256` | `:377` |
| `验收标准：还没有定义——…先定验收标准再动手。` | `:380` |
| `完成门：现在还不能标记完成。还差 …` | `:400` |
| `做完本轮的工作后用 goal_delivery 同步计划；证据必须来自真实跑过的东西。` | `:388` |

而且它**跟着状态变了**：我加了两个验收标准之后，同一块变成 `验收标准：0/2 已验证` 和 `还差 AC-001、AC-002`。

**二、`goal_delivery` 工具真的注册了、真的能用。** 我直接调它两次 `addAcceptance`，返回 `ok: ... 新建 AC-001` / `AC-002`，**落盘**到 `~/.dsh/luzzy-goal/session-3c5ab27f….json`（revision 2，2 条 AC）。

**三、完成门真的拦下了。** 我对一个 `0/2 已验证` 的目标调 `update_goal(action=complete)`：

```
Error: GOAL_COMPLETION_REJECTED: 目标还不能标记为完成。

Unverified Criteria:
AC-001, AC-002
```

**这个调用从未到达 `ctx.goals`** —— 之后 `get_goal` 显示目标仍是 `phase: active`，`delivery.can_complete: false`。这是 AC-004 / AC-013 在**真机上**的证明，不是替身里的。

**四、`get_goal` 增强也生效了**：返回里带着完整的 `delivery` 块，`enforcement` 计数器显示 **`preflights: 3`、`lastPreflightTurn: 4`** —— 这是 §86 指标在真实会话里计数。

> 上一轮 `verify-on-machine.mjs` 结尾写着「NOT PROVABLE FROM THIS SCRIPT」的三条，**这一轮三条全部在真机上发生了**。

### 本轮补上第五条可观测性指标

上一轮我把 §86 的十个指标对了一遍，结论是「九条有、证据覆盖缺」。**这条补上了。**

`completionGate` 早就在算 `missingEvidence`，但**没有任何东西在计数**。而「完成被拒」和「完成因为缺证据被拒」是**两件不同的事**：前者是在做的活，后者是流程缺口。§86/§87 把 evidence coverage 和 preflight / reconciliation / completion / drift 并列为「值得看的五件事」，只有它没有计数器。

现在 `stats().evidenceMissing` 把它分开计。断言钉住两个方向：**未验证的标准被拒不计数**（那是进行中）、**声称已验证但没有证据的才计数**。

第二条路径只能用直接写文档的方式造 —— 因为 `setAcceptanceStatus` 到 `verified` **本身就被域拒绝**（`GOAL_MISSING_EVIDENCE`）。这正说明门必须**自己也检查一遍**，不能信变更路径。回退计数器 → 1 条断言立刻红。

### 本轮又修掉一个静默缺陷

**`/__luzzy/goal` 里有两个都叫 `counters` 的字段，说了不一致的话。**

一处是 `readCounters(sessionId)`（真实的每个会话计数器），另一处是**手写的三键字面量** `{reconciliations, lastReconcileAt, turnsSinceReconcile}`。preflight 加上 `preflights` / `preflightMisses` / `goalNudged` 之后，那个字面量**悄悄不再描述同一个东西** —— 同一个 payload 里两个同名块，三个键一致、其余全缺。

§86 要的正是「Agent 到底有没有真正用 Goal」的可观测性，而**少了 preflight 计数的计数器块回答不了这个问题**。已改为两处都用 `readCounters`，并把形状钉在 `test-goal-routes.mjs`：**回退那个字面量 → 8 条断言立刻红**。

> 教训：**同一个 payload 里不该有两个同名块**。它们一开始一致，之后各自演化，而没有任何东西在看着。

### 还没做 —— 只剩真机验证

**代码侧已无已知缺口。** 本轮把此前记的最后一条也补上了。

**一、AC-012 现在是运行级验证。** 读 round driver 源码后确认：**它也在 `agent/pre-step` 上**，所以「职责不重复」必须在**派发链**里证明，不能靠 grep 自己的源码。

它的处理器契约是 `isGoalRoundSource(source) → next()`，谓词是 `source.kind === "goal" && source.round > 0`，所以本层注入的 `kind: 'plugin'` 消息**直接穿过它**。`test-goal-lifecycle.mjs` 把这条契约**原样建模**成第二个监听器（插件在外、driver 在内 —— cordis waterfall 的真实顺序），断言：

- 普通一轮 → driver 不介入，插件照常注入
- goal-round 消息 → driver 认领并 reject，**插件的注入不覆盖它的裁决**，且不为这一轮花 preflight

**差点写成假断言**：第一版把顺序弄反（driver 在外），那样插件在 goal round 里**根本不会运行** —— 什么都不会出错，也就什么都没测到。是「先确认补丁真的会失败」这条纪律逼出来的：patch 打上后必须变红，而它当时没红。改对后 patch 让套件**崩在 `decision.messages is not iterable`**（exit 1）—— 顺带说明那道守卫是**双重承重**的：没有它，插件不只是覆盖裁决，而是直接崩。

**其余四条在第十一轮续补上**（同一个套件，对着**真实 `Session` 对象**验，不是替身）：

| 方案书条目 | 怎么验的 | 结论 |
|---|---|---|
| §53 compaction（AC-008） | 真实 `append('compaction/*')` 后 `observeTurn` 仍找得到 turn 边界；覆盖层本就不在 transcript 里 | ✅ 计划存活 |
| §54 resume（AC-009） | 真实 `new Session(id, events, header, 'restored')`，同一个 id | ✅ 读同一个文件、同一修订 |
| §55 fork | 真实分叉拿到**新 id**，所以是新文件 | ✅ **不继承**（改坏 key → 2 条断言立刻红） |
| 卸载无孤儿 | 卸载后四个钩子全部移除，驱动事件什么都不做 | ✅ |

**二、宿主半已重启并加载（01:28）。** 
ode tools/verify-on-machine.mjs 现在只剩一条 FAIL：帧还没在重启后重新拉过 goal 路由（打开一次「目标」tab 即可）。 
ode tools/verify-on-machine.mjs 会自己判断：宿主标记的 pid **是否还活着**、**宿主文件是否比标记更新**（这条区分「重启过」与「重启在我的最后一次改动之前」）、帧自己的 diag 里 goal-fetch 最后是成功还是失败。**当前它的输出是 2 FAIL / 1 skip** —— 正是应当的：宿主 pid 290788 启动于 13:35，而 goal-enforce.mjs 改于 15:12。 客户端半热重载、宿主半不会（既有事实，§5.3）。**当前证据**：运行中的宿主 pid 290788 启动于 13:35:01，而 `lib/index.js` 改于 14:56 —— 帧内 diag 已经在报 `goal-fetch-failed`，正是预期的旧宿主状态。

重启后应验一次真机：路由返回运行时 goal、`goal_delivery` 出现在工具列表、**preflight 真的注入过**（帧内 `report()` 或 diag 看得到）、无 goal 时提示过一次、完成门在真会话上拦下过一次过早的 `complete`。

### 本轮（第十一轮续）修掉的三件事

**一、AC-002 的 preflight 补上了。** 上一轮我把它记成「与 §82/83 冲突」，**那个判断是错的**——读全之后不矛盾：

| 出处 | 要求 |
|---|---|
| §10 / §46 | substantial turn 必须**观察** goal 状态 |
| §82 / §83 | 「Do not inject full goal artifact every turn」，orientation 保持 small fixed overhead |
| §68 方案 B | 被禁的是每轮塞整份 Markdown |

调和点是**观察必须且便宜**（~740 字节的块），**artifact 才是不能每轮注入的那个**。§13 又定了「每轮」的含义：trivial turn 仍必须 READ，只是不必 WRITE。所以现在 `agent/pre-step` 在**每个有 goal 的轮次**注入紧凑块，成本由**步数间隔**控制（`preflightEverySteps` 默认 6 —— 一个 12 步的长轮次注入 2–3 次而不是 12 次）。

**二、`readDeliveryOverlay` 把「读不出来」当成了「不存在」。** 这是 stress 套件写出来时抓到的**真缺陷**：所有读取失败都塌缩成 `absent`，于是**一份存在但读不出的计划会被当作空计划交给对账屏障**，屏障再让模型去对账一份它从没写过的计划；页面对一份躺在磁盘上的计划说「你没有计划」。

现在按 errno 区分：`ENOENT`/`ENOTDIR` → 正常的首次运行状态；其余（`EISDIR`/`EACCES`/`EBUSY`…）→ 具名失败 `source: 'unreadable'`。store 与 stress 两个套件都钉住了这条，**并验证过会失败**（回退实现 → 3 条断言立刻红）。

**三、被取消的轮次会被要求对账。** 循环在 `agent/turn-stopping` 派发**之后**立刻 `throwIfAborted()`，所以那一刻 steer 不只是没用：abort 会展开、steer 的消息留在 `next-step`、下一次机会被排干——模型被告知去对账一个被取消的轮次，而会话为此花掉八次对账额度里的一次。现在两条钩子都在 `signal.aborted === true` 时直接返回，且**不计入 `preflightMiss`**（那是「读了但读不出来」的信号，与「主动跳过」混在一起会让指标分不清是计划坏了还是轮次被取消了）。

### 第十二轮续（二）：AC-001 也补上了

**上一轮我漏报了一条。** 记「还没做」的时候我只看了压力测试那五条，**没有回头核对 AC-001..AC-014 全表** —— 而 **AC-001（长期任务第一轮可以自动建立 Goal）根本没有实现**：`lib/*.mjs` 里搜 `create_goal` 一处都没有，preflight 的「无 goal」分支直接 return。

**现在这样处理**（分工来自方案书自己）：

| 谁 | 判断什么 |
|---|---|
| harness（确定性） | 会话日志里**真的在改工作区**（`observeTurn` 看到 mutating 工具） |
| 模型（语义） | 这算不算一个跨多轮、可恢复的**长期目标** |

所以这条路径**不建目标** —— 它报告观察到的事实并请模型自己判断。§39 把「是否长期任务」明确放在模型判断那一列；自动建会更糟，因为 §6 点名「你好」「帮我解释一下 Promise」**不能**有目标，而只看工具调用的规则分不出它和一次重构。

**每会话只提示一次**，且 `--preflight=false` 时一并关闭。**关键断言**：只读的一轮、没有任何工具调用的一轮、以及**已经有 goal 的会话**，一律不提示 —— 把 `if (!work.wroteFiles && !work.ranCommand)` 改成永远为假，**4 条断言立刻红**（含「只读的一轮从不被提示」）。

### 第十二轮续：把「还没做」里的四条补上

上一轮记的五条未覆盖里，**四条其实做得到** —— 因为 `@deepseek-ai/dsh-session` 导出了 `Session` 本身。`test-goal-lifecycle.mjs` 构造**真实 Session**、用真实 `append` 写真实事件、驱动真实钩子：

| 方案书条目 | 结论 |
|---|---|
| §53 compaction（AC-008） | ✅ 计划存活（覆盖层按 session id 存，不在 transcript 里）；`observeTurn` 在 compaction 事件之后仍找得到 turn 边界 |
| §54 resume（AC-009） | ✅ 真实 `new Session(id, events, header, 'restored')`，同一 id → 同一文件、同一修订 |
| §55 fork | ✅ 真实分叉拿**新 id** → 新文件 → **不继承**。改坏 key 会让 2 条断言立刻红 |
| 卸载无孤儿 | ✅ 四个钩子全部移除；钩子名收在 `HOOK_NAMES` 里，以后加钩子绕不过这条断言 |

**踩到的三个真实 API 契约**（都不是靠猜能对的）：新建 Session **不要**传 header（harness 自己按版本 3 造）；`tool/result` **必须**带 `surfaceOp`，而 `tool/call` **不能**带（只有 4 个类型算 surface-eligible）；分叉的 header **id 必须是子会话的**，否则抛「header id does not match」。

**AC-012 只剩源码级断言**：`test-goal-lifecycle.mjs` 断言交付层从不调 `followup` / `runMaintenance` / 不自造 goal 来源消息 —— 那是**能做什么**的证明，不是**跑起来会怎样**。要跑起来需要真实 DSH 会话加挂载 round driver，已如实留在「还没做」里。

### AC-001..014 全表核对（本轮补做）

上一轮我漏报 AC-001，原因是**只顺着「压力测试」那条线记，没回头核对验收标准全表**。本轮逐条对着代码走过一遍：

| AC | 实现位置 | 证据 |
|---|---|---|
| 001 长期任务建目标 | `agent/pre-step` 提示一次 | 只读轮 / 无工具调用轮 / 已有 goal 都不提示（4 条断言可证伪） |
| 002 substantive turn 先 preflight | `agent/pre-step` 注入紧凑块 | 每轮都观察，成本由步数间隔控制 |
| 003 有进展后同步 goal | `agent/turn-stopping` 屏障 | `needsReconciliation(wroteFiles)` → true |
| 004 验收未满足不能完成 | `tools/pre-execute` 完成门 | 未验证的标准一律拒绝 |
| 005 修订保护 | `writeDeliveryOverlay` CAS | 过期写被拒 + 返回当前文档 |
| 006 `.agent/goal.md` | `ARTIFACT_RELATIVE_PATH` | `renderGoalMarkdown` 确定性投影 |
| 007 GUI 与 Agent 同一份状态 | `/__luzzy/goal` 读**运行时** goal | 路由只做投影，不存第二份 |
| 008 compaction 不丢 | 覆盖层按 session id 存 | 真实 Session 验过 |
| 009 resume 不丢 | 同上 | 真实 Session 验过 |
| 010 用户改目标后重对齐 | `detectDrift` + `reconcile` | 漂移被检出、重对齐后消失 |
| 011 不能静默扩大 scope | `applyDeliveryOp` **没有**那条分支 | `setScope` 不是 agent op |
| 012 与 round driver 不重复 | 源码级：从不调 `followup` | ⚠️ 只有源码级，见「还没做」 |
| 013 完成必须过门 | `tools/pre-execute` | 过早完成被 DENY |
| 014 关键变更可追踪 | `recordChange` → `delivery.changes` | 每条带 actor / action / at |

**教训**：验收标准表要**逐条对着代码走**，不能只沿着当前那条线索记。漏掉 AC-001 的代价是它整整两轮没被实现。

### 设计边界（有意为之）

- **一个会话一个计划**。DSH 本身就只支持一个当前 goal，覆盖层跟着它走。
- **不接管续行**。`dsh-goal-round-driver` 管「要不要再给一轮」，这一层管「这一轮是不是围绕正确的目标」。**两者不合并**——交付层不调 `followup()`。
- **不用第二个 LLM 审查**。能确定性判定的（修订、证据存在、必做项状态）全用规则；只有「目标是否真的达成」留给模型。
- **fork 不继承计划**。新会话 id，新文件——一个 fork 不该自己复活旧目标。
