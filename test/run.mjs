// 自测：单元层用「假 shell」把每条命令的回答喂成固定值，验证
//   ① 注册形状 / schema / 护栏  ② 17 项齐全  ③ 报告与摘要落盘  ④ 只读保证  ⑤ 没有执行通道时的降级
// 真环境的探测不靠这份测试证明 —— 那一层用一次性 profile 跑 headless 端到端（见 docs/IMPLEMENTATION.md）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 宿主的真校验器：校验我们用到的 JSON Schema 子集，防止自造「看起来对」的 schema。
const hostValidator = await import(
  pathToFileURL(
    'C:/Users/神/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js',
  ).href
)
const { assertSupportedJsonSchema, validateJsonSchemaValue } = hostValidator

import { apply } from '../lib/tools.js'
import { createProbe } from '../lib/probe.js'
import { CHECKS } from '../lib/checks.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')
const devRoot = path.resolve(packageRoot, '..')

let passed = 0
let failed = 0
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`PASS  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

// ---------- 假 shell：按命令前缀返回固定输出 ----------
const ACL_TEXT = [
  'C:\\Users\\神\\Documents\\deepseek-harness\\default-workspace LAPTOP\\神:(I)(OI)(CI)(F)',
  '                                                           Everyone:(CI)(DENY)(DC)',
  '                                                           S-1-4-803020457-741359850:(OI)(CI)(W,D,DC)',
  '                                                           LAPTOP\\CodexSandboxUsers:(I)(OI)(CI)(RX)',
  '                                                           Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)',
  '',
  '成功处理 1 个文件；处理 0 个文件时失败',
].join('\r\n')

const FIXTURES = [
  [/^where git$/, { code: 0, stdout: 'C:\\fake\\git\\cmd\\git.exe\r\n' }],
  [/^where node$/, { code: 0, stdout: 'C:\\fake\\node\\node.exe\r\n' }],
  [/^where npm$/, { code: 0, stdout: 'C:\\fake\\node\\npm.cmd\r\n' }],
  [/^where pnpm$/, { code: 0, stdout: 'C:\\fake\\pnpm\\pnpm.cmd\r\n' }],
  [/^where gh$/, { code: 0, stdout: 'C:\\fake\\gh\\gh.exe\r\n' }],
  [/^where python$/, { code: 0, stdout: 'C:\\fake\\python\\python.exe\r\n' }],
  [/^where bash$/, { code: 1, stdout: '', stderr: 'INFO: Could not find files for the given pattern(s).\r\n' }],
  [/-lc "echo MSYS_OK"$/, { code: 0, stdout: 'MSYS_OK\r\n' }],
  [/^where scoop$/, { code: 1, stdout: '', stderr: 'INFO: Could not find files for the given pattern(s).\r\n' }],
  [/^dsh --version$/, { code: 0, stdout: '0.2.0-rc.2\r\n' }],
  [/^icacls /, { code: 0, stdout: ACL_TEXT }],
  [/^git config --global --get http\.proxy$/, { code: 1, stdout: '' }],
  [/^git config --global --get-all credential\.https:\/\/github\.com\.helper$/, { code: 0, stdout: "!'C:\\Users\\神\\AppData\\Local\\Programs\\GitHub CLI\\bin\\gh.exe' auth git-credential\r\n" }],
  [/^npm config get proxy$/, { code: 0, stdout: 'null\r\n' }],
  [/^npm config get https-proxy$/, { code: 0, stdout: 'null\r\n' }],
  [/^Get-ExecutionPolicy|^powershell\.exe -NoProfile -Command Get-ExecutionPolicy$/, { code: 0, stdout: 'Restricted\r\n' }, 'all'],
  [/Get-ExecutionPolicy -Scope CurrentUser$/, { code: 0, stdout: 'Undefined\r\n' }],
  [/IsInRole\(/, { code: 0, stdout: 'False\r\n' }],
  [/^winget --version$/, { code: -1978335231, stdout: '', stderr: '' }],
  [/^choco --version$/, { code: 0, stdout: '2.7.4\r\n' }],
  [/^pnpm --version$/, { code: 0, stdout: '12.8.1\r\n' }],
  [/^python --version$/, { code: 0, stdout: 'Python 3.14.4\r\n' }],
  [/^reg query .*LongPathsEnabled$/, { code: 0, stdout: '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\r\n    LongPathsEnabled    REG_DWORD    0x0\r\n\r\n' }],
  [/^curl\.exe /, { code: 0, stdout: '' }],
]

function fixtureFor(command) {
  for (const [pattern, answer] of FIXTURES) {
    if (pattern.test(command)) return answer
  }
  return { code: 0, stdout: '' }
}

const executedCommands = []
const fakeShell = {
  sandboxMode: 'workspace-write',
  resolve(request) {
    return { command: request.command, workdir: devRoot, timeoutMs: request.timeoutMs ?? 10_000 }
  },
  async execute(spec) {
    executedCommands.push(spec.command)
    const answer = fixtureFor(spec.command)
    return {
      async result() {
        return {
          exitCode: answer.code,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: spec.timeoutMs,
          stdout: { text: answer.stdout ?? '', truncated: false },
          stderr: { text: answer.stderr ?? '', truncated: false },
        }
      },
    }
  },
}

// ---------- 1. 注册形状 ----------
let registered = null
const guards = []
const ctx = {
  tools: {
    register(definition) {
      registered = definition
      return () => {}
    },
    guard(guard) {
      guards.push(guard)
      return () => {}
    },
  },
  sandboxPolicy: {
    resolve() {
      return { mode: 'workspace-write', workspaceRoot: devRoot }
    },
  },
  get(name) {
    return name === 'shell' ? fakeShell : undefined
  },
}

apply(ctx)

check('工具已注册且名字正确', registered?.name === 'dsh_env_doctor')
assertSupportedJsonSchema(registered.parameters)
check('parameters 是合法 JSON Schema（宿主窄子集）', true)
check('护栏已挂上', guards.length === 1)

const guard = guards[0]
check('护栏：fix 缺 confirm 被拒', typeof guard({ toolName: 'dsh_env_doctor', arguments: { mode: 'fix', fix: { id: 'B.2' } } }) === 'string')
check('护栏：非白名单 id 被拒', typeof guard({ toolName: 'dsh_env_doctor', arguments: { mode: 'fix', fix: { id: 'A.3', confirm: true } } }) === 'string')
check('护栏：合法 fix 放行', guard({ toolName: 'dsh_env_doctor', arguments: { mode: 'fix', fix: { id: 'B.2', confirm: true } } }) === undefined)
check('护栏：check 模式不受影响', guard({ toolName: 'dsh_env_doctor', arguments: { mode: 'check' } }) === undefined)
check('未知检查项报错（不猜）', await throws(() => registered.execute({ checks: 'Z.9' }, {})))
check('17 项检查齐全', CHECKS.length === 17)

// ---------- 2. 只读保证：写命令一律拒绝 ----------
const guardProbe = createProbe({ checkId: 'C.2', workspaceRoot: devRoot, shell: fakeShell })
for (const command of [
  'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned',
  'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f',
  'icacls "C:\\work" /grant Users:(F)',
  'git config --global credential.helper manager',
  'npm install -g pnpm',
]) {
  check(`只读拒绝：${command.slice(0, 34)}`, await throws(() => guardProbe.read(command)))
}
check('只读放行：icacls 只读查询', !(await throws(() => guardProbe.read('icacls "C:\\work"'))))

// ---------- 3. 跑 17 项（假 shell） ----------
const startedAt = Date.now()
const value = await registered.execute({}, { agent: undefined })
const elapsed = Date.now() - startedAt
validateJsonSchemaValue(registered.output.schema, value)
check('返回值通过 output.schema 校验', true)
check('results 是 17 条', value.results.length === 17)
check('counts 自洽', value.counts.ok + value.counts.warn + value.counts.fail + value.counts.undiagnosed === 17)
check(`报告文件已写入且含五个区块`, hasFiveBlocks(value.reportPath))
check('摘要 ≤14 行', registered.output.render({}, value)[0].text.split('\n').length <= 14)
check('out 指向工作区外被拒', await throws(() => registered.execute({ out: 'C:\\Windows\\Temp\\x.md' }, {})))
check('每条 warn/fail 都有下一步', value.results.filter((r) => r.verdict === 'warn' || r.verdict === 'fail').every((r) => r.fix))

// ---------- 4. 没有执行通道时的降级（不能假装 ok） ----------
const noShellCtx = { ...ctx, get: () => undefined }
let noShellTool = null
noShellCtx.tools = { register: (definition) => { noShellTool = definition }, guard: () => () => {} }
apply(noShellCtx)
const degraded = await noShellTool.execute({ checks: 'all' }, {})
const degradedOk = degraded.results.filter((r) => r.verdict === 'ok').map((r) => r.id)
check('无 shell 时命令类检查全部 undiagnosed', degraded.results.filter((r) => r.verdict === 'undiagnosed').length >= 14)
check('无 shell 时只有 A.1/A.2/C.1 可能 ok', degradedOk.every((id) => ['A.1', 'A.2', 'C.1'].includes(id)))

// ---------- 5. 结果明细 ----------
console.log(`\n--- 假 shell 跑 17 项 · 耗时 ${(elapsed / 1000).toFixed(1)}s · 结论 ${value.verdict} · ${JSON.stringify(value.counts)} ---`)
for (const result of value.results) {
  console.log(`${result.verdict.padEnd(11)} ${result.id.padEnd(4)} ${result.detail.replace(/\s+/g, ' ').slice(0, 90)}`)
}
console.log('\n摘要：')
console.log(registered.output.render({}, value)[0].text)
console.log(`\n共执行 ${executedCommands.length} 条命令；报告：${value.reportPath}`)
console.log(`\nPASS ${passed} / FAIL ${failed}`)
process.exitCode = failed === 0 ? 0 : 1

// ---------- helpers ----------
async function throws(fn) {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}

function hasFiveBlocks(reportPath) {
  try {
    const text = fs.readFileSync(reportPath, 'utf8')
    return ['总体结论', '需要你动手的', '全部检查', '说不准的', '机器可读'].every((marker) => text.includes(marker))
  } catch {
    return false
  }
}
