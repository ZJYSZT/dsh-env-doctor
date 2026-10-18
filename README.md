# dsh-env-doctor

> Windows / DSH 环境医生 —— 说一句「体检一下」，拿到「哪里坏了 + 为什么 + 该敲什么」。

**状态：v0.1.0 已发布到 npm。** 设计文档仍在（[检查目录](docs/checks/catalog.md)、[安全模型](docs/safety/model.md)、[报告格式](docs/prototypes/report/)），随包一起发。

[中文](#dsh-env-doctor) · [English](#english)

---

## 1. 它解决什么

Windows 上跑 DSH（或任何 Node 工具链），坏掉的方式往往很隐蔽：命令明明装了却解析到 `.ps1`、`git push` 卡在凭据、`bash` 起不来但不是 Git 坏了、沙箱把写入拒了却给不出原因。这些问题的共同点是——**报错信息不指向真正的原因**。

`dsh-env-doctor` 做一件事：把该查的都查一遍，按「真的坏了 / 能用但要注意 / 说不准」三档给结论，每条都带原始证据和可以直接粘贴的命令。

它不是万能修复器，设计上刻意保守：

- **体检零副作用**：除了两个自写自删的探针文件，不建文件、不改配置、不动注册表。
- **只有 4 条能自动修**（`B.2` / `C.4` / `D.1` / `E.3`），且都要你先明确点头；其余只给命令。
- **说不准就说不准**：探测不到时给 `undiagnosed` 并说明原因，绝不猜成 `ok`。

## 2. 安装

```bash
dsh plugin --profile desktop add dsh-env-doctor
```

装完**完全退出** DSH Desktop 再打开一次（模块代码要重启才加载；只热更新配置不够）。`dsh web` 用户用 `--profile web` 并重启 `dsh web`。

> 装不上时优先试：`add dsh-env-doctor@latest --registry https://registry.npmjs.org`。刚发布的版本可能被 pnpm 的 `minimumReleaseAge` 供应链接管期静默跳过，或镜像还没同步。

## 3. 使用

在对话里说「**体检一下**」，或直接点名工具：

```
dsh_env_doctor(mode="check")
```

三种模式：

| 模式 | 做什么 | 写东西吗 |
|---|---|---|
| `check` | 跑全部 17 项，写报告文件 | 只写报告（默认在你工作区的 `.dsh-doctor/`） |
| `explain` | 不跑命令，按当前沙箱模式解释某一项为什么这样判 | 不写 |
| `fix` | 执行一条已确认的修复（见第 5 节） | 会改你点头的那一处 |

报告写到 `<工作区>/.dsh-doctor/report-<时间戳>.md`（旁边一份同内容 JSON 供历史对比），给模型看的只有十来行摘要。

## 4. 它检查什么（17 项）

| 组 | 查什么 | 项 |
|---|---|---|
| **A** 沙箱与文件权限 | 沙箱模式、工作区可写性、边界是否生效、ACL 是否被改坏 | A.1–A.3 |
| **B** Git Bash | 能不能启动（沙箱内启动失败是已知限制，判 `undiagnosed` 而不是故障）、是否在 PATH | B.1–B.2 |
| **C** 网络 / TLS / 凭据 | npm registry 可达性、TLS 栈、代理三处一致性、git 凭据助手是否指向不存在的程序 | C.1–C.4 |
| **D** 执行策略 | PowerShell 是否拦住 `npm.ps1` / `pnpm.ps1` | D.1 |
| **E** 工具链 | DSH 与 Node 版本、必备命令、同名多份安装、pnpm 大版本、python | E.1–E.5 |
| **F** 权限与安装通道 | 管理员/winget/choco/scoop、磁盘空间与长路径 | F.1–F.2 |

完整的判据、探测命令、危险等级在 [检查目录](docs/checks/catalog.md)；那份表是实现和历史的唯一契约，id 发布后不再改。

## 5. 它会改什么、绝不改什么

**能自动修的 4 条**（都要你先确认，命令逐字打印，旧值记进报告以便撤销）：

| id | 改什么 |
|---|---|
| `B.2` | 把 bash 所在目录追加进**用户级** PATH |
| `C.4` | 删掉指向不存在程序的 git 凭据 helper，再 `gh auth setup-git` |
| `D.1` | 把 `CurrentUser` 执行策略设为 `RemoteSigned` |
| `E.3` | 调整**用户级** PATH 顺序，让 `.cmd` 优先于 `.ps1` |

**永不碰**：ACL（交棒内置技能 `diagnose-windows-sandbox-acl`）、注册表安全项、MSI/需要 UAC 的安装、系统级 PATH、任何带密码或令牌的文件。这些一律只给命令。

安全模型的完整论证（为什么"体检不写"能靠代码保证、两道确认门在哪、怎么测）见 [docs/safety/model.md](docs/safety/model.md)。

## 6. 报告长什么样

给模型的摘要（十来行，不是报告全文）：

```
体检完成：17 项检查 —— 通过 13、注意 2、失败 1、说不准 1。总体：失败
1. [高危] C.4 git 凭据助手指向的程序是否存在
   → git config --global --unset-all credential.https://github.com.helper
2. [中] D.1 执行策略是否拦 `.ps1` 脚本
   → Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
3. [低] E.3 同名命令多份安装 / 解析到意料之外
   → 把 %APPDATA%\npm 与 pnpm 的 .cmd shim 所在目录在用户级 PATH 中前置到 WindowsApps 之前
说不准：B.1（原因见报告）
全文：C:\...\.dsh-doctor\report-20261014-171203.md
```

这段就是 [sample-summary.md](docs/prototypes/report/sample-summary.md) 的原文（那个示例里 `B.2` 已经修完并复检通过，所以它不在「要动手」里，而是出现在报告的「已执行的修复」）。

完整报告是 Markdown：顶部一张元信息表 + 一句话结论，然后每个问题一节（现象 / 证据 / 下一步），最后是 17 项总表和「说不准的」。样例见 [docs/prototypes/report/sample-report.md](docs/prototypes/report/sample-report.md)（**构造的示例**，用来演示四种 verdict 的形状，不是某台机器的真体检记录）。

## 7. 常见问题

- **`B.1` 说 bash 起不来，可我明明能用 Git Bash？** 在 DSH 沙箱里启动 MSYS2 会报 `couldn't create signal pipe, Win32 error 5`，这是沙箱限制，不是你的 Git 坏了——所以判 `undiagnosed` 并给你一条在新终端里跑的命令。
- **`A.3` 为什么总是「说不准」？** ACL 的真损坏只有两类（授权树里缺有效的 `WRITE_DAC`/`WRITE_OWNER`，或出现显式 AppContainer 包 ACE）；其余一律不猜。这项交棒给内置技能处理，本插件不改 ACL。
- **报告的 id 会变吗？** 不会。`C.4` 这类 id 是历史对比的键，只许往后追加新项。

## 8. 卸载

```bash
dsh plugin --profile desktop remove dsh-env-doctor
```

自动修过的东西不会自动还原——按报告里每条的「撤销」命令回退即可。

## 9. 开发

```bash
git clone https://github.com/ZJYSZT/dsh-env-doctor
cd dsh-env-doctor
npm test                      # 假 shell 的单元测试 + 四组安全测试（见 docs/safety/model.md §4）
npm run test:e2e              # 在本机真跑 17 项（会真的读注册表 / 查 PATH，不写除报告外的任何东西）
npm run verify:samples        # 重新生成报告样例并验证 schema / 样例 / 渲染器三者不漂移
dsh plugin --profile desktop add .    # 本地装进 profile
```

发布流程（版本策略、registry 前置条件、发布清单）见 [RELEASE.md](RELEASE.md)。

## 10. 许可

[Apache-2.0](LICENSE)，版权声明见 [NOTICE](NOTICE)。

---

## English

**dsh-env-doctor** is a Windows environment doctor for [DSH](https://github.com/deepseek-harness). Say "run a health check" and get a verdict per check — *broken / worth noting / can't tell* — each with raw evidence and a command you can paste.

Design principles: the health check never mutates your machine (only a report file), exactly four items can be auto-fixed (`B.2`, `C.4`, `D.1`, `E.3`) and only after you explicitly confirm, and anything unobservable is reported as `undiagnosed` instead of being guessed as `ok`.

**Status:** design complete, implementation in progress; `v0.1.0` is not published yet.

**Install (once published):**

```bash
dsh plugin --profile desktop add dsh-env-doctor
# then fully quit and reopen DSH Desktop
```

**Use:**

```
dsh_env_doctor(mode="check")     # run all 17 checks, write the report
dsh_env_doctor(mode="explain", input="A.3")   # explain one check without running it
dsh_env_doctor(mode="fix", fix={id:"C.4", confirm:true})   # one confirmed fix
```

Reports go to `<workspace>/.dsh-doctor/report-<timestamp>.md` plus a JSON twin for history. The 17 checks cover sandbox/ACL, Git Bash, network/TLS/credentials, PowerShell execution policy, toolchain, and install channels. Never touched: ACLs, registry security keys, anything needing UAC, system PATH, credential files.

Full design — check catalog, safety model, report schema — lives in [`docs/`](docs/). Licensed under [Apache-2.0](LICENSE).
