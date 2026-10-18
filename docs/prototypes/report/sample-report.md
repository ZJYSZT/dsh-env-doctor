# DSH 环境体检报告

| 项 | 值 |
|---|---|
| 生成时间 | 2026-10-14T17:12:03+08:00 |
| 沙箱模式 | workspace-write |
| 工作区 | C:\Users\神\Documents\deepseek-harness\default-workspace |
| 检查项 | 17 项 |
| 总体结论 | **失败** |

一句话：通过 13、注意 2、失败 1、说不准 1。先处理失败项。

## 需要你动手的

### C.4 · git 凭据助手指向的程序是否存在（高危）

- 现象：全局 credential helper 里有一条指向已删除路径的记录，git 需要凭据时会直接失败（或退回让你手输密码）。这会挡住所有 push/pull，是本次体检里唯一「真的坏了」的一项。
- 证据：`credential.https://github.com.helper=!'C:\old\gh.exe' auth git-credential`
- 说明：只动这一条 helper 记录，不碰其它 git 配置；第二条会让 gh 重新写回正确路径。
- 下一步：

  ```bash
  git config --global --unset-all credential.https://github.com.helper
gh auth setup-git
  ```

### D.1 · 执行策略是否拦 `.ps1` 脚本（中）

- 现象：五个 scope 都是 Undefined，生效值是 Restricted，会拦住 npm.ps1 / pnpm.ps1。命令行里敲 npm 时若先解析到 .ps1 就会失败。
- 证据：`Get-ExecutionPolicy -List → 全部 Undefined / Get-ExecutionPolicy → Restricted`
- 说明：只改当前用户，不影响系统级；RemoteSigned 仍会拦未签名脚本。
- 下一步：

  ```bash
  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
  ```

### E.3 · 同名命令多份安装 / 解析到意料之外（低）

- 现象：npm 与 pnpm 各有 3 份，且命令行解析到的是 .ps1 版本而不是 .cmd——这条与 D.1 叠加就会出问题（.ps1 被执行策略拦住）。
- 证据：`Get-Command npm -All → 3 条（npm.ps1 排第一） / Get-Command pnpm -All → 3 条（pnpm.ps1 排第一）`
- 说明：只调用户级 PATH 顺序，不删任何命令；改完重开终端。
- 下一步：

  ```bash
  把 %APPDATA%\npm 与 pnpm 的 .cmd shim 所在目录在用户级 PATH 中前置到 WindowsApps 之前
  ```

## 已执行的修复

- 2026-10-14T17:12:21+08:00 · **B.2** · 结果：ok
  - 执行：`[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';D:\Git\Git\bin', 'User')`
  - 旧值（撤销依据）：`用户级 PATH：C:\Users\神\AppData\Local\Microsoft\WindowsApps;C:\Users\神\AppData\Roaming\npm（没有 bash 目录）`

## 全部检查

| id | 结论 | 级别 | 说明 |
|---|---|---|---|
| A.1 | ✅ 通过 | 提示 | 当前模式 workspace-write，工作区根可写（报告文件已成功写进去）。模式取自 ctx.sandboxPolicy，不是猜的。 |
| A.2 | ✅ 通过 | 提示 | 往工作区外写一个探针文件被拒，这是 workspace-write 的预期行为，不是权限损坏。真要写外面，得对那一次操作显式升到更宽的模式并说明理由。 |
| A.3 | ✅ 通过 | 提示 | 授权树结构与 workspace-write 的预期一致（能读到自己的写权限，没有异常 AppContainer 包 ACE）。真损坏的判定与修复交棒给内置技能 diagnose-windows-sandbox-acl，本插件不改 ACL。 |
| B.1 | ❔ 说不准 | 提示 | 在 DSH 沙箱里启动 MSYS2 失败（建不了信号管道），这既可能是沙箱令牌限制，也可能是本机 Git 安装问题——从进程内部区分不了，所以判「说不准」，不判失败。请在新开的普通终端里跑一次确认。 |
| B.2 | ✅ 通过 | 提示 | 原先 bash 不在 PATH（Git 装在 D:\Git，bin 没进用户级 PATH，脚本里直接写 bash 会失败）。这次执行了白名单里的修复：把 D:\Git\Git\bin 追加到用户级 PATH 并复检，新进程能解析到 bash。撤销就是去掉这一条。 |
| C.1 | ✅ 通过 | 提示 | registry.npmmirror.com 正常响应，装包不会卡在这里。 |
| C.2 | ✅ 通过 | 提示 | curl 与 Invoke-WebRequest 都能完成 TLS 握手并取到内容；没有出现 schannel 凭据错误。 |
| C.3 | ✅ 通过 | 提示 | 环境变量、git 配置、npm 配置三处都没有代理设置，彼此一致。以后要挂代理，这三处必须一起改，否则会出现「浏览器能开、命令行不行」。 |
| C.4 | ❌ 失败 | 高危 | 全局 credential helper 里有一条指向已删除路径的记录，git 需要凭据时会直接失败（或退回让你手输密码）。这会挡住所有 push/pull，是本次体检里唯一「真的坏了」的一项。 |
| D.1 | ⚠️ 注意 | 中 | 五个 scope 都是 Undefined，生效值是 Restricted，会拦住 npm.ps1 / pnpm.ps1。命令行里敲 npm 时若先解析到 .ps1 就会失败。 |
| E.1 | ✅ 通过 | 提示 | DSH 0.2.0-rc.2，自带运行时 node 24.18.1，PATH 上的 node 是 24.21.0——两个 Node 都在，且都满足插件要求。 |
| E.2 | ✅ 通过 | 提示 | git / node / npm / gh 都能直接调用；pwsh 没装，但 DSH 用的是 powershell.exe，不影响使用。 |
| E.3 | ⚠️ 注意 | 低 | npm 与 pnpm 各有 3 份，且命令行解析到的是 .ps1 版本而不是 .cmd——这条与 D.1 叠加就会出问题（.ps1 被执行策略拦住）。 |
| E.4 | ✅ 通过 | 提示 | PATH 上的 pnpm 12.8.1 与 DSH 自带的 11.7.0 差一个大版本；插件安装走的是 DSH 自带那份，所以不影响本插件，但自己手动 pnpm install 时要注意 lockfile 兼容性。 |
| E.5 | ✅ 通过 | 提示 | python 3.14.4 可用，是真实安装而不是 WindowsApps 的占位 stub。 |
| F.1 | ✅ 通过 | 提示 | 当前不是管理员；choco 已装但改不了系统目录，scoop 未装。装工具优先用便携包 + 用户级 PATH，不必提权。 |
| F.2 | ✅ 通过 | 提示 | 系统盘剩余 55.8 GB，够装依赖；长路径未开启，但现代 git 与 node 已很少触到 260 字符上限。 |

## 说不准的

这些项这次没法给出结论（通常是沙箱/权限导致观测失败）。它们不算坏，但也不算好：

- **B.1** Git Bash 能否启动：在 DSH 沙箱里启动 MSYS2 失败（建不了信号管道），这既可能是沙箱令牌限制，也可能是本机 Git 安装问题——从进程内部区分不了，所以判「说不准」，不判失败。请在新开的普通终端里跑一次确认。

## 机器可读

```json
{
  "schemaVersion": "1.0",
  "generatedAt": "2026-10-14T17:12:03+08:00",
  "mode": "check",
  "sandboxMode": "workspace-write",
  "workspaceRoot": "C:\\Users\\神\\Documents\\deepseek-harness\\default-workspace",
  "reportPath": "C:\\Users\\神\\Documents\\deepseek-harness\\default-workspace\\.dsh-doctor\\report-20261014-171203.md",
  "verdict": "fail",
  "counts": {
    "ok": 13,
    "warn": 2,
    "fail": 1,
    "undiagnosed": 1
  },
  "results": [
    {
      "id": "A.1",
      "group": "A",
      "title": "沙箱模式与工作区可写性",
      "verdict": "ok",
      "level": "info",
      "detail": "当前模式 workspace-write，工作区根可写（报告文件已成功写进去）。模式取自 ctx.sandboxPolicy，不是猜的。",
      "evidence": "mode=workspace-write\nworkspaceRoot=C:\\Users\\神\\Documents\\deepseek-harness\\default-workspace\nreport write ok"
    },
    {
      "id": "A.2",
      "group": "A",
      "title": "沙箱边界自检：工作区外写入必须被拒",
      "verdict": "ok",
      "level": "info",
      "detail": "往工作区外写一个探针文件被拒，这是 workspace-write 的预期行为，不是权限损坏。真要写外面，得对那一次操作显式升到更宽的模式并说明理由。",
      "evidence": "write C:\\Users\\神\\dsh-doctor-probe.txt → UnauthorizedAccessException（预期内拒绝）"
    },
    {
      "id": "A.3",
      "group": "A",
      "title": "工作区 ACL 是否被改坏",
      "verdict": "ok",
      "level": "info",
      "detail": "授权树结构与 workspace-write 的预期一致（能读到自己的写权限，没有异常 AppContainer 包 ACE）。真损坏的判定与修复交棒给内置技能 diagnose-windows-sandbox-acl，本插件不改 ACL。",
      "evidence": "icacls: S-1-4-803020457-741359850:(OI)(CI)(W,D,DC) / Low Mandatory Level:(OI)(CI)(NW) / 无 S-1-15-2-* 显式包 ACE"
    },
    {
      "id": "B.1",
      "group": "B",
      "title": "Git Bash 能否启动",
      "verdict": "undiagnosed",
      "level": "info",
      "detail": "在 DSH 沙箱里启动 MSYS2 失败（建不了信号管道），这既可能是沙箱令牌限制，也可能是本机 Git 安装问题——从进程内部区分不了，所以判「说不准」，不判失败。请在新开的普通终端里跑一次确认。",
      "evidence": "bash.exe: *** fatal error - couldn't create signal pipe, Win32 error 5"
    },
    {
      "id": "B.2",
      "group": "B",
      "title": "bash 是否在 PATH 里",
      "verdict": "ok",
      "level": "info",
      "detail": "原先 bash 不在 PATH（Git 装在 D:\\Git，bin 没进用户级 PATH，脚本里直接写 bash 会失败）。这次执行了白名单里的修复：把 D:\\Git\\Git\\bin 追加到用户级 PATH 并复检，新进程能解析到 bash。撤销就是去掉这一条。",
      "evidence": "修复前：where bash 无结果；D:\\Git\\Git\\bin\\bash.exe 存在\n修复后：where bash → D:\\Git\\Git\\bin\\bash.exe",
      "fix": {
        "command": "[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';D:\\Git\\Git\\bin', 'User')",
        "risk": "low",
        "needsAdmin": false,
        "autoApplicable": true,
        "note": "只追加一条用户级 PATH，不动系统级；撤销就去掉这一条。"
      },
      "applied": {
        "at": "2026-10-14T17:12:21+08:00",
        "id": "B.2",
        "command": "[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';D:\\Git\\Git\\bin', 'User')",
        "before": "用户级 PATH：C:\\Users\\神\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Users\\神\\AppData\\Roaming\\npm（没有 bash 目录）",
        "outcome": "ok"
      }
    },
    {
      "id": "C.1",
      "group": "C",
      "title": "npm registry 可达性",
      "verdict": "ok",
      "level": "info",
      "detail": "registry.npmmirror.com 正常响应，装包不会卡在这里。",
      "evidence": "https://registry.npmmirror.com → 200 (1635 ms)"
    },
    {
      "id": "C.2",
      "group": "C",
      "title": "curl / Invoke-WebRequest 的 TLS 栈",
      "verdict": "ok",
      "level": "info",
      "detail": "curl 与 Invoke-WebRequest 都能完成 TLS 握手并取到内容；没有出现 schannel 凭据错误。",
      "evidence": "curl https://registry.npmmirror.com → 200\nInvoke-WebRequest → 200"
    },
    {
      "id": "C.3",
      "group": "C",
      "title": "代理配置三处一致性（env / git / npm）",
      "verdict": "ok",
      "level": "info",
      "detail": "环境变量、git 配置、npm 配置三处都没有代理设置，彼此一致。以后要挂代理，这三处必须一起改，否则会出现「浏览器能开、命令行不行」。",
      "evidence": "HTTP(S)_PROXY 未设置\ngit config http.proxy → 空\nnpm config get proxy → null"
    },
    {
      "id": "C.4",
      "group": "C",
      "title": "git 凭据助手指向的程序是否存在",
      "verdict": "fail",
      "level": "high",
      "detail": "全局 credential helper 里有一条指向已删除路径的记录，git 需要凭据时会直接失败（或退回让你手输密码）。这会挡住所有 push/pull，是本次体检里唯一「真的坏了」的一项。",
      "evidence": "credential.https://github.com.helper=!'C:\\old\\gh.exe' auth git-credential",
      "fix": {
        "command": "git config --global --unset-all credential.https://github.com.helper\ngh auth setup-git",
        "risk": "low",
        "needsAdmin": false,
        "autoApplicable": true,
        "note": "只动这一条 helper 记录，不碰其它 git 配置；第二条会让 gh 重新写回正确路径。"
      }
    },
    {
      "id": "D.1",
      "group": "D",
      "title": "执行策略是否拦 `.ps1` 脚本",
      "verdict": "warn",
      "level": "medium",
      "detail": "五个 scope 都是 Undefined，生效值是 Restricted，会拦住 npm.ps1 / pnpm.ps1。命令行里敲 npm 时若先解析到 .ps1 就会失败。",
      "evidence": "Get-ExecutionPolicy -List → 全部 Undefined\nGet-ExecutionPolicy → Restricted",
      "fix": {
        "command": "Set-ExecutionPolicy -Scope CurrentUser RemoteSigned",
        "risk": "low",
        "needsAdmin": false,
        "autoApplicable": true,
        "note": "只改当前用户，不影响系统级；RemoteSigned 仍会拦未签名脚本。"
      }
    },
    {
      "id": "E.1",
      "group": "E",
      "title": "DSH 与 Node 版本",
      "verdict": "ok",
      "level": "info",
      "detail": "DSH 0.2.0-rc.2，自带运行时 node 24.18.1，PATH 上的 node 是 24.21.0——两个 Node 都在，且都满足插件要求。",
      "evidence": "dsh 0.2.0-rc.2 (win32 x64)\nDSH runtime node v24.18.1\nPATH node v24.21.0"
    },
    {
      "id": "E.2",
      "group": "E",
      "title": "必备命令是否就位",
      "verdict": "ok",
      "level": "info",
      "detail": "git / node / npm / gh 都能直接调用；pwsh 没装，但 DSH 用的是 powershell.exe，不影响使用。",
      "evidence": "git 2.56.0.windows.1\nnode v24.21.0\ngh 2.102.0\npwsh → 未找到（powershell.exe 可用）"
    },
    {
      "id": "E.3",
      "group": "E",
      "title": "同名命令多份安装 / 解析到意料之外",
      "verdict": "warn",
      "level": "low",
      "detail": "npm 与 pnpm 各有 3 份，且命令行解析到的是 .ps1 版本而不是 .cmd——这条与 D.1 叠加就会出问题（.ps1 被执行策略拦住）。",
      "evidence": "Get-Command npm -All → 3 条（npm.ps1 排第一）\nGet-Command pnpm -All → 3 条（pnpm.ps1 排第一）",
      "fix": {
        "command": "把 %APPDATA%\\npm 与 pnpm 的 .cmd shim 所在目录在用户级 PATH 中前置到 WindowsApps 之前",
        "risk": "low",
        "needsAdmin": false,
        "autoApplicable": true,
        "note": "只调用户级 PATH 顺序，不删任何命令；改完重开终端。"
      }
    },
    {
      "id": "E.4",
      "group": "E",
      "title": "PATH 上的 pnpm 与 DSH 自带 pnpm 大版本不一致",
      "verdict": "ok",
      "level": "info",
      "detail": "PATH 上的 pnpm 12.8.1 与 DSH 自带的 11.7.0 差一个大版本；插件安装走的是 DSH 自带那份，所以不影响本插件，但自己手动 pnpm install 时要注意 lockfile 兼容性。",
      "evidence": "pnpm.cmd → 12.8.1\nDSH runtime pnpm → 11.7.0"
    },
    {
      "id": "E.5",
      "group": "E",
      "title": "python 是否可用",
      "verdict": "ok",
      "level": "info",
      "detail": "python 3.14.4 可用，是真实安装而不是 WindowsApps 的占位 stub。",
      "evidence": "python --version → Python 3.14.4"
    },
    {
      "id": "F.1",
      "group": "F",
      "title": "安装通道：管理员 / winget / choco / scoop",
      "verdict": "ok",
      "level": "info",
      "detail": "当前不是管理员；choco 已装但改不了系统目录，scoop 未装。装工具优先用便携包 + 用户级 PATH，不必提权。",
      "evidence": "IsInRole(Administrator)=False\nchoco 2.7.4（bin 不可写）\nscoop → 未找到"
    },
    {
      "id": "F.2",
      "group": "F",
      "title": "磁盘空间与长路径支持",
      "verdict": "ok",
      "level": "info",
      "detail": "系统盘剩余 55.8 GB，够装依赖；长路径未开启，但现代 git 与 node 已很少触到 260 字符上限。",
      "evidence": "C: free 55.8 GB / 400 GB\nLongPathsEnabled=0"
    }
  ],
  "undiagnosed": [
    "B.1"
  ]
}
```
