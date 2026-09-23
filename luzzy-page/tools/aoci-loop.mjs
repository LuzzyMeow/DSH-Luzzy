// Drive the AOCI authoring loop: fetch a batch, report candidates, submit authored entries.
//
// Usage:
//   node tools/aoci-loop.mjs <workspace> fetch   <out.json>     # get the next machine batch
//   node tools/aoci-loop.mjs <workspace> status                  # where are we
//   node tools/aoci-loop.mjs <workspace> submit  <batch.json> <entries.json>
//
// `entries.json` is `{ "path": "full Entry line" }`. Batch identity, candidate_id and
// source_sha256 all come from the machine response and are passed through untouched — the
// client never synthesises them.
import { readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'file:///C:/Users/Administrator/Desktop/DSH%20Plugin/luzzy-page/tools/aoci-mcp-client.mjs'

const [, , ws, command, a, b] = process.argv
const client = await connect({ repo: ws })

try {
  if (command === 'fetch') {
    const result = await client.callTool('aoci_maintain')
    writeFileSync(a, result.text, 'utf8')
    const parsed = JSON.parse(result.text)
    const plan = parsed.code_plan
    console.log('status   :', parsed.status, '| aligned:', parsed.aligned, '| next:', parsed.next_action)
    if (plan) {
      console.log('batch    :', plan.batch_id)
      console.log('targets  :', plan.total_targets, '| included:', plan.included, '| remaining:', plan.remaining)
      for (const c of plan.candidates) console.log(`  ${c.path}`)
    }
    const orphans = parsed.orphan_remove_candidates ?? []
    if (orphans.length > 0) {
      console.log('orphans  :', orphans.length)
      for (const o of orphans) console.log(`  ${o}`)
    }
  } else if (command === 'status') {
    const result = await client.callTool('aoci_maintain')
    const parsed = JSON.parse(result.text)
    console.log('status :', parsed.status, '| aligned:', parsed.aligned)
    console.log('next   :', parsed.next_action)
    const g = parsed.governance
    if (g) {
      console.log('code   : source', g.code_source_count, '| entries', g.code_entry_count)
      console.log('drift  : missing', g.code_drift.missing.length, '| orphan', g.code_drift.orphan.length,
        '| stale', g.code_drift.stale.length, '| unbaselined', g.code_drift.unbaselined.length)
      console.log('tokens :', g.budget.whole_index_tokens)
    }
    writeFileSync(a ?? 'maintain.json', result.text, 'utf8')
  } else if (command === 'submit') {
    // BOM-tolerant: Windows tooling writes one, and JSON.parse rejects it with a message that
    // points at column 1 rather than naming the BOM.
    const stripBom = (text) => text.replace(/^\uFEFF/, '')
    const batch = JSON.parse(stripBom(readFileSync(a, 'utf8')))
    const authored = JSON.parse(stripBom(readFileSync(b, 'utf8')))
    const plan = batch.code_plan
    if (!plan) throw new Error('the batch file has no code_plan')
    const entries = plan.candidates.map((c) => {
      const line = authored[c.path]
      if (line === undefined) throw new Error(`no authored Entry for ${c.path}`)
      return { path: c.path, source_sha256: c.source_sha256, candidate_id: c.candidate_id, new_entry: line }
    })
    const result = await client.callTool('aoci_update_entry', { code_batch_id: plan.batch_id, entries })
    console.log(result.text.slice(0, 3000))
  } else {
    throw new Error(`unknown command ${command}`)
  }
} finally {
  client.close()
}
