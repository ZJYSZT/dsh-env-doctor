// 修复：只有 4 条白名单动作，全部用户级、可逆，且必须带 before（撤销依据）。
//
// 这一支不在体检路径上：它由 lib/tools.js 在过了「用户确认 + 护栏 + 沙箱模式」三道关之后才调用，
// 而且一次只修一条（没有「一次调用改 4 处」）。
//
// 所有命令都经宿主 ctx.shell 跑（不自己 spawn）；PowerShell 一律用 -EncodedCommand，
// 免得 cmd 与 bash 的引号/反斜杠规则差异把命令改坏。
import fs from 'node:fs'
import { execCommand } from './probe.js'

export const FIXABLE = ['B.2', 'C.4', 'D.1', 'E.3']

export const FIX_TITLES = {
  'B.2': '把 bash 所在目录追加进用户级 PATH',
  'C.4': '删掉失效的 git 凭据助手行，并用 gh 重写',
  'D.1': '把 CurrentUser 的执行策略改成 RemoteSigned',
  'E.3': '把 .cmd 所在目录提到用户级 PATH 前面',
}

/** 用 -EncodedCommand 发 PowerShell：绕开 cmd/quotes 嵌套的坑（UTF-16LE base64）。 */
export function psCommand(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return `powershell.exe -NoProfile -EncodedCommand ${encoded}`
}

function contextOf(options) {
  const shell = options?.shell
  const workspaceRoot = options?.workspaceRoot ?? process.cwd()
  if (!shell || typeof shell.resolve !== 'function') {
    throw new Error('E_FIX_UNAVAILABLE: 宿主没有提供 ctx.shell，无法执行修复')
  }
  return { shell, workspaceRoot }
}

async function run(options, command, timeoutMs = 20_000) {
  const { shell, workspaceRoot } = contextOf(options)
  return execCommand({ shell, command, workdir: workspaceRoot, timeoutMs })
}

async function ps(options, script, timeoutMs = 20_000) {
  return run(options, psCommand(script), timeoutMs)
}

export async function readUserPath(options) {
  const result = await ps(options, `[Environment]::GetEnvironmentVariable('Path','User')`)
  return result.code === 0 ? result.stdout.trim() : ''
}

async function findBash(options) {
  const where = await run(options, 'where bash')
  if (where.code === 0) {
    const first = where.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    if (first) return first
  }
  const known = 'D:\\Git\\Git\\bin\\bash.exe'
  return fs.existsSync(known) ? known : null
}

/** 生成修复计划：先算出 before（旧值原文）、要执行的命令、以及撤销命令。 */
export async function planFix(id, options) {
  contextOf(options)
  if (!FIXABLE.includes(id)) {
    throw new Error(`E_FIX_NOT_ALLOWED: ${id} 不在白名单（只允许 ${FIXABLE.join('/')}）`)
  }

  if (id === 'B.2') {
    const bash = await findBash(options)
    if (!bash) throw new Error('E_FIX_PRECONDITION: 没找到 bash，无法决定要追加哪个目录')
    const dir = bash.replace(/[\\/][^\\/]+$/, '')
    const before = await readUserPath(options)
    return {
      id,
      title: FIX_TITLES[id],
      commands: [
        psCommand(
          `$p=[Environment]::GetEnvironmentVariable('Path','User'); if ($p -notlike '*${dir}*') { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';${dir}'), 'User') }`,
        ),
      ],
      before: before || '(空)',
      undo: psCommand(`[Environment]::SetEnvironmentVariable('Path','${before.replace(/'/g, "''")}','User')`),
      note: `只追加 ${dir}；已存在则不动。`,
    }
  }

  if (id === 'C.4') {
    const current = await run(options, 'git config --global --get-all credential.https://github.com.helper')
    const before = current.code === 0 ? current.stdout.trim() || '(未配置)' : '(未配置)'
    return {
      id,
      title: FIX_TITLES[id],
      commands: ['git config --global --unset-all credential.https://github.com.helper', 'gh auth setup-git'],
      before,
      undo:
        before
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => `git config --global --add credential.https://github.com.helper "${line.replace(/"/g, '\\"')}"`)
          .join(' && ') || '（原本未配置，撤销就是保持不配置）',
      note: '只删 github.com 的 helper 行；gh auth setup-git 会重写一份指向现有 gh.exe 的。',
    }
  }

  if (id === 'D.1') {
    const current = await ps(options, '[Security.PowerShell.ExecutionPolicy]::GetExecutionPolicy -Scope CurrentUser')
    const before = current.code === 0 ? current.stdout.trim() : '(未知)'
    const effective = await ps(options, '[Security.PowerShell.ExecutionPolicy]::GetExecutionPolicy')
    return {
      id,
      title: FIX_TITLES[id],
      commands: [psCommand('Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force')],
      before: `CurrentUser=${before} · 生效=${effective.code === 0 ? effective.stdout.trim() : '(未知)'}`,
      undo: psCommand(
        `Set-ExecutionPolicy -Scope CurrentUser ${/^(Undefined|RemoteSigned|Restricted|AllSigned|Bypass|Unrestricted)$/.test(before) ? before : 'Undefined'} -Force`,
      ),
      note: '只改 CurrentUser scope，不动 LocalMachine。',
    }
  }

  if (id === 'E.3') {
    const where = await run(options, 'where npm')
    const hits = where.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const cmdHit = hits.find((hit) => /\.cmd$/i.test(hit)) ?? hits[0]
    if (!cmdHit) throw new Error('E_FIX_PRECONDITION: 找不到 npm 的解析路径')
    const dir = cmdHit.replace(/[\\/][^\\/]+$/, '')
    const before = await readUserPath(options)
    return {
      id,
      title: FIX_TITLES[id],
      commands: [
        psCommand(
          `$d='${dir.replace(/'/g, "''")}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); $parts=@($p -split ';' | Where-Object { $_ -ne '' -and $_.TrimEnd('\\') -ne $d.TrimEnd('\\') }); [Environment]::SetEnvironmentVariable('Path', ((@($d) + $parts) -join ';'), 'User')`,
        ),
      ],
      before: before || '(空)',
      undo: psCommand(`[Environment]::SetEnvironmentVariable('Path','${before.replace(/'/g, "''")}','User')`),
      note: `只把 ${dir} 提到最前，不删任何条目。`,
    }
  }

  throw new Error(`E_FIX_NOT_ALLOWED: ${id}`)
}

/** 依次执行计划里的命令；任何一条失败就停（不自动重试、不换第二种修法）。 */
export async function applyFix(plan, options) {
  const outputs = []
  for (const command of plan.commands) {
    const result = await run(options, command, 30_000)
    outputs.push({ command, code: result.code, stdout: result.stdout, stderr: result.stderr })
    if (result.code !== 0 || result.timedOut) {
      return { outcome: 'failed', outputs, command: plan.commands.join(' && '), before: plan.before, undo: plan.undo }
    }
  }
  return { outcome: 'ok', outputs, command: plan.commands.join(' && '), before: plan.before, undo: plan.undo }
}
