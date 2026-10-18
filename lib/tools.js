// 工具行：注册 dsh_env_doctor（check / explain / fix 三模式）。
//
// 三道关（安全模型 docs/safety/model.md §3）：
//   1. 参数层：fix 必须是 { id: 白名单, confirm: true }，schema 用 enum + const 直接挡；
//   2. 护栏：ctx.tools.guard 是单调护栏，只能 deny、不能被别的插件放宽 —— 这是机械保证；
//   3. 沙箱模式：read-only 下 fix 直接 E_FIX_UNAVAILABLE，不尝试升级。
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createProbe } from './probe.js'
import { getCheck, selectChecks } from './checks.js'
import {
  SCHEMA_VERSION,
  assertConsistent,
  countByVerdict,
  overallVerdict,
  render,
  valueSchema,
  writeReport,
} from './report.js'
import { FIXABLE, applyFix, planFix } from './fix.js'

export const name = 'dsh-env-doctor-tools'

export const inject = ['tools', 'sandboxPolicy']

const TOOL_NAME = 'dsh_env_doctor'
const MAX_DETAIL = 600
const MAX_EVIDENCE = 400

/** 从宿主的沙箱策略里拿 { mode, workspaceRoot }；拿不到就是 unknown（不猜）。 */
function resolvePolicy(ctx, exec) {
  try {
    const policy = ctx.sandboxPolicy.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session })
    return { mode: policy?.mode ?? 'unknown', workspaceRoot: policy?.workspaceRoot ?? process.cwd() }
  } catch {
    return { mode: 'unknown', workspaceRoot: process.cwd() }
  }
}

function normalizeFix(fix) {
  if (!fix) return undefined
  const command = Array.isArray(fix.command) ? fix.command.join('\n') : String(fix.command ?? '')
  return {
    command,
    risk: fix.risk ?? 'medium',
    needsAdmin: fix.needsAdmin === true,
    autoApplicable: fix.autoApplicable === true,
    ...(fix.note ? { note: String(fix.note) } : {}),
  }
}

/** 逐项跑检查；单项抛错只把这一项判 undiagnosed，不连累整份报告。 */
async function runChecks(selected, env) {
  const results = []
  // 没有命令执行通道时，除 A.1/A.2（纯 fs 探针）与 C.1（进程内 fetch）之外，
  // 其余检查都无法观测 —— 显式记 undiagnosed，绝不把「没测到」写成 ok。
  const shellFree = new Set(['A.1', 'A.2', 'C.1'])
  for (const check of selected) {
    if (!env.shell && !shellFree.has(check.id)) {
      results.push({
        id: check.id,
        group: check.group,
        title: check.title,
        verdict: 'undiagnosed',
        level: check.level,
        detail: '宿主没有提供 ctx.shell，这条检查没法观测（不代表环境有问题）',
      })
      continue
    }
    const probe = createProbe({ checkId: check.id, workspaceRoot: env.workspaceRoot, home: env.home, shell: env.shell })
    let outcome
    try {
      outcome = await check.run(probe, env)
    } catch (error) {
      outcome = {
        verdict: 'undiagnosed',
        detail: `检查自身出错（不代表环境坏）：${error?.message ?? String(error)}`,
      }
    }
    results.push({
      id: check.id,
      group: check.group,
      title: check.title,
      verdict: outcome.verdict,
      level: check.level,
      detail: String(outcome.detail ?? '').slice(0, MAX_DETAIL),
      ...(outcome.evidence ? { evidence: String(outcome.evidence).slice(0, MAX_EVIDENCE) } : {}),
      ...(outcome.fix ? { fix: normalizeFix(outcome.fix) } : {}),
    })
  }
  return results
}

/** 组装规范值 + 自洽检查 + 写报告（报告路径必须落在工作区内）。 */
function finish({ mode, results, env, generatedAt, out, applied }) {
  const counts = countByVerdict(results)
  const value = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    mode,
    sandboxMode: env.sandboxMode ?? 'unknown',
    workspaceRoot: env.workspaceRoot,
    reportPath: '',
    verdict: overallVerdict(results),
    counts,
    results,
    undiagnosed: results.filter((result) => result.verdict === 'undiagnosed').map((result) => result.id),
  }

  if (applied) {
    const target = value.results.find((result) => result.id === applied.id)
    if (target) target.applied = applied
  }

  const stamp = generatedAt.replace(/[:.]/g, '-')
  const target = out
    ? resolve(String(out))
    : join(env.workspaceRoot, '.dsh-doctor', `report-${stamp}.md`)
  const rel = relative(env.workspaceRoot, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`E_OUT_OUTSIDE_WORKSPACE: 报告只能写在工作区内（${env.workspaceRoot}），拒绝写 ${target}`)
  }
  value.reportPath = target

  assertConsistent(value)
  try {
    writeReport(target, value)
  } catch (error) {
    value.reportPath = `${target}（写入失败：${error?.message ?? String(error)}）`
  }
  return value
}

export function apply(ctx) {
  const tools = ctx.tools

  // 单调护栏：fix 必须显式确认、且 id 在白名单。护栏只会 deny —— 别的插件无法把它放宽。
  if (typeof tools.guard === 'function') {
    tools.guard((exec) => {
      const toolName = exec?.toolName ?? exec?.name
      if (toolName !== TOOL_NAME) return undefined
      const args = exec?.arguments ?? exec?.args ?? exec?.input
      if (args?.mode !== 'fix') return undefined
      if (args?.fix?.confirm !== true) {
        return 'fix 模式必须显式传 fix.confirm = true（第一道门：用户已明确同意）'
      }
      if (!FIXABLE.includes(args?.fix?.id)) {
        return `fix.id=${args?.fix?.id} 不在自动修白名单（${FIXABLE.join(' / ')}）`
      }
      return undefined
    })
  }

  tools.register({
    name: TOOL_NAME,
    description:
      '给 Windows 上的 DSH 环境做体检（A 沙箱/ACL、B Git Bash、C 网络/TLS/凭据、D 执行策略、E 工具链、F 权限与安装通道），返回结构化结论与可执行命令。' +
      'mode=check 只读探测（默认）；mode=explain 解释某个检查项或某条路径为什么被拦；mode=fix 执行白名单里的 4 条修复（B.2/C.4/D.1/E.3），' +
      '必须先经用户明确同意并在参数里传 fix.confirm=true。报告默认写到 <workspaceRoot>/.dsh-doctor/report-<时间戳>.md。',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['check', 'explain', 'fix'],
          description: '默认 check（只读）。explain 需要 input。fix 需要 fix 对象。',
        },
        checks: {
          type: 'string',
          description: '要跑哪些检查：默认 "all"；可写组字母 "A" 或逗号分隔的 id 列表 "A.1,C.4"。未知 id 会报错而不是猜。',
        },
        out: {
          type: 'string',
          description: '报告路径，默认 <workspaceRoot>/.dsh-doctor/report-<时间戳>.md；拒绝写工作区外。',
        },
        input: {
          type: 'string',
          description: 'explain 模式的输入：检查项 id（如 "A.1"）或一个路径。',
        },
        fix: {
          type: 'object',
          properties: {
            id: { type: 'string', enum: ['B.2', 'C.4', 'D.1', 'E.3'] },
            confirm: { type: 'boolean', const: true },
          },
          required: ['id', 'confirm'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    timeoutMs: 120_000,
    output: {
      schema: valueSchema,
      render,
    },
    async execute(args, exec) {
      const mode = args?.mode === 'fix' ? 'fix' : args?.mode === 'explain' ? 'explain' : 'check'
      const policy = resolvePolicy(ctx, exec)
      const env = {
        sandboxMode: policy.mode,
        workspaceRoot: policy.workspaceRoot,
        home: homedir(),
        // ctx.get 不抛错也不等待：服务还没挂上就是 undefined，检查项据此走 undiagnosed。
        shell: ctx.get('shell'),
      }
      const generatedAt = new Date().toISOString()

      if (mode === 'check') {
        const selected = selectChecks(args?.checks)
        const results = await runChecks(selected, env)
        return finish({ mode, results, env, generatedAt, out: args?.out })
      }

      if (mode === 'explain') {
        const input = String(args?.input ?? '').trim()
        if (!input) throw new Error('E_EXPLAIN_NEEDS_INPUT: explain 模式需要 input（检查项 id 或路径）')
        const check = getCheck(input)
        if (check) {
          const results = await runChecks([check], env)
          const first = results[0]
          const note = first.fix?.note ? ` · 说明：${first.fix.note}` : ''
          first.detail = `【explain】${first.detail}${note} · 当前沙箱模式=${env.sandboxMode}`
          return finish({ mode, results, env, generatedAt, out: args?.out })
        }
        const target = resolve(input)
        const rel = relative(env.workspaceRoot, target)
        const inside = !(rel.startsWith('..') || isAbsolute(rel))
        const allowed = inside || env.sandboxMode === 'danger-full-access'
        const detail = inside
          ? `${target} 在工作区内 · 沙箱模式=${env.sandboxMode} → ${allowed ? '允许' : '拒绝'}`
          : `${target} 在工作区外 · 沙箱模式=${env.sandboxMode} → ${allowed ? '允许（danger-full-access）' : '会被拒（需要一次性升级 sandbox_permissions）'}`
        return finish({
          mode,
          results: [
            {
              id: 'POLICY',
              group: 'A',
              title: '路径与沙箱模式',
              verdict: 'ok',
              level: 'info',
              detail,
            },
          ],
          env,
          generatedAt,
          out: args?.out,
        })
      }

      // fix
      const id = args?.fix?.id
      if (args?.fix?.confirm !== true) {
        throw new Error('E_FIX_NEEDS_CONFIRM: fix 模式必须显式传 fix.confirm = true（先拿到用户明确同意）')
      }
      if (!FIXABLE.includes(id)) {
        throw new Error(`E_FIX_NOT_ALLOWED: ${id} 不在自动修白名单（${FIXABLE.join(' / ')}）；这一项只给命令`)
      }
      if (env.sandboxMode === 'read-only') {
        throw new Error('E_FIX_UNAVAILABLE: 当前是只读沙箱，修需要更宽的模式；本插件不会尝试升级')
      }

      const fixContext = { shell: env.shell, workspaceRoot: env.workspaceRoot }
      const plan = await planFix(id, fixContext)
      const outcome = await applyFix(plan, fixContext)
      const check = getCheck(id)
      const results = check ? await runChecks([check], env) : []
      const applied = {
        at: new Date().toISOString(),
        id,
        command: outcome.command,
        before: String(outcome.before ?? ''),
        outcome: outcome.outcome,
      }
      if (outcome.outcome === 'failed') {
        const stderr = outcome.outputs.map((entry) => entry.stderr).filter(Boolean).join(' / ')
        const target = results[0]
        if (target) {
          target.verdict = 'fail'
          target.detail = `修复执行了但失败：${stderr || outcome.command}`.slice(0, MAX_DETAIL)
          target.fix = normalizeFix({
            command: outcome.undo,
            risk: 'low',
            needsAdmin: false,
            autoApplicable: false,
            note: '已按上面的命令尝试过；若要回退，用 undo 命令（旧值见 applied.before）。',
          })
        }
      }
      return finish({ mode, results, env, generatedAt, out: args?.out, applied })
    },
  })
}

/**
 * 直调入口：给本仓库的 e2e 与宿主自检用，走的是同一个 execute（同一份定义、同一套检查）。
 *
 * 唯一的区别是不经过 tools.register —— 也就是说没有护栏。护栏保护的是「模型调用面」
 * （docs/safety/model.md 第二道门）；进程内自检本来就是可信调用方。
 * 生产环境永远走 apply(ctx) → ctx.tools.register()。
 *
 * @param services - 只需要两个服务：`sandboxPolicy.resolve(request)` 与 `get('shell')`。
 */
export async function runDoctor(services, args, exec = {}) {
  let definition
  const bag = {
    tools: {
      register: (candidate) => {
        definition = candidate
        return () => {}
      },
      guard: () => () => {},
    },
    sandboxPolicy: services?.sandboxPolicy,
    get: (service) => services?.get?.(service),
  }
  apply(bag)
  if (!definition) throw new Error('E_DOCTOR_NOT_DEFINED: 工具定义没有生成')
  return definition.execute(args, exec)
}
