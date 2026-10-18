// 真机 e2e：用「文件重定向 + fd 直传」的极简执行器跑真正的 17 项体检。
//
// 为什么要这个脚本：本仓库的开发沙箱里 spawn 的管道 stdio 被拒（EPERM），
// 所以单元测试只能用假 shell。这里换一条真实但不需要管道的路子 ——
// stdio 直接指向临时文件（不是 pipe），于是能在这台机器上真的跑一遍命令，
// 拿到一台真机的体检结论。执行器只是测试替身；插件在生产里走宿主 ctx.shell。
import { spawn } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDoctor } from '../lib/tools.js'

const WORKSPACE = join(import.meta.dirname, '..', '..', '..')

function fileExecutor() {
  return {
    resolve(request) {
      return {
        command: request.command,
        workdir: request.workdir ?? WORKSPACE,
        timeoutMs: request.timeoutMs ?? 60_000,
        onExpiry: 'kill',
        stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      }
    },
    async execute(spec) {
      const dir = mkdtempSync(join(tmpdir(), 'dsh-doctor-e2e-'))
      const outFile = join(dir, 'out.txt')
      const errFile = join(dir, 'err.txt')
      const outFd = openSync(outFile, 'w')
      const errFd = openSync(errFile, 'w')
      let timedOut = false
      const code = await new Promise((resolvePromise) => {
        const child = spawn(spec.command, {
          cwd: spec.workdir,
          shell: true,
          windowsHide: true,
          stdio: ['ignore', outFd, errFd],
        })
        const timer = setTimeout(() => {
          timedOut = true
          child.kill()
        }, spec.timeoutMs)
        child.on('error', () => {
          clearTimeout(timer)
          resolvePromise(null)
        })
        child.on('close', (exitCode) => {
          clearTimeout(timer)
          resolvePromise(typeof exitCode === 'number' ? exitCode : null)
        })
      })
      closeSync(outFd)
      closeSync(errFd)
      let stdout = ''
      let stderr = ''
      try {
        stdout = readFileSync(outFile, 'utf8')
        stderr = readFileSync(errFile, 'utf8')
      } catch {
        // 文件没建出来就是没有输出
      }
      rmSync(dir, { recursive: true, force: true })
      return {
        result: async () => ({
          exitCode: code,
          signal: null,
          timedOut,
          aborted: false,
          timeoutMs: spec.timeoutMs,
          stdout: { text: stdout, truncated: false },
          stderr: { text: stderr, truncated: false },
          sandbox: { mode: 'workspace-write', denied: false },
        }),
      }
    },
  }
}

const executor = fileExecutor()
const services = {
  sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: WORKSPACE }) },
  get: (service) => (service === 'shell' ? executor : undefined),
}

const startedAt = Date.now()
const value = await runDoctor(services, { checks: process.argv[2] ?? 'all', out: process.argv[3] })
const elapsed = Date.now() - startedAt

const ICON = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', undiagnosed: '??  ' }
for (const result of value.results) {
  console.log(`${ICON[result.verdict]}  ${result.id}  ${result.detail.slice(0, 150)}`)
}
console.log('---')
console.log(`耗时 ${(elapsed / 1000).toFixed(1)}s · 结论 ${value.verdict} · ${JSON.stringify(value.counts)}`)
console.log(`报告 ${value.reportPath}`)
