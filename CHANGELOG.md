# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- v0.1.0 实现落地（可安装、可调用、可自测）：
  - `lib/` 六件：`index.js`（注册 bundled 技能）、`tools.js`（`dsh_env_doctor` 工具 + 单调护栏）、`probe.js`（单一只读执行器，一律走宿主 `ctx.shell`，不自己 spawn）、`checks.js`（17 项检查）、`report.js`（规范值 / 一致性闸门 / 摘要与全文渲染）、`fix.js`（4 条白名单修复）。
  - `cordis.patch.yml` 两行（技能包 + 工具包）与 `bundled-skills/env-doctor/SKILL.md`。
  - `test/` 四套：`run.mjs`（假 shell，25 条断言）、`safety.mjs`（四组安全测试）、`e2e-real.mjs`（本机真跑 17 项）、`e2e-installed.mjs`（装进 profile 后按包名解析并注册）。
  - 报告样例改由 `lib/report.js` 生成（`make-samples.mjs`）；`verify.mjs` 增加「文档 schema ≡ 代码 valueSchema」与样例漂移两道闸门；原型渲染器 `render.mjs` 删除，渲染只有一处实现。
- 设计定稿（文档）：
  - 17 项检查目录（A 沙箱/ACL · B Git Bash · C 网络/TLS/凭据 · D 执行策略 · E 工具链 · F 权限与安装通道），见 `docs/checks/catalog.md`。
  - 报告格式：人读 Markdown + 机读 JSON schema（规范值是唯一事实来源，摘要与全文都由它渲染），见 `docs/prototypes/report/`。
  - 安全模型：体检零副作用（能力收口 + 单一只读执行器）、仅 4 条可自动修（B.2 / C.4 / D.1 / E.3）、两道确认门、每条修留 `before` 供撤销，见 `docs/safety/model.md`。
  - 插件契约实测：`dsh.bundle.patch` 才能激活、`parameters` 必须是完整 JSON Schema、`ctx.X` 需 `inject`、工具包绝不进 `dependencies`（第二份副本会让所有工具调用崩在 `prepare`）。

### Changed

- `E.1` 的判据从「PATH 里没有 dsh → fail/high」改为 `warn/low`：本工具本身跑在 dsh 里，PATH 缺 dsh 不等于环境坏（理由已写回 `docs/checks/catalog.md`）。
- 报告分组标签与 `docs/checks/catalog.md` 对齐：A 沙箱与文件权限 / B Git Bash / C 网络 · TLS · 凭据 / D 执行策略 / E 工具链 / F 权限与安装通道。
- `files` 从 `docs` 收窄成 `docs/checks`、`docs/safety`、`docs/prototypes`：调研稿留在 `default-workspace` 仓库，不随包发。重测 tarball：21 个文件、`size 61,770` / `unpackedSize 178,051`（此前 23 个文件 / 98,460 / 271,026）。

### Fixed

- **观测受限被写成结论**（沙箱或宿主 `ctx.shell` 不可用时最要命）：`probe.lookup()` 把「真的没有这个命令」和「这次根本查不了」分开；`C.2`/`C.4`/`E.2`/`E.3`/`E.4`/`E.5`/`F.1`/`F.2` 在查不成时一律 `undiagnosed`，不再输出「缺 7 个」「pnpm 不可用」「只解析到一份」这类假结论。
- `F.2` 不再把「长路径没读到」写成「都正常」：磁盘够但 `LongPathsEnabled` 未知时判 `undiagnosed`；同时把磁盘空闲判据对齐目录（`< 10 GB → warn`），evidence 里写真实盘符而不是写死 `C:`。
- `C.2` 的 TLS 探测从 `curl -o NUL`（会被只读护栏当写命令拦掉）改成 `curl -I`（HEAD 请求，不落盘），并对 GBK 代码页输出做可读化处理。
- `test/safety.mjs` 第 4 组补两条：宿主 shell 全面失败时报告仍完整；单个检查抛异常被降级成 `undiagnosed` 且不污染其余 17 项（`runChecks` 的 try/catch 现在有测试盯着）。

### Not yet

- 首次 `npm publish`（registry 登录与 OTP 见 `RELEASE.md`）。
