# LuzzyMode

一个 DSH 智能体预设：**系统提示词不在预设文件里，由 LuzzyPage 的「预设」子页托管。**

改提示词、切换激活的智能体，都在**下一次请求**生效——不用重启、不用重开会话。

---

## 这个目录是什么

```
luzzy-preset/
├── preset.yml             # 预设元数据：显示名、描述、在选项器里的排序
├── agent.cordis.yml       # 组装：随包 standard 的全部行，只换了 identity 那一段
└── lib/
    ├── persona.mjs        # 那个「换掉的一段」——把提示词接进来
    ├── preset-store.mjs   # 读取磁盘上的提示词（与 luzzy-page 的副本逐字节相同）
    └── default-prompt.md  # 兜底：存储和默认提示词都读不到时用它
```

**它自成一体**：没有任何 package.json、没有 cordis.patch.yml、不需要注册进 profile 的 bundle 列表。预设行可以写同目录下的相对路径（`./lib/persona.mjs`），roster 就是按预设目录解析的。本机的 `liangshen` 预设是同一个形态（用 `./minimal-prompt.mjs` 且无 package.json），这条路径已经在本机跑通。

---

## 它是怎么工作的

组装里原本该放 persona 的那一行，换成了 `./lib/persona.mjs`：

```yaml
- id: luzzy-persona
  name: ./lib/persona.mjs
```

这个行做两件事：

1. 注册 `deployment:persona-prefix` 段，**文本是一个固定引用** `{{luzzy_persona}}`；
2. 注册 `luzzy_persona` 这个**提示词变量**，它的 provider 每次组装都去读磁盘。

### 为什么是变量，而不是直接把提示词写进段文本

因为 `renderPrompt` 会对**段文本**做 `{{...}}` 插值，遇到未知引用会**抛异常**。用户自己写的提示词里出现一对花括号（写示例、写模板都很常见）就会让每一次请求都失败。而**变量的取值不会被再次扫描**——用户文本原样送进去，安全。

### 为什么这就绕开了「会话不能换预设」

`agent-presets` 的规则是：会话一旦产出过内容，预设就锁死了。而这里换的是**被读取的文件**，不是预设——锁管不到它。所以「切换激活的智能体」能在同一轮对话中间生效。

### 生效时机

`SystemPrompt.assemble()` 在**每一步请求前**都会跑一次。provider 每次读盘，所以文件一改，下一次请求送出的提示词就变了；渲染文本与上一轮不同时，agent loop 会替换掉头部的 system 节点。**不需要新开会话，也不需要重启。**

### 读取路径（按顺序，第一个非空者胜）

1. `$DSH_HOME/luzzy-preset/agents/<激活的智能体 id>.md`
2. `$DSH_HOME/luzzy-preset/default.md`
3. `lib/default-prompt.md`（本目录里的兜底）

**空文件不算数**——它会被跳过，和不存在一样。空提示词是最不可见的一种故障：会话看起来正常，只是规则全没了。

### 为什么没有缓存

曾经按 `(size, mtimeMs, birthtimeMs)` 做过记忆化，测完删掉了：**本机 NTFS 上 200 次等长原地改写里，144 次得到的 stat 四元组完全相同**。一个字的修改（`猫` → `狗`）正好是这个形状——缓存会把**旧提示词**送给模型，而页面上显示的是新的，任何地方都不会报错。正确性不建立在这个分辨率上；代价是每次组装多读一次小文件，可以忽略。

---

## 安装

```bash
node tools/install-preset.mjs              # 先看会改什么（不写任何东西）
node tools/install-preset.mjs --apply      # 真的装
```

它会把这个目录拷到 `$DSH_HOME/.agent-presets/luzzy-mode/`，并做三件事：

- **绝不覆盖**已有的 `agents/*.md` 与 `default.md`——那是用户写的东西；
- **绝不覆盖**已有的 `agent.cordis.yml`，除非显式 `--force`（那里是加工具行的地方）；
- 首次安装时，如果本机已有 `luzzy` 预设的 `persona.md`，把它播种成 `agents/luzzy.md`，这样第一次打开就是你已经在用的提示词，而不是兜底文本。

装完**重启 DSH**：roster 在启动时读预设目录；页面插件的宿主半也在启动时注册路由（客户端半会热重载，宿主半不会）。

### 让它成为新会话的默认预设

```bash
node tools/install-preset.mjs --apply --set-default
```

或者手工在 `~/.dsh/settings.yaml` 里写：

```yaml
agent-presets:
  default: luzzy-mode
```

**已经产出过内容的会话换不了预设**（DSH 的硬规则）。它们要么继续用原预设，要么新建一个会话——子页面上会明确这么说，不会假装切换成功。

---

## 编辑提示词

在 DSH 里打开 LuzzyPage →「预设」子页：

- 左栏是智能体名单，可以分组、拖拽排序；
- 右栏编辑选中智能体的 system prompt；
- 「设为当前」决定模型下一次请求用谁——**对所有会话生效**，因为它是一个全局指针；
- 「默认提示词」是所有没设自己提示词的智能体的兜底。

存储位置：

```
$DSH_HOME/luzzy-preset/
├── settings.json          # 名单、分组、当前激活的智能体
├── default.md             # 默认提示词
└── agents/<id>.md         # 每个智能体的提示词
```

这些都是普通文件，直接改也生效——下次请求就会读到。

---

## 与 LuzzyPage 的关系

提示词的读写在 `lib/preset-store.mjs` 里，这个模块在两边各有一份**逐字节相同**的副本：

- 这里（预设侧）：预设被拷进 `~/.dsh/.agent-presets/` 后只能解析自己的同级文件，所以只能自带；
- `luzzy-page/lib/preset-store.mjs`（宿主侧）：子页面的路由用它。

两边不能互相 import，所以靠 `luzzy-page/tools/test-preset-parity.mjs` 断言两份保持一致——**字节相同**，并且在同一份 fixture 上的行为也相同。改这个模块时改一处、同步另一处，测试会拦住漂移。
