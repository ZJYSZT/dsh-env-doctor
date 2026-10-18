/**
 * 探针：检查函数拿到的唯一执行能力。
 *
 * 两条硬规则（docs/safety/model.md §2）：
 *   1. 检查函数只会拿到 probe，拿不到 shell / fs / exec。
 *   2. 写命令一个都不能发出去 —— 唯一执行出口 read() 先过 WRITE_VERBS 正则，
 *      只有 A.1 / A.2 两个探针有白名单。
 *
 * 为什么不自己 spawn：DSH 的 Windows 沙箱禁止子进程走管道 stdio
 * （Node 的 child_process.spawn + stdio:'pipe' 直接 EPERM），而宿主已经为工具
 * 准备好了 ctx.shell（ShellExecutor）—— 它自己负责沙箱语义与输出收集。
 * 所以命令一律经 shell.resolve → shell.execute → result()。
 *
 * 观测失败必须显式化：read() 返回的 observed=false 表示「没测到」，
 * 检查项要据此给 undiagnosed，绝不允许把没测到当成 ok（那样会骗人）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 单条命令超时（catalog 全局规则：单条 10 秒）。 */
export const COMMAND_TIMEOUT_MS = 10_000

/** 证据给模型看的上限：400 字符（catalog 全局规则）。 */
const EVIDENCE_LIMIT = 400

/** 会改变状态的命令片段。命中即拒绝（fail-closed）。 */
const WRITE_VERBS = [
  /\bset-item(?:property)?\b/i,
  /\bnew-item\b/i,
  /\bremove-item\b/i,
  /\bmove-item\b/i,
  /\bcopy-item\b/i,
  /\brename-item\b/i,
  /\bout-file\b/i,
  /\badd-content\b/i,
  /\bset-content\b/i,
  /\bclear-content\b/i,
  /\bset-executionpolicy\b/i,
  /\bset-path\b/i,
  /\breg\s+(add|delete|set|import|save|load|restore)\b/i,
  /\bicacls\b[^|&;]*(?:\/(grant|deny|remove|setowner|reset|restore|substitute|save|setintegritylevel|inheritance:))/i,
  /\btakeown\b/i,
  /\battrib\b/i,
  /\bchoco\s+install\b/i,
  /\bwinget\s+install\b/i,
  /\bmsiexec\b/i,
  /\bnpm\s+(install|i|add|remove|uninstall|link)\b/i,
  /\bpnpm\s+(add|install|remove|update|link)\b/i,
  // 下载器带落盘参数就是写
  /\b(curl|wget)\b[^|&;]*\s(?:-o|--output|-O|--remote-name)\b/i,
  /\b(invoke-webrequest|iwr|invoke-restmethod|irm)\b[^|&;]*-outfile\b/i,
  // 重定向写文件（`2>&1`、`>&1` 不算）
  /(?<![0-9&])>\s*[^\s|&;]/,
  /\b(cp|mv|rm|rmdir|mkdir|touch|chmod|chown|ln|del|erase|copy|move|ren|rename)\s+\S/i,
  /\b(file|io\.file)\]::(write|create|append|delete|move|copy|replace)/i,
  /\bgit\s+(checkout|switch|reset|clean|push|commit|add|merge|rebase|stash|pull)\b/i,
  /\bgit\s+config\b[^|&;]*\s(?:--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section)\b/i,
  // `git config --global key value` 是赋值；带 --get/--list/--show-origin 的才是读。
  /\bgit\s+config\s+--(?:global|system|local|worktree)\s+(?!--(?:get|get-all|get-regexp|list|show-origin|show-scope|help)\b)[\w.-]+\s+[^\s|&;]/i,
  /\bgh\s+(auth\s+(login|logout|refresh)|repo\s+(create|delete)|issue\s+(create|close|edit))\b/i,
  /\b(export|setx?)\s+\w+=/i,
  /\bschtasks\b/i,
  /\btaskkill\b/i,
  /\bshutdown\b/i,
]

/**
 * 只读例外：这些命令虽然命中上面的动词，但确实是「看」而不是「改」。
 * 只对 read() 生效 —— fix 走另一条路（lib/fix.js），那边必须带审批令牌。
 */
const WRITE_VERB_EXCEPTIONS = [
  /^\s*powershell(\.exe)?\s+-\S+\s+-command\s+"?get-executionpolicy/i,
]

/** 允许在只读探针里推进去的唯一两种写（A.1 / A.2 的自写自删）。 */
const PROBE_CHECK_IDS = new Set(['A.1', 'A.2'])

function assertReadOnly(command, checkId) {
  if (WRITE_VERB_EXCEPTIONS.some((re) => re.test(command))) return
  const hit = WRITE_VERBS.find((re) => re.test(command))
  if (!hit) return
  throw new Error(
    `E_READONLY_VIOLATION: 检查 ${checkId ?? '?'} 试图执行写命令：${command.slice(0, 120)}`,
  )
}

function truncate(text) {
  const raw = String(text ?? '')
  if (raw.length <= EVIDENCE_LIMIT) return raw
  return `${raw.slice(0, EVIDENCE_LIMIT)}…（截断，原长 ${raw.length} 字符）`
}

function decodeCommandText(buffer) {
  // where / icacls 在中文 Windows 上可能输出 GBK；这里只做「能读」的尽力解码。
  const utf8 = buffer.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return utf8
  }
}

/**
 * 唯一的命令执行实现：一律经宿主 ctx.shell。
 *
 * 只读探针（read）会先过 WRITE_VERBS；修复路径（lib/fix.js）拿着白名单里的命令
 * 直接调这里 —— 那一支已经过了「用户确认 + 护栏 + 沙箱模式」三道关。
 *
 * @returns {Promise<{code: number|null, stdout: string, stderr: string,
 *   timedOut: boolean, observed: boolean, sandbox?: object, error?: string}>}
 */
export async function execCommand({ shell, command, workdir = process.cwd(), timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  if (!shell || typeof shell.resolve !== 'function' || typeof shell.execute !== 'function') {
    return {
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      observed: false,
      error: 'SHELL_UNAVAILABLE: 宿主没有提供 ctx.shell，无法执行命令',
    }
  }

  try {
    const spec = shell.resolve({ command, workdir, timeoutMs })
    const execution = await shell.execute(spec)
    const result = await execution.result()
    const code = typeof result.exitCode === 'number' ? result.exitCode : null
    return {
      code,
      stdout: truncate(result.stdout?.text ?? ''),
      stderr: truncate(result.stderr?.text ?? ''),
      timedOut: result.timedOut === true,
      observed: code !== null,
      sandbox: result.sandbox,
      error: code === null ? 'SHELL_NO_EXIT_CODE: 进程没有给出退出码（可能被杀或起不来）' : undefined,
    }
  } catch (error) {
    const message = error?.message ?? String(error)
    // 宿主自己在起子进程时就被拒（Windows 沙箱禁管道 stdio）—— 这不是被测命令的问题，
    // 必须说清楚，否则用户会以为 git/bash 装坏了。
    const denied = /EPERM|EACCES|spawn .*(EPERM|denied)|operation not permitted/i.test(message)
    return {
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      observed: false,
      error: denied
        ? `SHELL_DENIED: 宿主的 shell 服务无法启动子进程（${message}）—— 这是沙箱限制，不是被测命令的问题`
        : `SHELL_FAILED: ${message}`,
    }
  }
}

/**
 * 允许在只读探针里执行的 PowerShell 脚本白名单（逐字匹配，不做模式推断）。
 *
 * 为什么要走 -EncodedCommand：宿主 ctx.shell 在 Windows 上可能是 cmd、也可能是 bash，
 * 括号 / 引号 / 反斜杠在两种 shell 下的转义规则不同。把脚本编码成 UTF-16LE base64，
 * 就只剩纯 ASCII，两边都不会改写它。代价是护栏看不见脚本内容 ——
 * 所以这里用「逐字白名单」补回来：没登记的脚本一条都发不出去。
 */
const PS_READONLY_SCRIPTS = new Set([
  'Get-ExecutionPolicy',
  'Get-ExecutionPolicy -Scope CurrentUser',
  '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  '[System.IO.DriveInfo]::new(67).AvailableFreeSpace',
])

/** 把 PowerShell 脚本包成 -EncodedCommand 形式的命令行。 */
export function encodePowerShell(script) {
  return `powershell.exe -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
}

/**
 * 创建一个探针。
 * @param {object} options
 * @param {string} options.checkId 当前检查项 id（写命令拒绝时用于报错、A.1/A.2 白名单判定）
 * @param {string} options.workspaceRoot 会话工作区根
 * @param {string} [options.home] 用户 home（默认 os.homedir()）
 * @param {object} [options.shell] 宿主 ctx.shell（ShellExecutor）；缺省时所有 read() 都是「未观测」
 */
export function createProbe({ checkId, workspaceRoot, home = os.homedir(), shell } = {}) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
    throw new Error('createProbe: workspaceRoot 必须是非空字符串')
  }

  const insidePath = path.join(workspaceRoot, '.dsh-doctor-probe')
  const outsidePath = path.join(home, '.dsh-doctor-probe')

  /**
   * 跑一条只读命令。
   * @returns {Promise<{code: number|null, stdout: string, stderr: string,
   *   timedOut: boolean, observed: boolean, sandbox?: object, error?: string}>}
   */
  async function read(command) {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error('probe.read: 命令不能为空')
    }
    assertReadOnly(command, checkId)
    return execCommand({ shell, command, workdir: workspaceRoot, timeoutMs: COMMAND_TIMEOUT_MS })
  }

  /** 跑一条白名单内的只读 PowerShell 脚本（走 -EncodedCommand，避开两种 shell 的转义差异）。 */
  async function readPowerShell(script) {
    if (!PS_READONLY_SCRIPTS.has(script)) {
      throw new Error(`E_READONLY_PS_SCRIPT: 脚本不在只读白名单：${String(script).slice(0, 100)}`)
    }
    return execCommand({ shell, command: encodePowerShell(script), workdir: workspaceRoot, timeoutMs: COMMAND_TIMEOUT_MS })
  }

  /** `where <name>` 的全部命中（按 PATH 顺序）。观测失败时返回空数组。 */
  async function which(name) {
    const result = await read(`where ${name}`)
    if (!result.observed || result.code !== 0) return []
    return String(result.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  }

  /** PATH 里的目录（原样顺序，未去重）。 */
  function pathEntries() {
    return String(process.env.PATH ?? process.env.Path ?? '')
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
  }

  /** HEAD 一个 URL（进程内 fetch，不起子进程）。 */
  async function http(url, timeoutMs = 8_000) {
    const started = Date.now()
    try {
      const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
      return { ok: response.ok, status: response.status, ms: Date.now() - started }
    } catch (error) {
      return { ok: false, status: 0, ms: Date.now() - started, error: String(error?.message ?? error) }
    }
  }

  /** 在工作区内写一个探针文件，读回来再删掉。 */
  async function probeInsideWorkspace() {
    const token = `probe-${process.pid}-${Date.now()}`
    let cleaned = true
    try {
      fs.writeFileSync(insidePath, token, 'utf8')
      const back = fs.readFileSync(insidePath, 'utf8')
      const matched = back === token
      try {
        fs.unlinkSync(insidePath)
      } catch {
        cleaned = false
      }
      return {
        ok: matched,
        cleaned,
        detail: matched ? '工作区内写入成功（探针已删除）' : '写入后读回的字节不一致',
      }
    } catch (error) {
      return {
        ok: false,
        cleaned,
        denied: `${error?.code ?? 'ERROR'}: ${String(error?.message ?? error).slice(0, 160)}`,
      }
    }
  }

  /** 在工作区外（家目录）写一个探针文件。期望被拒；写成功反而是问题。 */
  async function probeOutsideWorkspace() {
    try {
      fs.writeFileSync(outsidePath, 'probe', 'utf8')
    } catch (error) {
      return {
        result: 'denied',
        code: String(error?.code ?? 'ERROR'),
        message: `${error?.code ?? 'ERROR'}: ${String(error?.message ?? error).slice(0, 160)}`,
        cleaned: true,
      }
    }
    let cleaned = true
    try {
      fs.unlinkSync(outsidePath)
    } catch {
      cleaned = false
    }
    return { result: 'writable', code: 'WRITABLE', message: '工作区外写入成功了', cleaned }
  }

  /** 路径是否存在（不抛错）。 */
  function exists(target) {
    try {
      fs.statSync(target)
      return true
    } catch {
      return false
    }
  }

  return {
    workspaceRoot,
    home,
    read,
    readPowerShell,
    which,
    pathEntries,
    http,
    probeInsideWorkspace,
    probeOutsideWorkspace,
    exists,
    /** 该探针是否具备执行能力（用于报告里区分「没测到」的原因）。 */
    get hasShell() {
      return Boolean(shell && typeof shell.resolve === 'function')
    },
  }
}

export { WRITE_VERBS, WRITE_VERB_EXCEPTIONS, PROBE_CHECK_IDS, decodeCommandText }
