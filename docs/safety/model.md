# 安全模型（v1）

> 这份文件回答票 [#8](https://github.com/ZJYSZT/default-workspace/issues/8) 的四条要求：哪些动作允许自动修、确认的粒度与话术原文、只读保证怎么在代码层强制、撤销手段。
> 状态：**v1 定稿（2026-10-14）**。检查目录见 [检查目录](../checks/catalog.md)，接口见票 #2 的决策记录。
> 一句话：**体检绝不写；修只修 4 条用户级、可逆的事；每一次修都要过两道门（对话里问一次 + 宿主审批一次）。**

---

## 1. 三条不变量

| # | 不变量 | 含义 |
|---|---|---|
| **I1** | 体检（`mode:"check"`）**不产生任何持久副作用** | 除了 A.1/A.2 两个「自写自删探针」（工作区内/`$HOME` 下一个固定名字的文件，写完立刻删），不建文件、不改文件、不改注册表/PATH/执行策略。 |
| **I2** | 只有 4 条命中**自动修白名单** | `B.2` `C.4` `D.1` `E.3`，且都必须：用户级、可逆、影响面小。其余 13 条只给命令，一个字都不改。 |
| **I3** | 修之前，命令与旧值必须先被看见 | 打印「要执行什么 + 会改成什么 + 怎么撤销」，拿到用户的明确同意，再过宿主的审批。没有这两道门，修这一支根本进不去。 |

不变量破了的判定很简单：**只要出现"我不知道它改了什么"**，就是破。所以每条修都必须把 `before`（旧值原文）写进报告，让撤销可以照着做。

---

## 2. 只读保证：能力收口，而不是"记得别写"

票据要求"在代码层强制"。靠自觉、靠 code review、靠注释都不算强制；本设计把「能写」这个能力从体检路径里**删掉**：

### 2.1 收口一：检查函数拿不到 shell

检查不是 `(ctx) => 命令字符串`，而是 `(probe: Probe) => Promise<Result>`，`Probe` 只暴露三个能力：

```ts
// lib/checks/types.ts（伪代码，签名以实现为准）
export interface Probe {
  /** 只读地跑一条命令并拿到 stdout/stderr/退出码。超时 10s。 */
  read(cmd: string): Promise<ProbeOutput>;
  /** 唯一允许的写：在工作区里建 <ws>/.dsh-doctor-probe 再删掉（A.1）。 */
  probeInsideWorkspace(): Promise<'ok' | { denied: string }>;
  /** A.2 专用：故意往 $HOME 写一个探针，期望被拒；无论成败都立刻清理。 */
  probeOutsideWorkspace(): Promise<'denied' | 'wrote'>;
  /** 路径是否存在（不读内容）。 */
  exists(path: string): Promise<boolean>;
}
```

检查函数**没有** `ctx`，也就没有 `ctx.fs` / `ctx.shell` / `ctx.get('shell')` 的直接引用；唯一出口是 `probe.read()`，而它在实现里对入参做白名单校验（见 2.3）。这不是风格问题：**类型上就没有写通道**。

### 2.2 收口二：写命令只有一处能发出去

`lib/exec/readonly-shell.ts` 是体检路径唯一的执行器：

```ts
const WRITE_VERBS = /\b(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|icacls|takeown|Set-ExecutionPolicy|SetEnvironmentVariable|New-ItemProperty|Set-ItemProperty|reg\s+add|npm\s+config\s+set|git\s+config\s+--global\s+(?:add|set|unset)|gh\s+config\s+set|dsh\s+plugin)\b/i;

export async function readOnlyShell(shell: ShellExecutor, cmd: string, ctx: { checkId: string }) {
  if (WRITE_VERBS.test(cmd) && !ALLOWED_WRITE_PROBES.has(ctx.checkId)) {
    // 编程错误，不是运行时状况：宁可让这一条 undiagnosed，也绝不执行
    throw new Error(`E_READONLY_VIOLATION: 检查 ${ctx.checkId} 试图执行写命令：${cmd}`)
  }
  return shell.execute(shell.resolve({ command: cmd, timeoutMs: 10_000 }))
}
```

两个细节值得记下来：

- 白名单是**按 checkId** 给的两条（`A.1`、`A.2`），不是按命令内容给；第三条探针将来要加入，必须同时改这张表和测试。
- 正则只是"防手滑"，真正的保证是 2.1 的能力收口。正则误漏一条写命令的后果是**多跑一条无害命令**，而不是"悄悄改了环境"——因为它还得通过 2.1 才有机会跑。
- 探针文件名写死为 `.dsh-doctor-probe`（工作区内）与 `$HOME/.dsh-doctor-probe`（A.2 专用），且 A.1 的探针路径必须落在 `workspaceRoot` 之内（用 `path.relative` 判，不许字符串前缀判）。

### 2.3 收口三：模式不是"可选项"

| 情况 | 行为 |
|---|---|
| `ctx.sandboxPolicy` 拿不到 | 所有跟写有关的结论一律 `undiagnosed`，并说明"拿不到沙箱策略，无法判断本次是否能写" |
| 宿主沙箱是 `read-only` | 体检照跑；但要修的那 4 条一律 `undiagnosed` + 给命令，`mode:"fix"` 直接拒绝（`E_FIX_UNAVAILABLE`），不尝试升级 |
| 宿主沙箱是 `workspace-write` / `danger-full-access` | 修可以走，但必须过第 3 节的两道门 |

「只读模式真的不写任何东西」在测试里是可验证的（见 4.1），不是声明。

---

## 3. 修：白名单、两道门、话术

### 3.1 白名单（只有这 4 条，逐条写明改什么）

| id | 改什么（确切） | 旧值记成什么 | 撤销命令 | 风险 |
|---|---|---|---|---|
| **B.2** | 用户级 `PATH`：追加 `D:\Git\Git\bin`（幂等；已存在则不动） | 追加前的 `PATH` 原文 | 用 `before` 覆盖回 `SetEnvironmentVariable('Path', before, 'User')` | low |
| **C.4** | `git config --global --unset-all <key>`（只删指向不存在程序的那几个 key）+ `gh auth setup-git` | 被删的 `key=value` 原文（可能多行） | 逐行 `git config --global --add <key> <value>` | low |
| **D.1** | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` | `CurrentUser` scope 的原值（本机实测 `Undefined`） | `Set-ExecutionPolicy -Scope CurrentUser <原值>` | low |
| **E.3** | 用户级 `PATH` 内部顺序（把 `.cmd` 所在目录提到 `AppData\Roaming\npm` 之前） | 调整前的 `PATH` 原文 | 同 B.2 | low |

四条之外**一律不动手**（catalog §1 逐项标了"否"）。特别是：`A.3`（ACL）交棒内置技能 `diagnose-windows-sandbox-acl`；`F.1`（winget/choco）与 `F.2`（长路径注册表）需要 UAC/管理员，只给命令。

### 3.2 第一道门：对话里问（话术原文）

模型**必须逐字**用这个模板（只填占位符），不许概述命令、不许合并多条、不许在用户没回答时继续：

```
要修 **<id> · <标题>**：
- 现状：<一句话 + 关键旧值>
- 将执行（<n> 条，权限范围：<用户级/当前用户 scope>）：
  ```
  <命令原文，逐条，不许缩写成"调整 PATH">
  ```
- 会改到：<具体文件或配置键>；不会碰别的。
- 撤销：`<撤销命令>`（旧值我已记进报告）
- 如果这一步失败或你点了取消：<什么都不改 / 已改的部分按上面的撤销命令回退>

要我做吗？（做 / 不做）
```

用户回答的解析规则（写进 SKILL.md 与工具描述）：

| 用户说 | 行为 |
|---|---|
| 明确肯定（"做"/"好"/"修吧"/"yes"） | 才允许调 `mode:"fix"` |
| 否定或"先别" | 什么都不做，报告里该条保持原结论 |
| 含糊（"嗯"、"随便"、没回答） | **不执行**，再问一次；两次含糊就放弃并说明"没得到明确同意，我不动" |
| "全都修了吧" | 允许，但仍**逐条**执行：每条单独一次工具调用、单独一次宿主审批、单独打印命令与旧值；**没有**"一次调用改 4 处" |

### 3.3 第二道门：宿主审批（这才是"强制"）

第一道门是对话纪律，可以被话说服；第二道是宿主的机制，绕不过去。实现上用宿主已有的三件东西，不自建弹窗：

1. **`tools/pre-execute` 决策**：当 `toolName === 'dsh_env_doctor'` 且 `mode === 'fix'` 时返回 `{ kind: 'ask', reason, displayReason }`。宿主的规则是：`ask` 只有在审批服务返回 `allowed-once` 时才继续，否则**拒绝**；没有审批服务时**默认拒绝**（fail-closed）。`displayReason` 用来把"要改什么"直接放进审批提示里。
2. **单调护栏 `ctx.tools.guard`**：再加一道只能收紧、不能被别的插件放宽的检查——`mode:"fix"` 且（`confirm !== true` 或 `id` 不在白名单）→ 返回拒绝理由。护栏只会 deny，不会 allow，所以它是"最后的机械保证"。
3. **写工作区外要升级**：`B.2`/`C.4`/`D.1`/`E.3` 都要写 `$HOME` 或用户级环境，落在 `workspace-write` 之外。所以修复命令必须以 `sandbox_permissions` + 非空的 `justification`（中文一句话）请求**更宽的模式**；`approveEscalation` 的语义是：只有更宽才需要审批、只对这一次调用生效、不是 `allowed-once` 就在执行前抛错——**一个字节都不会写**。

> 为什么不用"工具内部自己弹窗"：插件没有弹窗能力，自建同意界面等于把"同意"降级成"模型说用户同意了"。用宿主的审批，用户看到的是宿主渲染的提示 + 我们的命令原文，拒绝时工具真的不会被执行。

### 3.4 参数层面的最小化

工具只有两个模式，`fix` 需要显式结构体，误调用在 schema 层就进不来：

```jsonc
"mode":  { "type": "string", "enum": ["check", "explain", "fix"] },
"fix":   {
  "type": "object",
  "properties": {
    "id":      { "type": "string", "enum": ["B.2", "C.4", "D.1", "E.3"] },
    "confirm": { "type": "boolean", "const": true }
  },
  "required": ["id", "confirm"],
  "additionalProperties": false
}
```

`confirm` 用 `const: true`（而不是靠代码里判）：模型忘了传，schema 直接拒；传了 `false` 也拒。

---

## 4. 怎么证明（测试清单，随实现一起写）

### 4.1 只读证明（对应 I1）

1. **命令白名单测试**：用会记录每条命令的假 shell 跑全部 17 项，断言：记录到的命令数 = 17 项实际需要的条数，且除 `A.1`/`A.2` 的探针外，没有任何命令命中 `WRITE_VERBS`。
2. **副作用测试（真机）**：跑 `mode:"check"` 前后，对这几个文件做 sha256 快照并断言不变：`~/.gitconfig`、`~/.npmrc`、`~/AppData/Roaming/npm/etc/npmrc`（若存在）、`~/.ssh/config`（若存在）、`~/AppData/Local/Microsoft/Windows/PowerShell/...`（若存在）；同时比对用户级 `PATH` 与 `Get-ExecutionPolicy -List` 的三处取值。
3. **探针清理测试**：`check` 跑完后断言 `Test-Path <ws>/.dsh-doctor-probe` = false 且 `Test-Path $HOME/.dsh-doctor-probe` = false（A.1 写工作区、A.2 写 $HOME 都必须删掉；A.2 写到一半被拒也要保证没留下半截文件）。
4. **无审批调用测试**：`mode:"check"` 全程不得调用审批服务一次（只读路径不该触发审批）。

### 4.2 修复闸门测试（对应 I2 / I3）

1. `mode:"fix"` + `confirm` 缺失或为 false → 被 schema 拒（或护栏拒），且假 shell 收到 0 条命令。
2. `fix.id = "A.3"` → 抛 `E_FIX_NOT_ALLOWED`，0 条命令。
3. 审批返回 `rejected` / `cancelled` / `unavailable` → 各给不同文案，0 条命令（三个分支都要测，别只测 rejected）。
4. 审批 `allowed-once` 但修复命令自己失败 → 该条结论保持 `fail` 并附"修了但没成功"+ 原始 stderr；不许写成 `ok`。
5. `read-only` 沙箱下 `mode:"fix"` → `E_FIX_UNAVAILABLE`，且**不**尝试升级。

### 4.3 撤销测试

对 `before` 的构造逻辑单测：给一份假配置，做 fix 再按 `before` 撤销，断言回到原值（PATH 的拆分/拼回、git 多行的 key/value、ExecutionPolicy 的 `Undefined` 都能还原）。

---

## 5. 撤销与失败

- **报告必须留 before**：`results[].applied = { at, id, command, before, outcome }`（`outcome` = `ok` / `failed` / `cancelled` / `rejected`）。这是撤销的唯一依据，也是"历史对比"能解释"谁改了什么"的依据。
- **修完必复检**：同一个 fix 执行后立刻重跑该条检查（复用 check 函数），把复检结果写进 `applied.outcome`，并在摘要里说"已修并复检通过 / 修了但没成功"。
- **失败不自动重试**：命令失败就停，把 stderr 原样给用户，不再试第二种修法（例如 D.1 失败后不会自动去改 `$PROFILE`）。
- **撤销提示**：报告里每条 `applied` 都紧跟一行"撤销：`<命令>`"，用户以后可以自己回退，不必重跑插件。

---

## 6. 边界：我不做什么

- 不改 ACL（`A.3` 交棒内置技能），不碰注册表安全项，不装 MSI，不请求 UAC 提权，不写系统级 PATH。
- 不在体检里做"顺手修复"（比如看见 registry 慢就换源）——`C.1` 的换源影响全局，只给命令。
- 不碰任何带密码/令牌的文件（`.netrc`、`~/.ssh/id_*`、`gh` 的 keyring 条目）；`C.4` 只删**指向不存在程序**的 helper 行。
- 不替用户做"要不要公开发布"的决定；插件默认 `private: true`，发布是另一张票（#7）。

---

## 7. 两处必须同步的改动（实现时别忘）

1. **报告 schema**：`results[]` 增加 `applied`（见 §5），`report.schema.json` 与 `render.mjs` 同步；样例重生成，`verify.mjs` 的 `counts` 自洽断言继续保持。
2. **检查目录**：`catalog.md` §1 的 `B.2` 修法写的是"追加 `D:\Git\Git\bin`"，但该路径要**运行期从 B.1 的探测结果推出来**（bash 可能装在别处），不许写死。实现时在 `B.2` 的判据里补一句"候选目录取自 B.1 解析出的 bash 父目录"。
