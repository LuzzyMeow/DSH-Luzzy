/**
 * Negative control for the two NEW gates: the per-turn state chain and the skill list.
 *
 * Same reason as `prove-gate.mjs`: an assertion that cannot fail is not a test. These two have a
 * failure mode that looks exactly like success — a chain gate that never fires and a skill gate
 * that never fires both leave every other suite green, and the只 difference is that the user's
 * 「每次对话都要执行状态链」 stopped happening.
 *
 * Sixteen arms across eight mutations, because they fail independently:
 *
 *   armA  the chain gate never refuses            -> 「答完才放行」不再是门
 *   armB  the plugin notice counts as a new turn  -> 链在每个 step 自己续期
 *   armC  the pending flag is cleared optimistically in the gate
 *                                                 -> 一次**被拒**的 judgeChain 也算答过
 *   armD  the skill gate removed                  -> 「命中技能清单」只要说一句就行
 *   armE  the skill gate blocks its own reading tools
 *                                                 -> 逼模型为了让门放行而把 skillCheck 改成 none
 *   armF  the turn filter narrowed back to `plugin`
 *                                                 -> 宿主的 goal_state 注入被当成人在说话
 *   armG  the skill-miss challenge never fires    -> 「答了没命中、却改了文件」重新变成一句没人问的话
 *   armH  the challenge is asked on every step    -> 追问退化成说教
 *
 * armE 与 armF 都是**实测出来的**，不是想出来的。同一个回合里连着被拦 5 次，其中 3 次是
 * `read`（门的文本要求先读的正文），另外几次是宿主的 `<goal_state>` 注入被当成了新一轮。
 * 合起来是两道自伤：一道逼人说假话，一道让门每步续期。
 *
 * armG 与 armH 也是实测出来的，而且就是本项目的会话本身：连续几轮把 `skillCheck` 答成 "none"，
 * 同时改的正是这个页面自己的 JS 与 CSS —— 按 §1.1.6 的清单，那是设计类 / HTML 网页开发。
 * 没有任何东西发现过，因为没有任何东西把「答了什么」和「这一轮做了什么」放在一起看。
 * **注意这一臂钉的不是门**：答 "none" 依然合法、不拦任何工具。它钉的是「有人问过」。
 *
 * Usage: node tools/prove-chain-gate.mjs
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')

let failures = 0
let checks = 0
function check(label, ok, detail = '') {
  checks += 1
  if (ok) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

function runSuite(sandbox) {
  try {
    return {
      exitedNonZero: false,
      output: execFileSync(process.execPath, [join(sandbox, 'tools', 'test-goal-enforce.mjs')], {
        encoding: 'utf8',
        env: { ...process.env },
      }),
    }
  } catch (error) {
    return { exitedNonZero: true, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/**
 * The suite's own FAIL lines.
 *
 * The prefix is load-bearing. Assertion labels may contain the word FAILED
 * (`a FAILED judgement does not open the gate`) and those lines read `ok` when they pass, so
 * filtering on `includes('FAIL')` counts them — which is how the first version of arm G got its
 * own reading wrong. When counting failing lines, the counting itself has to be right.
 */
function failLines(output) {
  return output.split('\n').filter((line) => line.startsWith('  FAIL '))
}

/**
 * Measured, not guessed — each is the number of FAIL lines the arm actually produced.
 *
 * arm G removes the trigger, so every assertion that names the challenge dies with it.
 * arm H removes the once-per-turn guard, so the same turn gets asked again on the next step.
 */
const G_EXPECTED_FAILS = 7
const H_EXPECTED_FAILS = 2

function sandboxWith(label, mutate) {
  const sandbox = mkdtempSync(join(tmpdir(), 'luzzy-chain-proof-'))
  cpSync(PLUGIN_ROOT, sandbox, { recursive: true })
  const target = join(sandbox, 'lib', 'goal-enforce.mjs')
  const source = readFileSync(target, 'utf8')
  const mutated = mutate(source)
  if (mutated === source) {
    failures += 1
    console.log(`  FAIL arm ${label}: the mutation matched nothing, so this arm tests nothing`)
  }
  writeFileSync(target, mutated)
  return sandbox
}

/** Assert one arm goes red and that the named assertion is among the failures. */
function expectRed(label, sandbox, matcher, describe) {
  const result = runSuite(sandbox)
  check(`${label}: the suite goes red`, result.exitedNonZero, describe)
  const lines = result.output.split('\n').filter((l) => l.includes('FAIL'))
  check(`${label}: and names ${matcher} (${lines.length} FAIL lines)`, lines.some((l) => matcher.test(l)), lines.slice(0, 3).join(' | '))
  for (const line of lines.slice(0, 4)) console.log(`       ${line.trim()}`)
}

const sandboxes = []
try {
  // ---- arm A: the chain gate exists but never refuses -------------------------------
  {
    const sandbox = sandboxWith('A', (s) => s.replace(
      `      if (entry.chainPending) {
        stats.chainBlocked += 1
        entry.chainBlocks += 1
        return { kind: 'deny', reason: renderChainGateRefusal(exec.name, entry) }
      }`,
      '      if (false) { /* arm A */ }',
    ))
    sandboxes.push(sandbox)
    expectRed('A', sandbox, /names the gate|before the chain is answered|STATE_CHAIN/i,
      'it passed with the chain gate removed')
  }

  // ---- arm B: our own notice counts as a new user turn ------------------------------
  //
  // The filter is two lines, and removing it is the shape of a plausible "simplification".
  // Without it every step re-arms the chain, so the model is asked the same question in a loop.
  {
    const sandbox = sandboxWith('B', (s) => s.replace(
      `          const kind = message?.source?.kind
          if (kind !== undefined && kind !== 'user') continue`,
      '          // arm B: the filter is gone',
    ))
    sandboxes.push(sandbox)
    expectRed('B', sandbox, /not mistaken for a new turn|does not re-arm/i,
      'it passed with the notice filter removed')
  }

  // ---- arm C: a refused judgement counts as an answer -------------------------------
  //
  // This is the shortcut the first draft took (clear the flag in the gate when the arguments
  // say judgeChain). It opens the gate on a call that FAILED validation — i.e. in exactly the
  // situation where the model has not actually decided anything.
  {
    const sandbox = sandboxWith('C', (s) => s.replace(
      "      if (readToolStatus(decision.content ?? result?.content) !== 'ok') return decision",
      '      // arm C: any call counts',
    ))
    sandboxes.push(sandbox)
    expectRed('C', sandbox, /FAILED judgement does not open the gate/i,
      'it passed with the status check removed')
  }

  // ---- arm D: 「命中技能清单」 becomes a sentence with no consequence -------------------
  {
    const sandbox = sandboxWith('D', (s) => s.replace(
      `        if (chain.skillCheck === 'hit' && read.delivery.skills.length === 0 && !SKILL_GATE_PASS_TOOLS.has(exec.name)) {
          stats.skillBlocked += 1
          entry.skillBlocks += 1
          return { kind: 'deny', reason: renderSkillGateRefusal(exec.name, entry) }
        }`,
      '        /* arm D */',
    ))
    sandboxes.push(sandbox)
    expectRed('D', sandbox, /SKILL_LIST_EMPTY|skillBlocked|SKILL one/i,
      'it passed with the skill gate removed')
  }

  // ---- arm E: the skill gate blocks the reading tools it tells you to use --------------
  //
  // 把 `!SKILL_GATE_PASS_TOOLS.has(...)` 拿掉，就退回到那个死锁形态：门说「先读正文再登记」，
  // 却把 read / skill 一起拦掉。这一臂钉住的是「门的指令与门的执行不矛盾」。
  {
    const sandbox = sandboxWith('E', (s) => s.replace(
      ' && !SKILL_GATE_PASS_TOOLS.has(exec.name)) {',
      ') {',
    ))
    sandboxes.push(sandbox)
    expectRed('E', sandbox, /read passes through the skill gate|skill loader itself/i,
      'it passed with the skill gate blocking the very tools that read a skill')
  }

  // ---- arm F: the filter is narrowed back to `plugin` ----------------------------------
  //
  // 这是**真实发生过的形态**，不是推演的变体：原来的过滤器只排除 `kind === 'plugin'`，
  // 于是宿主的 `<goal_state>` 注入（同样是 user 角色）每来一次就被读成「用户又说了一句」。
  // 实测后果：一个回合里连着被拦 5 次，每次都要重答两道分支，而人只说了一句话。
  {
    const sandbox = sandboxWith('F', (s) => s.replace(
      "          if (kind !== undefined && kind !== 'user') continue",
      "          if (kind === 'plugin') continue",
    ))
    sandboxes.push(sandbox)
    expectRed('F', sandbox, /goal-state injection is not a new turn|workspace-instruction injection/i,
      'it passed with only the plugin kind excluded (the shape of the real bug)')
  }
  // ---- arm G: the skill-miss challenge never fires ------------------------------------
  //
  // 这是本轮实测出来的漏洞的形状：`skillCheck` 是模型的判断（§39），所以答 "none" 合法、
  // 而且**一度不花任何代价**。代价为零的判断等于没有判断 —— 本项目自己的会话里连续几轮答
  // "none" 同时改这个页面的 JS / CSS（§1.1.6 的清单里那是设计类 / HTML 网页开发），没有任何
  // 东西发现过。把触发条件整个拿掉（`skillMiss` 恒为 null），断言必须红。
  //
  // 数失败行数，不是只看 PASS/FAIL：这一臂要证明的正是「问过」这件事**有可数的断言在守**。
  {
    const sandbox = sandboxWith('G', (s) => s.replace(
      `      let skillMiss = null
      if (entry.lastSkillCheck === 'none' && entry.skillMissChallenged !== turn) {
        const work = observeTurn(agent)
        if (work.files.length > 0) skillMiss = work.files
      }`,
      '      const skillMiss = null',
    ))
    sandboxes.push(sandbox)
    const result = runSuite(sandbox)
    check('G: the suite goes red', result.exitedNonZero, 'it passed with the challenge removed')
    // `  FAIL ` 这个前缀是有意的：套件里有断言名带「FAILED」（`a FAILED judgement does not
    // open the gate`）而它**通过**，用 `includes('FAIL')` 会把那几行 ok 一起数进来 —— 上一版
    // 就是这么把自己的读数搞错的。测失败行数的时候，连测法本身也要对。
    const lines = failLines(result.output)
    check(`G: and exactly the ${G_EXPECTED_FAILS} challenge assertions fail (${lines.length} FAIL lines)`,
      lines.length === G_EXPECTED_FAILS, lines.join(' | '))
    check('G: and every failing assertion names the challenge, so the arm is precise',
      lines.length > 0 && lines.every((l) => /challenge/.test(l)), lines.join(' | '))
    for (const line of lines) console.log(`       ${line.trim()}`)
  }

  // ---- arm H: the challenge is asked on every step ------------------------------------
  //
  // 追问一次是提问，追问每一步是说教。把「这一轮问过没有」那半条条件拿掉，同一个回合的后
  // 每一步都会再问一遍 —— 「问过一次」的那条断言必须红。
  {
    const sandbox = sandboxWith('H', (s) => s.replace(
      "      if (entry.lastSkillCheck === 'none' && entry.skillMissChallenged !== turn) {",
      "      if (entry.lastSkillCheck === 'none') {",
    ))
    sandboxes.push(sandbox)
    const result = runSuite(sandbox)
    check('H: the suite goes red', result.exitedNonZero, 'it passed with the challenge repeating every step')
    const lines = failLines(result.output)
    check(`H: and exactly the ${H_EXPECTED_FAILS} "asked twice" assertions fail (${lines.length} FAIL lines)`,
      lines.length === H_EXPECTED_FAILS, lines.join(' | '))
    for (const line of lines) console.log(`       ${line.trim()}`)
  }
} finally {
  for (const sandbox of sandboxes) {
    try {
      rmSync(sandbox, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} of ${checks} assertion(s)`)
  process.exit(1)
}
console.log(`PASS — ${checks} assertions (both chain gates and the skill-miss challenge fail when they should)`)
