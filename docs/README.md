# DSH Plugin 调研

调研对象：DeepSeek Harness（`dsh`）的插件形式：怎么写、怎么装、要注意什么、跑起来能调用哪些服务。

核验版本：本机 `dsh 0.1.5-rc.1`（实测）。所有带「本机实测」标记的结论来自在这台机器上跑出的输出或读到的源码文件。

> **版本备注**：本机同时存在 `0.1.5-rc.1`（Desktop 运行时）与 `0.1.5-rc.2`（`resources/app/node_modules` 里的官方包）。01–04 的结论基于 rc.1；[05](05-前端技术栈与客户端插件机制.md) 直读的是 rc.2 的包，两版在本文涉及的范围（客户端插件机制、slot 注册、前端构建产物）未见差异。

## 一句话结论

DSH 没有特权内核。插件是一个导出 `apply(ctx)` 的模块，通过 `ctx` 注册服务、工具、事件监听。所有注册都是可逆副作用，插件卸载时自动撤销。

写一个插件，绝大多数情况就是：写一个函数，再在 `cordis.patch.yml` 里插一行。

## 文档导航

| 文件 | 内容 |
|---|---|
| [01-插件模型与写法.md](01-插件模型与写法.md) | 插件是什么、三种形态、四个导出、工具 DSL、配置、事件系统、生命周期 |
| [02-组装安装与客户端插件.md](02-组装安装与客户端插件.md) | profile / bundle / patch 三层组装、安装与分发、Web UI 插槽插件 |
| [03-注意事项与来源核验.md](03-注意事项与来源核验.md) | 踩坑清单、安全边界、版本兼容、来源分级与本机核验记录 |
| [04-服务与运行时.md](04-服务与运行时.md) | 核心服务总览、系统提示词组装、会话与上下文重建、模型调用、shell 与后台任务、轮次骨架、能力 seam、工具执行流水线 |
| [05-前端技术栈与客户端插件机制.md](05-前端技术栈与客户端插件机制.md) | 前端是 Electron 壳 + Vite/React SPA、右侧栏选项卡的两步注册、iframe 塞自有页面的真实实现、框架准入边界 |

## 相关文档（仓库根目录）

| 文件 | 内容 |
|---|---|
| [RESEARCH-DSH插件层可行性调研.md](RESEARCH-DSH插件层可行性调研.md) | 对照 AstrBot / HanaAgent / QwenPaw 三家机制，逐条判定哪些能在 DSH 插件层实现（含 hook、代价与缺口） |

> 调研所用的一手素材（B 站两期视频的字幕与公开评论笔记）含第三方内容，**不随本仓库分发**。

## 结论速览

**插件的最小形态**（官方 `develop/basic`）：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'
export function apply(ctx: Context) {
  // 在这里注册能力
}
```

**四个导出的分工**：

| 导出 | 作用 | 何时需要 |
|---|---|---|
| `name` | 诊断信息里标识插件 | 建议总是写 |
| `inject` | 声明必需服务，Loader 等它们就绪才执行 `apply` | 用到 `ctx.tools` / `ctx.llm` 等服务时 |
| `Config` | Schemastery schema，声明部署期配置 | 有可调参数时 |
| `apply` | 插件主体，注册一切贡献 | 必须 |

**三条最值得记住的规则**：

1. **注册必须可逆**。走 `ctx.effect()` / `ctx.on()` / `ctx.tools.register()`，卸载时框架自动回滚。在 `apply` 里裸干的副作用不会被回滚。
2. **可调参数不能写死**。判断标准是：能不能只改 `cordis.yml` 就改变这个值，而不动代码？
3. **patch 按 id 替换整行 `config`，不是深合并**。覆盖一行就得把这一行需要的每个键都重述一遍。

## 来源分级摘要

**一类来源（官方，结论直接采信）**

| 来源 | 用途 |
|---|---|
| [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 官方仓库，MIT，含全部源码与 `docs/` |
| [deepseek-harness.github.io](https://deepseek-harness.github.io/deepseek-harness/) | 官方文档站（VitePress，中英双语） |
| [deepseek.com/harness](https://www.deepseek.com/harness/en/) | DeepSeek 官方产品页，架构声明 |
| 仓库内 `docs/architecture.zh.md`、`docs/cordis-primer.zh.md`、`docs/cookbook/*`、`docs/subsystems/*`、`SAFETY.zh.md` | 设计真源 |

**本机一手证据（可信度等同一类，可复现）**

| 证据 | 位置 |
|---|---|
| CLI 行为与层顺序说明 | `dsh --help`、`dsh plugin --help` |
| 组合后的插件树（586 行，含层标记） | `dsh --profile desktop --dump-config` |
| 真实 profile manifest | `~/.dsh/profiles/desktop/package.json` |
| 真实用户 patch 层 | `~/.dsh/profiles/desktop/cordis.patch.yml` |
| 真实插件样本（含客户端 bundle） | `~/.dsh/plugins/dsh-tabbit-plugin/` |
| 三个第三方 bundle 的 `dsh` 字段 | `~/.dsh/profiles/desktop/node_modules/{dshmarket,dsh-smooth-stream,dsh-thoughtdag}/package.json` |

**二类来源（第三方，仅作交叉验证，不单独采信）**

- [DeepSeek Harness (dsh) 插件开发教程](https://dev.to/henry_lin_3ac6363747f45b4/deepseek-harness-dsh-cha-jian-kai-fa-jiao-cheng-4h6j)（DEV Community）。内容与官方文档一致，可作补充视角；个别断言（如默认导出会丢 `inject` 元数据）未在官方文档中直接找到对应段落，已在 [03](03-注意事项与来源核验.md) 中标记为待核。

## 阅读前提

DSH 处于 **developer preview**，官方声明「THERE WILL BE COMPATIBILITY-BREAKING CHANGES」。本文结论对应 `0.1.5-rc.1`，升级后建议用 `dsh --profile <name> --dump-config` 重新核对。
