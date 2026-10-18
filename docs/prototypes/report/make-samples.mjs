#!/usr/bin/env node
/**
 * 用真正的渲染器（lib/report.js）重新生成示例产物。
 *
 * 规范值（sample-result.json）一改就重跑这个脚本；否则 verify.mjs 会报
 * 「sample-report.md 与当前渲染结果不同 —— 规范值改了但没重新生成」。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertConsistent, render, renderReport } from '../../../lib/report.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const value = JSON.parse(readFileSync(join(HERE, 'sample-result.json'), 'utf8'))

// 先自检：不一致就别落盘，免得把错的样例写出去
assertConsistent(value)

const report = renderReport(value)
writeFileSync(join(HERE, 'sample-report.md'), report.endsWith('\n') ? report : `${report}\n`)
writeFileSync(join(HERE, 'sample-summary.md'), `${render({}, value)[0].text}\n`)

console.log('已重新生成 sample-report.md（人读）与 sample-summary.md（工具返回的摘要）')
