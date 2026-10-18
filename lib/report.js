// 报告：规范值一份，摘要与全文都从它渲染（原型见 docs/prototypes/report/）。
//
// 三件事必须成立，否则宁可不渲染：
//   1. counts / undiagnosed / verdict 与 results 自洽（assertConsistent）；
//   2. 摘要硬上限 14 行、最多 5 条动作项（summaryLines）；
//   3. 每条 fail/warn 都有「下一步」（fix.command 或明确说明无需命令）。
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const SCHEMA_VERSION = '1.0'

export const VERDICTS = ['ok', 'warn', 'fail', 'undiagnosed']
export const MODES = ['check', 'explain', 'fix']
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access', 'unknown']
export const LEVELS = ['info', 'low', 'medium', 'high']
export const RISKS = ['low', 'medium', 'high']

/** 工具 output.schema 用的 JSON Schema（宿主窄子集：只许 type/oneOf/properties/required/additionalProperties/items/enum/const）。 */
export const valueSchema = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'string', const: SCHEMA_VERSION },
    generatedAt: { type: 'string' },
    mode: { type: 'string', enum: MODES },
    sandboxMode: { type: 'string', enum: SANDBOX_MODES },
    workspaceRoot: { type: 'string' },
    reportPath: { type: 'string' },
    verdict: { type: 'string', enum: VERDICTS },
    counts: {
      type: 'object',
      properties: {
        ok: { type: 'integer' },
        warn: { type: 'integer' },
        fail: { type: 'integer' },
        undiagnosed: { type: 'integer' },
      },
      required: ['ok', 'warn', 'fail', 'undiagnosed'],
      additionalProperties: false,
    },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          group: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E', 'F'] },
          title: { type: 'string' },
          verdict: { type: 'string', enum: VERDICTS },
          level: { type: 'string', enum: LEVELS },
          detail: { type: 'string' },
          evidence: { type: 'string' },
          fix: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              risk: { type: 'string', enum: RISKS },
              needsAdmin: { type: 'boolean' },
              autoApplicable: { type: 'boolean' },
              note: { type: 'string' },
            },
            required: ['command', 'risk', 'needsAdmin', 'autoApplicable'],
            additionalProperties: false,
          },
          applied: {
            type: 'object',
            properties: {
              at: { type: 'string' },
              id: { type: 'string' },
              command: { type: 'string' },
              before: { type: 'string' },
              outcome: { type: 'string', enum: ['ok', 'failed', 'cancelled', 'rejected'] },
            },
            required: ['at', 'id', 'command', 'before', 'outcome'],
            additionalProperties: false,
          },
        },
        required: ['id', 'group', 'title', 'verdict', 'level', 'detail'],
        additionalProperties: false,
      },
    },
    undiagnosed: { type: 'array', items: { type: 'string' } },
  },
  required: ['schemaVersion', 'generatedAt', 'mode', 'sandboxMode', 'workspaceRoot', 'reportPath', 'verdict', 'counts', 'results', 'undiagnosed'],
  additionalProperties: false,
}

export const LEVEL_LABEL = { info: '提示', low: '低', medium: '中', high: '高危' }

export function countByVerdict(results) {
  const counts = { ok: 0, warn: 0, fail: 0, undiagnosed: 0 }
  for (const result of results) {
    if (counts[result.verdict] === undefined) throw new Error(`E_BAD_VERDICT: ${result.id} → ${result.verdict}`)
    counts[result.verdict] += 1
  }
  return counts
}

export function overallVerdict(results) {
  const counts = countByVerdict(results)
  if (counts.fail > 0) return 'fail'
  if (counts.warn > 0) return 'warn'
  if (counts.undiagnosed === results.length && results.length > 0) return 'undiagnosed'
  return 'ok'
}

/** 自洽检查：counts / undiagnosed / verdict 三者必须与 results 对得上。 */
export function assertConsistent(value) {
  const results = value.results ?? []
  const counts = countByVerdict(results)
  for (const key of Object.keys(counts)) {
    if (value.counts?.[key] !== counts[key]) {
      throw new Error(`E_INCONSISTENT: counts.${key}=${value.counts?.[key]} 但实际 ${counts[key]}`)
    }
  }
  const undiagnosed = results.filter((result) => result.verdict === 'undiagnosed').map((result) => result.id)
  const declared = value.undiagnosed ?? []
  if (undiagnosed.join(',') !== declared.join(',')) {
    throw new Error(`E_INCONSISTENT: undiagnosed=[${declared.join(',')}] 但实际 [${undiagnosed.join(',')}]`)
  }
  const verdict = overallVerdict(results)
  if (value.verdict !== verdict) {
    throw new Error(`E_INCONSISTENT: verdict=${value.verdict} 但应为 ${verdict}`)
  }
  for (const result of results) {
    if ((result.verdict === 'fail' || result.verdict === 'warn') && !result.fix?.command) {
      throw new Error(`E_NO_NEXT_STEP: ${result.id} 是 ${result.verdict} 但没有下一步`)
    }
  }
  return true
}

/** 动作项排序：fail 先，同级按等级降序，再按 id。 */
export function actionItems(results) {
  const weight = { fail: 0, warn: 1 }
  const levelWeight = { high: 0, medium: 1, low: 2, info: 3 }
  return results
    .filter((result) => result.verdict === 'fail' || result.verdict === 'warn')
    .sort((a, b) => {
      const byVerdict = weight[a.verdict] - weight[b.verdict]
      if (byVerdict !== 0) return byVerdict
      const byLevel = levelWeight[a.level] - levelWeight[b.level]
      if (byLevel !== 0) return byLevel
      return a.id.localeCompare(b.id)
    })
}

const MAX_ITEMS = 5
const MAX_LINES = 14

/** 给模型看的摘要：≤14 行、最多 5 条动作项。 */
export function summaryLines(value) {
  const counts = value.counts
  const lines = [
    `体检完成：${value.results.length} 项检查 —— 通过 ${counts.ok}、注意 ${counts.warn}、失败 ${counts.fail}、说不准 ${counts.undiagnosed}。总体：${{ ok: '健康', warn: '需注意', fail: '失败', undiagnosed: '说不准' }[value.verdict]}`,
  ]
  const items = actionItems(value.results)
  for (const [index, item] of items.slice(0, MAX_ITEMS).entries()) {
    lines.push(`${index + 1}. [${LEVEL_LABEL[item.level] ?? item.level}] ${item.id} ${item.title}`)
    const command = Array.isArray(item.fix.command) ? item.fix.command[0] : String(item.fix.command).split('\n')[0]
    lines.push(`   → ${command}`)
  }
  if (items.length > MAX_ITEMS) lines.push(`另有 ${items.length - MAX_ITEMS} 项需注意，见报告`)
  if (value.undiagnosed.length > 0) lines.push(`说不准：${value.undiagnosed.join('、')}（原因见报告）`)
  if (value.reportPath) lines.push(`全文：${value.reportPath}`)
  if (lines.length > MAX_LINES) {
    const kept = lines.slice(0, MAX_LINES - 1)
    kept.push(`（已截断，全文见报告）`)
    return kept
  }
  return lines
}

/** 工具 output.render 的签名：(args, value) → ContentBlock[]。 */
export function render(args, value) {
  return [{ type: 'text', text: summaryLines(value).join('\n') }]
}

/** 人读全文（Markdown）。 */
export function renderReport(value) {
  const lines = []
  lines.push('# DSH 环境体检报告')
  lines.push('')
  lines.push('| 项 | 值 |')
  lines.push('|---|---|')
  lines.push(`| 生成时间 | ${value.generatedAt} |`)
  lines.push(`| 沙箱模式 | ${value.sandboxMode} |`)
  lines.push(`| 工作区 | ${value.workspaceRoot} |`)
  lines.push(`| 检查项 | ${value.results.length} 项 |`)
  lines.push(`| 总体结论 | **${{ ok: '健康', warn: '需注意', fail: '失败', undiagnosed: '说不准' }[value.verdict]}** |`)
  lines.push('')
  const counts = value.counts
  lines.push(
    `一句话：通过 ${counts.ok}、注意 ${counts.warn}、失败 ${counts.fail}、说不准 ${counts.undiagnosed}。${
      counts.fail > 0 ? '先处理失败项。' : counts.warn > 0 ? '注意项不阻塞，但建议看一眼。' : '没发现需要动手的事。'
    }`,
  )
  lines.push('')

  const items = actionItems(value.results)
  lines.push('## 需要你动手的')
  lines.push('')
  if (items.length === 0) {
    lines.push('这次没有需要你动手的项。')
    lines.push('')
  }
  if (items.length > 0) {
    for (const item of items) {
      lines.push(`### ${item.id} · ${item.title}（${LEVEL_LABEL[item.level] ?? item.level}）`)
      lines.push('')
      lines.push(`- 现象：${item.detail}`)
      if (item.evidence) lines.push(`- 证据：\`${String(item.evidence).replace(/\n/g, ' / ').slice(0, 300)}\``)
      if (item.fix?.note) lines.push(`- 说明：${item.fix.note}`)
      const commands = Array.isArray(item.fix.command) ? item.fix.command : [item.fix.command]
      lines.push('- 下一步：')
      lines.push('')
      lines.push('  ```bash')
      for (const command of commands) lines.push(`  ${command}`)
      lines.push('  ```')
      lines.push('')
    }
  }

  const appliedList = value.results.map((result) => result.applied).filter(Boolean)
  lines.push('## 已执行的修复')
  lines.push('')
  if (appliedList.length === 0) {
    lines.push('这次没有执行任何修复（体检本身不改环境）。')
    lines.push('')
  }
  if (appliedList.length > 0) {
    for (const applied of appliedList) {
      lines.push(`- ${applied.at} · **${applied.id}** · 结果：${applied.outcome}`)
      lines.push(`  - 执行：\`${applied.command}\``)
      lines.push(`  - 旧值（撤销依据）：\`${String(applied.before).replace(/\n/g, ' / ').slice(0, 300)}\``)
    }
    lines.push('')
  }

  lines.push('## 全部检查')
  lines.push('')
  lines.push('| id | 结论 | 级别 | 说明 |')
  lines.push('|---|---|---|---|')
  for (const result of value.results) {
    const icon = { ok: '✅ 通过', warn: '⚠️ 注意', fail: '❌ 失败', undiagnosed: '❔ 说不准' }[result.verdict]
    lines.push(`| ${result.id} | ${icon} | ${LEVEL_LABEL[result.level] ?? result.level} | ${String(result.detail).replace(/\|/g, '\\|')} |`)
  }
  lines.push('')

  lines.push('## 说不准的')
  lines.push('')
  if (value.undiagnosed.length === 0) {
    lines.push('没有说不准的项 —— 17 项这次都拿到了结论。')
    lines.push('')
  }
  if (value.undiagnosed.length > 0) {
    lines.push('这些项这次没法给出结论（通常是沙箱/权限导致观测失败）。它们不算坏，但也不算好：')
    lines.push('')
    for (const id of value.undiagnosed) {
      const result = value.results.find((entry) => entry.id === id)
      lines.push(`- **${id}** ${result?.title ?? ''}：${result?.detail ?? ''}`)
    }
    lines.push('')
  }

  lines.push('## 机器可读')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify(value, null, 2))
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

/** 写报告到磁盘（唯一允许的写盘动作，路径已由调用方校验为工作区内）。 */
export function writeReport(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, renderReport(value), 'utf8')
  return path
}
