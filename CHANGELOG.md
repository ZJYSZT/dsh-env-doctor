# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 设计定稿（代码尚未落地）：
  - 17 项检查目录（A 沙箱/ACL · B Git Bash · C 网络/TLS/凭据 · D 执行策略 · E 工具链 · F 权限与安装通道），见 `docs/checks/catalog.md`。
  - 报告格式：人读 Markdown + 机读 JSON schema（规范值是唯一事实来源，摘要与全文都由它渲染），见 `docs/prototypes/report/`。
  - 安全模型：体检零副作用（能力收口 + 单一只读执行器）、仅 4 条可自动修（B.2 / C.4 / D.1 / E.3）、两道确认门、每条修留 `before` 供撤销，见 `docs/safety/model.md`。
  - 插件契约实测：`dsh.bundle.patch` 才能激活、`parameters` 必须是完整 JSON Schema、`ctx.X` 需 `inject`、工具包绝不进 `dependencies`（第二份副本会让所有工具调用崩在 `prepare`）。

### Not yet

- `lib/` 实现、`bundled-skills/env-doctor/SKILL.md`、`test/` 四组安全测试、首次 `npm publish`。
