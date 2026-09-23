# LuzzyPage

DSH Web GUI 里与「对话」「轨迹」并列的第三个视图。内含四个子页：

1. **说明**（默认）—— 渲染本插件的 README
2. **用量** —— Token 活动阵列（一个自然月，每格一天）、按模型的平滑趋势图、按模型的饼图
3. **预设** —— LuzzyMode 的提示词与智能体名单，单栏 Markdown 编辑
4. **目标** —— 长任务的交付控制面：验收标准、任务、证据、焦点、下一步、阻塞、决策，以及一个**完成门**

趋势图有三个窗口（日 / 周 / 月），**没有小时视图**——「日」画的就是当天的小时。窗口按钮只作用于趋势图，就放在那张卡的标题栏里。没到的时间留空，不是 0。

「目标」子页的完整设计（两层状态、三个不变量、为什么钩子长那样、错误码与路由）见 [`docs/GOAL-交付层.md`](docs/GOAL-交付层.md)。

中文用**阿里巴巴普惠体**、西文用 **Alibaba Sans**，四款字重全部内联，不请求任何外部资源。

## 结构

```
luzzy-page/
├── package.json           dsh.bundle + dsh.client（platform: web）
├── cordis.patch.yml       insert 一行，把插件挂进 profile
├── src/
│   └── client.js          ← 唯一手写源文件（界面）。改这里
├── lib/
│   ├── index.js           宿主侧：/__luzzy/{usage,readme,diag} 三条路由
│   ├── usage-aggregate.mjs 宿主侧：聚合门面（worker 线程 + 结果缓存 + 后台预热）
│   ├── usage-worker.mjs   宿主侧：worker 线程，解压 / 解析 / 分桶 / 算窗口
│   ├── usage-core.mjs     宿主侧：纯聚合逻辑（无线程、无缓存）
│   ├── usage-window.mjs   宿主侧：三个趋势窗口 + 活动阵列（纯函数，可注入 now）
│   ├── usage-cache.mjs    宿主侧：解析结果磁盘缓存（跨重启，带版本，soft fail）
│   ├── preset-ops.mjs     宿主侧：「预设」子页的操作
│   ├── preset-routes.mjs  宿主侧：/__luzzy/preset 路由
│   ├── preset-store.mjs   宿主侧：提示词与名单的磁盘真源
│   ├── goal-domain.mjs    宿主侧：「目标」的纯逻辑（完整性 / 完成门 / 漂移 / Markdown）
│   ├── goal-store.mjs     宿主侧：CAS 持久化 + goal.md 投影
│   ├── goal-enforce.mjs   宿主侧：完成门钩子、对账屏障、get_goal 增强
│   ├── goal-tools.mjs     宿主侧：goal_delivery 工具
│   ├── goal-routes.mjs    宿主侧：/__luzzy/goal 路由
│   └── client.js          ← 构建产物。不要手改
└── tools/
    ├── build-font-css.py        扫描 src/ + README.md → 子集化 → 内联 → 出 lib/client.js
    │                            末尾用 node 解析产物，解析不过就非零退出
    ├── verify-font-css.py       解码产物，验证四款字体与字形覆盖
    ├── render-font-proof.py     字体验证页（canvas 宽度对照）
    ├── scan-frame-backticks.mjs 扫帧模板里的未转义反引号（空白帧的元凶）
    ├── render-frame-preview.mjs 抽出帧文档做结构校验（30 项）
    ├── render-frame-with-data.mjs 帧 + 真实数据 → 页面，可 --shot 直接出图
    ├── render-hover-shot.mjs    真实指针事件驱动浮窗 → --shot 出图
    ├── render-anim-shot.mjs     在切换动画**进行中**截图
    ├── shoot.mjs                唯一的截图步骤（headless Edge），两个渲染器都调它
    ├── test-animation.mjs       动效三臂实验：[as-is|reduce|motion]
    ├── dump-usage-data.mjs      导出真实聚合数据，供上面的渲染器用
    ├── probe-aggregate.mjs      单独跑一遍聚合，隔离「worker 坏了」与「路由坏了」
    ├── probe-cache-bench.mjs    冷 vs 缓存重启，冻结快照逐位比对 + 计时
    ├── probe-first-paint.mjs    三种打开时机的首屏耗时
    ├── probe-extract-cost.mjs   拆解冷读各阶段耗时与缓存体积
    ├── probe-warmth.mjs         冷 / 结果缓存 / 重新分桶 三段对比
    ├── probe-session-usage.py   探查会话日志的真实结构
    ├── aggregate-usage.py       Python 独立实现，用作对账参照
    ├── reconcile-usage.mjs      Node vs Python 逐位对账
    ├── test-loader-contract.mjs 加载器契约（6）
    ├── test-client-load.mjs     组件与插槽契约（59）
    ├── test-usage-window.mjs    趋势窗口与活动阵列（60）
    ├── test-chart-path.mjs      曲线几何：单调不过冲（15）
    ├── test-usage-cache.mjs     解析缓存：Map 往返 / 版本 / 损坏 / soft fail（27）
    ├── test-host-routes.mjs     宿主路由，真实 HTTP（34）
    ├── test-host-integration.mjs 真实 webserver 包集成（15）
    ├── test-goal-domain.mjs     「目标」纯逻辑：完成门 / 权威 / 漂移 / 投影（119）
    ├── test-goal-store.mjs      「目标」CAS / 原子写 / goal.md 投影 / 可读性区分（77）
    ├── test-goal-enforce.mjs    「目标」四条钩子：完成门 / preflight / 屏障 / 增强（105）
    ├── test-goal-routes.mjs     「目标」路由，真实 HTTP（83）
    ├── test-goal-stress.mjs     「目标」边界载荷：取消 / 敌意会话 / 竞态 / fail-closed（37）
    ├── test-goal-lifecycle.mjs  「目标」真实 Session：compaction / resume / fork / 卸载（31）
    ├── probe-goal-layout.mjs    真实浏览器里量各视口的横向溢出
    ├── shoot-goal-tab.mjs       两主题 + 真实 420px 截图，sha 必须互不相同
    ├── test-event-loop-responsiveness.mjs 聚合与预热都不阻塞主线程
    └── verify-no-hooks.cjs      无第二份 React、无 require('react')、必须有 srcDoc
```

**`src/client.js` 是真源，`lib/client.js` 是产物。** 改完源码必须重跑构建，否则改的是会被覆盖的文件。

## 为什么是「秒开」

首屏曾经要等 **20 秒以上**，而且会一直卡住。两个独立原因，都修了。

### 一、`srcDoc` 每次渲染都重建 → iframe 反复重载

`srcDoc` 原来写作 `buildFrameDocument(FONT_FACE_CSS, theme)`，每次渲染都生成一个 **394 KB 的新字符串**。React 按值比较，一变就**重新加载 iframe** —— 正在跑的请求作废、已解压的进度丢掉，从头再读一遍 220 MB。

现在文档**构建一次**成常量（`FRAME_DOCUMENT`），主题写在帧的根属性上而不是塞进文档。`tools/test-client-load.mjs` 断言「连续渲染两次 srcDoc 逐字节相同」。

### 二、冷读 20 秒几乎全在解压，而结果只有 3 MB

| 阶段 | 耗时 |
|---|---|
| 解压 zstd → jsonl（553 MB） | **18,012 ms** |
| 解析 jsonl → attempts | 2,378 ms |
| 冷读合计 | 20,390 ms |
| 缓存文件（解析后的 attempts） | **3.1 MB** |
| 读缓存 + 解析 | **16 ms** |

贵的部分完全可以复用。`lib/usage-cache.mjs` 按文件缓存解析结果，键是 **(size, mtimeMs)** —— 日志追加过就重读，没动过就直接用。

两条容易踩的：

- **`modelRouting` 是 Map，而 `JSON.stringify` 把 Map 悄悄变成 `{}`。** 直接缓存的话，读回来是普通对象，worker 遍历时抛错，被 per-file catch 吞掉，**整个文件算作 skipped、数字全变 0**。所以显式存成条目数组。
- **缓存带版本号。** 解析逻辑一变，旧缓存格式合法但**内容是错的**，`(size, mtime)` 看不出来。改 `usage-core` 的输出就 bump `CACHE_VERSION`。

缓存**全程 soft fail**：缺失 / 损坏 / 写不进去 / 版本不符 → 退化成冷启动，绝不会退化成错数字。

### 实测

```
1. no cache (cold)        20889 ms   {"hits":0,   "misses":200, "saved":true}
2. after restart (cached)   144 ms   {"hits":200, "misses":0,   "saved":false}
   attempts: 20085 -> 20085    totals: 6627259780 -> 6627259780
```

**145 倍，结果逐位一致**（`tools/probe-cache-bench.mjs`，先冻结快照再比，否则活跃会话的新增记录会让比对必然不一致）。

另加**延后 15 秒的后台预热**，使「重启后第一次打开」也接近瞬时：

| 场景 | 首屏耗时 |
|---|---|
| 预热完成后打开（常态） | **0 ms** |
| 预热进行中打开 | 加入同一次运行，不重复读 |
| 完全没有缓存 | ~21 s |

预热**必须**满足两点才安全（早期版本崩过 DSH 两次）：跑在 **worker** 里（主线程只 postMessage，实测最坏停顿 19 ms），并且**延后**到启动之后。`tools/test-event-loop-responsiveness.mjs` 用同一个 1 秒上限约束它。


## 数据从哪来

浏览器端**没有**跨会话统计的接口，所以聚合在**宿主侧一次完成**，前端只渲染：

```
宿主侧 读 $DSH_HOME/sessions/**/*.jsonl.zstd → 解压 → 按正确口径聚合
       GET /__luzzy/usage    → 一个 JSON：totals + buckets + models + 三个窗口 + 活动阵列
       GET /__luzzy/readme   → README 原文
客户端 只 fetch 与绘制，不自己算
```

**一个请求返回全部三个窗口**（日 / 周 / 月），窗口由前端切换——所以切换窗口不发请求、不会和刷新赛跑。

### 三个「趋势窗口」是自然时间单位，不是「最近 N 个桶」

| 窗口 | 画什么 | x 轴 |
|---|---|---|
| 日 | **今天的 24 小时** | `00:00` … `23:00` |
| 周 | **本周的 7 天**（周一起） | `9/14` … `9/20` |
| 月 | **本月自己的各周**（按天切，不按 ISO 周） | `第1周` + `8.31 - 9.6` … `第5周` + `9.28 - 10.4` |

两条规则，都在 `lib/usage-window.mjs`：

1. **还没到的时段留空，不画成 0。** 未来的小时不是「用量为零」——画成 0 会凭空造出一段掉到轴上的塌方。这些位置的值是 `null`，曲线在那里**断开**。
2. **窗口内每一格都画**，哪怕没有数据——安静的一天是真实的 0，x 轴要保持形状。

活动阵列则始终**一个自然月、每格一天**：已过的日期按用量深浅填色，**未到的留白**（占位但不填色的格子，所以 30 天的月恒有 30 格）。

### 月视图的周标签带日期区间，且自然跨月

`第几周` 和它的日期区间都由 `monthSlots()` 的 `range` 字段给出，**前端不拼字符串**——区间是数据的一部分，所以「跨月的那一周」不需要特判。本机实测最后一周是 `第5周 / 9.28 - 10.4`，从 9 月自然延到 10 月。悬停浮窗里带同一份区间。

### 悬停浮窗

移到某个点上（或某组柱子上）显示 `标签 · 合计`，下面是**各模型分行**，从大到小，用量为零的模型省略。配指引线与放大点，浮窗贴近边缘时自动翻到另一侧。线图与条形图都有。

### 切换时入场动画，首次渲染不动画

曲线和柱子带一段很短的入场（透明度 + 6px 上浮）。两条纪律：

- **只在图表的「身份」真的变了时才播**——身份是 `窗口/模式` 的组合。刷新拿回同一张图的新数据不重播，否则每次刷新都像闪一下。
- **属性是临时的**，400 ms 后移除 `data-animate`。用定时器而不是 `animationend`：`prefers-reduced-motion` 下动画是 `none`，那个事件**永远不会触发**，属性会被永久卡住。

系统开启「减少动态效果」时，媒体查询会把动画整个关掉。

> 静态截图**证明不了动画存在**——动画结束时和从不播放在像素上完全一样。`tools/test-animation.mjs` 在动画**进行中**采样，并且分三个臂分别验「被抑制」与「真的在跑」（见「视觉验收」一节）。

### 折线用**单调**平滑，不是 Catmull-Rom

Catmull-Rom 会**过冲**：两个正数之间会鼓到轴下面——日视图真的在 03:00–04:00 画出了负 token。现在用 **Fritsch–Carlson 单调插值**，曲线保证落在数据自己的范围内。`tools/test-chart-path.mjs` 把贝塞尔控制点读回来采样，断言曲线不越界。

### 曲线数量有上限

窗口内模型超过 8 个时，后几名合并成「其他模型（N 个）」。本机月视图能到 16 个模型，所以这条实际生效。**合并是求和不是丢弃**——图例数字加总仍等于窗口总量，测试断言了这一点。

### 一个必须守住的口径：同一次请求记了两遍

每个已结算的尝试在日志里**记录两份用量**：

- `assistant/message` 的 `.data.usage`
- 同一事件的 `.data.stream[N].chunk.usage`

`dsh-token-meter` 的契约写明「最终 assistant 消息样本会**替换**同一次尝试的流式用量」。**朴素相加会多算约 1.64 倍**——本机实测：正确 61.8 亿 vs 朴素 101.3 亿。

聚合规则：每次尝试**只取一份**——有 `.data.usage` 用它，否则回退到最后一个 stream chunk。模型归属取该请求前最近的 `request/header`（`data.header.config.{provider, model}`），时间取事件自带的 `time`（毫秒）。

`tools/aggregate-usage.py` 是**独立写就的第二实现**，`tools/reconcile-usage.mjs` 拿两者逐位比对，四档单位全部一致。

### 日志是多帧 zstd

会话日志是**追加式**的：每次写入追加一个独立的 zstd 帧（1.9 MB 的样本里有 21 帧）。两个标准解压器都单独用不了：

- `zstdDecompressSync` 在**第一帧结束就停**，静默返回截断结果（1.9 MB → 222 字节），聚合全变 0 且**不报错**
- 流式 `createZstdDecompress` 读完第一帧后，遇到下一帧的起始字节会报 `Unknown frame descriptor`

所以按魔数 `28 B5 2F FD` 切分缓冲区、逐帧解压。

## 改文案之后

页面用到的 CJK 字形是从源码里抽出来做子集的——这是体积从 7.1 MB 降到 12 KB 的原因。所以：

```bash
# 1. 改 src/client.js 里的字典或结构
# 2. 重建（同时重新收集字形）
python tools/build-font-css.py
# 3. 验证
python tools/verify-font-css.py
```

**第 2 步不能省。** 新增的汉字若没进子集，页面会静默回退到系统字体——`verify-font-css.py` 就是为了抓这个而写的，它拿源码里的字符去反查产物，缺一个就 FAIL。

### 体积参考

| 字体 | woff2 | base64 |
|---|---|---|
| Luzzy PuHuiTi 400（子集） | 12 KB | 16 KB |
| Luzzy PuHuiTi 700（子集） | 12 KB | 15 KB |
| Luzzy Sans 400（整份） | 40 KB | 54 KB |
| Luzzy Sans 700（整份） | 42 KB | 56 KB |
| **合计** | **105 KB** | **141 KB** |

字重可以增删：改 `build-font-css.py` 的 `FACES` 表加一行，但新字重的字重号要写进 `PAGE_CSS` 的 `data-weight` 选择器。

## 字体怎么分中英

字体栈是 `'Luzzy Sans', 'Luzzy PuHuiTi', <回退>`，**拉丁在前**：

- Alibaba Sans **不含任何 CJK 字形**（734 字形全是拉丁），所以汉字直接落到普惠体，拉丁字永远命中 Sans
- 一个栈完成双语拆分，**不需要 `unicode-range`**。这也正是不加它的原因——加了会把 `U+3001`（、）`U+FF0C`（，）这类中文标点错误地排除在外

源字体在 `D:\.NekoTool\LuzzyRP\app\src\main\res\font\`（Alibaba PuHuiTi 3.0 + Alibaba Sans）。要换字体改 `build-font-css.py` 顶部的 `DEFAULT_FONT_DIR` 与 `FACES`。

## 页面为什么这么写

### 踩过的坑之一：bundle 注册 id 必须是包名

`window.__ModuleLoader__.load({ id })` 的 `id` **必须等于 `package.json` 的 `name`**。

加载器服务 bundle 后，会用**图行 id** 去查工厂表（`factories.has(row.id)`），而这个行 id 就是包名。对不上就整包失败，界面上表现为：

```
failed to import loader entry ... (dsh-luzzy-page):
client-modules: bundle /plugins/??...,dsh-luzzy-page/client.js&rev=... loaded
without registering "dsh-luzzy-page" via __ModuleLoader__.load
```

**三个 id 不在同一个命名空间，别混用：**

| 位置 | 值 | 规则 |
|---|---|---|
| `__ModuleLoader__.load({ id })` | **包名** `dsh-luzzy-page` | 必须等于 `package.json` 的 `name` |
| `cordis.patch.yml` 的 `id` | `luzzy-page` | patch 层条目标识，随便起 |
| `slots.register({ id })` | `luzzy-page` | `conversation.view` 格子里的条目 id，随便起（Tabbit 同理：包名 `@tabbit-ai/dsh-tabbit` vs 条目 id `tabbit-local-agent`） |

`tools/test-loader-contract.mjs` 专守这条：它实现加载器的**真实**校验，断言「id 等于包名」「id 不是 patch id」。改错必 FAIL —— 用反向验证试过，把 id 改回旧值，报错信息与线上崩溃一字不差。

### 踩过的坑之二：宿主主线程绝不能被占用（这条崩过 DSH 两次）

桌面宿主进程跑着一条 **profile admission 通道**，它的 RPC 调用 **30 秒超时**（`HostRpc`，`timeoutMs = 3e4`）。而聚合全部会话日志约需 **20 秒**同步 CPU（多帧 zstd 解压 + JSONL 解析）。

**两次真实崩溃，两种错误做法：**

| 版本 | 做法 | 后果 |
|---|---|---|
| 第一版 | 启动 1.5 秒后 setTimeout 跑全量聚合 | 主线程被占 20 秒 → admission 饿死 → `host-boot` 卡 123 秒失败，**DSH 起不来** |
| 第二版 | setImmediate 分块 + 每块之间让出 | 单文件解析仍可阻塞 5.9 秒 → **同样崩**（实测证明让出不够） |

**现在的做法**：全部重活跑在 `worker_threads` 里（`usage-worker.mjs`），主线程只合并每文件的小结果。实测冷聚合期间主线程**最坏停顿 7 毫秒**，admission 窗口毫无压力。

**回归测试**：`tools/test-event-loop-responsiveness.mjs` 持续采样事件循环，单次停顿超过 1 秒即 FAIL。改这个文件前先跑它。

**纪律**：宿主进程里的任何插件代码，只要可能超过几百毫秒，就不许同步执行——不管它包装在 setTimeout 还是 setImmediate 里。

### 其余三条约束

来自 DSH 的客户端架构，不是风格选择：

1. **`require` 不 `import` React。** 宿主的静态模块表持有唯一实例，自己引会拿到第二份，hooks 立刻报错。
2. **所有子组件在模块顶层。** 在渲染函数里声明组件会让 React 每轮看到新类型、整棵子树重新挂载——输入框丢焦点、动效重启。单文件手写没有模块边界，这条最容易犯。
3. **注册包在 `ctx.effect()` / `ctx.slots.inject()` 里。** 否则卸载不回滚，热重载后残留。

样式走 `data-plugin-css` 去重注入，且**只作用于 `.luzzy-page` 容器**——DSH 其余界面的字体与配色不受影响。

设计 token 用 DSH 的 `--dsw-alias-*` 与 `--dsh-content-font-size`，所以自动跟随主题与用户字号设置。

## 安装

`~/.dsh/profiles/desktop/package.json` 里加两处：

```json
"dependencies": {
  "dsh-luzzy-page": "link:../../../Desktop/DSH Plugin/luzzy-page"
},
"dsh": { "profile": { "bundles": [ "...", "dsh-luzzy-page" ] } }
```

然后 `dsh plugin --profile desktop install` 建立链接。

**注意**：`dsh plugin add <路径>` 在路径含空格时会被 PowerShell 拆成两个参数，装出两个垃圾依赖。这个包路径里有空格，所以走手工改 `package.json` 再 install 的路线。

验证层已生效：

```bash
dsh --profile desktop --dump-config | grep -A2 luzzy
# 应出现 "# == dsh-luzzy-page" 与 "id: luzzy-page"
```

### 必须重启

客户端 bundle 在**宿主启动时**同步装配。装完插件后必须重启 DSH Desktop，标签才会出现——刷新页面不够。

## 验证

全套（按依赖顺序，约 2 分钟）：

```bash
node --check src/client.js && node --check lib/client.js && node --check lib/index.js
python tools/verify-font-css.py          # 字体与字形覆盖
node tools/test-loader-contract.mjs      # 加载器契约（bundle id 必须是包名）
node tools/test-client-load.mjs          # 组件结构
node tools/test-host-routes.mjs          # 宿主路由，真实 HTTP
```

### 「目标」子页

```bash
node tools/test-goal-domain.mjs          # 完成门 / 权威 / 漂移 / Markdown 投影
node tools/test-goal-store.mjs           # CAS / 原子写 / goal.md 投影 / 开关
node tools/test-goal-enforce.mjs         # 四条钩子：完成门 / preflight / 屏障 / 增强
node tools/test-goal-stress.mjs          # 取消 / 敌意会话 / 修订竞态 / fail-closed 穷举
node tools/test-goal-lifecycle.mjs       # 真实 Session：compaction / resume / fork / 卸载后无孤儿

# 真机验收（重启 DSH 之后跑）——离线套件证明不了宿主半真的加载了
node tools/verify-on-machine.mjs
node tools/test-goal-routes.mjs          # 路由契约，真实 HTTP
node tools/probe-goal-layout.mjs         # 真实浏览器，三个视口的横向溢出
```

`probe-goal-layout.mjs` 量的是事实而不是观感：文档的 `scrollWidth` 是否超过视口、谁越界、`goalGrid` 折成了几列、每个状态徽标是否都带图标。截图只能看出「怪怪的」，这些数字能定位到元素。

### 数字正确性

```bash
node tools/reconcile-usage.mjs           # Node vs Python 逐位对账，四档单位
```

**必须先冻结快照再比对**，脚本已内置：活跃会话在检查期间持续写入，而 Python 侧要跑约 15 秒，直接比对会永远「不一致」，差值恰好等于期间新增的 token。脚本先把日志复制到临时目录，两边读同一份副本。

加 `--live` 可以读实时目录，但那只能看漂移，不能当结论。

### 视觉验收（不需要重启 DSH）

```bash
node tools/dump-usage-data.mjs                                 # 导出真实数据
node tools/render-frame-preview.mjs                            # 帧文档结构校验（30 项）
node tools/render-frame-with-data.mjs --tab usage --window day --mode line --shot day.png
node tools/render-frame-with-data.mjs --tab usage --window week --shot week.png
node tools/render-frame-with-data.mjs --tab usage --window month --mode bar --shot month-bar.png
node tools/render-frame-with-data.mjs --tab readme --shot readme.png
node tools/render-hover-shot.mjs --window month --mode bar --shot hover.png   # 浮窗
node tools/test-animation.mjs motion                           # 动画真的在跑
node tools/test-animation.mjs reduce                           # 减少动态效果时必须停
```

渲染器**加载真实 bundle**、抽出帧文档、喂入真实聚合数据——截图看的是出货代码，不是重画的替身。`--shot` 直接出图，不必自己拼 Edge 命令行。

「目标」子页有自己的截图入口，因为它需要**真的窄**：

```bash
node tools/shoot-goal-tab.mjs            # 浅色 / 暗色 / 真实 420px，三张 sha 必须互不相同
```

**`--window-size` 在这台机器上给不出窄视口。** Windows 有最小窗口宽度，所以要 420px 得到的页面实际按 **492px** 排版、再**裁切**成 420px——看起来就像内容从右边缘溢出去，而实际上什么都没溢出。实测：

```
--window-size=420,900  =>  innerWidth 492, outerWidth 516
```

这个假信号骗过一轮「窄屏布局坏了」。`shoot-goal-tab.mjs` 改用 CDP 的 `Emulation.setDeviceMetricsOverride` 设置**真实**布局视口，并且每次截图都断言 `innerWidth` 就是请求的宽度——**截图工具必须自证它拍的是它声称的那张**。

五条曾踩的坑，改动前先读：

- **`--window` / `--mode` 必须真的驱动帧内控件**。帧总是从「日 / 折线」开始，只点标签页并不改窗口：早先 `--unit hour` 与 `--unit day` 的截图**逐字节相同**，等于没验。**判据：两张应当不同的图若 sha256 相同，就是没验到。**
- **帧文档是模板字符串**，里面写反引号必须转义成 `` \` ``，否则模板提前结束、整帧变成语法错误。症状是空白帧，且报错位置离真正错误很远（踩了三次）。`tools/scan-frame-backticks.mjs` 专门扫这个，`build-font-css.py` 也会在写完产物后用 node 解析一遍，**解析不过就退出非零**。
- **渲染器的 shim 也是模板字符串**，而且是在 **Node** 里求值：写 `${...}` 会被当占位符求值、写反引号会终止字符串——**连注释里都不行**。
- **`className` 必须输出成 `class`**。写成 `classname` 时 CSS 完全不命中，页面「看起来还行」但全无样式——这种失败不报错，只出错版。（历史坑，离线渲染器已换成直接读取帧文档，不再自己拼 HTML。）
- **无头浏览器恒定报 `prefers-reduced-motion: reduce`**，于是动画一律被媒体查询关掉，看起来像「动画坏了」。而且 `--force-prefers-reduced-motion` **不接受取值**——写 `=no-preference` 照样强制 reduce，两轮会产出**逐字节相同**的截图。想验动画真的在跑，用 `test-animation.mjs motion`（把媒体查询块从帧副本里删掉，其余不动）。详见 `AGENTS.md` §5.15。

**截图走 `--shot`，不要自己调 Edge。** GUI 程序不会被 shell 等待，profile 共用会撞锁，Edge 移交启动后会非零退出——四种失败全都表现为「图没出现，而输出每一行都正常」。这些都收在 `tools/shoot.mjs` 里了。批量补图后**在新进程里复核哈希**：同一批命令里刚截完就读，可能读到旧文件或半写的文件。

## 卸载

```bash
cd ~/.dsh/profiles/desktop
# 从 package.json 删掉 dsh-luzzy-page 两处引用
dsh plugin --profile desktop install
```

profile 的备份在 `package.json.bak-luzzypage-*`。

## 现状

两个子页都已实现并验证：

| 子页 | 内容 | 状态 |
|---|---|---|
| 说明 | README 全文，**帧内自带的 markdown 渲染器**（不是宿主 `MarkdownText`） | 已实现，字形已并入子集 |
| 用量 | 活动阵列（当月每日）+ 模型趋势（日/周/月 × 折线/条形）+ 模型饼图 | 已实现，数字已对账 |
**整页跑在一个 `<iframe srcDoc>` 里**——帧内是纯 HTML + 原生 JS，零 React、零 hooks、零框架注入。为什么必须这样，见 `src/client.js` 开头的三条死路记录。

**真机已确认取数**（帧内黑匣子上报 `usage-fetch-ok`，数字与离线导出一致）。离线渲染器另验过：浅色/暗色、折线与条形、三个窗口、悬停浮窗、动画两臂、以及 README 页。

剩下的视觉项需要**重启 DSH** 才能逐条过完整流程（重启会终止正在做这件事的会话）。重启后请确认：

1. 标签在「轨迹」右侧
2. 进入默认显示说明子页，且**左右占满**（不再居中偏窄）
3. 切到用量子页，数据出现，数字与 `node tools/dump-usage-data.mjs` 输出一致
4. **活动阵列是当月**，**已过的格子按深浅填色、未到的留白**
5. **切「日 / 周 / 月」**：x 轴变成 24 小时 / 7 天 / 本月各周，且**未来时段留空、曲线在那里断开**
6. **月视图的周标签带日期**（`第1周 8.31 - 9.6` … `第5周 9.28 - 10.4`）
7. **切窗口 / 切「折线 / 条形」时有入场动画**，进页面时不动画
8. **移到点上出现浮窗**，表头是 `标签 · 合计`，下面是各模型分行
9. 切「折线 / 条形」都生效（条形是按模型分组并排的）
10. 切换 DSH 的浅色/暗色主题，页面跟着变
11. 浏览器控制台无报错

**首屏耗时**：常态是即时——解析结果按文件缓存（`(size, mtimeMs)` 为键，带版本号，全程 soft fail），且宿主在启动后**延后 15 秒**在 worker 线程里做一次预热。所以只有「缓存为空且预热还没跑完」才会走到约 20 秒的冷读，页面上有计时与说明。

**预热跑在 `worker_threads` 里**——这条是硬的：早期在宿主主线程同步跑预热，DSH 起不来两次（`AGENTS.md` §5.2）。实测最坏主线程停顿 19 ms。
