/**
 * 技能清单节点 —— 注入正文的读取与摘要。
 *
 * WHY A SEPARATE MODULE, AND WHY IT READS A FILE INSTEAD OF EMBEDDING THE TEXT
 *
 * 正文里有 ``` 代码围栏（AnySearch 的 CLI 用法）。把它内联成 JS 字符串就要逐个转义反引号，
 * 而这个项目在「给坑写注释时踩坑」上已经有过三次记录（见 AGENTS.md §5.6）。读文件绕开整类问题。
 *
 * 更重要的是**单一源**：正文住在 `docs/skill-roster-injection.md`，人和 agent 都读那一份；
 * 这个模块只负责按标记切出来。把同一段文字同时存在 .md 和 .mjs 里，就是本方案要消灭的那种副本。
 *
 * @module luzzy-page/skill-roster
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(HERE, '..', 'docs', 'skill-roster-injection.md')

const BEGIN = '===BEGIN==='
const END = '===END==='

/**
 * 切出注入正文：`===BEGIN===` 与 `===END===` 之间，两边的说明与标记都不注入。
 *
 * @param {string} raw
 * @returns {string} 正文；标记缺失时返回空串（调用方据此 fail-soft）
 */
export function extractRoster(raw) {
  const from = raw.indexOf(BEGIN)
  const to = raw.indexOf(END)
  if (from < 0 || to < 0 || to <= from) return ''
  return raw.slice(from + BEGIN.length, to).trim()
}

/**
 * 读一次正文。读不到**不抛**：这是一段注入文本，读不出来应该降级成「本轮不注入清单」，
 * 而不是让整个预检挂掉 —— 状态链本身还在，门还在，只是少了一张表。
 *
 * @returns {{text: string, digest: string, error: string|null}}
 */
export function readRoster() {
  let raw
  try {
    raw = readFileSync(SOURCE, 'utf8')
  } catch (error) {
    return { text: '', digest: '', error: String(error && error.message || error) }
  }
  const text = extractRoster(raw)
  if (text === '') return { text: '', digest: '', error: `${SOURCE} 里没有 ${BEGIN} / ${END} 标记` }
  return { text, digest: createHash('sha256').update(text).digest('hex').slice(0, 16), error: null }
}

export { SOURCE as ROSTER_SOURCE }
