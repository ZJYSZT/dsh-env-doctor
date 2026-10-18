// 17 项检查（目录见 docs/checks/catalog.md，判据逐条照它写）。
//
// 每个检查只拿到 probe（只读能力）与 env（宿主给的少量事实），没有 ctx、没有写通道。
// run() 返回 { verdict, detail, evidence?, fix? }；level 写在检查定义上，不随结果变。
// verdict 只有四种：ok / warn / fail / undiagnosed（说不准）。

import { statfsSync } from 'node:fs'

export const GROUPS = {
  A: '沙箱与文件权限',
  B: 'Git Bash / MSYS',
  C: '网络 · TLS · 凭据',
  D: '执行策略',
  E: '工具链',
  F: '权限与安装通道',
}

const ok = (detail, evidence) => ({ verdict: 'ok', detail, evidence })
const warn = (detail, evidence, fix) => ({ verdict: 'warn', detail, evidence, fix })
const fail = (detail, evidence, fix) => ({ verdict: 'fail', detail, evidence, fix })
const unknown = (detail, evidence) => ({ verdict: 'undiagnosed', detail, evidence })

const isWindows = process.platform === 'win32'

/** 从 icacls 输出里抓已知的两类「真损坏」信号；其余一律视为正常（沙箱本来就会加 deny 与 low IL）。 */
const APPCONTAINER_PACKAGE_ACE = /S-1-15-2-(?!1\b|2\b)[0-9-]+/g

function parseWhereLines(stdout) {
  return String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** 取某个命令的「第一个」解析路径（where 的输出顺序就是 PATH 顺序）。 */
async function firstOf(probe, name) {
  const hits = await probe.which(name)
  return hits.length > 0 ? hits[0] : null
}

/**
 * 和 firstOf 一样取第一个解析路径，但把「这次有没有看见」一起带回来。
 * 沙箱挡住子进程时 observed=false —— 调用方必须据此判 undiagnosed，
 * 绝不能把「查不了」写成「这个命令缺了」。
 */
async function lookupFirst(probe, name) {
  if (typeof probe.lookup !== 'function') {
    const hits = await probe.which(name)
    return { path: hits.length > 0 ? hits[0] : null, observed: true, error: null }
  }
  const result = await probe.lookup(name)
  return { path: result.found[0] ?? null, observed: result.observed === true, error: result.error ?? null }
}

/** 把观测失败统一成一句人话（会出现在报告里）。 */
function unobservedDetail(error, what = '这次操作') {
  return `没法完成「${what}」：${String(error ?? '原因不明').slice(0, 160)} —— 这是观测受限，不代表环境有问题`
}

/**
 * 命令行工具的输出可能是本地代码页（GBK）编码，被当成 UTF-8 读会变成一串乱码。
 * 报告里只留可读字符：丢掉替换符和高位 Latin-1（GBK 被误解码后落在这里）。
 */
function cleanText(value, max = 160) {
  return String(value ?? '')
    .replace(/[\u0080-\u00FF\uFFFD]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export const CHECKS = [
  {
    id: 'A.1',
    group: 'A',
    title: '沙箱模式与工作区可写性',
    level: 'high',
    async run(probe, env) {
      const mode = env.sandboxMode
      const result = await probe.probeInsideWorkspace()
      if (!mode) {
        return unknown('拿不到沙箱策略，无法判断本次是否能写；工作区探针结果仅供参考', result.ok ? '探针写入成功' : result.denied)
      }
      if (result.ok) {
        return ok(
          `沙箱模式=${mode}；工作区内写入成功${result.cleaned === false ? '（但探针文件没删掉，建议手动删 .dsh-doctor-probe）' : '（探针已删除）'}`,
          `workspaceRoot=${env.workspaceRoot}`,
        )
      }
      return fail(`沙箱模式=${mode}，但工作区内写入被拒 —— 体检报告可能写不出来`, result.denied, {
        command: '检查 workspaceRoot 的 ACL，或换一个工作区再试',
        risk: 'low',
        needsAdmin: false,
        autoApplicable: false,
        note: '写入被拒通常意味着工作区 ACL 被改坏或沙箱令牌受限；ACL 单项请用内置技能 diagnose-windows-sandbox-acl。',
      })
    },
  },
  {
    id: 'A.2',
    group: 'A',
    title: '工作区外写入必须被拒',
    level: 'medium',
    async run(probe, env) {
      const result = await probe.probeOutsideWorkspace()
      if (result.result === 'denied') {
        return ok(`$HOME 写入如预期被拒（${result.code}）`, result.message)
      }
      return warn(
        `能往 $HOME 写文件（探针${result.cleaned ? '已删' : '没删掉'}）—— 说明当前沙箱没有拦工作区外写入`,
        `沙箱模式=${env.sandboxMode ?? '(未知)'}`,
        {
          command:
            env.sandboxMode === 'danger-full-access'
              ? '无需处理：danger-full-access 本来就允许写工作区外'
              : '确认这个 profile 真的启用了沙箱（策略声明不等于执行）；再用普通用户令牌重跑一次',
          risk: 'low',
          needsAdmin: false,
          autoApplicable: false,
          note:
            env.sandboxMode === 'danger-full-access'
              ? 'danger-full-access 下这是预期行为，不算故障。'
              : 'workspace-write 下写成功，说明「策略声明」与「实际执行」不一致 —— 不是命令写错了，是沙箱没生效。',
        },
      )
    },
  },
  {
    id: 'A.3',
    group: 'A',
    title: '工作区 ACL 是否被改坏',
    level: 'medium',
    async run(probe, env) {
      if (!isWindows) return unknown('ACL 检查仅支持 Windows')
      const result = await probe.read(`icacls "${env.workspaceRoot}"`)
      if (result.observed !== true) {
        return unknown(`icacls 没能执行：${result.error ?? '没有拿到退出码'}`, `exit=${result.code}`)
      }
      if (result.code !== 0) {
        return unknown('icacls 执行失败，无法判断 ACL', result.stderr || result.stdout)
      }
      const text = `${result.stdout}\n${result.stderr}`
      const suspicious = text.match(APPCONTAINER_PACKAGE_ACE) ?? []
      const aceCount = (text.match(/\)\s*$/gm) ?? []).length
      if (suspicious.length > 0) {
        return fail(
          `工作区 ACL 里有 ${suspicious.length} 个 AppContainer 包 ACE —— 这是「被别的容器打包过」的信号`,
          suspicious.slice(0, 3).join(', '),
          {
            command: 'icacls 修复请交给内置技能：diagnose-windows-sandbox-acl',
            risk: 'high',
            needsAdmin: false,
            autoApplicable: false,
            note: '本插件永不动 ACL；调用内置技能，它会给出 verdict 与修复命令。',
          },
        )
      }
      // 目录里的第二类真损坏是「缺 WRITE_DAC / WRITE_OWNER」。icacls 不打印 owner，
      // 而 owner 天然带 WRITE_DAC —— 所以只看文本判不出「真缺」还是「owner 兜着」。
      // 按目录规则「其余一律 undiagnosed」，这里交棒内置技能而不是报 fail。
      if (!/\(F\)/.test(text)) {
        return unknown(
          'icacls 里没看到 (F) 授权 —— 可能只是 owner 自带 WRITE_DAC（icacls 不打印 owner），也可能授权被改坏；这种二义性交棒内置技能判定',
          text.slice(0, 200),
        )
      }
      return ok(
        `ACL 未见已知损坏信号（${aceCount} 条 ACE，(F) 授权在；Everyone deny / 低完整性级别 / 沙箱用户 RX 都属正常形态）`,
        text.slice(0, 200),
      )
    },
  },
  {
    id: 'B.1',
    group: 'B',
    title: 'Git Bash 能否启动',
    level: 'high',
    async run(probe, env) {
      if (!isWindows) return unknown('Git Bash 检查仅支持 Windows')
      const found = (await firstOf(probe, 'bash')) ?? (await probe.exists('D:\\Git\\Git\\bin\\bash.exe') ? 'D:\\Git\\Git\\bin\\bash.exe' : null)
      if (!found) {
        return warn('没找到 bash：Git Bash 未安装或不在常见位置', 'where bash 无结果；D:\\Git\\Git\\bin\\bash.exe 不存在', {
          command: '下载并安装 Git for Windows（自带 Git Bash）：https://git-scm.com/download/win',
          risk: 'medium',
          needsAdmin: false,
          autoApplicable: false,
          note: '装完不需要把它加进 PATH；插件会按已知路径找。',
        })
      }
      const result = await probe.read(`"${found}" -lc "echo MSYS_OK"`)
      const combined = `${result.stdout} ${result.stderr}`
      if (result.observed !== true) {
        return unknown(`没法执行 bash -lc：${result.error ?? '没有拿到退出码'}`, found)
      }
      if (result.code === 0 && /MSYS_OK/.test(result.stdout) && !/fatal error/i.test(combined)) {
        return ok('bash 可启动（MSYS_OK）', found)
      }
      if (/couldn't create signal pipe|Win32 error 5|0xC0000142/i.test(combined)) {
        const line = (result.stderr || result.stdout)
          .split(/\r?\n/)
          .map((entry) => entry.trim())
          .find((entry) => /fatal error|couldn't create signal pipe/i.test(entry)) ?? ''
        const reason = line.replace(/^.*?fatal error\s*-\s*/i, '') || line
        return unknown(
          `bash 起不来，但原因在沙箱本身（不是 Git Bash 装坏了）：${reason} —— 本沙箱里所有走 bash 的工具都会这样，换个非沙箱终端再验一次`,
          `exit=${result.code}`,
        )
      }
      return fail(`bash 启动失败（exit=${result.code}${result.timedOut ? '，超时' : ''}）`, result.stderr || result.stdout || result.error || '', {
        command: '重装 Git for Windows，或检查 D:\\Git\\Git 是否被安全软件拦',
        risk: 'medium',
        needsAdmin: false,
        autoApplicable: false,
        note: '沙箱内出现 couldn\'t create signal pipe 属于自因，本插件判 undiagnosed 而不是 fail。',
      })
    },
  },
  {
    id: 'B.2',
    group: 'B',
    title: 'bash 是否在 PATH 里',
    level: 'low',
    async run(probe, env) {
      const found = (await firstOf(probe, 'bash')) ?? (await probe.exists('D:\\Git\\Git\\bin\\bash.exe') ? 'D:\\Git\\Git\\bin\\bash.exe' : null)
      if (!found) return warn('没找到 bash，跳过 PATH 判断', null)
      const dir = found.replace(/[\\/][^\\/]+$/, '')
      const entries = probe.pathEntries().map((entry) => entry.toLowerCase())
      if (entries.includes(dir.toLowerCase())) {
        return ok(`bash 所在目录已在 PATH 里：${dir}`, found)
      }
      return warn(`bash 存在但不在 PATH：${dir}`, found, {
        command: `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';${dir}', 'User')`,
        risk: 'low',
        needsAdmin: false,
        autoApplicable: true,
        note: '只追加用户级 PATH；撤销时用报告里的 before 原文覆盖回去。',
      })
    },
  },
  {
    id: 'C.1',
    group: 'C',
    title: 'registry 可达性（npmmirror / npmjs / github）',
    level: 'high',
    async run(probe) {
      const targets = [
        ['https://registry.npmmirror.com', 'npmmirror'],
        ['https://registry.npmjs.org', 'npmjs'],
        ['https://github.com', 'github'],
      ]
      const rows = []
      for (const [url, label] of targets) {
        const result = await probe.http(url)
        rows.push(`${label} ${result.ok ? `http ${result.status}` : 'FAIL'} ${result.ms}ms`)
      }
      const bad = rows.filter((row) => row.includes('FAIL'))
      if (bad.length === 0) return ok(`三个源都通：${rows.join(' · ')}`, rows.join('\n'))
      // 目录里的判据：两个 npm registry 都不通才算真坏（装插件必失败）。
      const registriesDown = bad.filter((row) => /^(npmmirror|npmjs) /.test(row))
      if (registriesDown.length === 2) {
        return fail(`两个 npm registry 都连不上：${bad.join(' · ')}`, rows.join('\n'), {
          command: '先确认代理与 DNS；能换源就换（npm config set registry https://registry.npmmirror.com）',
          risk: 'medium',
          needsAdmin: false,
          autoApplicable: false,
          note: '装插件必失败，所以判 fail；换源影响全局，只给命令不代改。',
        })
      }
      return warn(`${bad.length}/3 个源不可达：${bad.join(' · ')}`, rows.join('\n'), {
        command: '换一个 registry（npm config set registry https://registry.npmmirror.com）或检查代理',
        risk: 'medium',
        needsAdmin: false,
        autoApplicable: false,
        note: '换源影响全局，本插件只给命令不代改。',
      })
    },
  },
  {
    id: 'C.2',
    group: 'C',
    title: 'curl / Invoke-WebRequest 的 TLS 栈',
    level: 'medium',
    async run(probe) {
      if (!isWindows) return unknown('TLS 栈检查仅支持 Windows')
      const curl = await lookupFirst(probe, 'curl')
      if (!curl.observed) return unknown(unobservedDetail(curl.error, '查 curl 的 where'), 'where curl')
      if (!curl.path) {
        return warn('没找到 curl.exe，无法探测 TLS 栈', null, {
          command: '确认 C:\\Windows\\System32\\curl.exe 在不在；不在就用 powershell.exe -NoProfile -Command "Invoke-WebRequest https://registry.npmjs.org/ -Method Head" 代替',
          risk: 'low',
          needsAdmin: false,
          autoApplicable: false,
          note: 'Windows 10 1803+ 自带 curl.exe；被安全软件删掉时才会缺。',
        })
      }
      // 用 HEAD 请求探测 TLS 栈：绝不落盘（旧版 `-o NUL` 会被只读护栏当写命令拦掉）。
      const result = await probe.read('curl.exe -sS -m 8 -I https://registry.npmjs.org/')
      if (result.observed !== true) {
        return unknown(
          `curl 在宿主 shell 里没能启动：${String(result.error ?? `exit=${result.code}`).slice(0, 160)}`,
          `exit=${result.code}`,
        )
      }
      const text = `${result.stderr} ${result.stdout}`
      if (result.code === 0) return ok('curl 走 https 成功（schannel 栈正常）', curl.path)
      if (/SEC_E_NO_CREDENTIALS|AcquireCredentialsHandle|schannel/i.test(text)) {
        return unknown(`curl 的 schannel 栈报错（常见于沙箱/工具层受限）：${cleanText(text)}`, `exit=${result.code}`)
      }
      return fail(`curl 请求失败（exit=${result.code}）：${cleanText(text)}`, curl.path, {
        command: '先跑 C.1 确认网络；TLS 问题可试 curl.exe --ssl-no-revoke',
        risk: 'low',
        needsAdmin: false,
        autoApplicable: false,
        note: '沙箱内 TLS 失败多数是自因，C.2 判 undiagnosed 时才需要人判断。',
      })
    },
  },
  {
    id: 'C.3',
    group: 'C',
    title: '代理三处是否一致（环境变量 / git / npm）',
    level: 'medium',
    async run(probe) {
      const envProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? ''
      const gitProxy = await probe.read('git config --global --get http.proxy')
      const npmProxy = await probe.read('npm config get proxy')
      const npmHttps = await probe.read('npm config get https-proxy')
      const gitValue = gitProxy.code === 0 ? gitProxy.stdout.trim() : ''
      const npmValue = npmProxy.code === 0 && npmProxy.stdout.trim() !== 'null' ? npmProxy.stdout.trim() : ''
      const npmHttpsValue = npmHttps.code === 0 && npmHttps.stdout.trim() !== 'null' ? npmHttps.stdout.trim() : ''
      if (gitProxy.observed !== true && npmProxy.observed !== true && npmHttps.observed !== true) {
        return unknown(
          'git / npm 都没法读代理配置，无法判断代理是否一致',
          `git: ${gitProxy.error ?? '(无)'} · npm: ${npmProxy.error ?? '(无)'}`,
        )
      }
      const values = { env: envProxy, git: gitValue, npm: npmValue, npmHttps: npmHttpsValue }
      const nonEmpty = Object.values(values).filter(Boolean)
      const evidence = Object.entries(values)
        .map(([key, value]) => `${key}=${value || '(空)'}`)
        .join('\n')
      if (nonEmpty.length === 0) return ok('三处都未设置代理 —— 一致', evidence)
      const unique = new Set(nonEmpty.map((value) => value.toLowerCase()))
      if (unique.size === 1) return ok(`三处代理一致：${nonEmpty[0]}`, evidence)
      return warn('代理配置不一致（有的地方设了、有的没设）', evidence, {
        command: '统一成一处：把同一个代理写进 npm config 与 git config，或全部清空',
        risk: 'medium',
        needsAdmin: false,
        autoApplicable: false,
        note: '不一致的典型症状是「浏览器能开、npm 装不上」。',
      })
    },
  },
  {
    id: 'C.4',
    group: 'C',
    title: 'git 凭据助手的目标程序是否存在',
    level: 'high',
    async run(probe) {
      const result = await probe.read('git config --global --get-all credential.https://github.com.helper')
      if (result.observed !== true) {
        return unknown(unobservedDetail(result.error, '读 git 凭据助手配置'), `exit=${result.code}`)
      }
      if (result.code !== 0) {
        return warn('没有配置 github.com 的凭据助手（https 推送会反复要密码）', result.stderr || null, {
          command: 'gh auth setup-git',
          risk: 'low',
          needsAdmin: false,
          autoApplicable: true,
          note: '需要先 gh auth login。',
        })
      }
      const lines = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      const missing = []
      for (const line of lines) {
        // gh 写入的空值行是用来「清空继承列表」的，没有目标程序，跳过。
        if (!line.startsWith('!')) continue
        const target = (line.match(/'([^']+)'/) ?? [])[1] ?? null
        if (!target) continue
        if (!(await probe.exists(target))) missing.push(target)
      }
      if (missing.length > 0) {
        return fail(`凭据助手指向不存在的程序：${missing.join(', ')}`, lines.join('\n'), {
          command: ['git config --global --unset-all credential.https://github.com.helper', 'gh auth setup-git'],
          risk: 'low',
          needsAdmin: false,
          autoApplicable: true,
          note: '删掉失效的 helper 行后由 gh 重新写一份；before 里会存被删的原文。',
        })
      }
      return ok(`凭据助手目标都存在（${lines.length} 条）`, lines.join('\n'))
    },
  },
  {
    id: 'D.1',
    group: 'D',
    title: '执行策略是否拦 .ps1（本机 PowerShell 脚本）',
    level: 'medium',
    async run(probe) {
      if (!isWindows) return unknown('执行策略检查仅支持 Windows')
      const effective = await probe.readPowerShell('Get-ExecutionPolicy')
      const currentUser = await probe.readPowerShell('Get-ExecutionPolicy -Scope CurrentUser')
      if (effective.observed !== true) {
        return unknown('拿不到执行策略（命令没能执行）', effective.error ?? effective.stderr ?? '')
      }
      if (effective.code !== 0) return unknown('拿不到执行策略', effective.stderr)
      const value = effective.stdout.trim()
      const scopeValue = currentUser.code === 0 ? currentUser.stdout.trim() : '(未知)'
      const npmPath = await firstOf(probe, 'npm')
      const hitsPs1 = /\.ps1$/i.test(npmPath ?? '')
      const evidence = `生效=${value} · CurrentUser=${scopeValue} · where npm → ${npmPath ?? '(无)'}`
      if (!hitsPs1) return ok(`执行策略=${value}，但 npm 解析到可执行文件（不是 .ps1），不受影响`, evidence)
      if (value === 'Restricted' || value === 'AllSigned') {
        return warn(`执行策略=${value} 会拦住 .ps1（npm/pnpm 解析到 .ps1 时会报「禁止运行脚本」）`, evidence, {
          command: 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned',
          risk: 'low',
          needsAdmin: false,
          autoApplicable: true,
          note: '只改 CurrentUser scope；撤销时写回 before 里的原值（本机实测是 Undefined）。',
        })
      }
      return ok(`执行策略=${value}，不拦 .ps1`, evidence)
    },
  },
  {
    id: 'E.1',
    group: 'E',
    title: 'DSH 与 Node 版本',
    level: 'high',
    async run(probe) {
      const nodeMajor = Number(process.versions.node.split('.')[0])
      const dsh = await probe.read('dsh --version')
      const dshVersion = dsh.code === 0 ? dsh.stdout.trim() : null
      const evidence = `node=${process.version} · dsh=${dshVersion ?? '(命令不在 PATH)'}`
      if (nodeMajor < 20) {
        return fail(`Node 版本过低：${process.version}（需要 >= 20）`, evidence, {
          command: '升级 Node：winget install OpenJS.NodeJS.LTS（或从 nodejs.org 装到用户目录）',
          risk: 'medium',
          needsAdmin: false,
          autoApplicable: false,
          note: 'DSH 自带运行时不受影响，但插件与工具链需要 Node 20+。',
        })
      }
      if (!dshVersion) {
        return warn(`Node ${process.version} 正常，但 PATH 里没有 dsh 命令（不影响已运行中的宿主）`, evidence, {
          command: '把 DSH 的 cli 目录加进 PATH，或用应用自带的 dsh.cmd 绝对路径调用',
          risk: 'low',
          needsAdmin: false,
          autoApplicable: false,
          note: '直接从桌面端启动时不需要 dsh 在 PATH。',
        })
      }
      return ok(`node=${process.version} · dsh=${dshVersion}`, evidence)
    },
  },
  {
    id: 'E.2',
    group: 'E',
    title: '必备命令是否就位',
    level: 'medium',
    async run(probe) {
      const names = ['git', 'node', 'npm', 'pnpm', 'gh', 'bash', 'python']
      const table = {}
      const blind = []
      for (const name of names) {
        const looked = await lookupFirst(probe, name)
        table[name] = looked.path
        if (!looked.observed) blind.push(`${name}: ${looked.error ?? '(无)'}`)
      }
      // 一条都没查到、而 where 又根本跑不起来 —— 这是观测受限，不是七个命令全丢了。
      if (blind.length === names.length) {
        return unknown(unobservedDetail(blind[0].replace(/^[^:]+:\s*/, ''), '查必备命令的 where'), blind.join(' · '))
      }
      const missing = Object.entries(table)
        .filter(([, path]) => !path)
        .map(([name]) => name)
      const evidence = Object.entries(table)
        .map(([name, path]) => `${name}=${path ?? '(缺)'}`)
        .join('\n')
      if (blind.length > 0) {
        return unknown(
          `有 ${blind.length} 个命令没查成（观测受限），其余 ${names.length - blind.length} 个已看见`,
          `${evidence}\n观测失败：${blind.join(' · ')}`,
        )
      }
      if (missing.length === 0) return ok('七个必备命令都在 PATH 里', evidence)
      return warn(`缺 ${missing.length} 个：${missing.join(', ')}`, evidence, {
        command: '缺 gh 装 GitHub CLI（https://cli.github.com）；缺 bash 装 Git for Windows；缺 pnpm 用 corepack 或 npm i -g pnpm',
        risk: 'medium',
        needsAdmin: false,
        autoApplicable: false,
        note: '只报告缺什么，不代装。',
      })
    },
  },
  {
    id: 'E.3',
    group: 'E',
    title: '多份安装 / 解析到意料之外的程序',
    level: 'low',
    async run(probe) {
      const reports = {}
      const blind = []
      for (const name of ['npm', 'pnpm', 'node']) {
        const looked = typeof probe.lookup === 'function' ? await probe.lookup(name) : { found: await probe.which(name), observed: true, error: null }
        reports[name] = looked.found
        if (looked.observed !== true) blind.push(`${name}: ${looked.error ?? '(无)'}`)
      }
      // 「每个命令只解析到一份」只有在真的看见 PATH 解析结果时才算数。
      if (blind.length > 0) {
        return unknown(unobservedDetail(blind[0].replace(/^[^:]+:\s*/, ''), '查命令解析路径的 where'), blind.join(' · '))
      }
      const dupes = Object.entries(reports).filter(([, hits]) => hits.length > 1)
      const ps1First = Object.entries(reports).filter(([, hits]) => /\.ps1$/i.test(hits[0] ?? ''))
      const evidence = Object.entries(reports)
        .map(([name, hits]) => `${name}: ${hits.join(' | ') || '(无)'}`)
        .join('\n')
      if (dupes.length === 0 && ps1First.length === 0) {
        return ok('每个命令都只解析到一份，且不是 .ps1', evidence)
      }
      const parts = []
      if (dupes.length > 0) parts.push(`多份：${dupes.map(([name, hits]) => `${name}×${hits.length}`).join(', ')}`)
      if (ps1First.length > 0) parts.push(`解析到 .ps1 优先：${ps1First.map(([name]) => name).join(', ')}`)
      return warn(parts.join('；'), evidence, {
        command: '把想要的那份目录在用户级 PATH 里提前（或用 .cmd 全路径调用）',
        risk: 'low',
        needsAdmin: false,
        autoApplicable: true,
        note: '自动修只调整 PATH 顺序，不删任何文件。',
      })
    },
  },
  {
    id: 'E.4',
    group: 'E',
    title: 'pnpm 大版本与 DSH 自带的一致吗',
    level: 'low',
    async run(probe) {
      const bundled = '11.7.0'
      const result = await probe.read('pnpm --version')
      if (result.observed !== true) return unknown(unobservedDetail(result.error, '跑 pnpm --version'), `exit=${result.code}`)
      if (result.code !== 0) {
        return warn('pnpm 不可用', result.stderr, {
          command: 'corepack enable pnpm（或 npm i -g pnpm）',
          risk: 'low',
          needsAdmin: false,
          autoApplicable: false,
          note: '装插件走 dsh plugin，不依赖 PATH 上的 pnpm；这条只影响手动装包。',
        })
      }
      const version = result.stdout.trim()
      const evidence = `PATH pnpm=${version} · DSH 自带=${bundled}`
      const major = version.split('.')[0]
      const bundledMajor = bundled.split('.')[0]
      if (major === bundledMajor) return ok(`同属 ${major}.x（${version} vs ${bundled}）`, evidence)
      return warn(
        `PATH 上的 pnpm 是 ${version}，DSH 自带 ${bundled} —— 大版本不同，lockfile 格式可能不一致`,
        evidence,
        {
          command: '需要和 DSH 一致时，直接用 DSH 自带的 pnpm（安装/更新插件请用 dsh plugin add）',
          risk: 'low',
          needsAdmin: false,
          autoApplicable: false,
          note: '这条只是提醒；插件安装走 dsh plugin，不受 PATH pnpm 影响。',
        },
      )
    },
  },
  {
    id: 'E.5',
    group: 'E',
    title: 'python 是否可用',
    level: 'low',
    async run(probe) {
      const result = await probe.read('python --version')
      const text = `${result.stdout} ${result.stderr}`.trim()
      if (result.observed !== true) return unknown(unobservedDetail(result.error, '跑 python --version'), `exit=${result.code}`)
      if (result.code === 0 && /Python\s+\d+\.\d+/.test(text)) {
        return ok(text, text)
      }
      if (/WindowsApps|Microsoft Store/i.test(text)) {
        return warn('python 解析到 Microsoft Store 的占位程序（打开会跳商店）', text, {
          command: '装真正的 Python：https://www.python.org/downloads/windows/ 或 winget install Python.Python.3.13',
          risk: 'medium',
          needsAdmin: false,
          autoApplicable: false,
          note: '注意 winget 在本机曾返回 0x8A150001，装不了时用官网安装包。',
        })
      }
      return warn(`python 不可用（exit=${result.code}）`, text || null, {
        command: '如果不需要 Python，忽略即可；需要就装一个',
        risk: 'low',
        needsAdmin: false,
        autoApplicable: false,
        note: null,
      })
    },
  },
  {
    id: 'F.1',
    group: 'F',
    title: '权限与安装通道（管理员 / winget / choco / scoop）',
    level: 'medium',
    async run(probe) {
      if (!isWindows) return unknown('安装通道检查仅支持 Windows')
      const admin = await probe.readPowerShell(
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
      )
      const adminObserved = admin.observed === true
      const isAdmin = adminObserved && /true/i.test(admin.stdout)
      const winget = await probe.read('winget --version')
      const choco = await probe.read('choco --version')
      const scoop = await lookupFirst(probe, 'scoop')
      const wingetOk = winget.observed === true && winget.code === 0
      const chocoOk = choco.observed === true && choco.code === 0
      // 三项全都没执行成 = 观测受限，不能得出「没有安装通道」的结论。
      if (!adminObserved && !wingetOk && !chocoOk && !scoop.observed) {
        return unknown(
          '管理员身份、winget、choco 都没测成（观测受限），说不准安装通道的状况',
          `admin: ${admin.error ?? '(无)'} · winget: ${winget.error ?? '(无)'} · choco: ${choco.error ?? '(无)'}`,
        )
      }
      const evidence = [
        `管理员=${adminObserved ? isAdmin : '(未知)'}`,
        `winget=${wingetOk ? winget.stdout.trim() : `失败 exit=${winget.code}`}`,
        `choco=${chocoOk ? choco.stdout.trim() : '不可用'}`,
        `scoop=${scoop.path ?? (scoop.observed ? '未安装' : '不知道')}`,
      ].join('\n')
      if (isAdmin) return ok('当前是管理员会话，安装通道不受限', evidence)
      if (wingetOk) return ok('非管理员，但 winget 可用（用户级安装够用）', evidence)
      if (!adminObserved) {
        return unknown('管理员身份没测成（观测受限），说不准有没有提权通道', evidence)
      }
      return warn('非管理员且 winget 不可用 —— 没有免提权的批量安装通道', evidence, {
        command: '用官方安装包（.zip/.exe）装到用户目录；winget 的 0x8A150001 常见于 App Installer 组件损坏，需重装',
        risk: 'high',
        needsAdmin: true,
        autoApplicable: false,
        note: '本插件永不请求 UAC、不装 MSI。',
      })
    },
  },
  {
    id: 'F.2',
    group: 'F',
    title: '磁盘空间与长路径支持',
    level: 'medium',
    async run(probe) {
      if (!isWindows) return unknown('磁盘/长路径检查仅支持 Windows')
      const free = await probe.readPowerShell('[System.IO.DriveInfo]::new(67).AvailableFreeSpace')
      const longPath = await probe.read('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled')
      // 磁盘空间优先用 Node 自己的 statfs（不起子进程、不依赖 PowerShell 引号）；
      // PowerShell 那条只是兜底。
      const drive = `${String(process.env.SystemDrive ?? 'C:').replace(/[\\/]+$/, '')}\\`
      let freeBytes = null
      let totalBytes = null
      try {
        const stats = statfsSync(drive)
        freeBytes = stats.bavail * stats.bsize
        totalBytes = stats.blocks * stats.bsize
      } catch {
        const fromPowerShell = Number(free.stdout.trim())
        freeBytes = free.observed === true && Number.isFinite(fromPowerShell) && free.stdout.trim() !== ''
          ? fromPowerShell
          : null
      }
      const freeGb = freeBytes === null ? null : freeBytes / 1024 ** 3
      const totalGb = totalBytes === null ? null : totalBytes / 1024 ** 3
      const longOn = /0x1\b/.test(longPath.stdout)
        ? true
        : /0x0\b/.test(longPath.stdout)
          ? false
          : null
      const evidence = [
        `${drive.replace(/\\$/, '')} 可用=${freeGb === null ? '(未知)' : `${freeGb.toFixed(1)} GB`}${totalGb === null ? '' : ` / 共 ${totalGb.toFixed(0)} GB`}`,
        `LongPathsEnabled=${longOn === null ? '(未知)' : longOn}`,
      ].join('\n')
      const problems = []
      // 目录判据：剩余 < 10 GB → warn/medium（装大依赖会失败）
      if (freeGb !== null && freeGb < 10) problems.push(`${drive.replace(/\\$/, '')} 只剩 ${freeGb.toFixed(1)} GB`)
      if (longOn === false) problems.push('长路径支持未开启（深层 node_modules 可能超 260 字符）')
      if (problems.length === 0) {
        // 磁盘够，但长路径开关没读到 —— 不能把「没测到」写成「都正常」。
        if (longOn === null) {
          return unknown('磁盘空间没问题，但长路径开关没读到（reg query 没有结果），这一半说不准', evidence)
        }
        return ok('磁盘与长路径都正常', evidence)
      }
      return warn(problems.join('；'), evidence, {
        command:
          'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f  ← 需要管理员',
        risk: 'high',
        needsAdmin: true,
        autoApplicable: false,
        note: '注册表与磁盘清理都是永不动手的项，只给命令。',
      })
    },
  },
]

export const CHECK_IDS = CHECKS.map((check) => check.id)

export function getCheck(id) {
  return CHECKS.find((check) => check.id === id) ?? null
}

/** 选检查：'all' | 'A' | 'A.1' | ['A.1','B.2']；未知 id 抛错，不猜。 */
export function selectChecks(selection) {
  const value = selection ?? 'all'
  if (value === 'all') return CHECKS.slice()
  const wanted = Array.isArray(value) ? value : String(value).split(',')
  const selected = []
  const unknownIds = []
  for (const raw of wanted) {
    const token = String(raw).trim()
    if (!token) continue
    if (GROUPS[token]) {
      selected.push(...CHECKS.filter((check) => check.group === token))
      continue
    }
    const check = getCheck(token)
    if (check) selected.push(check)
    else unknownIds.push(token)
  }
  if (unknownIds.length > 0) {
    throw new Error(`E_UNKNOWN_CHECK: 未知检查项 ${unknownIds.join(', ')}（可用：${CHECK_IDS.join(', ')} 或 A–F）`)
  }
  return [...new Map(selected.map((check) => [check.id, check])).values()]
}
