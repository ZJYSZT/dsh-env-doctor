#!/usr/bin/env node
/**
 * dsh-env-doctor · 报告渲染原型（throwaway）
 *
 * 输入：sample-result.json —— 工具返回的规范值（canonical output）
 * 输出：sample-report.md     完整报告，工具写进 out
 *       sample-summary.md    render() 返回给模型的内容块文本（不落盘，这里落盘只为对照）
 *
 * 这份文件是未来 lib/report/render.mjs 的草稿：
 *   - renderSummary() 对应工具注册里的 output.render(args, value) → ContentBlock[]
 *   - renderReport()  对应「工具自己写完整报告」那一步
 * 设计要点：规范值是唯一事实来源，报告与摘要都由它生成，绝不各写一份。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const RESULT_FILE = join(HERE, 'sample-result.json')
export const REPORT_FILE = join(HERE, 'sample-report.md')
export const SUMMARY_FILE = join(HERE, 'sample-summary.md')

const VERDICT_LABEL = { ok: '通过', warn: '注意', fail: '失败', undiagnosed: '说不准' }
const LEVEL_LABEL = { info: '信息', low: '低危', medium: '中危', high: '高危' }
const GROUP_LABEL = {
  A: '\u6c99\u7bb1\u4e0e\u6587\u4ef6\u6743\u9650',
  B: 'Git Bash',
  C: '\u7f51\u7edc / TLS / \u51ed\u636e',
  D: '\u6267\u884c\u7b56\u7565',
  E: '\u5de5\u5177\u94fe',
  F: '\u6743\u9650\u4e0e\u5b89\u88c5\u901a\u9053',
}
/** 报告与摘要里「需要你动手的」排序：先高危，再看严重度。 */
const LEVEL_RANK = { high: 4, medium: 3, low: 2, info: 1 }

export function countByVerdict(value) {
  const counts = { ok: 0, warn: 0, fail: 0, undiagnosed: 0 }
  for (const r of value.results) counts[r.verdict] += 1
  return counts
}

export function overallVerdict(value) {
  const counts = countByVerdict(value)
  if (counts.fail > 0) return 'fail'
  if (counts.warn > 0) return 'warn'
  if (value.results.length > 0 && counts.undiagnosed === value.results.length) return 'undiagnosed'
  return 'ok'
}

/**
 * 规范值自洽性检查：counts / undiagnosed / verdict 三者必须与 results 一致。
 * 渲染器宁可抛错，也不生成一份自相矛盾的报告 —— 历史对比靠的就是这份数据。
 */
export function assertConsistent(value) {
  const computed = countByVerdict(value)
  for (const k of Object.keys(computed)) {
    if (value.counts[k] !== computed[k]) {
      throw new Error(`counts.${k} 与 results 不一致：声明 ${value.counts[k]}，实际 ${computed[k]}`)
    }
  }
  const undiagnosedIds = value.results.filter((r) => r.verdict === 'undiagnosed').map((r) => r.id)
  if (JSON.stringify(undiagnosedIds) !== JSON.stringify(value.undiagnosed)) {
    throw new Error(`undiagnosed 列表与 results 不一致：${JSON.stringify(value.undiagnosed)} vs ${JSON.stringify(undiagnosedIds)}`)
  }
  const overall = overallVerdict(value)
  if (value.verdict !== overall) {
    throw new Error(`verdict 与 results 不一致：声明 ${value.verdict}，应为 ${overall}`)
  }
}

/** 需要人动手的条目：先 fail，再 warn，各自按危险等级降序、按 id 升序。 */
export function actionItems(value) {
  const bad = value.results.filter((r) => r.verdict === 'fail' || r.verdict === 'warn')
  return bad.sort((a, b) => {
    const bySeverity = (a.verdict === 'fail' ? 0 : 1) - (b.verdict === 'fail' ? 0 : 1)
    if (bySeverity !== 0) return bySeverity
    const byLevel = (LEVEL_RANK[b.level] || 0) - (LEVEL_RANK[a.level] || 0)
    if (byLevel !== 0) return byLevel
    return a.id.localeCompare(b.id)
  })
}

function firstCommandLine(fix) {
  if (!fix || !fix.command) return null
  return fix.command.split('\n')[0]
}

/**
 * 给模型看的紧凑摘要（就是 output.render 的返回值）。刻意只有十来行：
 * 结论 + 最要紧的动作 + 说不准的项 + 全文路径，不把报告正文塞进上下文。
 */
export function summaryLines(value) {
  assertConsistent(value)
  const c = value.counts
  const lines = []
  lines.push(
    `体检完成：${value.results.length} 项检查 —— 通过 ${c.ok}、注意 ${c.warn}、失败 ${c.fail}、说不准 ${c.undiagnosed}。总体：${VERDICT_LABEL[value.verdict]}`,
  )
  const items = actionItems(value)
  if (items.length === 0) {
    lines.push('没有发现需要处理的问题。')
  } else {
    lines.push('')
    items.forEach((r, i) => {
      lines.push(`${i + 1}. [${LEVEL_LABEL[r.level]}] ${r.id} ${r.title}`)
      const cmd = firstCommandLine(r.fix)
      if (cmd) {
        const total = r.fix.command.split('\n').length
        lines.push(`   → ${cmd}${total > 1 ? `（共 ${total} 条命令，见报告）` : ''}`)
      } else {
        lines.push('   → 没有可直接执行的修复命令，见报告里的「为什么」')
      }
    })
  }
  if (value.undiagnosed.length > 0) {
    lines.push('')
    lines.push(`说不准：${value.undiagnosed.join('、')}（原因见报告）`)
  }
  lines.push(`全文：${value.reportPath}`)
  return lines
}

/** 工具注册里要的就是这个签名：render(args, value) → ContentBlock[] */
export function render(_args, value) {
  return [{ type: 'text', text: summaryLines(value).join('\n') }]
}

function fence(lang, text) {
  return ['```' + lang, String(text).replace(/\r\n/g, '\n').trimEnd(), '```']
}

/** 完整报告（人读）。故意不用表格塞长文本：每一处问题都配「现象 / 证据 / 下一步」。 */
export function renderReport(value) {
  assertConsistent(value)
  const c = value.counts
  const out = []
  out.push('# DSH 环境体检报告')
  out.push('')
  out.push('| 项 | 值 |')
  out.push('|---|---|')
  out.push(`| 生成时间 | ${value.generatedAt} |`)
  out.push(`| 沙箱模式 | \`${value.sandboxMode}\` |`)
  out.push(`| 工作区 | \`${value.workspaceRoot}\` |`)
  out.push(`| 总体结论 | **${VERDICT_LABEL[value.verdict]}** —— ${value.results.length} 项：通过 ${c.ok} / 注意 ${c.warn} / 失败 ${c.fail} / 说不准 ${c.undiagnosed} |`)
  out.push('')
  out.push('## 一句话结论')
  out.push('')
  const items = actionItems(value)
  if (items.length === 0) {
    out.push('没有发现需要处理的问题。')
  } else {
    const fails = value.results.filter((r) => r.verdict === 'fail')
    const says = fails.length > 0
      ? `有 ${fails.length} 项真的坏了（${fails.map((r) => r.id).join('、')}），先修它再谈别的`
      : `没有硬性故障，但有 ${items.length} 项值得处理`
    const und = value.undiagnosed.length > 0 ? `；另有 ${value.undiagnosed.length} 项说不准（${value.undiagnosed.join('、')}），不代表没问题` : ''
    out.push(`${says}${und}。`)
  }
  out.push('')
  out.push('## 需要你动手的（按优先级）')
  out.push('')
  if (items.length === 0) {
    out.push('（无）')
    out.push('')
  }
  for (const r of items) {
    out.push(`### ${r.id} · ${r.title} — ${LEVEL_LABEL[r.level]} · ${VERDICT_LABEL[r.verdict]}`)
    out.push('')
    out.push(`**现象与原因**：${r.detail}`)
    if (r.evidence) {
      out.push('')
      out.push('**证据**：')
      out.push('')
      out.push(...fence('text', r.evidence))
    }
    if (r.fix) {
      out.push('')
      out.push(`**下一步**（风险：${LEVEL_LABEL[r.fix.risk] || r.fix.risk}${r.fix.needsAdmin ? '，需要管理员' : ''}${r.fix.autoApplicable ? '，可以替你执行（执行前会再问一次）' : '，只给命令，不自动执行'}）：`)
      out.push('')
      out.push(...fence('bash', r.fix.command))
      if (r.fix.note) {
        out.push('')
        out.push(`> ${r.fix.note}`)
      }
    }
    out.push('')
  }
  out.push('## 全部检查')
  out.push('')
  out.push('| # | 检查 | 结果 | 等级 |')
  out.push('|---|---|---|---|')
  for (const r of value.results) {
    out.push(`| ${r.id} | ${r.title} | ${VERDICT_LABEL[r.verdict]} | ${LEVEL_LABEL[r.level]} |`)
  }
  out.push('')
  out.push('### 分组')
  out.push('')
  for (const g of Object.keys(GROUP_LABEL)) {
    const rows = value.results.filter((r) => r.group === g)
    if (rows.length === 0) continue
    const bad = rows.filter((r) => r.verdict === 'fail' || r.verdict === 'warn').length
    out.push(`- **${g} ${GROUP_LABEL[g]}** —— ${rows.length} 项${bad > 0 ? `，其中 ${bad} 项要处理` : '，全部正常'}`)
  }
  out.push('')
  out.push('## 说不准的')
  out.push('')
  if (value.undiagnosed.length === 0) {
    out.push('（无）')
  } else {
    for (const id of value.undiagnosed) {
      const r = value.results.find((x) => x.id === id)
      out.push(`- **${id} · ${r.title}** —— ${r.detail}`)
    }
  }
  out.push('')
  out.push('## 机器可读')
  out.push('')
  const jsonPath = value.reportPath.replace(/\.md$/i, '.json')
  out.push(`同目录的 \`${jsonPath.split(/[\\/]/).pop()}\` 是本次结果的规范值（与工具返回值同一份数据），历史对比直接比它；格式见 \`docs/prototypes/report/report.schema.json\`。`)
  out.push('')
  return out.join('\n')
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const value = JSON.parse(readFileSync(RESULT_FILE, 'utf8'))
  assertConsistent(value)
  const report = renderReport(value)
  const summary = render({}, value)[0].text
  writeFileSync(REPORT_FILE, report.endsWith('\n') ? report : report + '\n', 'utf8')
  writeFileSync(SUMMARY_FILE, summary + '\n', 'utf8')
  console.log(`report  → ${REPORT_FILE} (${report.length} chars)`)
  console.log(`summary → ${SUMMARY_FILE} (${summary.length} chars)`)
}
