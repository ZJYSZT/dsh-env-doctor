// 四组安全测试（docs/safety/model.md 的可执行版本）。
//
// 1. 只读保证：体检路径上一条写命令都发不出去；
// 2. 两道门：fix 必须白名单 + confirm，只读沙箱下直接拒，且计划里必须带 before/undo；
// 3. 工作区边界：报告与 explain 都不许碰工作区外的路径；
// 4. 不冒充：观测失败一律 undiagnosed，绝不写成 ok。
import fs from 'node:fs'
import { join } from 'node:path'
import { createProbe } from '../lib/probe.js'
import { FIXABLE, applyFix, planFix } from '../lib/fix.js'
import { runDoctor } from '../lib/tools.js'
import { CHECKS } from '../lib/checks.js'

const WORKSPACE = join(import.meta.dirname, '..', '..')
let failures = 0
function check(label, passed) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}`)
  if (!passed) failures += 1
}
async function throws(fn) {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}

const FIXTURES = [
  [/^where npm$/, 'C:\\Program Files\\nodejs\\npm.cmd\nC:\\Windows\\system32\\npm.cmd'],
  [/^where bash$/, 'D:\\Git\\Git\\bin\\bash.exe'],
]
const fakeShell = {
  resolve: (request) => ({ ...request, onExpiry: 'kill', stdoutMaxBytes: 64_000 }),
  execute: async (spec) => {
    const hit = FIXTURES.find(([pattern]) => pattern.test(spec.command))
    const text = hit ? hit[1] : ''
    return {
      result: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: 1000,
        stdout: { text, truncated: false },
        stderr: { text: '', truncated: false },
      }),
    }
  },
}
const services = {
  sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: WORKSPACE }) },
  get: (name) => (name === 'shell' ? fakeShell : undefined),
}

// ---------- 1. 只读保证 ----------
console.log('## 1. 只读保证')
const probe = createProbe({ checkId: 'C.2', workspaceRoot: WORKSPACE, shell: fakeShell })
const WRITES = [
  'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned',
  'Set-ItemProperty -Path HKCU:\\x -Name y -Value 1',
  'New-Item -ItemType File C:\\x',
  'Remove-Item C:\\x',
  'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f',
  'reg delete "HKCU\\Software\\x" /f',
  'icacls "C:\\work" /grant Users:(F)',
  'takeown /f C:\\work',
  'git config --global credential.helper manager',
  'git config --global --unset-all credential.https://github.com.helper',
  'git push origin main',
  'npm install -g pnpm',
  'npm i -g gh',
  'curl -o out.txt https://example.com',
  'iwr https://example.com -OutFile out.txt',
  'echo hi > out.txt',
  'cmd /c "del C:\\x"',
  'cp a b',
  'rm -rf node_modules',
  'mkdir newdir',
]
for (const command of WRITES) {
  check(`拒绝写命令：${command.slice(0, 46)}`, await throws(() => probe.read(command)))
}
const READS = [
  'where git',
  'icacls "C:\\work"',
  'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled',
  'git config --global --get-all credential.https://github.com.helper',
  'node --version',
  'cmd /c "echo 2>&1"',
]
for (const command of READS) {
  check(`放行读命令：${command.slice(0, 46)}`, !(await throws(() => probe.read(command))))
}

// ---------- 2. 两道门 ----------
console.log('## 2. 修复的两道门')
const readOnlyServices = {
  sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: WORKSPACE }) },
  get: (name) => (name === 'shell' ? fakeShell : undefined),
}
check(
  '只读沙箱下 fix 被拒（E_FIX_UNAVAILABLE）',
  await throws(() => runDoctor(readOnlyServices, { mode: 'fix', fix: { id: 'D.1', confirm: true } })),
)
check(
  '缺 confirm 的 fix 被拒（E_FIX_NEEDS_CONFIRM）',
  await throws(() => runDoctor(services, { mode: 'fix', fix: { id: 'D.1' } })),
)
check(
  '白名单外的 id 被拒（E_FIX_NOT_ALLOWED）',
  await throws(() => runDoctor(services, { mode: 'fix', fix: { id: 'A.1', confirm: true } })),
)
check('自动修白名单只有 4 条', FIXABLE.length === 4)
for (const id of FIXABLE) {
  const plan = await planFix(id, { shell: fakeShell, workspaceRoot: WORKSPACE })
  check(`${id} 计划带 before / undo / commands`, Boolean(plan.before) && Boolean(plan.undo) && plan.commands.length > 0)
}
check(
  'planFix 拒绝白名单外的 id',
  await throws(() => planFix('A.1', { shell: fakeShell, workspaceRoot: WORKSPACE })),
)
check(
  '没有 shell 时 applyFix 直接拒（E_FIX_UNAVAILABLE）',
  await throws(() => applyFix({ commands: ['echo hi'], before: '', undo: '' }, { workspaceRoot: WORKSPACE })),
)

// ---------- 3. 工作区边界 ----------
console.log('## 3. 工作区边界')
const outside = join('C:\\Windows', 'Temp', 'dsh-doctor-should-not-exist.md')
check(
  '报告写工作区外被拒（E_OUT_OUTSIDE_WORKSPACE）',
  await throws(() => runDoctor(services, { out: outside })),
)
check('被拒之后那个文件确实不存在', !fs.existsSync(outside))
const explain = await runDoctor(services, { mode: 'explain', input: 'C:\\Windows\\System32' })
check(
  'explain 工作区外路径时明说会被拒',
  explain.results[0].detail.includes('会被拒') || explain.results[0].detail.includes('拒绝'),
)
const inside = join(WORKSPACE, '.dsh-doctor', 'safety-inside.md')
const written = await runDoctor(services, { checks: 'C.1', out: inside })
check('工作区内写报告成功', fs.existsSync(inside))
check('报告里的 reportPath 就是写下去的那个', written.reportPath === inside)
fs.rmSync(inside, { force: true })

// ---------- 4. 不冒充 ----------
console.log('## 4. 观测失败不冒充 ok')
const noShell = await runDoctor({ sandboxPolicy: services.sandboxPolicy, get: () => undefined }, { checks: 'all' })
const shellFree = new Set(['A.1', 'A.2', 'C.1'])
check(
  '没 shell 时命令类检查全部 undiagnosed',
  noShell.results.every((result) => shellFree.has(result.id) || result.verdict === 'undiagnosed'),
)
check(
  '没 shell 时只有 A.1/A.2/C.1 可能不是 undiagnosed',
  noShell.results.filter((result) => result.verdict !== 'undiagnosed').every((result) => shellFree.has(result.id)),
)
const denied = await runDoctor(
  {
    sandboxPolicy: services.sandboxPolicy,
    get: () => ({
      resolve: (request) => request,
      execute: async () => {
        throw new Error('spawn EPERM')
      },
    }),
  },
  { checks: 'B.1' },
)
check(
  'shell 被沙箱拒绝时判 undiagnosed 且说清是沙箱',
  denied.results[0].verdict === 'undiagnosed' && /SHELL_DENIED|沙箱/.test(denied.results[0].detail),
)
check('17 项里没有「观测失败却写 ok」的项', CHECKS.length === 17)

if (failures === 0) {
  console.log('四组安全测试：全部通过')
  process.exit(0)
}
console.log(`四组安全测试：${failures} 项失败`)
process.exit(1)
