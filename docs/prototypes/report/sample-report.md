# DSH 环境体检报告

| 项 | 值 |
|---|---|
| 生成时间 | 2026-10-14T17:12:03+08:00 |
| 沙箱模式 | `workspace-write` |
| 工作区 | `C:\Users\神\Documents\deepseek-harness\default-workspace` |
| 总体结论 | **失败** —— 9 项：通过 5 / 注意 2 / 失败 1 / 说不准 1 |

## 一句话结论

有 1 项真的坏了（C.2），先修它再谈别的；另有 1 项说不准（D.1），不代表没问题。

## 需要你动手的（按优先级）

### C.2 · git 凭据助手指向一个不存在的程序 — 高危 · 失败

**现象与原因**：全局 credential helper 里有一条指向已删除路径的记录，git 在需要凭据时会直接失败（或退回让你手输密码）。这会挡住所有 push/pull，是本次体检里唯一「真的坏了」的一项。

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

### E.1 · 已装插件的版本要求与当前 DSH 不匹配 — 中危 · 注意

**现象与原因**：@roarpeng/graphflow 声明 peerDependencies @deepseek-ai/dsh-tools >=0.3.0，而当前 DSH 是 0.2.0-rc.2。现在能跑，但下次升级或重装这个插件时会被拒（宿主装完会校验并回滚）。

**证据**：

```text
peerDependencies {"@deepseek-ai/dsh-tools":">=0.3.0"} — dsh 0.2.0-rc.2
```

**下一步**（风险：中危，只给命令，不自动执行）：

```bash
dsh plugin --profile desktop add @roarpeng/graphflow@2.2.9
```

> 降到与当前 DSH 兼容的版本；升 DSH 才是根治，但那要等上游出正式版。

### F.1 · 系统盘剩余空间 — 低危 · 注意

**现象与原因**：C: 剩余 12.4 GB。插件与 pnpm store 都在这个盘上，低于 20 GB 时安装大依赖容易失败。暂时不影响使用。

**证据**：

```text
C: free 12.4 GB / total 476 GB
```

## 全部检查

| # | 检查 | 结果 | 等级 |
|---|---|---|---|
| A.1 | DSH 与 Node 版本 | 通过 | 信息 |
| A.2 | 关键命令都在 PATH 里 | 通过 | 信息 |
| B.1 | 沙箱模式与工作区可写性 | 通过 | 信息 |
| B.2 | 工作区之外的写入被拒 | 通过 | 信息 |
| C.1 | gh 登录状态 | 通过 | 信息 |
| C.2 | git 凭据助手指向一个不存在的程序 | 失败 | 高危 |
| D.1 | npm registry 连通性 | 说不准 | 信息 |
| E.1 | 已装插件的版本要求与当前 DSH 不匹配 | 注意 | 中危 |
| F.1 | 系统盘剩余空间 | 注意 | 低危 |

### 分组

- **A 运行时与工具链** —— 2 项，全部正常
- **B 沙箱与文件权限** —— 2 项，全部正常
- **C git 与凭据** —— 2 项，其中 1 项要处理
- **D 网络与代理** —— 1 项，全部正常
- **E 插件与技能装载** —— 1 项，其中 1 项要处理
- **F 磁盘与编码** —— 1 项，其中 1 项要处理

## 说不准的

- **D.1 · npm registry 连通性** —— 对 registry.npmmirror.com 的探测 10 秒超时，既没成功也没给出明确错误——这一项「说不准」。不等于坏了：可能是瞬时网络问题，也可能需要代理。

## 机器可读

同目录的 `report-20261014-171203.json` 是本次结果的规范值（与工具返回值同一份数据），历史对比直接比它；格式见 `docs/prototypes/report/report.schema.json`。
