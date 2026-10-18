# 发布计划（票 #7 的产物）

> 这份文件回答「别人怎么装得上」。每一条结论都尽量带证据或来源；没有证据的写「待实测」。
> 状态：**v1 定稿（2026-10-14）**。实现落地前，包里还没有 `lib/`，所以现在只能验证 metadata，不能真发布。

## 1. 身份

| 项 | 决定 | 为什么 |
|---|---|---|
| npm 包名 | **`dsh-env-doctor`**（无 scope） | 2026-10-14 实测 `npm view dsh-env-doctor` → `E404 Not found`，名字可用；无 scope 的安装命令最短：`dsh plugin --profile desktop add dsh-env-doctor`。名字不锁 Windows，将来能加别的平台 |
| 备选 | `@zjyszt/dsh-env-doctor`（同一天实测也 404，可用） | 只有在无 scope 名被别人抢注、或需要和别的 `dsh-*` 包区分时才用；scoped 包发布时要 `publishConfig.access: "public"`，否则默认私有、别人装不上 |
| 仓库 | `ZJYSZT/dsh-env-doctor`（**先 private**） | 设计/实现阶段不对外；发布前转 public，转的一刻 README 与 LICENSE 必须已经是终态 |
| 许可 | **Apache-2.0** | 用户选择。`LICENSE` 为 apache.org 官方原文（逐字，不手抄），`NOTICE` 写产品名 + 版权年 + 版权人；Apache-2.0 第 4 条要求分发时带上 NOTICE |
| 版权人 | `ZJYSZT`（与 git `user.name`、GitHub 账号一致） | 凭据来自本机 `git config --global user.name` |

## 2. 版本与变更记录

- **0.x 阶段**：`0.1.0` 是第一个能装上的版本（17 项检查 + 工具 + 技能 + 报告）；之后按 SemVer：`0.1.1` 修 bug、`0.2.0` 加检查项或改报告字段。
- **1.0.0 的门槛**（写死，不许随口升）：17 项在**第二台机器 + 另一个 GitHub 账号**上跑通，且 `docs/checks/catalog.md` 的 17 个 id 一个都没改过。理由：0.x 期间报告字段与检查语义还可能动，1.0.0 是「历史对比可以当真」的承诺。
- **预发布**：偶尔需要先发一版给朋友试，用 `npm publish --tag next`；`latest` 只留稳定版。
- **git tag**：`v0.1.0` 与 npm 版本号严格一致；GitHub Release 从 tag 生成，正文取自 `CHANGELOG.md` 对应小节。
- **变更记录**：手写 `CHANGELOG.md`（Keep a Changelog 格式）。单个包、没有 monorepo，**不引入 changesets**——它会带来一个额外的发布工具链和「忘了跑」的风险，收益不抵成本。

## 3. `dsh plugin add <name>` 从 registry 解析的前置条件

逐条列出来，因为这些是"发布成功但装不上/装上不加载"的常见死法：

1. **已发布到公共 registry**，且版本过了 pnpm 的 `minimumReleaseAge` 供应链接管期。本机 desktop profile 的 `pnpm-workspace.yaml` 里有这个策略；刚发布的版本可能被静默跳过。README 里要给用户的解法：`add dsh-env-doctor@latest --registry https://registry.npmjs.org`，或等一天。
2. **`dsh.bundle.patch` 必须指向包里真实存在的 `cordis.patch.yml`**。这是唯一的激活开关：`dsh-plugin-manager` 的 `bundleManifest()` 在没有 `dsh.bundle.patch` 时返回 undefined，包会被装成**普通依赖**，只打一行 `declares no dsh.bundle — installed as a plain dependency, not a profile layer` 的警告。缺了它，装上也不加载。
3. **`files` 必须覆盖运行期需要的一切**：`lib/`、`cordis.patch.yml`、`bundled-skills/`（技能走 `registerProvider` 时要从包目录读 SKILL.md）、`LICENSE`、`NOTICE`、`README.md`、`CHANGELOG.md`。`private: true` 时 `npm pack` 仍然可用，所以**发布前用 `npm pack --dry-run --json` 检查文件清单**，别靠记忆。
4. **`exports` 的子路径要能解析**：`cordis.patch.yml` 里的行 `name: 'dsh-env-doctor/tools'` 靠 `exports["./tools"]`；漏写这个子路径，行会 import 失败（实测 dsh-hello 的 `./tools` 行就是这么成功的）。
5. **不写 `peerDependencies` 里的 `@deepseek-ai/dsh*`**：这是有意为之。写了会被宿主的兼容性检查在**安装后**拦下并回滚（`installation rejected` + 恢复 package.json/lockfile），更要命的是 pnpm 会为它装**第二份**工具包——deck 的血泪注释记着：第二份副本的 identity 与宿主不一致，所有工具调用崩在 `Cannot read properties of undefined (reading 'prepare')`。宿主能力一律运行期用 `ctx.get('shell')` / `ctx.get('tools')` 探测，不声明依赖。
6. **`engines.dsh` 只是声明**，没有任何代码读它（`dsh-package-manifest` 的类型注释原话："declarative until a reader enforces it"）。留着它是为了让市场和人类看得懂，不要指望它挡住不兼容。
7. **没有 client 半边就不需要构建步骤**：v1 只有工具 + 技能，`lib/*.js` 直接是 ESM 源码，随包发即可。将来加控制面板行（`dsh.client`）时，`lib/client.js` 必须**预构建后随包发**——registry tarball 安装不会跑 `prepare`（只有 git 安装才跑），指望安装端构建会静默失败。
8. **`private: true` 现在是开着的**，发布当天要手动改成 `false`（或删掉这一行）。这是故意的闸门：防止手滑 `npm publish` 一个半成品。

## 4. 发布清单（发布当天照着打勾）

```text
[ ] 1. npm 已登录：npm.cmd whoami（本机实测：未登录，报 ENEEDAUTH）
[ ] 2. package.json 的 private 改为 false；version 改成目标版本
[ ] 3. CHANGELOG.md 顶部把 [Unreleased] 改成 [x.y.z] - YYYY-MM-DD
[ ] 4. npm pack --dry-run --json  → 人工核对文件清单（lib/ cordis.patch.yml bundled-skills/ LICENSE NOTICE README CHANGELOG）
[ ] 5. 本地装一次真跑：dsh plugin --profile <临时 profile> add ./dsh-env-doctor-x.y.z.tgz
[ ] 6. npm publish（开了 2FA 就加 --otp <六位码>）；预发布用 --tag next
[ ] 7. git tag v<x.y.z> && git push --tags
[ ] 8. gh release create v<x.y.z> --notes-from-tag（正文取 CHANGELOG 该小节）
[ ] 9. 仓库转 public（gh repo edit --visibility public --accept-visibility-change-consequences）
[ ] 10. 干净环境复验：dsh plugin --profile desktop add dsh-env-doctor（等过 minimumReleaseAge）
```

第 5 步不能省：registry 装与本地 tgz 装走的路径不同（前者受 `minimumReleaseAge`、镜像滞后影响），但**包内容**必须先在小 profile 里验证过，否则装上一个跑不起来的包，比装不上更难排查。

## 5. 发布之后：改不了的事

- **npm 的 unpublish 只有 72 小时窗口**，且被别的包依赖过就不让删；过了窗口只能用 `npm deprecate dsh-env-doctor@0.1.0 "原因"` 打标并另发新版。→ 所以 §4 第 4/5 步是发布前最后的刹车。
- **`latest` 标签指错版本**要立刻 `npm dist-tag add dsh-env-doctor@x.y.z latest`，别靠再发一版盖。
- **镜像滞后**不是我们的问题：npmmirror 同步通常几分钟到几十分钟，用户在镜像上装不到时应给 `--registry https://registry.npmjs.org` 兜底。

## 6. 文档迁移（发布前必须做）

设计文档现在在 `default-workspace` 仓库（私有）：`docs/checks/catalog.md`、`docs/safety/model.md`、`docs/prototypes/report/`、`docs/research/`。插件仓库的 README 会链接这些文档——**转 public 之前**必须把它们复制进本仓库 `docs/`（`files` 已包含 `docs`），否则公开的 README 会指向别人看不见的私有仓库。
