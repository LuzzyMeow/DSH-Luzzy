# DSH 插件层可行性调研

> 调研对象：AstrBot / openhanako（HanaAgent）/ QwenPaw 三家开源 Agent 的机制优势，与 DSH（DeepSeek Harness）插件层的对照
> 关键词：知识库嵌入模型注入、记忆嵌入注入、前缀缓存保持、延迟加载工具
> 核验版本：本机 `dsh 0.1.5-rc.1`（Desktop 版）

---

## 〇、一句话结论

**用户点名的三件事，DSH 插件层都能做**——而且其中两件的「半成品」DSH 内核里已经有了，缺的只是把它们接到检索上：

| 用户目标 | 结论 | 依据一句话 |
|---|---|---|
| AstrBot 的知识库 + 嵌入模型注入 | ✅ 能，社区已有可用实现 | `dsh-rag-kb`（MIT）已跑通「Ollama 嵌入 + 余弦检索 + 三条 agent 工具 + 网页端面板」 |
| QwenPaw 的记忆嵌入模型注入 | ✅ 能，但**它的做法比配置更有价值** | 它把召回结果**伪装成一条 `memory_search` 工具调用消息**插在用户消息后——这个形态 DSH 的 `agent/pre-step` 接得住 |
| openhanako 的优化 | ✅ 大部分能，且比想象中更容易 | 它最核心的「缓存保持型压缩」DSH 有对应 seam；「小纸条」机制 DSH 内核本就是**差异化快照** |

**但有一条关键纠正**：视频里说的「HanaAgent 的记忆用 embedding」，在 HanaAgent v2 里**已经被作者主动删掉了**——`lib/memory/memory-search.ts:4` 原话是「替代 v1 的 embedding KNN + 混合排序 + 链接展开」，现在走**标签匹配 + SQLite FTS5 全文兜底**。所以「抄 HanaAgent 的嵌入注入」这个前提本身不成立；要抄嵌入就抄 AstrBot 或 QwenPaw，或者干脆学 HanaAgent 别用嵌入。

**另一条纠正**：QwenPaw 也不用向量数据库。它的长期记忆是 **Markdown 文件**（`MEMORY.md` + 日记），只有索引被向量化，存储走 ReMe 的 `LocalFileStore`。三家没有一家在长期记忆上用独立的向量库产品。

**本轮新增的实测修正（与初判相反，已改）**：

| 原先的判断 | 实测结果 | 影响 |
|---|---|---|
| 「缓存命中率观测需先验 DeepSeek usage 有没有 cache 字段」 | **有**。`TokenUsage` 含 `cacheReadTokens` / `cacheWriteTokens`，DeepSeek 适配器已把 `prompt_cache_hit_tokens` 映射进去，且**按「不相交」口径减掉了** | 这一格从「待核」升为 ✅，**成为最该先做的插件**（见 §5.1） |
| 「provider 缓存亲和键也许能用 header 注入」 | **不能**。`LlmCallConfig` 只有 6 个字段，无 headers；唯一 header 机制是 `attributionHeaders()`（只产 `user-agent`） | 这一格从 🟡 降为 🔴——插件层做不了，要写得写新适配器 |

**§5 给出了四个插件的具体接法**（缓存观测、知识库嵌入注入、记忆召回注入、工具延迟加载），含 hook、伪代码与代价，照着能开工。

---

## 一、调研方法与证据基础

### 1.1 怎么做的

| 手段 | 具体动作 | 样本 |
|---|---|---|
| 克隆精读 | `git clone --depth 1` 三仓库，派三路子代理分头读源码 | AstrBot 17.6MB / HanaAgent 81.9MB / QwenPaw 96.1MB |
| 本机实证 | 直读 DSH Desktop 安装目录里的官方包 `lib/index.js` 与 `README.zh.md` | `C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\` |
| 视频提取 | 取标题、简介、`ai-zh` 字幕、全部公开评论 | BV11q8J6CEZS（HanaAgent）/ BV1QwJu6hEoE（QwenPaw） |
| 联网检索 | AnySearch 查社区已有实现与 MemOS/OpenClaw 配置 | 命中 `dsh-rag-kb` discussion #552 |

### 1.2 证据分级

| 级别 | 含义 | 本文中的例子 |
|---|---|---|
| **A · 本机直读** | 直接读到源码/文件，可复现 | DSH 的 `SECTION_ORDERS` 表、`RuntimeContextProjection.project()`、HanaAgent 的参数默认值 |
| **B · 仓库精读** | 子代理读克隆仓库所得，带 `路径:行号` | AstrBot 的 `_apply_kb()`、HanaAgent 的 `compaction-guard-ext.ts` |
| **C · 视频自述** | UP 主口述，未在代码中逐条验证 | 「延迟加载工具」的产品声明 |
| **D · 推断** | 本文作者的判断 | 可行性结论、改动代价 |

**凡标 `【推断】` 的都是 D 级**，可以直接质疑。

---

## 二、DSH 插件层的能力底牌（本机实测）

这一节是全部可行性判断的地基。来源：`@deepseek-ai/dsh-system-prompt`、`dsh-agent-loop`、`dsh-agent`、`dsh-llm`、`dsh-compaction` 等包的 `lib/index.js` 与 `README.zh.md`。

### 2.1 系统提示词的排序表（完整）

`dsh-system-prompt/lib/index.js:10-42` 的真实常量：

```js
const SECTION_ORDERS = {
  HARNESS_IDENTITY: -1e3,
  DEPLOYMENT_PERSONA_PREFIX: 0,
  PLAN_POLICY: 500, TEAM_POLICY: 600, PTC_ONLY: 800, FILE_REFERENCE: 900,
  TOOL_BASH: 1e3, TOOL_PWSH: 1010, TOOL_READ: 1100, TOOL_WRITE: 1200,
  TOOL_EDIT: 1300, TOOL_GLOB: 1400, TOOL_GREP: 1500, TOOL_JOBS: 1600,
  TOOL_PTY: 1700, TOOL_WEB_SEARCH: 2e3, TOOL_WEB_FETCH: 2100, TOOL_LSP: 2200,
  TOOL_SESSION_QUERY: 2300, TOOL_GOAL: 2400, TOOL_CORDIS: 2500,
  TOOL_WORKFLOW: 2600, TOOL_RALPH: 2700, TOOL_SUBAGENT: 2800, TOOL_REPORT: 2900,
  TOOLS_SDK: 5e3,
  DELIVERABLE_FILE_REFERENCES: 9e3,
  STRUCTURED_OUTPUT: 9900,
  HARNESS_SOURCE: 1e4, WEB_SURFACE: 10100,
  DEPLOYMENT_PERSONA_SUFFIX: 10200      // ← 排序里最后一段
};
```

**两条从这张表直接读出来的结论**：

1. **人设后缀已是全局最后一段**（10200）。HanaAgent 视频里讲的「把人设放最后能提高遵从度」，DSH 有现成的落点。
2. **每个工具一段（1000–2900），一次性全进提示词**。DSH **没有**工具说明书的延迟加载——这正是 HanaAgent 的差异点。

### 2.2 运行时上下文是「差异化快照」，天然保护前缀缓存

`dsh-agent-loop/lib/index.js:336-355`：

```js
project(current, sections) {
  if (this.retained === void 0 && current.length === 0) return;
  const snapshot = current.length === 0 ? CLEARED : current;
  if (this.retained?.text === snapshot) return;   // ← 内容没变就不追加
  return createUserMessage({ content: [{ type: "text", text: snapshot }], source: { kind: "plugin", ... } });
}
```

再看 `preStep()`（`:885-907`）：把渲染出的动态上下文作为一条 **user 角色消息追加在当前 step 消息之后**，然后交给 `agent/pre-step` waterfall。

**这一条极其重要**，因为它意味着：

- HanaAgent 的「reminder / 小纸条」机制——环境变了、时间变了就贴一张条子——**DSH 内核本来就是这么干的**，不需要插件复刻。
- 快照只在真正变化时才新增，**追加式而非替换式**，所以历史前缀保持稳定，缓存命中率得到保护。
- 官方 README 的表述是：「上下文在循环下成为模型历史中带来源的 user 角色快照」「只在存在时才会成为带来源的 user 角色快照」。

### 2.3 三条注入通道（对应 AstrBot 的「临时内容块」）

| 通道 | 签名/用法 | 落点 | 是否进历史 |
|---|---|---|---|
| `ctx.systemPrompt.context()` | 注册 provider，每次组装求值 | 派生成 user 角色快照 | 进，但**仅变化时**新增 |
| `ctx.systemPrompt.section()` | 静态/动态段落，带 `order` | 系统提示词（surface 第 0 号节点） | 进 |
| `agent.inject(input)` | `dsh-agent-loop/lib/index.js:795` | 收件箱 `next-step`，**不唤醒驱动器** | 进，且**每次都追加** |

`agent.inject` 的官方语义（`dsh-agent/README.zh.md`）：「添加面向模型的上下文但不唤醒驱动器，因此它落在下一个被接纳的步骤中」——被接纳的内容成为后续步骤派生历史的一部分。

**关键差异**：AstrBot 用 `mark_as_temp()` 让检索结果**只发给 provider、不写入历史**。DSH **没有这个语义**。要在 DSH 里做「每轮注入但不累积」，只有两条路：

- 走 `systemPrompt.context()`，靠「内容变了才追加」天然限流——**推荐**；
- 走 `agent/pre-step` 直接改 `decision.messages`（waterfall 里 `messages` 可替换），自己造一次性消息——但这是在造框架本就有的轮子，且要自己保证可重建性。

### 2.4 模型调用可包裹，且请求不可改写

`dsh-llm/README.zh.md` + `04-服务与运行时.md`：

```js
registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle
async prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>
stream(options: GenerateOptions): AsyncIterable<StreamChunk>
```

- `llm/stream` 是 **waterfall**，包住每一次流式模型调用，**重试、重放、路由都能挂这里**；listener 可以 `next()` 到达适配器，也可以直接 yield 自己的 chunk 短路。
- 但注意：loop 构造的请求**到达时已深冻结（改它会抛）**，listener 只读不改写。

**两个类型的确切定义**（出自 `dsh-llm/lib/typert.host.js` 的 `declaration` 段，与源码等价）：

```ts
export interface LlmCallConfig {          // ← 只有 6 个字段，没有 headers
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffortId;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}

export interface TokenUsage {             // ← 缓存命中量在这里
  inputTokens: number;                    // 注意：适配器已把 cache 读部分减掉
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
```

`call-config.js` 的模块注释还写明了一句要紧的话：「provider 路由、model、reasoning effort 与 sampling 值是**会影响缓存复用**的请求头状态；request waterfall 替换它们，loop 记录变更后的快照而非允许每次调用静默漂移。」——**这就是 DSH 自带的缓存漂移记录点**。

**由此确定两件事**：

- 「缓存命中率观测」**可行**（`TokenUsage.cacheReadTokens` 存在，且 `dsh-llm-deepseek/lib/index.js:1146-1163` 已把 DeepSeek 的 `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens` 映射进去）；
- 「provider 缓存亲和键」**插件层不可行**（`LlmCallConfig` 无 header 位置，只能写新适配器）。

这同时决定了「保前缀压缩」的可达程度（见 §4.3 与 §5.1）。

### 2.5 本机完整包清单里与本次调研相关的部分

`C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\` 下 200+ 个包，以下与三家对照直接相关：

| 包 | 它已经是什么 | 与哪一家对应 |
|---|---|---|
| `dsh-session-query-sqlite` | **SQLite FTS5 全文检索**，跨会话 + 会话内，游标分页，派生库不改原始存储 | HanaAgent 的 FTS5 记忆检索**同款技术** |
| `dsh-skill` + `dsh-skill-filesystem` | 本地 skill 发现、frontmatter 解析、目录监视、按需加载正文 | 三家的 skill 系统 |
| `dsh-compaction` + `-basic` + `-tool-result-pruner` | 压缩 seam（日志锁）+ 后端 + 超大工具输出修剪（head/middle/tail） | HanaAgent 的 L1/L3 防护 |
| `dsh-time-context` | 按 step 注入时间/时区/间隔读数 | HanaAgent 的 reminder |
| `dsh-repeat-tool-reminder` | 同一工具同参重复 3/5/8 次时提醒 | HanaAgent 的 reminder |
| `dsh-persona` | 人设前缀/后缀段落，可按 preset 作用域遮蔽 | HanaAgent 的人格补丁 |
| `dsh-llm-retry` | 持久 step 边界重试，`retryPolicy` 可选 normal/always | HanaAgent 无（它明确没有重试） |
| `dsh-goal` / `dsh-plan-mode` | 跨轮目标 / 计划态 | — |
| `dsh-session-reference` | `@label` 跨会话引用，有界只读快照 + 固定警告 | — |
| `dsh-token-meter` | 回放日志估算 token 压力，确定且不调模型 | HanaAgent 的 usage 观测 |
| `dsh-mcp-client` | MCP 服务器桥接（只桥工具） | 接 MemOS / 接任何工具服务器 |
| `dsh-spill` / `dsh-output-retention` | 超大文本落盘取回 / head-tail 保留窗口 | HanaAgent 的 L1 截断 |
| `dsh-hooks-claude-code` / `-codex` | 复用两家 `hooks.json`，可加对话上下文 | — |

**反过来说，DSH 里确实没有的**：任何 embedding / 向量库 / rerank / 知识库包（在 `@deepseek-ai` 全目录下 grep `embedding|vector|knowledge|rerank|semantic` 的 package 声明，**零命中**）。

---

## 三、三家逐个拆解

### 3.1 AstrBot —— 知识库与嵌入注入最成熟的一家

版本 4.28.1，AGPL-3.0，Python ≥3.12，FastAPI + Quart 单进程，Web 面板 Vue。

#### 3.1.1 嵌入 provider 抽象（最值得抄的部分）

`astrbot/core/provider/provider.py:324-343` 定义 `EmbeddingProvider`：`get_embedding` / `get_embeddings` / `get_dim`；`:419-438` 定义 `RerankProvider`。

**已实现 embedding 5 家**：`openai_embedding`、`ollama_embedding`、`gemini_embedding`、`dashscope_embedding`、`nvidia_embedding`。
**已实现 rerank 5 家**：`bailian_rerank`、`nvidia_rerank`、`tei_rerank`、`vllm_rerank`、`xinference_rerank`。

配置字段（`sources/openai_embedding_source.py:31-48,70-123`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `embedding_api_base` | `https://api.openai.com/v1` | **可填任意第三方**，`_normalize_api_base()` 会自动去尾斜杠、剥 `/embeddings`、无版本号补 `/v1` |
| `embedding_api_key` | — | |
| `embedding_model` | `text-embedding-3-small` | |
| `embedding_dimensions` | 可选 | |
| `embedding_dimensions_mode` | `auto` | `auto` 对非官方域**不下发** dimensions，正是为兼容第三方端点 |
| `timeout` | 20 | |

批处理 `get_embeddings_batch`（`:348-416`）默认 `batch_size=16, tasks_limit=3, max_retries=3`，`asyncio.Semaphore` 控并发 + `2**attempt` 指数退避；KB 入库侧实际传 `batch_size=32`（`kb_helper.py:224-226`）。写库前**强校验维度**，不符直接抛 `KnowledgeBaseUploadError`（`vec_db.py:175-187`）。

#### 3.1.2 检索管线

存储后端**只有 FAISS 一种**（`kb/` 下仅 `faiss_impl/`，Chroma/Milvus/pgvector 未找到）。三层落盘：`kb.db`（元数据，SQLModel）、每 KB 一个 `doc.db`（SQLite 块 + FTS5）、`index.faiss`。

参数默认值（`knowledge_base/models.py:37-42`）：

```python
chunk_size    = 512
chunk_overlap = 50
top_k_dense   = 50
top_k_sparse  = 50
top_m_final   = 5
```

全局另有 `kb_fusion_top_k=20`、`kb_final_top_k=5`、`kb_agentic_mode=False`（`config/default.py:324-327`）。

四步管线（`retrieval/manager.py:64-193`）：稠密 FAISS（`fetch_k = dense_k*2`，本层关 rerank）→ 稀疏 BM25 → 融合 → Rerank。

融合器 `rank_fusion.py:35-56` 有两个细节做得对：

- `dense_weight=0.9`，RRF 平滑 `k=60`；
- **稠密分数全局 min-max 归一化，BM25 分数按 KB 分组归一化**——注释写明「独立 FTS5 索引的 BM25 分数不可比」；
- RRF 分**仅用于同分 tie-break**（`:157-166`）；去重按 chunk 文本（`:198-200`）。

**没找到的**：相似度阈值（无任何 score cutoff，只有 `top_m_final` 截断）、token 预算控制。

#### 3.1.3 注入方式——本报告最值得移植的一条

`astr_main_agent.py:289-320` 的 `_apply_kb()`：

```python
req.extra_user_content_parts.append(
    TextPart(text=f"[Related Knowledge Base Results]:\n{kb_result}").mark_as_temp()
)
```

三个要点：

1. **不是 system prompt，不是独立消息**，而是「用户消息之后的附加内容块」；拼装顺序见 `provider/entities.py:202-217`（先原始 prompt，再依次追加 extra parts）。
2. `mark_as_temp()` 置 `_no_save=True`（`agent/message.py:68-71`）——**只发给 provider，不写入对话历史**。这是「每轮自动注入」能长期跑而不膨胀的关键。
3. 触发模式由**一个全局布尔** `kb_agentic_mode` 切换：`False`（默认）每轮自动注入，query 取 `req.prompt`；`True` 则把 `astr_kb_search` 工具塞进 `req.func_tool`，交给模型自主 function calling。

#### 3.1.4 隔离粒度与复刻障碍

两档隔离：全局 `kb_names` + 会话级 `kb_config`（`kb_ids` / `top_k`，`tools/knowledge_base_tools.py:49-56`）。`umo` 即「平台:会话」维度。**persona 与 KB 无任何关联字段**（grep 零命中）。

**复刻障碍**：AstrBot 的 KB 是**主程序内置模块**而非插件——`KBHelper` 直接调 `ProviderManager.get_provider_by_id`，`_apply_kb` 是主循环固定调用点。它的插件 API 面**没暴露**「注册 KB 后端」或「在用户消息后追加临时内容块」的钩子；插件能触达的最近似钩子是 `register_on_llm_request`。**讽刺的是，DSH 在这两点上比 AstrBot 更开放**。

> 另需注意：AstrBot 的 `provider/register.py` **只有注册、没有 unregister**（对比 `platform/register.py:66` 有反注册）——【推断】插件热卸载时 provider 注册会残留。

---

### 3.2 openhanako（HanaAgent）——优化做得最深的一家

v0.450.0，Apache-2.0，Electron + TypeScript，近 2900 个源文件，依赖 `@earendil-works/pi-*` 0.80.3（Pi SDK，上游 `badlogic/pi-mono`）。**不是 fork**——`scripts/patch-pi-sdk.cjs:20-23` 只做版本校验，`:1-14` 明确声明「不再写 node_modules」。

#### 3.2.1 它真正的核心：缓存保持型压缩

视频只讲了冰山一角（「前文冻结 + 小纸条」），代码里的完整论证在 `lib/extensions/compaction-guard-ext.ts:1-33`：Pi SDK 原生 summarizer 走**冷启动请求**，破坏 prompt cache；且窗口涨到百万级后固定 16384 reserve 让触发点贴到 98%，**实际压不动**。

三层防护：

| 层 | 机制 | 参数 |
|---|---|---|
| **L1** | `tool_result` hook：超阈值即 head+tail 截断，中间插省略标记，UTF-8 安全切片；**错误返回保留完整**便于 debug | `maxToolResultBytes = 32*1024`，头尾各 40% |
| **L2** | 运行时覆写 reserve 公式，替换 `settingsManager.getCompactionReserveTokens` | `max(16_384, ceil(10% × contextWindow))`；触发点落到 `min(90% 窗口, 窗口−16384)` |
| **L3** | `session_before_compact` hook：分别估算「完整缓存前缀请求」与「原生摘要请求」，都超阈值才硬截断；仅前者超限时 auto 模式交回原生；**都容得下则在原会话前缀后追加内部压缩指令**，让主模型在同一 cache 前缀上产 summary | `hardTruncateThreshold = 0.85` |

保前缀的四条纪律（这部分比三层防护更有价值）：

1. **system prompt 逐 session 冻结**——注释直说「后续记忆编译、技能变更只影响新对话，已有对话的 prompt 不变（保护 prefix cache）」（`core/session-coordinator.ts:2002-2009`）。
2. **provider 缓存亲和键**——`prompt_cache_key` / `session_id` / `x-client-request-id` / `x-session-affinity` / `x-affinity` 按 api 分派（`lib/llm/provider-cache-affinity.ts:24-48`），键取「不可变 Fork lineage key」而非会话 ID，截断 64 字符。
3. **压缩请求与实况请求共用同一 payload 归一化与同一 reasoning level**——理由：「两者共享 cache 前缀，归一化不同即破坏 cache」。
4. **契约哈希 + 漂移诊断**——`cache-prefix-contract.ts:57-87` 对 model/systemPrompt/tools 做 stable serialize 后 sha256；漂移时给出首个差异下标与 ±120 字符摘录（`:104-127`）。

其它默认参数（可当调参参照）：`keepRecentTokens = 20_000`、压缩请求估算 buffer `1024`、压缩输出上限 `max(512, floor(reserve×0.8))`、字符→token 估算 `ceil(len/4)`（刻意高估）。

#### 3.2.2 视频提到但代码里另有说法的一条

**「延迟加载工具」**：视频说「平时这些说明书直接不进上下文，只有在 agent 真正需要某个工具的时候，系统才会请求一张小纸条」。代码侧的对应物是 `core/tool-catalog.ts`（15KB）+ `core/tool-catalog-bridge.ts`（14KB）+ `core/tool-availability.ts`（5.7KB）。**子代理未能逐行验证「工具有效集按需扩缩」的确切实现**，此项按 C 级（视频自述）采信。

#### 3.2.3 顺手挖到的一条反例

`lib/memory/memory-search.ts:4` 的原话：

> `替代 v1 的 embedding KNN + 混合排序 + 链接展开。`
> `v2 用标签匹配 + 日期过滤 + FTS5 全文搜索兜底。`
> `标签由 LLM 在元事实拆分时生成，也由 LLM 在搜索时生成查询标签，两边的"语言习惯"天然接近，一致性有保障。`

也就是说：**HanaAgent 在 v2 主动放弃了 embedding**，改用「LLM 生成标签 + 标签匹配 + FTS5」。这直接影响用户问题里的「HanaAgent 的优化」该怎么抄——忘掉嵌入，抄它的 FTS5 + 标签方案反而更省。

同一个文件里还有一条会话作用域纪律值得抄（`:19-30`）：频道会话默认看不到其它频道的事实，跨频道检索必须显式传 `cross_channel: true`（注释标注 #1670 群聊记忆混淆）。

#### 3.2.4 扩展机制

Pi SDK Extension API（`PLUGINS.md:501-531`）：`extensions/*.js` 默认导出 `(pi) => void`，事件 `tool_call` / `tool_result` / `before_provider_request` / `context` / `before_agent_start` / `input` / `session_before_compact`。注册链在 `core/engine.ts:2814-2851`，顺序 core → framework → plugin，且注明天花板「**只影响此后创建的 session**」。

两级权限（`PLUGINS.md:139-188`）：restricted 只能 tools/skills/commands/agents/config/bus；`extensions/`、routes、providers、`registerTool`、lifecycle **必须 `"trust": "full-access"`** 且用户开总开关。

**与 DSH 的关系**：全仓库 grep 不到任何「DeepSeek Harness / DSH」提及；但 `core/provider-prompt-patches.ts` 是 **DeepSeek 专属**的（对 DeepSeek reasoning 模型追加「输出契约」system 段，强制把面向用户的答案写进最终 content），说明 DeepSeek 是一等公民。

---

### 3.3 QwenPaw —— 记忆系统做得最讲究的一家

> 标题更正：一开始按「定位不同、可借鉴度低」判断，读完源码后**推翻**——QwenPaw 的记忆注入形态（见 §3.3.3）是三家里面最值得抄的。

来自 agentscope-ai（AgentScope 26K+ 星、AgentScope 相关项目组成的生态），Python 3.11~<3.14，Apache-2.0，PyPI 可装，有官方安装脚本 / Docker / Windows+macOS 桌面测试版。

**形态**：Python + FastAPI + React Console + Tauri 桌面壳，**基于 AgentScope 2.0 全新重构**（`pyproject.toml:8` `agentscope[model-ollama]==2.0.7.post1`），并内嵌 **ReMe 0.4.1.11** 作为记忆引擎（`pyproject.toml:24-26`）。不是框架，是成品应用。

#### 3.3.1 记忆系统的形态——和你猜的不一样

| 层 | 存储 |
|---|---|
| 工作/短期上下文 | 内存 + 持久化会话，**Scroll 策略**（滚出窗口的轮次带索引、按需回放，**不摘要**） |
| 长期记忆（核心） | **Markdown 文件**：`MEMORY.md` + `<daily_dir>/YYYY-MM-DD.md` + `YYYY-MM-DD/{topic}.md` |
| 知识库/摘要 | `<digest_dir>/` |
| 原始对话日志 | 每 session 一个 JSONL，文件名 = `qpsid_sha256_<hash>` |

**没有向量数据库**——`sqlite-vec` / `chroma` / `milvus` / `pgvector` / `faiss` / `qdrant` 全部未使用。它用的是 ReMe 的 `LocalFileStore` + `keyword_index: bm25` + `embedding_store: local`（`reme_config.py:609-656`）。**记忆是 Markdown 文件，只有索引被向量化。**

写入由**框架自动抽取**，不需要模型主动调工具：周期性触发 `auto_memory_interval` 默认 **5**（每 5 个用户轮次一次，`config/config.py:949-956`），外加**压缩上下文时兜底 flush**（`middlewares.py:268-286`，防止压缩丢事实）。且有排除名单 `_MEMORY_SKIP_SOURCES = ("cron", "heartbeat", "portability_adaptation")`——自动化轮次不写记忆、不召回，避免自污染。

#### 3.3.2 嵌入模型的接入（用户点名的部分）

封装在 `agents/memory/embedding_model.py`（160 行，`create_embedding_model()` `:51-83`），经 AgentScope 的 credential→model 工厂构造。

**后端只有 5 个**（`config/config.py:787-793`）：`openai` / `dashscope` / `dashscope_multimodal` / `gemini` / `ollama`。**没有本地 sentence-transformers 后端。**

配置字段（`EmbeddingModelConfig`，`config/config.py:796-847`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `backend` | `"openai"` | 5 选 1 |
| `api_key` / `base_url` / `model_name` | `""` | |
| `dimensions` | **1024** | 严格校验 |
| `enable_cache` | `True` | 带 `max_cache_size=10000` |
| `use_dimensions` | `False` | 是否向 provider 传 `dimensions`，**仅 openai 生效** |
| `max_input_length` | 8192 | |
| `max_batch_size` | 10 | |

**能否自带任意 OpenAI 兼容端点：能，纯配置。** `backend="openai"` + 填 `api_key`/`base_url`/`model_name`/`dimensions` 即可，`base_url` 会被透传给凭据（`reme_config.py:729-733`）。

**但卡点有三处，都不是配置层的**：

1. 想加**新后端名**要改 4 处：`EmbeddingBackend` 的 `Literal` + `_CREDENTIAL_TYPES` + ReMe 侧 `_OPENAI_COMPAT_EMBEDDING_BACKENDS` + Console 下拉。
2. **维度必须严格匹配**：`test_embedding_model` 在 `actual_dimensions != config.dimensions` 时直接判失败。
3. **改嵌入 = 必须重建索引**：`embedding_vector_space_fingerprint`（含 backend/base_url/model_name/dimensions/use_dimensions，**刻意排除 api_key**）一变就置 `needs_reindex` 并拒绝服务，直到重建完成。换 key 不该触发重建这个字段划分很讲究。

#### 3.3.3 记忆如何注入——**本次调研最值得抄的一条**

**三路并行**：A. system prompt 静态指引｜B. 自动召回注入｜C. 模型主动调 `memory_search` 工具。

**路线 B 是精华**（`middlewares.py:124-174` + `base_memory_manager.py:180-250`）：自动召回**不是**往 system prompt 堆料，而是**伪造一次 assistant 的 `memory_search` 工具调用 + 工具结果**，插在用户消息的下一条位置：

```python
# 造的是完整的三块结构
ThinkingBlock + ToolCallBlock(name="memory_search") + ToolResultBlock
AssistantMsg(name="memory_search")
```

好处有三层：① 模型把它当「自己刚查过的结果」，比 system prompt 段更易被引用；② 天然带 block id，可**在压缩前按 id 精确剥离**（`_messages_without_auto_memory_search`，压缩与 Scroll 两侧都调），不会永久污染历史；③ 时序上贴着用户消息。

配套的几条工程纪律：

- **按轮次缓存 + 换轮即清**（`:137-162`）：同一 user turn 内多次模型调用只检索一次，旧轮证据绝不渗进新轮。缓存键用 turn_marker。
- **查询只取最后一条 user 消息，截断到 50 字符**（`MAX_QUERY_CHARS = 50`）。
- **估算型 token 预算而非假装精确**：`int(len(text.encode("utf-8")) / divisor + 0.5)`，divisor 默认 4，并把 `"estimated": True` + `estimate_divisor` 一起写进 metadata，后续可审计可校准。
- **空结果即零注入**：明确哨兵字符串 `"No relevant memories found."`，命中就不插消息。
- **取数是 diff 而非全量**：`msgs[context_len:]`，只保留含 tool_call/tool_result 的块，避免把后端返回的整段历史误插。

#### 3.3.4 检索与 DSH 的对照

检索是**向量 + BM25 混合、RRF 融合**（`reme_config.py:130-164`：`vector_weight=0.7`、`candidate_multiplier=3.0`、`expand_links=True`、`limit` 默认 5、`min_score` 默认 0.0）。可选 reranker 默认关，启用后过采样 `max_results × 3` 再重排。

**与 DSH 的对接线索（重要）**：全仓检索 `dsh|DSH_|deepseek-harness` **只命中一处**，且是**设计对齐而非代码集成**——`plugins/apps/qwenpaw-creator/backend/services/file_agent_runtime/notifications.py:6-8` 的注释写着：

> Two delivery primitives, aligned with the Codex subagent-notification and **DeepSeek-Harness inject/steer models**

即 QwenPaw 借鉴了 DSH 的 inject/steer 语义来设计自己的 runtime→agent 通知总线。**没有 QwenPaw↔DSH 的代码级适配器。**

**它有三套正交的扩展机制**（决定复刻难度）：Middleware（AgentScope `MiddlewareBase`，包裹单个 Agent 回复循环，钩子 `on_system_prompt` / `on_model_call` / `on_reply` / `on_compress_context`）｜Runtime Hook（8 个 phase，包裹一次 `Runtime.run()`）｜LifecycleHook。

**关键含义**【推断】：**QwenPaw 的记忆注入完全不依赖「专用记忆钩子」**，只用了两个通用切点——改 system prompt、改每次调用的消息数组。DSH 只要能在插件层拿到等价的两个切点，记忆注入就能 1:1 平移，**不需要 DSH 提供记忆原语**。而这两个切点 DSH 都有（见 §2.3）。

> 旁证（B 级）：用户给的第二期视频评论区里，有人给出与本次源码调研一致的评价——「提示词、上下文管理还欠缺一点，尤其**提示词膨胀**」（BV1QwJu6hEoE 评论，作者「彼时路人甲」）。这与 QwenPaw 的优势排序吻合：它的亮点在**渠道接入 + 安全边界 + 多 agent 协作**，不在上下文工程。

---

## 四、可行性矩阵

图例：✅ 现成 / 🟡 插件层可做 / 🔴 需要核心改动或代价高 / ➖ 不适用

### 4.1 AstrBot 系（知识库与嵌入）

| 能力 | DSH 现状 | 插件层可行性 | 需要的 hook / API | 代价与坑 |
|---|---|---|---|---|
| 嵌入 provider 抽象 | 无任何 embedding 包 | 🟡 | 插件自建抽象。**不要**硬塞 `ctx.llm.registerAdapter`（那是**文本补全**适配器，强行塞会让流式路径和计费口径打架，且官方 README 明确「适配器把 schema 作为独立 wire 字段传输」）；用 `ctx.storageDomain` 存配置、`ctx.credentials` 存密钥、直接 HTTP 调 embedding 端点 | 要自己写 OpenAI 兼容客户端的 base_url 归一化（照抄 AstrBot `_normalize_api_base()` 的四种情况） |
| 向量存储 + 相似检索 | 无 | 🟡 | 参考 `dsh-rag-kb`：JSON/SQLite 持久化 + 余弦相似度；或复用 `dsh-storage-domain` 做 schema 校验的键值域 | 内存内暴力检索只适合小库；上万 chunk 要上索引 |
| **每轮自动注入检索结果** | `systemPrompt.context()` 已具备 | ✅ | `ctx.systemPrompt.context({ name, order?, text })` | 语义差一档：AstrBot 是**只发本次请求、不进历史**；DSH 快照**会进历史**，靠「变了才追加」限流。**要严格复刻 `mark_as_temp` 就得自己造一次性消息，不划算** |
| 模型自主检索（agentic 模式） | 工具系统现成 | ✅ | `ctx.tools.register(defineTool({...}))`，做成 `kb_search` 工具 | 零难点。`dsh-rag-kb` 就是这么做的（`kb_search`/`kb_index`/`kb_status`） |
| 双路（稠密 + 稀疏 BM25）融合 | **FTS5 已有** | 🟡 | 复用 `dsh-session-query-sqlite` 的 FTS5 做稀疏路，嵌入选 稠密路，融合照抄 `rank_fusion.py` | 分数归一化是真实坑：BM25 跨库不可比，要按库内归一化 |
| Rerank | 无 | 🟡 | 同 embedding，插件自己调 rerank 端点 | 注意 AstrBot 自己也只取**第一个**可用 rerank provider，跨 KB 共用 |
| 相似度阈值 | 无（AstrBot 也没有） | 🟡 | 自己加 | 这是 AstrBot 的缺口不是优势，别照抄 |
| token 预算控制 | `dsh-token-meter` 可估算 | 🟡 | 用 `dsh-token-meter` 的 `contextPressure` 做注入前的预算判断 | AstrBot 在这一项上是空白（「未找到」），DSH 反而更强 |
| 多 KB / 会话级隔离 | preset 作用域 + 会话存储 | 🟡 | 按 agent preset 隔离最自然（`dsh-persona` 的 scope 遮蔽是现成范式） | AstrBot 只有全局 + 会话两档，**无 persona 级**；DSH 的 preset 作用域更细 |
| 网页端管理面板 | 插槽系统完整 | 🟡 | `dsh.client` + `ctx.slots.register()`；插槽树已有 `settings.plugins.tab` / `main.conversation` | `dsh-rag-kb` 已经把「左下角可拖拽悬浮面板」跑通了，照它做即可 |

### 4.2 QwenPaw 系（记忆 + 嵌入）

| 能力 | DSH 现状 | 插件层可行性 | 需要的 hook / API | 代价与坑 |
|---|---|---|---|---|
| 任意 OpenAI 兼容 embedding 端点 | 无 | 🟡 | 插件自建（同 §4.1 第一行） | **QwenPaw 在这里反而更笨**：它的 `backend` 是 `Literal` 白名单，加新后端名要改 4 处代码；DSH 插件从零写没有历史包袱【推断】 |
| **嵌入配置指纹 + 强制重建索引** | 无 | 🟡 | 插件自持 fingerprint（backend/base_url/model/dimensions）→ 变更即标 `needs_reindex` 并拒服务，留 `pending_reindex_embedding_config` 供撤销 | **直接可抄**（`embedding_model.py:150-159`）。注意它的指纹**刻意排除 api_key**——换 key 不该触发重建，这个划分是对的 |
| 测试-暂存-应用三段式热更新 | 无 | 🟡 | 插件暴露 test / apply 两个动作 + 带指纹校验的应用 | 失败可回滚、不用重启（`reme_embedding.py:50-70`） |
| **记忆注入伪装成工具调用消息** | 无，但 `agent/pre-step` 可替换进入消息 | 🟡 | `agent/pre-step` waterfall 返回决策 `{ kind: 'enter', messages }` | **最值得抄的一条**（见 §3.3.3），但 DSH 有硬约束：**模型可见即已记录**，抵达模型的一切必须能从日志重建。所以要写成带来源的正式消息，不能凭空捏造 assistant 块——**形态要改，思想可留** |
| 按轮次缓存召回 + 换轮即清 | 无 | 🟡 | 插件自持，按 turn id 做键 | 便宜且直接，无框架依赖 |
| 估算型 token 预算（显式标 `estimated`） | `dsh-token-meter` 回放日志估算，**比它更准** | ✅ | 直接用 `ctx.tokenMeter` 的 `contextPressure` | DSH 这一项显著强于 QwenPaw 的 `len/4` |
| 空结果零注入 | 无 | 🟡 | 插件判断 | 一行代码，省 token |
| 通用内存 K/V + 文本搜索 | **比它强**：内存 store（`ctx.sessions`）+ **SQLite FTS5** | ✅ | `ctx.sessions` + `dsh-session-query-sqlite` | 见 §3.2.3 与 §4.4 的路径选择与 §5.3 |
| 上下文压缩时兜底 flush | `dsh-compaction` seam 完整 | 🟡 | 在 `compaction/start` 前挂 listener 做 flush | 直接，比 QwenPaw 的 middleware 钩子更明确 |
| 排除自动化来源（cron/heartbeat 不写记忆） | `dsh-schedule` 存在 | 🟡 | 按消息 `source` 过滤 | QwenPaw 这条**值得抄**：自动化轮次不写记忆、不召回，避免自污染 |

### 4.3 HanaAgent 系（优化）

| 能力 | DSH 现状 | 插件层可行性 | 需要的 hook / API | 代价与坑 |
|---|---|---|---|---|
| **「小纸条」环境变更通知** | **内核本来就是** | ✅ | 无需做 | `RuntimeContextProjection.project()` 的差异化快照已实现同一语义，`dsh-time-context` / `dsh-repeat-tool-reminder` 是现成范例 |
| L1 工具输出 head+tail 截断 | `dsh-compaction-tool-result-pruner` **已有**，且是 head+省略标记+tail | ✅ | 现成；或 `dsh-output-retention` 的 `TextRetainer` | 阈值可调。DSH 版本**不发起模型调用**，比 HanaAgent 的 L1 更省 |
| 动态 reserve 公式 | `dsh-compaction-basic` 用 token meter 判压，**未见 HanaAgent 式公式** | 🟡 | 压缩触发条件挂在 `dsh-compaction` seam 上；预备保留量需要自己的后端 | 要换压缩后端（写明实现 `CompactionResult`），比调参重 |
| **保前缀压缩**（压缩请求复用同一前缀） | 压缩 seam 完整，**但后端行为需自写** | 🟡→🔴 | `compaction/start` / `summary` / `end` 事件 + 单次表层替换；压缩请求走 `llm/stream` waterfall 自造 | **真正的难点**：DSH 里 system prompt 是 surface 节点、`deriveMessages()` 从日志派生，**插件对「压缩请求的前缀」控制力有限**；HanaAgent 是直接改 SDK 的 payload 归一化。要做到它的程度，可能需要核心暴露压缩前置 seam【推断】 |
| 契约哈希 + 漂移诊断 | 无 | ✅ | 纯 hashing，无依赖。注册为 `agent/request` 的观察 listener 或独立工具 | **性价比最高的一条**，建议第一个做 |
| 缓存命中率 / 成本观测 | **有字段，缺读取**：`TokenUsage` 含 `cacheReadTokens` / `cacheWriteTokens`；`dsh-token-meter` 有 token 与 `contextPressure`，未见命中率与成本 | ✅ | `llm/stream` 的 finish chunk（含 usage） | **本项已实测确认可行**，实现见 §5.1。DeepSeek 适配器把 `prompt_cache_hit_tokens` 映射成 `cacheReadTokens`，且**已按「不相交」口径减掉**，口径可直接用 |
| system prompt 逐 session 冻结 | **部分已具备**（动态上下文只在变化时追加） | 🟡 | 若要「新记忆只影响新会话」，插件需自持一份 snapshot 并在会话内不更新 | 与 `dsh-agent-instructions` 的行为需协调（它会在发现新嵌套文件时让变更可见） |
| provider 缓存亲和键 | 🔴 **不可行（已实测排除）** | 🔴 | — | `LlmCallConfig` 真实定义只有 6 个字段：`provider` / `model` / `reasoningEffort?` / `temperature?` / `maxTokens?` / `stop?`——**没有 headers**。唯一的 header 机制是 `attributionHeaders()`（当前只产 `user-agent`）。要注入 `prompt_cache_key` 一类亲和键，只能**写新的 LLM 适配器**，属核心级改动，不是插件层能做的 |
| usage 账本 / costRates | `dsh-token-meter` 部分覆盖 | 🟡 | `ctx.storageDomain` 落账本 | 直接，但要确认 usage 字段形状 |
| **延迟加载工具说明书** | 🔴 **不原生**（`SECTION_ORDERS` 里每个工具一段，全量下发） | 🟡 | `ctx.systemPrompt.tools()` 返回 **限制后的可见集合** + 提供「获取工具说明书」元工具，按需把工具加进可见集 | 代价有两处：① 每次扩集**改变工具 schema → 令缓存前缀从此处失效**（HanaAgent 也躲不掉，它靠「小纸条」把变更点后移）；② 要处理「模型请求了未加载的工具」的失败路径 |
| DeepSeek 专属输出契约补丁 | 未检出 | ✅ | `ctx.systemPrompt.section()` 加一段，或 `agent/request` 里按 provider 判断 | 纯 prompt 层，零风险，可立即做 |
| MCP / 子代理 / Agent Skills | **全部已有** | ✅ | 现成 | 不需要复刻 |

> **一条容易混淆的点**（也是视频观众问到的）：**「延迟加载工具」≠「skill 按需加载」**。
> - Skill：DSH 的 `dsh-skill` + `dsh-tool-skill` **已经是按需加载正文**——列摘要，模型要用才读全文。
> - 工具：**不是**。工具 schema 从第一轮就在系统提示词里，每轮都付 token。
> 所以 HanaAgent 那条优化在 DSH 上仍是空白，需要工具注册表的可见集控制。

### 4.4 如果只做一件事，做哪个

按「改动半径 ÷ 收益」排序【推断】：

1. **缓存观测与漂移诊断**（半天）：读 `llm/stream` 的 usage（含 `cacheReadTokens`），对 provider+model+tools 做 stable serialize + sha256，漂移时打印首个差异下标与摘录。**几乎零风险，且已实测确认字段存在**——立刻能解释「为什么这次没命中缓存」。设计见 §5.1。
2. **知识库插件（工具形态）**（1–3 天）：`kb_search` / `kb_index` / `kb_status` 三工具 + Ollama 嵌入 + 余弦检索。**已有 `dsh-rag-kb` 可作蓝本或直接复用**。
3. **知识库插件（自动注入形态）**（+1 天）：加 `ctx.systemPrompt.context()` provider，靠差异化快照限流。设计见 §5.2。
4. **记忆注入器**（3–5 天）：**抄 QwenPaw 的「伪装成检索结果」思想**，但落成 DSH 允许的形态（带来源的正式消息）；检索层**用 `dsh-session-query-sqlite` 的 FTS5**，配 LLM 生成标签——即 HanaAgent v2 的方案。**不要上嵌入**：HanaAgent 已经试过一次并主动退回来了。设计见 §5.3。
5. **延迟加载工具**（一周+）：`systemPrompt.tools()` 可见集控制 + 元工具，注意缓存代价。设计见 §5.4。

> 关于第 4 条的路径选择，三家的做法摆在一起看很清楚：
>
> | 做法 | 谁在用 | 判定 |
> |---|---|---|
> | 向量 + BM25 + RRF | AstrBot、QwenPaw | 最成熟，但要维护嵌入 provider + 索引重建 |
> | **标签匹配 + FTS5** | **HanaAgent v2（主动放弃向量）** | **最省，且 DSH 已有 FTS5** |

**明确排除的一项**：provider 缓存亲和键（`prompt_cache_key` 一类）**不在插件层做**——`LlmCallConfig` 无 header 字段，要做得写新的 LLM 适配器。见 §4.3 与 §7。

---

## 五、实现设计（四个插件的具体接法）

这一节把前三节的判定落成可开工的骨架。**照这个写就能跑**；每一处引用都是本机实测或仓库源码。

### 5.1 插件一：缓存观测与漂移诊断（建议第一个做）

**目标**：回答两个问题——「这次请求有没有命中缓存」「为什么没命中」。

**所需的 DSH 事实（全部已实测）**：

```ts
// @deepseek-ai/dsh-llm/lib/typert.host.js —— TokenUsage 真实定义
export interface TokenUsage {
  inputTokens: number;          // 注意：DeepSeek 适配器已把 cache 读部分减掉
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;     // ← 命中量在这里
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

// @deepseek-ai/dsh-llm/lib/types/call-config.js —— LlmCallConfig 真实定义（只有 6 个字段）
export interface LlmCallConfig {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffortId;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}
```

**接入点**：`llm/stream` 是 **waterfall**，包住每一次流式模型调用；用 `next()` 委托给下游拿到流，边透传边观察。请求本身到达时**已深冻结（改它会抛）**，只读。

```ts
export const name = 'cache-observer'
export const inject = ['llm']

export function apply(ctx) {
  ctx.on('llm/stream', async (options, next) => {
    const stream = await next()                 // 委托下游，不改写请求
    return observe(stream, fingerprint(options)) // 透传 + 旁路统计
  })
}

// 契约哈希：照抄 HanaAgent lib/llm/cache-prefix-contract.ts 的做法
function fingerprint(options) {
  const stable = JSON.stringify({
    provider: options.provider, model: options.model,
    reasoningEffort: options.reasoningEffort,
    tools: options.tools?.map(t => t.name).sort(),  // 只取名字，避免参数噪音
  })
  return sha256(stable).slice(0, 16)
}
```

拿到 usage 后算命中率——**沿用 DeepSeek 官方口径**，即 `cacheReadTokens / (cacheReadTokens + inputTokens)`：

```ts
function hitRatio(u) {
  const denom = (u.cacheReadTokens ?? 0) + u.inputTokens
  return denom === 0 ? null : (u.cacheReadTokens ?? 0) / denom
}
```

**为什么这一条值得先做**：

- 零风险——纯观察，不改变任何请求内容；
- 立刻有用——把「为什么这次没命中缓存」从玄学变成一串哈希；
- 有现成的对标实现——HanaAgent 的 `cache-prefix-contract.ts` 就干这个，漂移时输出首个差异下标与 ±120 字符摘录，可直接照搬思路。

### 5.2 插件二：知识库 + 嵌入注入

**形态选择**：`dsh-rag-kb` 已经证明**工具形态**可行且简单。若要做**自动注入形态**，接法如下。

**第一步——嵌入 provider（插件自建，不要塞进 `ctx.llm`）**：

`ctx.llm.registerAdapter` 是**文本补全**适配器注册（`stream(): AsyncIterable<StreamChunk>`），强行用它跑 embedding 会让流式路径和计费口径打架。正确做法是在插件内自建一个极薄客户端，照抄 AstrBot 的 `_normalize_api_base()` 四种归一化：

```ts
function normalizeApiBase(raw: string): string {
  let s = raw.trim().replace(/\/+$/, '')     // 去尾斜杠
  s = s.replace(/\/embeddings$/, '')         // 剥 /embeddings
  if (!/\/v\d+$/.test(s)) s += '/v1'         // 无版本号则补
  return s
}
```

配置走 `Config` schema（`Schema.string()` / `Schema.number().default()`），密钥走 `ctx.credentials` 或环境变量，**不写进配置明文**。

**第二步——检索**：复用 DSH 已有的 FTS5 做稀疏路，嵌入选稠密路。融合照抄 AstrBot `rank_fusion.py:35-56` 的两个关键点：

- `dense_weight = 0.9`，RRF 平滑 `k = 60`；
- **稠密分数全局 min-max 归一化，BM25 分数按库内归一化**（独立 FTS5 索引的 BM25 跨库不可比）；
- RRF 分仅作同分 tie-break。

**第三步——注入**：走 `ctx.systemPrompt.context()`，靠 §2.2 的差异化快照限流。

```ts
ctx.effect(() => ctx.systemPrompt.context({
  name: 'kb/retrieved',
  order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION') + 1,
  text: (assembleCtx) => {
    const q = latestUserText(assembleCtx)
    if (!q) return ''                       // 空则不注入 → 不产生快照
    const hits = search(q, { topK: 5 })
    if (hits.length === 0) return ''        // 空结果零注入，省 token
    return renderKnowledge(hits)            // 照抄 AstrBot kb_mgr.py:352-361 的格式
  },
}))
```

**要如实承认的语义差**：AstrBot 用 `mark_as_temp()` 让检索结果**只发本次请求、不进历史**；DSH 的快照**会进历史**，靠「内容变了才追加」限流。**这个差异不致命**（快照是追加式的，前缀仍稳定），但多轮之后历史上会累积若干份检索快照。若要严格控制，就在 provider 里把渲染结果做成对「同一 query 恒等」，让重复提问不产生新快照。

### 5.3 插件三：记忆召回注入

**接法**：`agent/pre-step` 是 waterfall，返回决策 `{ kind: 'enter', messages }`——可以把检索出来的内容**追加**到本轮进入的 messages 里。

```ts
ctx.on('agent/pre-step', async (payload, next) => {
  const decision = await next()
  if (decision.kind !== 'enter') return decision     // 别拦人家自己的拒绝决策
  const recalled = recall(payload.messages)          // 按 turn id 缓存，换轮即清
  if (recalled.length === 0) return decision         // 空结果零注入
  return { ...decision, messages: [...decision.messages, ...recalled] }
})
```

**必须改的形态**：QwenPaw 伪造的是 `AssistantMsg` 里塞 `tool_call` + `tool_result` 块，**DSH 搬不过来**——DSH 有硬约束「**模型可见即已记录**，抵达模型请求的一切都必须能从日志重建，并有运行时不变量断言这一点」。凭空捏造一个 assistant 工具调用会破坏可重建性。所以：

- **思想可留**（把召回伪装成「刚发生的一次检索」，比 system prompt 堆料更易被引用）；
- **形态要改**——落成**带来源（source）的正式消息**，让它能被正常记录与回放。

**其余可直接抄的纪律**（都出自 QwenPaw，代码位置见 §3.3.3）：

| 纪律 | 为什么 |
|---|---|
| 按 turn id 缓存召回，换轮即清 | 同一轮多次模型调用只检索一次；旧轮证据不渗进新轮 |
| 查询取最后一条 user 消息，截断到 50 字符 | 省 token，且够用 |
| 空结果零注入（不返回任何消息） | 省 token；也是「不产生快照」的前提 |
| 排除自动化来源（cron / heartbeat 不写记忆、不召回） | 避免自污染 |
| token 预算用 `ctx.tokenMeter` 而非 `len/4` | DSH 的回放式估算是确定的，比 QwenPaw 的字符估算准 |

**检索层选型建议**：**别上嵌入**。用 `dsh-session-query-sqlite` 的 FTS5（DSH 已有）+ LLM 生成标签，也就是 HanaAgent v2 在踩过 v1 嵌入方案之后选的路。

### 5.4 插件四：工具说明书延迟加载

**机制**：`ctx.systemPrompt.tools(provider)` 注册一个工具 schema 提供方，**每次组装时求值**，返回**限制后的可见集合**；被滤掉的工具其 schema 不进系统提示词。

```ts
export const inject = ['systemPrompt', 'tools']

export function apply(ctx, config) {
  const loaded = new Set<string>()     // 本会话已加载的工具名

  ctx.effect(() => ctx.systemPrompt.tools(() => {
    const all = ctx.tools.list()                       // 全量
    const visible = all.filter(t =>
      config.alwaysVisible.includes(t.name) || loaded.has(t.name))
    return {
      tools: visible,                                  // ← 只发这些 schema 给模型
      knownNames: new Set(all.map(t => t.name)),       // orderTools 用的限制前全集
    }
  }))

  // 元工具：模型用它取说明书，取完该工具对后续请求可见
  ctx.tools.register(defineTool({
    name: 'load_tool',
    description: '取回某个工具的使用说明，之后即可调用它。',
    parameters: { name: { type: 'string', required: true } },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args) {
      const tool = ctx.tools.get(args.name)
      if (!tool) throw new Error(`no such tool: ${args.name}`)
      loaded.add(args.name)
      return { name: tool.name, description: tool.description, parameters: tool.parameters }
    },
  }))
}
```

除 `load_tool` 外只留极少数 `alwaysVisible`（bash / read / edit 这类高频工具），其余全部延迟。

**必须同时接受的两项代价**：

1. **扩集会让缓存前缀从该处失效**。工具 schema 是系统提示词组装的一部分，改可见集 = 改提示词 = 前缀变化。HanaAgent 也躲不掉，它靠「小纸条」把变更点后移换来的收益。**所以扩集要有节制**——别让模型每步都 `load_tool`。
2. **要处理「模型请求了未加载的工具」的失败路径**：模型可能凭印象直接调一个它还没加载的工具。`load_tool` 的报错文案要明确告诉它「先调 load_tool 取说明书」。

`ctx.systemPrompt.getSectionOrder()` 的 `TOOL_*` 名字表（见 §2.1）可以拿来做 `alwaysVisible` 的默认值——那批是 DSH 自己认定的高频工具。

**注意**：这条与 **skill 的按需加载不是一回事**。`dsh-skill` + `dsh-tool-skill` 已经是「列摘要、要用才读全文」；这里延迟的是**工具 schema 本身**，两码事（视频评论区正好有人问到这一条）。

---

## 六、社区已有的同源实现（重要）

检索命中 **`dsh-rag-kb`**（DeepSeek Harness 官方仓库 Discussion #552，作者 AlowEnsoul，MIT）：

**它证明的正是本报告的核心结论——DSH 插件层可以做嵌入检索知识库。**

| 它的组成 | 对应 DSH 机制 |
|---|---|
| 左下角可拖拽悬浮面板（记住位置） | 客户端插件 `dsh.client` + 插槽 |
| 原生 Windows 文件选择器，支持 `.txt/.md/.json/.py/.doc/.docx` | 宿主侧 + 客户端 |
| **语义检索：Ollama embeddings + 余弦相似度** | 插件内自建嵌入客户端 |
| 多知识库、独立索引 | 插件自持存储 |
| 可配置：嵌入服务 URL、模型、chunk size | `Config` schema（`Schema.string()` 等） |
| agent 工具 `kb_search` / `kb_index` / `kb_status` + `/kb` HTTP 路由 | `ctx.tools.register()` + 自建路由 |
| 中文路径安全（路径走 base64） | 工程细节 |
| JSON 持久化 `dsh-kb-store.json` | 插件自持或 `ctx.storageDomain` |

它的流水线（原文）：

```text
browser (ui-kb) ──fetch /kb──▶ host (rag-kb) ──curl──▶ Ollama /api/embed
        ▲                              │
        │                    chunking + cosine search
        │                              │
        └── JSON persistence ◀── dsh-kb-store.json
```

**注意它选的路线**：**工具形态**（模型主动调 `kb_search`），不是每轮自动注入。理由是自动注入要处理历史累积与 token 预算——这正好印证了 §4.1 里那格「语义差一档」的判断，对应的自动注入设计见 §5.2。

另外命中一条 HanaAgent 与 DSH 的桥接：**`dsh-hanako`（DSHana）**，作者 Nyasers（GitHub `Nyasers/dsh-hanako`），由 HanaAgent 作者本人在视频置顶评论里提及。若目标是「把 HanaAgent 的能力带进 DSH」，这个插件是最直接的既有工件对照。

---

## 七、未解决 / 待核项

诚实起见，以下没查清：

1. ~~**HanaAgent「延迟加载工具」的确切实现**~~ → **已关掉（2026-09-23）**。源码逐行核过（本机浅克隆 v0.450.0 / `1d3ef308`），机制见 §七·补。**并且确认一件更要紧的事**：reminder 与「延迟加载工具」是**两个特性**，不是一件事 —— 前者信封 `[hana_reminder]`（正文硬上限 300 字符），后者走 `[hana_reference]`（自己的预算）。视频里作者说的「系统才请求一张小纸条」是营销口径，代码里是**目录 + 三件套 + 尾部投递**。
2. **`agent/inject()` 的生成签名**——`docs/04-服务与运行时.md` §9 自己就把它列为「没查清的部分」；本报告是从 `dsh-agent-loop/lib/index.js:795` 的实现读出的，未见官方签名文档。
3. **ReMe `LocalFileStore` 的底层实现**——QwenPaw 只读本仓无法证实（`cli/doctor_checks.py:236-245` 有「SQLite < 3.35 可能破坏某些向量库」的警告，暗示底层是 SQLite，但属【推断】）。
4. **`dsh-rag-kb` 的实际可用性**——只读了它的 Discussion 自述（README 声称的安装五步），未 clone 验证。
5. **压缩时「前缀复用」的确切可达程度**——§4.3 判定它需要核心暴露压缩前置 seam，但未实测验证；这一格的结论是【推断】。

**本轮已关掉的两项**（原先列在此处）：

- ~~DSH 侧 DeepSeek usage 是否含 cache 字段~~ → **已实测**：`TokenUsage` 含 `cacheReadTokens` / `cacheWriteTokens`，DeepSeek 适配器已映射。见 §4.3 与 §5.1。
- ~~`LlmCallConfig` 是否开放自定义 header~~ → **已实测**：只有 6 个字段，无 header。结论从「待核」变为「🔴 插件层不可行」。见 §4.3。

---

## 七·补、工具说明书延迟加载 —— 逐轮改工具定义到底能不能做（2026-09-23 复核）

> §5.4 那一版设计草案写在一个**没被验证过的前提**上。这一节是补上证据之后的复核，
> 其中一处结论**要翻过来**：不是「必须走尾部追加、不能碰 `tools` 数组」，
> 而是「**能碰 `tools`，但每轮都碰才是代价**」。

### 补.1 钩子是 `system-prompt/assemble`，`tools/*` 里没有

`tools/*` 一共六个事件（`dsh-tool-cordis/lib/index.js:5551-5618`）—— `tools/change`、
`tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/result`、
`tools/ptc-dispatch-log` —— **全部是执行期的**。组装期一个都没有。

绕过去的是系统提示词的 waterfall（`dsh-tool-cordis/lib/index.js:5529-5531`）：

```
'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly,
                         context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>
```

`PromptAssembly` 里就有 `tools: ToolSchema[]`，**可变数组，返回替换值即生效**
（`dsh-system-prompt/lib/index.js:351`），并且真的通向模型
（`dsh-agent-loop/lib/index.js:1030` → `buildRequest(..., assembly.tools, ...)` → 请求头）。

三条让它安全的事实，都读到了原文：

| 事实 | 位置 | 为什么重要 |
|---|---|---|
| 工具清单**每个 step 重算** | `dsh-agent-loop/lib/index.js:890`（`preStep` 内）、`:937` | 「按轮次改」不是外挂，是本来就走的路 |
| `assemble()` 对每条 schema 做 `structuredClone` | `dsh-system-prompt/lib/index.js:322-326` | 改副本**不会污染注册表** |
| 自带的唯一不变量只校验 `name` | `dsh-system-prompt/lib/invariant.js:25` | `description` / `parameters` **根本不校验** |

**缺的那一环是语义上的，不是机制上的**：DSH 把工具定义当**组装期产物**（`assembly.tools`），
没把它当**可拦截的执行期事件**。逐轮粒度的 `ctx.tools.restrict()` 也不存在 ——
`dsh-tools/lib/index.js:2790-2805` 是 `effect` 注册，作用域内常驻直到 dispose，
且只能整条去掉工具，**不能只改 description**。

### 补.2 缓存：破，而且 DSH 自己会检测

`dsh-agent-loop/lib/index.js:910-917` 的 `toolsChanged()` 把本轮工具与上一条请求头**逐条
JSON 字符串比对**；为真则在 `:1019-1022` 把 `startsSeries` 置为 `true`，于是系统提示词
**节点 0 被原地重写**（`:266-284` 的 `SystemPromptProjection.project`）。

DSH 自己的 README 把代价说死了（`dsh-agent-loop/README.zh.md:160`，逐字）：

> schema 或组合变更则从第一个改变的请求 token 起使复用失效。

**所以「不能改写 `tools` 数组」这个说法不准确。准确的是：「不能让它每轮都不一样」。**
推论（本项目判断，非官方文档）：**常驻态恒定**（所有轮同一套短描述）时，
只有「取说明书」那一步破缓存，其余步全部命中。

另有两条排除项：
- `dsh-compaction-basic/README.zh.md:12` 明说压缩**帮不上忙**（「无法缩减系统提示词、工具或会话前缀」）。
- **DeepSeek 的 `tools` 字段参不参与前缀缓存 —— 官方 KV-cache 文档没说，标未核实。**
  要用 `prompt_cache_hit_tokens` 实测，别假设。

### 补.3 修正后的形状

```
system-prompt/assemble   → 把每个工具的 description 压成一行（恒定，不随轮变）
agent/pre-step           → 模型要某个工具时，把完整说明作为一条 message 追加到对话尾部
                           （PreStepDecision 的 messages 可整体替换；常见做法见
                            dsh-tool-cordis/lib/index.js:9494-9518）
tools/pre-execute        → 准入（本项目已有的那道门）
```

「先有目标才给工具」这一条**在既有实现里没有先例**，见补.5。

### 补.4 外部一手证据（八家，逐条带来源）

| 实现 | 做法 | 关键数字 / 原话 | 置信度 |
|---|---|---|---|
| Anthropic Tool Search Tool | `defer_loading: true`，命中后展开完整定义 | 55K → **8.7K（-85%）**；MCP 准确率 Opus 4 **49%→74%** | 高（官方工程博客） |
| OpenAI / Azure `tool_search` | 逐函数/namespace/server defer | **「模型仍能看到名字与描述，主要推迟的是参数 schema」**；工具**追加在上下文末尾**以保缓存 | 高（微软官方文档） |
| Claude Code SDK | 默认开，窗口 10% 触发，每次 ≤5 个 | **30-50 个工具以上选择准确率下降**；非一方 base_url 会**关掉** tool search | 高（官方文档） |
| Cursor | 不做 search，把工具描述同步成文件夹让 agent `rg` | MCP 场景总 token **-46.9%**（A/B） | 高（官方博客） |
| HanaAgent（openhanako v0.450.0） | 目录一行/工具 + `mcp_search_tools` / `mcp_describe_tool` / `mcp_call` | 清单走 `[hana_reference]` 尾部投递、**一次/会话**；装配**会话内不再变** | 高（本机克隆源码，file:line 见子报告） |
| NVIDIA NemoClaw | 三家 agent 各自的 bridge | **「Progressive disclosure changes model context, not authorization」** | 高（官方文档） |
| MCP 协议 | 只定义 `notifications/tools/list_changed` | 客户端**是否响应没有强制要求**，别依赖它自动同步 | 高（规范正文） |
| AWS Bedrock | cache checkpoint 顺序 | **`tools → system → messages` 链式**，改 `tools` 会连后面一起失效 | 高（官方文档） |

术语：`tool search tool` ｜ `deferred tool loading` / `defer_loading` ｜
`progressive tool disclosure` ｜ `dynamic context discovery`（Cursor）｜
`tool retrieval`（学术）｜ `MCP tax`（论文）。

### 补.5 三条会决定成败的告诫

1. **目标门不能把目录也摘掉。** 模型看不见工具时，唯一补救是它知道「有这么一类能力可以找」。
   要么给一份目录（HanaAgent 的做法），要么往系统提示里写一句「有哪些类别的工具可搜」
   （Anthropic 的做法）。**门要设在 describe / call 那一步**，即已有的 `tools/pre-execute`。
2. **可见性与授权要分开。** 上一行那句 NVIDIA 原话就是理由；HanaAgent 的 `mcp_call`
   也从不以自己的名义申请审批，而是先解析目标、出示**真实能力**。
3. **小工具集别做。** Claude Code 文档与 Anthropic 博客都说 <10 个工具载入全部更快。
   本插件目前工具数远低于阈值，**这件事现在做是负收益**。

### 补.6 这条结论怎么来的

两个后台子代理各跑一路：一路读 HanaAgent 源码 + 八家官方文档（外部证据），
一路读 DSH 安装字节里的 `dsh-agent-loop` / `dsh-system-prompt` / `dsh-tools`（本机机制）。
**本节的 file:line 全部来自实际读到的原文**，标「本项目判断」的是推断。
两边交叉一致的一点：**不要在轮次之间改变工具集** —— 与 §5.4 草案的方向一致，理由更硬了。

---

## 九、技能清单提示词能否懒加载（2026-09-23 实测复核）

**问的问题**：能不能把「技能清单相关提示词」从常驻改成懒注入，当 Agent 走到状态链的第二步
（技能分支）时再注入，选中之后才注入那份 skill 的正文 —— 以省 token。

**结论：不需要做，因为 DSH 层已经是这个样子；而真正费 token 的东西不是被问的那一处。**

### 九.1 被问的那一处有多大（实测）

| 内容 | 字符 | 位置 |
|---|---|---|
| `§1.1.6` 十七类清单表 + `§1.1.6.1` 框架子项 | **2,922** | `LuzzyPrompt/prompt/Luzzy.md` L247–285 |
| 整个 `§1.1`（硬门 / 回执 / 阅读规则 / 反假读 / 分诊 / 认知门 / 清单 / 解析 / 触发口径 / 阅读顺序） | **11,562** | L126–342 |

`§1.1.6` 表是**指向 roster skill 的索引**。把它移出提示词，就变成「要读 skill 才知道该读哪个
skill」—— `LuzzyPrompt/AGENTS.md` 第 14 与第 51 行、`prompt/Luzzy.md` §1.1 三处都明文禁止这种
下沉（规则只住提示词，skill 只装「怎么做」）。**收益约 1k token，代价是拆掉整套必读清单硬门。**

### 九.2 DSH 自己的技能目录：已经是懒加载，但很大

读 `@deepseek-ai/dsh-tool-skill/lib/index.js`（本机安装字节）：

- L168 / L203 两个 `ctx.on("agent/pre-step", …)` 监听器
- L217–235：按 **digest** 去重；目录没变就**不重发**，变了才发一份 `renderCatalogUpdate`
- L238–261 `renderCatalogMessage` / L262–284 `renderCatalogUpdate`：产出一条
  `createUserMessage({ source: { kind: 'skill-catalog' } })` —— 即**独立的 user message**
- L359–361 `catalogDescription`：`description` 按 `catalogDescriptionMaxLength` 截断
- L49：`Config = z.object({ catalogDescriptionMaxLength: z.number().default(500) })`

**所以「技能目录懒加载」这件事已经发生了。** 但它作为一条 **message 进会话前缀**，一旦发出，
之后每个请求都要重新携带 —— 目录越大，每轮都付。

`@deepseek-ai/dsh-skill-filesystem/lib/index.js` L31–33 / L77–78：`includeDefaultRoots` 默认
`true`，扫 `~/.agents/skills` **与** `~/.claude/skills` 两处。

### 九.3 实测体量（`tools/measure-skill-catalog.mjs`）

本机两处根目录共 **176 个不同 skill**（20 个撞到 500 字符上限）：

| `catalogDescriptionMaxLength` | 渲染后字符 | 估算 token |
|---|---|---|
| **500（当前默认）** | **~54,965** | **~18,300 – 32,300** |
| 200 | ~33,220 | ~11,100 – 19,500 |
| 120 | ~23,489 | ~7,800 – 13,800 |
| 80 | ~17,480 | ~5,800 – 10,300 |

**对照**：被问的 `§1.1.6` 表是 2,922 字符（~1.0k–1.7k token）。技能目录是它的 **约 19 倍**。

### 九.4 能做的事（按收益排序，全部未实施 —— 需用户裁决）

1. **调 `catalogDescriptionMaxLength`**：在预设的 `tool-skill` 行加 `config`。500 → 80 省下
   约 3.7 万字符 ≈ 1.2 万–2.2 万 token／轮。**代价**：描述变短后模型更可能挑错 skill
   （目录是它唯一的选型依据）。**这是一个判断，不是一个数字** —— 见 §九.5。
2. **收窄 skill 根**：`includeDefaultRoots: false` + 只指向真正要暴露的目录。本机 176 个
   skill 里绝大多数与 LuzzyMode 无关。
3. **`§1.1.6` 表不动**：理由见 §九.1。

### 九.5 一条必须说清的分界

「省 token」与「选得准」在这里是**同一根轴的两端**：目录是模型唯一能看见的选型依据，
把描述砍短就是在减少它的决策信息。HanaAgent 的 reminder 做法（用户提的参照物）
之所以可行，是因为它的技能面**小**；176 个 skill 是另一个量级。

所以本文**只给表，不给建议值** —— 该砍到多少，取决于「模型选错 skill」与「每轮多付两万
token」哪一边更痛，那是产品判断，不是实测能回答的。

---

## 十、三份 skill 副本的漂移（2026-09-23 实测）

`§1.1.7` 规定了「多副本不一致时以较新为准，并向用户提一句」—— 本次实测**真的存在不一致**：

| 副本 | 路径 | `luzzy-roster-design` 版本 | 时间 |
|---|---|---|---|
| 仓库 | `DSH Plugin/skills/` | **1.1.0** | 09-16 12:31 |
| harness | `~/.agents/skills/` | **1.0.0** | 09-16 11:58 |
| 上游 | `LuzzyPrompt/skills/` | **1.1.0** | 09-16 12:31 |

其余三个设计类 skill（react / vue / compose）三处逐字节相同。**只有 `luzzy-roster-design`
一份 stale**，且 harness 目录里那份是旧的。

**推论**：任何按 `§1.1.7` 顺序解析、命中第 2 步（harness 目录）的读取，拿到的都是 v1.0.0。
本次会话开头读的是**仓库副本**（第 1 步），所以未受影响 —— 但这是运气，不是机制。

**未实施**：是否把 harness 那份升到 1.1.0，需要用户裁决（那是用户机器的 skill 目录）。

### 十.1 人格提示词的实际来源（同时实测）

| 路径 | SHA256 | 字符 |
|---|---|---|
| `LuzzyPrompt/prompt/Luzzy.md` | `AADE287580DCFE49` | 58,562 |
| `~/.dsh/luzzy-preset/agents/luzzy.md`（活动人格） | `AADE287580DCFE49` | 58,562 |

**逐字节相同。** 即 `LuzzyPrompt` 已经是活动人格的**内容源**，两者之间缺的不是「合并」，
而是一条**引用关系**（现在靠手工同步，没有任何机制保证它们一致）。

---

## 八、来源台账

| 类别 | 来源 | 用途 |
|---|---|---|
| 一类 · 本机直读 | `C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\*` 的 `lib/index.js`、`lib/types/*.js`、`lib/typert.host.js` 与 `README.zh.md` | DSH 能力面的全部断言。`TokenUsage` 与 `LlmCallConfig` 的字段定义出自 `dsh-llm/lib/typert.host.js` 的 `declaration` 段，与源码等价 |
| 一类 · 工作区既有 | `docs/01`–`04`（DSH 插件模型、组装、注意事项、服务与运行时） | 插件写法、生命周期、seam 图 |
| 一类 · 官方仓库 | AstrBot 4.28.1 / HanaAgent 0.450.0 / QwenPaw（浅克隆，路径行号见正文） | 三家机制 |
| 一类 · 官方 Discussion | deepseek-harness discussions #552（`dsh-rag-kb`，MIT） | 同源可行性实证 |
| 二类 · 视频 | BV11q8J6CEZS、BV1QwJu6hEoE 的字幕与评论 | 产品意图、用户反馈 |
| 二类 · 检索 | AnySearch 命中的 OpenClaw memory search / MemOS 文档片段 | 交叉参照，**未单独采信** |

**时效提醒**：DSH 处于 developer preview，官方声明「THERE WILL BE COMPATIBILITY-BREAKING CHANGES」。本文结论对应 `0.1.5-rc.1`，升级后请用 `dsh --profile desktop --dump-config` 重新核对，并重读 `@deepseek-ai/dsh-system-prompt` 的 `SECTION_ORDERS`。

---

*本报告由本机实证、三仓库源码精读、B 站字幕与评论提取交叉整理而成。标 `【推断】` 处为作者判断，非事实。*
