#!/usr/bin/env node
/**
 * dsh-env-doctor · 报告契约验证
 *
 * 验六件事：
 *  1. report.schema.json 落在 DSH 允许的窄子集里（能直接当 output.schema 用）；
 *  2. 子集检查是真的（负面对照：$schema / format 之类必须被拒）；
 *  3. 文档 schema 与 lib/report.js 的 valueSchema 去掉注释键后完全一致（防两处各写一份）；
 *  4. sample-result.json 通过 schema，且 counts / undiagnosed / verdict 自洽；
 *  5. render() 返回 ContentBlock[]（工具 output.render 的契约形状），摘要 ≤14 行；
 *  6. 落盘的 sample-report.md / sample-summary.md 与当前渲染器逐字一致（改了规范值必须重新生成）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { assertConsistent, render, renderReport, valueSchema } from '../../../lib/report.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA_FILE = join(HERE, 'report.schema.json')
const RESULT_FILE = join(HERE, 'sample-result.json')
const REPORT_FILE = join(HERE, 'sample-report.md')
const SUMMARY_FILE = join(HERE, 'sample-summary.md')

// 宿主自己那份校验器（与本机 DSH 0.2.0-rc.2 完全一致）
const SUBSET_MOD = 'C:/Users/神/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js'

const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(SUBSET_MOD).href)

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

const ANNOTATIONS = new Set(['title', 'description', 'default', 'examples'])
function strip(node) {
  if (Array.isArray(node)) return node.map(strip)
  if (node && typeof node === 'object') {
    const out = {}
    for (const [key, value] of Object.entries(node)) {
      if (!ANNOTATIONS.has(key)) out[key] = strip(value)
    }
    return out
  }
  return node
}
function canonical(node) {
  if (Array.isArray(node)) return `[${node.map(canonical).join(',')}]`
  if (node && typeof node === 'object') {
    return `{${Object.keys(node)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(node[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(node)
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

check('文档 schema 与 lib/report.js 的 valueSchema 一致（去掉注释键后逐键相同）', () => {
  const doc = canonical(strip(schema))
  const code = canonical(strip(valueSchema))
  if (doc !== code) {
    for (let i = 0; i < Math.max(doc.length, code.length); i += 1) {
      if (doc[i] !== code[i]) {
        throw new Error(`第 ${i} 个字符起不同：文档 ${doc.slice(i, i + 80)} ≠ 代码 ${code.slice(i, i + 80)}`)
      }
    }
    throw new Error('两份 schema 不同')
  }
  return `${doc.length} 字符完全相同`
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

check('counts / undiagnosed / verdict 与 results 自洽（warn/fail 必须带 fix.command）', () => {
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
    throw new Error('sample-report.md 与当前渲染结果不同 —— 规范值改了但没重新生成（node docs/prototypes/report/make-samples.mjs）')
  }
  if (summaryOnDisk !== summaryNow + '\n') {
    throw new Error('sample-summary.md 与当前渲染结果不同 —— 规范值改了但没重新生成（node docs/prototypes/report/make-samples.mjs）')
  }
  return '两文件逐字一致'
})

check('报告里每条问题都在「需要你动手的」或「已执行的修复」里', () => {
  const report = readFileSync(REPORT_FILE, 'utf8')
  const actionItems = value.results.filter((x) => (x.verdict === 'fail' || x.verdict === 'warn') && !x.applied)
  for (const r of actionItems) {
    if (!report.includes(`### ${r.id} · ${r.title}`)) throw new Error(`${r.id} 没出现在「需要你动手的」里`)
    if (!r.fix && !report.includes(r.detail)) throw new Error(`${r.id} 没有 fix，细节也没进报告`)
  }
  const appliedItem = value.results.find((x) => x.applied)
  if (appliedItem && !report.includes(`**${appliedItem.id}**`)) {
    throw new Error(`${appliedItem.id} 的 applied 没进「已执行的修复」`)
  }
  return `${actionItems.length} 条待动手 + ${appliedItem ? 1 : 0} 条已执行逐条核对`
})

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`)
process.exit(failures === 0 ? 0 : 1)
