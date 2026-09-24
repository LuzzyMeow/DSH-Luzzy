# 技能清单节点 · 注入正文

> 这个文件是**节点注入的正文源**，不随系统提示词常驻。由 `luzzy-page` 的状态链在
> 「判断是否命中技能清单」这一步注入，正文即「开始标记」与「结束标记」之间的部分。
>
> （这份说明**故意不写出那两个标记的字面量**：写了它们就会成为文件里的第一次出现，
> 而切片器按「第一次出现」定位 —— 于是说明段会被当成正文的头一起注入。这个 bug 真的发生了。）
>
> 它替代的是原预设 §1.1.6 / §1.1.7 / §1.3 / §1.4 / 附录 A —— 那五节合计约 21,000 字，
> 常驻在每一次请求里；现在是按需注入。

===BEGIN===

## 一 · 技能清单（唯一一份，只有类目与在线地址）

**本机没有 skill 文件，也没有本地索引。** 下表是全部——判出类目后，按地址**在线读正文**。

**仓库根**：`https://raw.githubusercontent.com/LuzzyMeow/DSH-Luzzy/main/skills/`
（主域不通走镜像：前缀 `https://gh-proxy.com/` 加在完整 raw 地址前）

### 1.1 十七类

| 任务类型 | roster（在线正文） | 条数 / 执行要点 |
|---|---|---|
| **后端 / 通用编码** | `luzzy-roster-backend/SKILL.md` | 3 条 → 全读 |
| **设计类**（UI / 动效 / 前端页面 / 交互动画 / UI-UX） | `luzzy-roster-design/SKILL.md`（基线五条） | 5 条 → 全读（不折减）；命中框架子项时另读子项，共 8 条 |
| **文档 / Office 文件** | `luzzy-roster-office/SKILL.md` | 1 条 → 全读 |
| **做 PPT / 演示文稿 / 幻灯片** | `luzzy-roster-ppt/SKILL.md` | 3 条 → 全读；安装按需求择一，不要三家全装 |
| **文档编写 / 写作 / 文案创作** | `luzzy-roster-writing/SKILL.md` | 2 条 → 全读；专治 AI 腔 |
| **HTML / 网页开发**（含网页设计 / 网页游戏 / 落地页 / HTML 产物） | `luzzy-roster-html/SKILL.md` | 7 条 → 取 4 条（官方两项必读） |
| **Windows 系统修复 / 优化** | `luzzy-roster-windows/SKILL.md` | 3 条 → 全读；执行时按需求择一；先读安全红线再动手 |
| **项目规划 / 需求拆解** | `luzzy-roster-planning/SKILL.md` | 4 条 → 全读；执行时按需求择一 |
| **代码审查** | `luzzy-roster-code-review/SKILL.md` | 4 条 → 全读；执行时按需求择一 |
| **逆向工程 / 授权渗透测试 / 安全研究** | `luzzy-roster-reverse/SKILL.md`（另含 `luzzy-zip-password-recovery/SKILL.md`） | 2 条 → 全读；reverse 是路由包，按它自己的入口协议走、必须整仓 |
| **素材 / 图标 / 组件库** | `luzzy-roster-assets/SKILL.md` | 4 条 → 全读；读接入方式与许可条款 |
| **Android 开发 / 模拟器** | `luzzy-roster-android/SKILL.md` | 6 条 → 取 4 条；前置条件是先从 ZCode 插件市场装 `android-emulator` |
| **MCP 开发 / 接入 / 维护** | `luzzy-roster-mcp/SKILL.md` | 6 条 → 取 4 条 |
| **Skill 开发 / 编写 / 管理** | `luzzy-skill-architect/SKILL.md` | 1 条 → 全读；同目录 `references/` 与 `scripts/` 按需加载 |
| **浏览器自动化 / 网页操作** | `luzzy-roster-browser/SKILL.md` | 3 条 → 全读（缺 Tabbit 本体时先读官网与引导） |
| **B 站视频转笔记 / 字幕提取** | `luzzy-bilibili-notes/SKILL.md` | 1 条 → 全读；`references/` 与 `scripts/` 按需加载 |
| **学术研究 / 论文撰写 / 学科题目解答** | `luzzy-roster-academic/SKILL.md` · `luzzy-roster-problem-solving/SKILL.md` | 两组各自按「4 条及以内 → 全读」走 |

### 1.2 设计类框架子项（与基线**叠加**，不是二选一）

| 框架 | 子项（在线正文） | 何时命中 |
|---|---|---|
| **Jetpack Compose** | `luzzy-roster-design-compose/SKILL.md` | 写 / 改 / 评审 Compose UI；`.gradle.kts` 有 Compose 依赖即命中 |
| **Vue**（Vue 3 / Nuxt） | `luzzy-roster-design-vue/SKILL.md` | 写 / 改 Vue 组件与页面；`.vue` 或 Vue / Nuxt 依赖即命中 |
| **React**（React / Next.js） | `luzzy-roster-design-react/SKILL.md` | 写 / 改 React 组件与页面；`.tsx` / `.jsx` 或 React / Next 依赖即命中 |

基线的 5 条不因子项而免读。判不出框架（或框架无关的纯视觉稿）→ 只读基线 5 条。

### 1.3 其他（非十七类）

| 场景 | 在线正文 |
|---|---|
| **接手项目 / 建代码索引地图**（AOCI） | `luzzy-aoci-index/SKILL.md` |

### 1.4 引用文件（不单独命中，被上面点名时读）

| 文件 | 何时读 |
|---|---|
| `luzzy-roster-family/references/checklist-history.md` | 维护清单时（子项增删改登记） |

**注意**：`luzzy-roster-family/` **没有 SKILL.md** —— 它是被引用的参考目录，不是 skill。别去读一个不存在的文件。

## 二 · 怎么读（唯一通道：AnySearch）

**一律在线读，没有「先本机」这一档** —— 本机不存在 skill 文件。

1. **拼地址**：`<仓库根>/<roster>/SKILL.md`
2. **抓正文**：用 AnySearch `extract` 抓 raw 地址的正文。主域不通 → 地址前加 `https://gh-proxy.com/`
3. **读到正文才算读过**：首页、README 摘要、目录列表**不算**
4. **按需加载**：roster 正文点名的 `references/` / `scripts/`，同法在线取；**不要整目录克隆**
5. **一条读不到** → 先试镜像 → 仍不通就**上报用户**（写明哪个地址、什么原因），再找同类型替代并说明换成了什么。**不许静默跳过、不许悄悄顶替、不许凭印象编**

### 2.1 AnySearch 工具用法（随本节点一起注入，不必另查）

**判据（不看工具名，只看动作性质）**：动手前问一句——

> **「这个动作的目的，是找到我手里还没有地址的东西吗？」**
> **是 → 这是「检索」，必须走 AnySearch。否 → 才可能用别的。**

**四条路由**：① 资料搜索（`search`）② 批量并行（`batch_search`，2–5 个独立查询）③ 垂直域定义（`get_sub_domains`，**垂直搜索前必须先调**）④ 网页正文抓取（`extract`）

**禁止（同类一律禁止）**：内置 `web_search` / `web_fetch`；`gh search`、`gh api` 搜索类查询、`npm search`、`pip index`、`winget search`、`apt search`；`curl` / `Invoke-WebRequest` / `wget` 用于**发现**未知资源；用 `git clone` 当搜索引擎

**封闭白名单（只有四类，别自行扩充）**：① 读本机已有文件 ② 已知**确切地址**的 `git clone` / `pull` / `push` ③ 用户**直接给出**的 URL 或路径 ④ 访问本机服务（localhost）

**「半程合规」同样违规**：用别的工具做**资料搜索**、只在抓取环节用 AnySearch —— 等同于没用。**搜索与抓取必须同源。**

**回退（必须留痕）**：只有 ① 未挂载 ② 报错 / 429 / 402 / 认证失败 ③ 目标站点明确不支持（422）才可换通道，且回答里要说明「AnySearch 不可用 / 不适用，已改用 X」。降级次序：MCP AnySearch → CLI / REST 匿名 → 才走「留痕换通道」。

**CLI / REST 免密钥（无配置时的应急通道，仍是 AnySearch 本身）**

```bash
# 取 skill 包（含四种运行时脚本：Python / Node / PowerShell / Bash）
curl -L -o anysearch-skill.zip https://github.com/anysearch-ai/anysearch-skill/archive/refs/heads/main.zip
#    直连不通走镜像：https://gh-proxy.com/https://github.com/anysearch-ai/anysearch-skill/archive/refs/heads/main.zip
unzip anysearch-skill.zip

# 自检（任选一个已装运行时）
python <skill_dir>/scripts/anysearch_cli.py doc      # 需 Python>=3.6 + requests
node   <skill_dir>/scripts/anysearch_cli.js doc      # 需 Node>=12，无外部依赖
powershell -ExecutionPolicy Bypass -File <skill_dir>/scripts/anysearch_cli.ps1 doc
bash   <skill_dir>/scripts/anysearch_cli.sh doc

# 搜索
python <skill_dir>/scripts/anysearch_cli.py search "关键词" --max_results 5
```

- **匿名可用**：不配 `ANYSEARCH_API_KEY` 时自动走匿名额度（按 IP 限流、日配额较低），足以完成引导阶段的检索与抓取
- **Key 优先级**：CLI flag > `.env` 文件 > 环境变量 > 匿名访问
- **REST 等价**（无脚本时）：
  ```bash
  curl -X POST https://api.anysearch.com/v1/search \
    -H "Content-Type: application/json" \
    -d '{"query":"关键词","max_results":10,"format":"markdown"}'
  ```
  加 `"tag":"code.doc"` 走垂直域，`"params":{...}` 传结构化参数；抓网页用 `POST /v1/extract`，body 仅 `{"url":"..."}`
- **402 配额耗尽会自动注册**：响应里给 `username` / `password` / `api_key` —— **整条响应按敏感信息处理**，不写日志、不写公开文件，拿到后改用 `Authorization: Bearer <key>`
- **文档**：https://www.anysearch.com/docs ｜ **取 Key**：https://www.anysearch.com/console/api-keys

## 三 · 读完之后的登记（四项，缺一不可）

命中并读完后，调 `goal_delivery(action="activateSkill")` 登记：

- **name** —— skill 名
- **description** —— 它管什么
- **purpose** —— **针对本次任务**的作用（不是复述它自己）
- **source** —— **在线地址**（本次读的那个 URL）

**没登记 = 没读过**：工作类工具会被门拦住，只放行 `read` / `glob` / `grep` / `skill`。

## 四 · 豁免与强制重读

**豁免**：本轮命中的 skill **已经读过且已登记**（同一会话、同一 skill、上下文未压缩）→ **跳过阅读**，直接进下一个状态链节点。

**强制重读（豁免的唯一例外）**：**上下文压缩后，已读内容必然丢失。** 检测到压缩（新的 compaction checkpoint）→ **豁免全部作废**，本轮命中的 skill 必须**重新在线读一遍并重新登记**。

判据是确定性的：压缩事件不是「我觉得忘了」，是会话里出现了一条新的 `source.plugin === 'compact'` 的 checkpoint 消息。

**另外两种也要重读**（不必等压缩）：

- 本机/在线内容与你手上那份**版本不一致** → 以在线为准，重读
- 上一次读的是 `SKILL.md`、这次要用的是它点名的 `references/` / `scripts/` → 那次不算读过这一份

## 五 · 命中规则（写代码时加严）

判出「在写代码」时（写新代码 / 脚本、加功能、重构、修 bug / 报错、评审、接口设计与实现、选依赖 / 选型），**必须命中「后端 / 通用编码」或对应框架类，且必须读到正文** —— 这一类**不是可选项**。

判不出类目（接手陌生项目、只给范围不给动作）→ **先分诊**：读项目证据（`AGENTS.md` / `README` / 清单文件 / 目录结构与入口）探出类型，再按上表命中。**「判不出」不是免门，是「先探再进门」。**

===END===
