# DSH 环境体检报告

| 项 | 值 |
|---|---|
| 生成时间 | 2026-10-14T17:12:03+08:00 |
| 沙箱模式 | `workspace-write` |
| 工作区 | `C:\Users\神\Documents\deepseek-harness\default-workspace` |
| 总体结论 | **失败** —— 17 项：通过 12 / 注意 3 / 失败 1 / 说不准 1 |

## 一句话结论

有 1 项真的坏了（C.4），先修它再谈别的；另有 1 项说不准（B.1），不代表没问题。

## 需要你动手的（按优先级）

### C.4 · git 凭据助手指向的程序是否存在 — 高危 · 失败

**现象与原因**：全局 credential helper 里有一条指向已删除路径的记录，git 需要凭据时会直接失败（或退回让你手输密码）。这会挡住所有 push/pull，是本次体检里唯一「真的坏了」的一项。

**证据**：

```text
credential.https://github.com.helper=!'C:\old\gh.exe' auth git-credential
```

**下一步**（风险：低危，可以替你执行（执行前会再问一次））：

```bash
git config --global --unset-all credential.https://github.com.helper
gh auth setup-git
```

> 只动这一条 helper 记录，不碰其它 git 配置；第二条会让 gh 重新写回正确路径。

### D.1 · 执行策略是否拦 `.ps1` 脚本 — 中危 · 注意

**现象与原因**：五个 scope 都是 Undefined，生效值是 Restricted，会拦住 npm.ps1 / pnpm.ps1。命令行里敲 npm 时若先解析到 .ps1 就会失败。

**证据**：

```text
Get-ExecutionPolicy -List → 全部 Undefined
Get-ExecutionPolicy → Restricted
```

**下一步**（风险：低危，可以替你执行（执行前会再问一次））：

```bash
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

> 只改当前用户，不影响系统级；RemoteSigned 仍会拦未签名脚本。

### B.2 · bash 是否在 PATH 里 — 低危 · 注意

**现象与原因**：bash 不在 PATH 上，脚本里直接写 bash 会失败。Git 装在了 D:\Git，但 bin 目录没进用户 PATH。

**证据**：

```text
Get-Command bash → 未找到
D:\Git\Git\bin\bash.exe 存在
```

**下一步**（风险：低危，可以替你执行（执行前会再问一次））：

```bash
[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';D:\Git\Git\bin', 'User')
```

> 只追加一条用户级 PATH，不动系统级；撤销就去掉这一条。

### E.3 · 同名命令多份安装 / 解析到意料之外 — 低危 · 注意

**现象与原因**：npm 与 pnpm 各有 3 份，且命令行解析到的是 .ps1 版本而不是 .cmd——这条与 D.1 叠加就会出问题（.ps1 被执行策略拦住）。

**证据**：

```text
Get-Command npm -All → 3 条（npm.ps1 排第一）
Get-Command pnpm -All → 3 条（pnpm.ps1 排第一）
```

**下一步**（风险：低危，可以替你执行（执行前会再问一次））：

```bash
把 %APPDATA%\npm 与 pnpm 的 .cmd shim 所在目录在用户级 PATH 中前置到 WindowsApps 之前
```

> 只调用户级 PATH 顺序，不删任何命令；改完重开终端。

## 全部检查

| # | 检查 | 结果 | 等级 |
|---|---|---|---|
| A.1 | 沙箱模式与工作区可写性 | 通过 | 信息 |
| A.2 | 沙箱边界自检：工作区外写入必须被拒 | 通过 | 信息 |
| A.3 | 工作区 ACL 是否被改坏 | 通过 | 信息 |
| B.1 | Git Bash 能否启动 | 说不准 | 信息 |
| B.2 | bash 是否在 PATH 里 | 注意 | 低危 |
| C.1 | npm registry 可达性 | 通过 | 信息 |
| C.2 | curl / Invoke-WebRequest 的 TLS 栈 | 通过 | 信息 |
| C.3 | 代理配置三处一致性（env / git / npm） | 通过 | 信息 |
| C.4 | git 凭据助手指向的程序是否存在 | 失败 | 高危 |
| D.1 | 执行策略是否拦 `.ps1` 脚本 | 注意 | 中危 |
| E.1 | DSH 与 Node 版本 | 通过 | 信息 |
| E.2 | 必备命令是否就位 | 通过 | 信息 |
| E.3 | 同名命令多份安装 / 解析到意料之外 | 注意 | 低危 |
| E.4 | PATH 上的 pnpm 与 DSH 自带 pnpm 大版本不一致 | 通过 | 信息 |
| E.5 | python 是否可用 | 通过 | 信息 |
| F.1 | 安装通道：管理员 / winget / choco / scoop | 通过 | 信息 |
| F.2 | 磁盘空间与长路径支持 | 通过 | 信息 |

### 分组

- **A 沙箱与文件权限** —— 3 项，全部正常
- **B Git Bash** —— 2 项，其中 1 项要处理
- **C 网络 / TLS / 凭据** —— 4 项，其中 1 项要处理
- **D 执行策略** —— 1 项，其中 1 项要处理
- **E 工具链** —— 5 项，其中 1 项要处理
- **F 权限与安装通道** —— 2 项，全部正常

## 说不准的

- **B.1 · Git Bash 能否启动** —— 在 DSH 沙箱里启动 MSYS2 失败（建不了信号管道），这既可能是沙箱令牌限制，也可能是本机 Git 安装问题——从进程内部区分不了，所以判「说不准」，不判失败。请在新开的普通终端里跑一次确认。

## 机器可读

同目录的 `report-20261014-171203.json` 是本次结果的规范值（与工具返回值同一份数据），历史对比直接比它；格式见 `docs/prototypes/report/report.schema.json`。
