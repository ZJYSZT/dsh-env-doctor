# 检查目录（v1 决策稿）

> 这份表是 `dsh-env-doctor` 实现的**唯一依据**。改表 = 改契约；票面之外不要临时加检查。
> 状态：**v1 已确认并冻结（票 #6，2026-10-14）**。id 不许再改；将来新增检查只能往后追加序号（E.6、E.7…），已有 id 不重排。

## 0. 全局规则

| 规则 | 内容 |
|---|---|
| id 格式 | `<组字母>.<序号>`，如 `C.4`。**发布后即历史对比的键**，改 id 等于断历史 |
| 组字母 | 按票 #6 的定义（与最初范围决策一致）：A 沙箱写拒绝/ACL · B MSYS/Git-Bash · C 网络/TLS/镜像 · D 执行策略 · E 工具链 · F 权限与安装通道 |
| 四种结论 | `ok`（正常）· `warn`（能用但有隐患）· `fail`（真的坏了）· `undiagnosed`（探测不到，必须承认，不许当 ok） |
| `level` vs `fix.risk` | `level` = 问题严重度（给人排序）；`fix.risk` = 修法危险度。高危问题可以有低危修法，两者不许混用 |
| 执行上下文 | 探测一律在**工具的沙箱进程**里跑。凡"沙箱本身导致失败"的检查（B.1、C.2），结论必须是 `undiagnosed` + 给用户一条在新终端里跑的命令，**不许**判成 fail |
| 只读保证 | 除 A.1/A.2 的"自写自删探针"（工作区内随机名、立即删除）外，所有探测**不写任何文件**；绝不改注册表、PATH、执行策略，除非用户在确认后点头 |
| 证据 | 每条 `results[].evidence` 必带原始输出，截断到 400 字符；不许只写"失败了" |
| 超时 | 单条探测 10 s；整体 120 s。超时按 `undiagnosed` 记，不按 fail |

## 1. 速查表

| id | 检查 | 级别 | 能自动修 |
|---|---|---|---|
| A.1 | 沙箱模式与工作区可写性 | 高 | 否 |
| A.2 | 沙箱边界自检：工作区外写入必须被拒 | 中 | 否 |
| A.3 | 工作区 ACL 是否被改坏 | 中 | 否（交棒内置技能） |
| B.1 | Git Bash 能否启动 | 高 | 否 |
| B.2 | bash 是否在 PATH 里 | 低 | **是** |
| C.1 | npm registry 可达性 | 高 | 否（换源要问） |
| C.2 | curl / Invoke-WebRequest 的 TLS 栈 | 中 | 否 |
| C.3 | 代理配置三处一致性（env / git / npm） | 中 | 否 |
| C.4 | git 凭据助手指向的程序是否存在 | 高 | **是** |
| D.1 | 执行策略是否拦 `.ps1` 脚本 | 中 | **是** |
| E.1 | DSH 与 Node 版本 | 高 | 否 |
| E.2 | 必备命令是否就位 | 中 | 否 |
| E.3 | 同名命令多份安装 / 解析到意料之外 | 低 | **是** |
| E.4 | PATH 上的 pnpm 与 DSH 自带 pnpm 大版本不一致 | 低 | 否 |
| E.5 | python 是否可用 | 低 | 否 |
| F.1 | 安装通道：管理员 / winget / choco / scoop | 中 | 否（要 UAC） |
| F.2 | 磁盘空间与长路径支持 | 中 | 否（要管理员） |

共 17 项。4 项标了"能自动修"（B.2 / C.4 / D.1 / E.3）：都属于**用户级、可逆、影响面小**，且执行前先打印命令再问一次；其余只给命令。ACL（A.3）与注册表（F.2 长路径）、UAC（F.1）**永不动手**。以上「4 项可自动」经票 #6 确认。

## 2. 逐项定义

### A.1 沙箱模式与工作区可写性 — 高

- **判据**：工作区内能建文件再删掉 → `ok`；建不了 → `fail`（工作区都写不了，插件没法干活）；拿不到 `ctx.sandboxPolicy` → `undiagnosed`。
- **PS**：`try { Set-Content -LiteralPath "<ws>\.dsh-doctor-probe" -Value x -EA Stop; Remove-Item "<ws>\.dsh-doctor-probe" -Force; "ok" } catch { "fail: " + $_.Exception.Message }`
- **Bash**：`touch ./.dsh-doctor-probe && rm -f ./.dsh-doctor-probe && echo ok`
- **修复**：无（环境级）。detail 里写清当前 `sandboxMode` 与工作区路径。

### A.2 沙箱边界自检 — 中

- **判据**：往工作区外写**必须**被拒 → 被拒 = `ok`；竟然成功 = `warn/medium`（沙箱没生效，属于安全风险）。
- **PS**：`try { Set-Content -LiteralPath "$HOME\.dsh-doctor-probe" -Value x -EA Stop; "WROTE (bad)" } catch { "denied" }`
- **Bash**：`: > ~/.dsh-doctor-probe 2>/dev/null && echo WROTE || echo denied`
- **证据**：实测这里报 `UnauthorizedAccessException | 对路径"…"的访问被拒绝。`——**不是** DSH 的 `[sandbox: file access denied …]` 标记，判据只能看"有没有写成功"。

### A.3 工作区 ACL 是否被改坏 — 中

- **PS**：`icacls "<ws>"`（**Bash**：`icacls "$(cygpath -w "$PWD")"`）
- **判据**（只认两类真损坏，其余一律 `undiagnosed`）：
  1. 授权树内缺少当前用户的有效 `WRITE_DAC` / `WRITE_OWNER`；
  2. 出现显式 AppContainer 包 ACE：`^S-1-15-2-(?![12]$)`。
- **必须视为正常**：`Everyone:(CI)(DENY)(DC)`、`CodexSandboxUsers:(I)(OI)(CI)(RX)`、`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`、以及 `S-1-4-*` 这种无主能力 SID —— 这些是沙箱自己加的。**只拿拒绝文案判不了**"预期内"还是"改坏了"，必须比 `workspaceRoot`。
- **修复**：**永不动手**。结论写 `undiagnosed`，交棒内置技能 `diagnose-windows-sandbox-acl`（`<DSH>\dsh-sandbox-windows-acl\assets\diagnose-windows-sandbox-acl\` 下有可读的 SKILL.md 与 798 行脚本），话术："这项交给 `diagnose-windows-sandbox-acl`，我不改 ACL。"

### B.1 Git Bash 能否启动 — 高

- **PS**：`& "D:\Git\Git\bin\bash.exe" -lc 'echo MSYS_OK'`（**Bash**：`bash -lc 'echo MSYS_OK'`）
- **判据**：
  - 可执行文件不存在 → `fail/high`（很多技能与脚本要用）；
  - 失败且 stderr 含 `couldn't create signal pipe`（实测 exit `-1073741502` / `0xC0000142`）且 `sandboxMode ∈ {read-only, workspace-write}` → **`undiagnosed`**，detail 写"这是 DSH 沙箱的已知限制，不代表 bash 坏了"，并给用户命令：`在新终端里跑 bash -lc 'echo ok'`；
  - 其他非零退出 → `fail/high`。
- **修复**：重装 Git for Windows（便携版，不需要管理员）。

### B.2 bash 是否在 PATH 里 — 低

- **PS**：`Get-Command bash -EA SilentlyContinue`（**Bash**：`command -v bash`）
- **判据**：找不到 → `warn/low`（本机实测就是没有：`D:\Git\Git\bin\bash.exe` 存在但 PATH 里没有）。
- **修复（可自动）**：把 `D:\Git\Git\bin` 追加到**用户级** PATH（`[Environment]::SetEnvironmentVariable('Path', …, 'User')`，幂等），执行前打印命令并问一次。

### C.1 npm registry 可达性 — 高

- **PS**：`node -e "…fetch HEAD, AbortSignal.timeout(8000)…"`（探 `registry.npmmirror.com` 与 `registry.npmjs.org`；**不要**用 `Invoke-WebRequest`/`curl`，见 C.2）
- **Bash**：`curl -sS -o /dev/null -w '%{http_code}' --max-time 8 https://registry.npmmirror.com/<pkg>`
- **判据**：两个都超时/连不上 → `fail/high`（装插件必失败）；只有一个 → `warn/medium`（记下哪个不通）；都 200 → `ok`。实测：npmmirror 200 / 1635 ms、npmjs 200 / 1418 ms、github 200 / 429 ms。
- **修复**：换源（`npm config set registry …`）—— 影响全局，**必须问**；只给命令，不自动。

### C.2 curl / Invoke-WebRequest 的 TLS 栈 — 中

- **PS**：`try { Invoke-WebRequest -Method Head -Uri https://registry.npmmirror.com -TimeoutSec 8 } catch { $_.Exception.Message }`
- **Bash**：`curl -sS -I --max-time 8 https://github.com`
- **判据**：报 `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` → 沙箱内 `undiagnosed`（工具层限制）；裸机 → `warn/medium`（TLS 栈真有问题）。
- **修复**：改用 node/pnpm 走网络；或修系统证书。命令只给不自动。

### C.3 代理配置三处一致性 — 中

- **PS**：`$env:HTTPS_PROXY` / `git config --global --get http.proxy` / `npm config get proxy` 三处取值
- **Bash**：`env | grep -i proxy; git config --global --get http.proxy`
- **判据**：三处不一致（尤其 env 有而 git 没有、或代理已失效）→ `warn/medium`；全空或全同 → `ok`。实测本机三处全空。
- **修复**：按用户实际代理对齐，命令只给。

### C.4 git 凭据助手指向的程序是否存在 — 高

- **PS**：取 `git config --global --get-regexp '^credential.*helper$'` 里 `!'<路径>' …` 的路径，逐个 `Test-Path`
- **Bash**：`git config --global --get-regexp '^credential.*helper$'`
- **判据**：有指向不存在程序的 helper → `fail/high`（会挡住所有 push/pull）；空值行是 gh 用来清空继承列表的**正常写法**，不许误报；helper 存在 → `ok`。
- **修复（可自动）**：`git config --global --unset-all <key>` + `gh auth setup-git`，低危、可逆，先打印再问。

### D.1 执行策略是否拦 `.ps1` 脚本 — 中

- **PS**：`Get-ExecutionPolicy`（生效值，不是 `-List`）+ 命令解析：`Get-Command npm,pnpm -All`
- **Bash**：`powershell -NoProfile -Command "Get-ExecutionPolicy"`
- **判据**：生效策略为 `Restricted`/`AllSigned` 且 `npm`/`pnpm` 首先解析到 `*.ps1` → `warn/medium`（PowerShell 里直接调 `pnpm` 会报"在此系统上禁止运行脚本"）。**只看 `-List` 会误判**：本机五个 scope 全是 `Undefined`，而 `Get-ExecutionPolicy` = `Restricted`。
- **修复（可自动）**：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`，低危可逆，先打印再问。替代方案（不自动）：一律用 `pnpm.cmd`。

### E.1 DSH 与 Node 版本 — 高

- **PS**：`dsh --version`（应用自带的 `…\resources\runtime\cli\bin\dsh.cmd`）+ `node --version`
- **Bash**：`dsh --version; node --version`
- **判据**：`dsh` 找不到 → `warn/low`（**v1 实现修正了初稿的 `fail/high`**：这个工具本身就跑在 dsh 里，PATH 上找不到 dsh 只说明它是从应用自带 runtime 起的，不等于环境坏）；Node 主版本 < 20 → `warn/medium`；否则 `ok`。实测 dsh `0.2.0-rc.2`、node `v24.21.0`。

### E.2 必备命令是否就位 — 中

- **PS**：对 `git node npm pnpm gh python` 逐个 `Get-Command`；bash 走 B.1 的文件判定
- **Bash**：`for c in git node npm pnpm gh python; do command -v $c || echo "MISSING $c"; done`
- **判据**：缺任一项 → `warn/medium`（detail 列出缺谁、各给安装入口）；全在 → `ok`。

### E.3 同名命令多份安装 / 解析到意料之外 — 低

- **PS**：`Get-Command <c> -All`，比较首选路径与其它路径
- **Bash**：`type -a <c>`
- **判据**：≥2 个不同路径且首选不是"我们期望的那个"（如 pnpm 解析到 `AppData\Roaming\npm\pnpm.ps1` 而非 `.cmd`）→ `warn/low`；否则 `ok`。实测 npm ×3、pnpm ×3、其余 ×1。
- **修复（可自动）**：调用户级 PATH 顺序，低危可逆，先打印再问。

### E.4 pnpm 大版本与 DSH 自带不一致 — 低

- **PS**：`pnpm.cmd --version` vs `<DSH>\resources\runtime\pnpm\package.json` 的 `version`
- **Bash**：`pnpm --version`
- **判据**：主版本不同 → `warn/low`（lockfile 会被两代 pnpm 反复重写）。实测 PATH 上 `12.8.1`，DSH 自带 `11.7.0`。
- **修复**：装插件一律用 `dsh plugin`（它用自带 pnpm），不要手搓 `pnpm add`。只给建议。

### E.5 python 是否可用 — 低

- **PS**：`python --version`（**Bash**：同）
- **判据**：退出码非 0 或输出空（WindowsApps 的 Store 桩）→ `warn/low`；有版本号 → `ok`。实测 `Python 3.14.4`，正常。
- **修复**：装官方 python 或用 `py`；只给命令。

### F.1 安装通道：管理员 / winget / choco / scoop — 中

- **PS**：`WindowsPrincipal.IsInRole(Administrator)`、`EnableLUA`、`winget --version` 退出码、`Test-Path C:\ProgramData\chocolatey\bin` 的**可写性**（不是存在性）、`Get-Command scoop`
- **Bash**：`net session >/dev/null 2>&1 && echo admin || echo not-admin; winget --version; command -v choco scoop`
- **判据**：非管理员是**正常状态**（`info`，不算问题）；`winget` 非零退出（实测 `-1978335231` / `0x8A150001`）→ `warn/medium`；choco 存在但 bin 不可写（实测 `UnauthorizedAccessException`）→ 记 info"需要 UAC"；scoop 缺失记 info。
- **修复**：优先便携解压 + 用户 PATH（本机装 gh 就是这么做的）；winget/choco 安装要 UAC，**永不动手**。

### F.2 磁盘空间与长路径支持 — 中

- **PS**：`[System.IO.DriveInfo]::new("C").AvailableFreeSpace`；`LongPathsEnabled` 注册表值
- **Bash**：`df -h /c`；`reg query "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled`
- **判据**：剩余 < 10 GB → `warn/medium`（装大依赖会失败）；`LongPathsEnabled=0` → `warn/low`（`node_modules` 深路径可能超 260）。实测 55.8 GB / 400 GB、`LongPathsEnabled=0`。
- **修复**：清理命令只给；开长路径要管理员改注册表 → **永不动手**，只给命令。

## 3. 与报告原型的一致性（已对齐）

早期原型（`docs/prototypes/report/render.mjs`）里的分组标签是示意值（`A=运行时与工具链, B=沙箱与文件权限, C=git 与凭据, D=网络与代理, E=插件与技能装载, F=磁盘与编码`），与本目录的 A–F 定义不一致。**已按本目录对齐**（本目录为准：票 #6 批准的原始范围）：

- 分组标签现在是 `A 沙箱与文件权限 / B Git Bash / C 网络 · TLS · 凭据 / D 执行策略 / E 工具链 / F 权限与安装通道`，落在 `lib/report.js` 的 `GROUP_LABEL` 里——原型渲染器已删掉，渲染只有一处实现。
- 样例（`sample-result.json` / `sample-report.md` / `sample-summary.md`）由 `node docs/prototypes/report/make-samples.mjs` 用同一个渲染器重新生成，`verify.mjs` 会挡住「规范值改了但样例没重生成」。
- `verify.mjs` 还会比对 `report.schema.json` 与 `lib/report.js` 的 `valueSchema`：去掉注释键后必须逐键相同，防止文档与代码各写一份。

## 4. 摘要折叠规则（已确认）

17 项跑下来，坏日子可能同时有 6–8 条要处理。建议：摘要里**最多列 5 条**（票 #6 已确认），其余折叠成一行"另有 N 项，见报告"。理由：摘要的硬上限是 14 行，不折叠会被撑爆；而"哪 5 条"按现有排序（fail 优先、同级按 level 降序）取前 5，天然是用户该先看的。

