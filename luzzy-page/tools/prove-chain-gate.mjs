/**
 * Negative control for the two NEW gates: the per-turn state chain and the skill list.
 *
 * Same reason as `prove-gate.mjs`: an assertion that cannot fail is not a test. These two have a
 * failure mode that looks exactly like success — a chain gate that never fires and a skill gate
 * that never fires both leave every other suite green, and the只 difference is that the user's
 * 「每次对话都要执行状态链」 stopped happening.
 *
 * Six arms, because they fail independently:
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
 *
 * armE 与 armF 都是**实测出来的**，不是想出来的。同一个回合里连着被拦 5 次，其中 3 次是
 * `read`（门的文本要求先读的正文），另外几次是宿主的 `<goal_state>` 注入被当成了新一轮。
 * 合起来是两道自伤：一道逼人说假话，一道让门每步续期。
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
console.log(`PASS — ${checks} assertions (both chain gates fail when they should)`)
