#!/usr/bin/env node
/**
 * dsh-env-doctor · 报告原型验证（throwaway）
 *
 * 用宿主真实的校验器验三件事：
 *  1. report.schema.json 落在 DSH 允许的窄子集里（能直接当 output.schema 用）；
 *  2. 子集检查是真的（负面对照：$schema / format 之类必须被拒）；
 *  3. sample-result.json 通过 schema，且报告/摘要与规范值一致、不漂移。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA_FILE = join(HERE, 'report.schema.json')
const RESULT_FILE = join(HERE, 'sample-result.json')
const REPORT_FILE = join(HERE, 'sample-report.md')
const SUMMARY_FILE = join(HERE, 'sample-summary.md')

// 宿主自己那份校验器（与本机 DSH 0.2.0-rc.2 完全一致）
const SUBSET_MOD = 'C:/Users/神/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js'

const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(SUBSET_MOD).href)
const { assertConsistent, render, renderReport } = await import(pathToFileURL(join(HERE, 'render.mjs')).href)

let failures = 0
function check(name, fn) {
  try {
    const detail = fn()
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (e) {
    failures += 1
    console.log(`FAIL  ${name} — ${e && e.message ? e.message : e}`)
  }
}

const schema = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'))
const value = JSON.parse(readFileSync(RESULT_FILE, 'utf8'))

check('schema 落在 DSH 窄子集内（可直接当 output.schema）', () => {
  assertSupportedJsonSchema(schema)
  return `${Object.keys(schema.properties).length} 个顶层字段`
})

check('负面对照：$schema 关键字被拒（子集检查不是摆设）', () => {
  let threw = null
  try {
    assertSupportedJsonSchema({ type: 'object', $schema: 'https://json-schema.org/draft/2020-12/schema', properties: {} })
  } catch (e) {
    threw = e
  }
  if (!threw) throw new Error('$schema 竟然被接受了 —— 子集检查无效')
  return String(threw.code || threw.message)
})

check('负面对照：format 关键字被拒', () => {
  let threw = null
  try {
    assertSupportedJsonSchema({ type: 'object', properties: { t: { type: 'string', format: 'date-time' } } })
  } catch (e) {
    threw = e
  }
  if (!threw) throw new Error('format 竟然被接受了 —— 子集检查无效')
  return String(threw.code || threw.message)
})

check('sample-result.json 通过 schema', () => {
  const violations = validateJsonSchemaValue(schema, value)
  if (violations.length > 0) throw new Error(violations.join('; '))
  return `${value.results.length} 条结果，0 violation`
})

check('负面对照：伪造的 verdict 会被 schema 抓住', () => {
  const bad = JSON.parse(JSON.stringify(value))
  bad.results[0].verdict = 'broken'
  const violations = validateJsonSchemaValue(schema, bad)
  if (violations.length === 0) throw new Error('非法 enum 竟然通过了')
  return violations[0]
})

check('counts / undiagnosed / verdict 与 results 自洽', () => {
  assertConsistent(value)
  return `counts=${JSON.stringify(value.counts)}`
})

check('render() 返回 ContentBlock[]（工具 output.render 的契约形状）', () => {
  const blocks = render({}, value)
  if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('不是非空数组')
  for (const b of blocks) {
    if (!b || b.type !== 'text' || typeof b.text !== 'string') throw new Error(`内容块形状不对：${JSON.stringify(b)}`)
  }
  const lines = blocks[0].text.split('\n')
  if (lines.length > 14) throw new Error(`摘要 ${lines.length} 行，太长了（目标 ≤ 14 行）`)
  return `${lines.length} 行`
})

check('落盘的报告与摘要没有漂移（重新渲染应与文件逐字相同）', () => {
  const reportOnDisk = readFileSync(REPORT_FILE, 'utf8')
  const summaryOnDisk = readFileSync(SUMMARY_FILE, 'utf8')
  const reportNow = renderReport(value)
  const summaryNow = render({}, value)[0].text
  if (reportOnDisk !== (reportNow.endsWith('\n') ? reportNow : reportNow + '\n')) {
    throw new Error('sample-report.md 与当前渲染结果不同 —— 规范值改了但没重新生成')
  }
  if (summaryOnDisk !== summaryNow + '\n') {
    throw new Error('sample-summary.md 与当前渲染结果不同 —— 规范值改了但没重新生成')
  }
  return '两文件逐字一致'
})

check('报告里每条问题都有「下一步」或明确的「没有命令」', () => {
  const report = readFileSync(REPORT_FILE, 'utf8')
  for (const r of value.results.filter((x) => x.verdict === 'fail' || x.verdict === 'warn')) {
    if (!report.includes(`### ${r.id} · ${r.title}`)) throw new Error(`${r.id} 没出现在「需要你动手的」里`)
    if (!r.fix && !report.includes(r.detail)) throw new Error(`${r.id} 没有 fix，细节也没进报告`)
  }
  return `${value.results.filter((x) => x.verdict === 'fail' || x.verdict === 'warn').length} 条逐条核对`
})

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`)
process.exit(failures === 0 ? 0 : 1)
