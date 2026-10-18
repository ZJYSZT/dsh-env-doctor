# Detecting the DSH sandbox and judging Windows ACL anomalies

Research findings for the `dsh-env-doctor` plugin (Windows / DSH environment doctor).

**Verification environment (this machine, all inspection read-only):**

- dsh CLI `0.2.0-rc.2` — `C:\Users\神\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\package.json:2` [V]
- `@deepseek-ai/dsh-sandbox-windows-acl` `0.2.0-rc.2` [V]
- Windows PowerShell `5.1.26100.9444` — observed via `$PSVersionTable.PSVersion` inside a confined shell [V]. Note: the `pwsh` tool's own description says it runs `pwsh -Command`, but in this session the confined child reported Windows PowerShell 5.1; do not assume PS7-only syntax.
- Session that produced the live probes ran under file policy **`workspace-write`**; approval prompts were disabled, so no mode switch, no elevation and no ACL write was possible. Every probe below is a read (`icacls`, `Get-Acl`, `cmd /c set`, `whoami`).
- Path abbreviations reused from the sibling report `docs/research/2026-10-14-dsh-plugin-contract.md`:
  - `<DSH>` = `C:\Users\神\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`
  - `<PM>` = that dsh's `dsh-plugin-manager`; `<BOOT>` = that dsh's `dsh-app-boot`
  - `<PROF>` = `C:\Users\神\.dsh\profiles\desktop`
  - New here: `<APP>` = `C:\Users\神\AppData\Local\Programs\DeepSeek Harness\resources`

Claims are tagged **[V]** = read directly from source, config, binary or from a live probe on this machine; **[I]** = inference (mechanism reasoned from verified code, not itself executed). No file outside `docs/research/` was written; no permission, owner or ACL was modified; nothing was installed.

---

## 0. The one-paragraph answer

**Q1:** Yes, reliably — but not from the environment. The file sandbox/policy is implemented across five `@deepseek-ai` packages whose authority is the Cordis service **`sandboxPolicy`** (`<DSH>\dsh-sandbox-policy\lib\index.js:111`), read from a plugin as `ctx.sandboxPolicy.resolve({ session })` → `{ mode, workspaceRoot }` (`:141-145`). The mode vocabulary is exactly `read-only` | `workspace-write` | `danger-full-access`, and **no `DSH_*` environment variable carries the mode** — the complete set a confined child sees is six variables, none of them about sandboxing [V, live probe]. The tool-visible denial marker is the literal template `` `[sandbox: file access denied under ${mode} mode]` `` (`<DSH>\dsh-sandbox\lib\index.js:64-66`), and on Windows the enforcement is an **ACL-based `WRITE_RESTRICTED` token lowered to Low integrity**, not a job object and not a kernel path allowlist.

**Q2:** A conservative check must be built on three refusals, taken verbatim from DSH's own diagnosis script: judge the precondition **only on the requested path itself** (never on ancestors above the granted tree — "their ownership and rights would otherwise mark every healthy path as a precondition failure", `diagnose-windows-sandbox-acl.ps1:566-568`); treat **failed observations as incomplete, never as damage** ("missing evidence is not evidence that a right is absent or a repair is safe", `:597`); and never infer causation from a deny ACE ("The reported allow and deny ACEs are evidence, not an attribution to one rule", `:607`). Exactly two classes are genuinely repairable, and both belong to the built-in skill.

**Q3:** The built-in skill is real and — contrary to the premise — **fully readable**: it ships as plain files in the npm package at `<DSH>\dsh-sandbox-windows-acl\assets\diagnose-windows-sandbox-acl\` (`SKILL.md` 6982 B, `scripts\diagnose-windows-sandbox-acl.ps1` 45460 B / 798 lines) and is merely *also* embedded in `<APP>\app.asar`. Our plugin must hand off **all ACL repair and all "this is why it failed" conclusions**, and own the one thing the skill explicitly leaves to the caller: deciding whether a denial is expected confinement or a real anomaly.

---

## Q1 — Can a process tell it is inside a restricted DSH sandbox?

### Q1.1 Which module implements the file sandbox / permission policy

Five packages, layered. The **policy authority** is `dsh-sandbox-policy`; the **contract** (modes, markers, escalation) is `dsh-sandbox`; **two independent enforcing families** consume them.

| Layer | Package | What it owns | Key artifact |
|---|---|---|---|
| Contract | `@deepseek-ai/dsh-sandbox` | mode ids, the two shared model-facing markers, escalation rules, `SandboxUnavailableError` | `<DSH>\dsh-sandbox\lib\index.js` (289 lines) |
| Policy authority | `@deepseek-ai/dsh-sandbox-policy` | the `sandboxPolicy` service: default mode, workspace root, per-session override fold, model-facing policy text | `<DSH>\dsh-sandbox-policy\lib\index.js:111` `super(ctx, "sandboxPolicy")` |
| Backend selection + grant plumbing | `@deepseek-ai/dsh-sandbox-local` | picks macOS/Linux/Windows backend, derives capability SIDs, creates the private temp dir | `<DSH>\dsh-sandbox-local\lib\index.js:416` |
| Windows enforcement | `@deepseek-ai/dsh-sandbox-windows-acl` | the ACL restricted-token runner + native P/Invoke layer + the bundled diagnosis skill | `<DSH>\dsh-sandbox-windows-acl\lib\runner.js`, `lib\types-Cl_DXjhk.js` (64309 B) |
| Enforcement family A (processes) | `@deepseek-ai/dsh-pwsh-sandbox`, `@deepseek-ai/dsh-bash-sandbox` | wrap the shell argv through `ctx.sandbox`, classify denials, register as `ctx.shell` | `<DSH>\dsh-pwsh-sandbox\lib\index.js:118-123` (`static inject = ["subprocess","sandbox","sandboxPolicy"]`) |
| Enforcement family B (fs mutations) | `@deepseek-ai/dsh-fs-sandbox` | the `ctx.fs` backend that fences writes to the workspace root | `<DSH>\dsh-fs-sandbox\lib\index.js:111`, `:157`, `:164` |
| Tool surface | `@deepseek-ai/dsh-tool-pwsh`, `@deepseek-ai/dsh-tool-fs` | render the denial markers, own the escalation approval flow | `<DSH>\dsh-tool-pwsh\lib\index.js:316-319`, `<DSH>\dsh-tool-fs\lib\index.js:1084-1087`, `:1162` |

The two enforcing families are separate code paths that share one marker vocabulary on purpose — `<DSH>\dsh-sandbox\lib\index.js:56-60`: "the one vocabulary both enforcing families teach and report, so the model recognizes a policy denial identically whether the kernel refused a bash file effect or the filesystem provider's fence refused a mutation." [V]

If the question is narrowed to "which module refuses a *file write*", the answer is **`<DSH>\dsh-fs-sandbox\lib\index.js`** (the fence) plus **`<DSH>\dsh-sandbox-windows-acl\lib\runner.js`** (the OS-level confinement that makes the refusal real for subprocesses).

### Q1.2 Every denial / denial-flavoured string, verbatim

**A. Model-facing markers (what the tool returns in-band).**

| # | String (verbatim) | Produced at |
|---|---|---|
| 1 | `` `[sandbox: file access denied under ${mode} mode]` `` | `<DSH>\dsh-sandbox\lib\index.js:64-66` — `sandboxDenialMarker(mode)`; doc comment calls it "the marker line, exactly as the model sees it" |
| 2 | `` `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]` `` | `<DSH>\dsh-sandbox\lib\index.js:76-78` — `escalationHintMarker(subject)`, `subject` ∈ {`command`, `operation`} |
| 3 | `` `The narrowest wider sandbox mode for a one-shot retry of the exact ${subject} the sandbox just denied; the retry asks the user for approval.` `` | `<DSH>\dsh-sandbox\lib\index.js:86-88` — `sandboxPermissionsDescription(subject)` (parameter description) |

Where marker #1/#2 are emitted: pwsh commands at `<DSH>\dsh-tool-pwsh\lib\index.js:25` (notes), `:166-167` (markers), `:207-208` (notices); fs mutations at `<DSH>\dsh-tool-fs\lib\index.js:1162` — ``new FsError(`${sandboxDenialMarker(mode)}\n${escalationHintMarker("operation")}`, "FS_SANDBOX_DENIED", { cause: error })``. [V]

The pwsh tool **description** also teaches the marker to the model verbatim: `...a blocked file operation is reported as [sandbox: file access denied under <mode> mode], a policy denial: do not retry another way.` — `<DSH>\dsh-tool-pwsh\lib\index.js:255` and `:257`. [V]

**B. Provider-level structured errors (bodies, with codes).**

| # | String (verbatim) | Code | Produced at |
|---|---|---|---|
| 4 | `` `cannot write "${target.displayPath}": file access denied under read-only mode` `` | `FS_SANDBOX_DENIED` | `<DSH>\dsh-fs-sandbox\lib\index.js:157` |
| 5 | `` `cannot write "${target.displayPath}": file access denied under workspace-write mode` `` | `FS_SANDBOX_DENIED` | `<DSH>\dsh-fs-sandbox\lib\index.js:164` |
| 6 | `` `sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing kernel (Linux), ensure sandbox-exec is usable (macOS), or ensure the ACL restricted-token runner can start (Windows) — otherwise switch the consumer to danger-full-access.` `` (plus optional `` ` Runner failure: ${detail}` ``) | `SANDBOX_UNAVAILABLE` | `<DSH>\dsh-sandbox\lib\index.js:272` |
| 7 | `` `sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode` `` | — | `<DSH>\dsh-sandbox\lib\index.js:102` |
| 8 | `` `sandbox escalation to "${mode}" requires approval, but no approval service is composed` `` | — | `<DSH>\dsh-sandbox\lib\index.js:103` |
| 9 | `` `sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through` `` | — | `<DSH>\dsh-sandbox\lib\index.js:104` |
| 10 | `invalid escalation: sandbox_permissions requires a justification` | — | `<DSH>\dsh-sandbox\lib\index.js:52` |
| 11 | `invalid escalation: justification is only valid together with sandbox_permissions` | — | `<DSH>\dsh-sandbox\lib\index.js:53` |
| 12 | `invalid justification: expected a non-empty sentence` | — | `<DSH>\dsh-sandbox\lib\index.js:54` |

**C. Model-facing policy text (three variants, injected as system context).**

`<DSH>\dsh-sandbox-policy\lib\index.js:74-76` — `renderPolicyContext(policy)`:

- `read-only` → `Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.`
- `workspace-write` → `` `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}. Some platform temporary areas may also be writable.` ``
- `danger-full-access` → `Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.`

The `workspace-write` sentence above is the exact text this session received, with `workspaceRoot` rendered as `"C:\\Users\\神\\Documents\\deepseek-harness\\default-workspace"`. [V]

**D. Runner-failure dialect (Windows).**

`<DSH>\dsh-sandbox-windows-acl\lib\runner.js:46-52`: every runner-side failure prints `` `windows-acl-run: <detail>` `` to stderr and **exits 127**; `const RUNNER_SIGNATURE = "windows-acl-run"`, `const RUNNER_FAILURE_EXIT = 127`. Relevant arg-validation bodies: `read-only does not accept --write-sid or --temp-write-sid` (`:118`), `workspace-write requires --write-sid and --temp-write-sid together` (`:119`), `--write-sid does not match --workspace` (`:133`), `--temp-write-sid does not match --temp` (`:136`), `SetEnvironmentVariableW TMP failed (Win32 ${...})` (`:154`), `SetEnvironmentVariableW TEMP failed (Win32 ${...})` (`:155`). [V]

**E. Confinement flavours that are NOT marker strings but read as denials.**

In `read-only` mode specifically (`<DSH>\dsh-tool-pwsh\lib\index.js:257`, verbatim from the tool description) [V]:

- PowerShell ConstrainedLanguage: `.NET static calls ([System.IO.*]::, [math]::), Add-Type, COM objects, and reflection fail with "only core types" errors`.
- Named pipes unavailable in **both** confined modes: `programs cannot open named pipes, so a command that captures another program's output through piped stdio (Node.js child_process.spawn/exec with the default stdio: 'pipe') fails with EPERM, while stdio: 'inherit' and stdio: 'ignore' spawns work and PowerShell's own pipelines are unaffected.`
- Force-killed commands settle as `[exit code: 1]` with no signal marker.

Observed live in this session (workspace-write) [V]: `Get-CimInstance Win32_OperatingSystem` returned `拒绝访问` / `HRESULT 0x80041003` (`Access denied`) from `root\cimv2` — the write-restricted token also loses WMI, which a diagnostic plugin must classify as **confinement, not ACL damage**.

**F. Human-facing strings from the bundled script** (the vocabulary our plugin will read back): `REPAIR_REFUSED … needs WRITE_DAC; stop for permission-policy review` (`:650`, `:694`), `GRANT_FAILED …; effective WRITE_DAC and WRITE_OWNER were not both confirmed; restore this invocation and stop` (`:681`), `RESTORE_REFUSED the caller lacks WRITE_DAC` (`:380`), and the verdict/nextAction vocabulary in §Q3.

### Q1.3 Runtime signals a plugin can read — ranked

**Rank 1 — `ctx.sandboxPolicy` (the authoritative, guaranteed signal).**

`<DSH>\dsh-sandbox-policy\lib\index.js:111` registers the service as `sandboxPolicy`. Its shape [V]:

```js
ctx.sandboxPolicy.defaultMode      // :107, :112 — config.mode, deployment default
ctx.sandboxPolicy.workspaceRoot    // :109, :113 — resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())
ctx.sandboxPolicy.resolve(request) // :141-145
//   → { mode: request.mode ?? overrideOf(session) ?? defaultMode,
//       workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot) }
ctx.sandboxPolicy.overrideOf(session)            // :155 — stateOf(session,"sandboxMode")
ctx.sessionProjections.stateOf(session,"sandboxMode")  // :114-119, :155
```

`resolve()` is what the tool layers themselves call for every confined call: `<DSH>\dsh-tool-pwsh\lib\index.js:319` ``sandboxPolicy?.resolve(exec.agent === void 0 ? {} : { session: exec.agent.session })`` and `<DSH>\dsh-tool-fs\lib\index.js:581` `await sandbox.resolvePolicy("write", args, exec)`. **This is the same value the enforcement path uses, so it cannot disagree with reality.** Caveat: it is a *may-be-absent* service — both consumers guard it and throw a composed-missing error (`dsh-tool-fs\lib\index.js:1086-1087`, `dsh-tool-pwsh\lib\index.js:316-317`), so a plugin must handle `undefined`.

Note also the write path is singular and inspectable: `:41` `session.append("sandbox/mode", { mode })` — the session event is the only mode mutation, and `:33` states "the switch IS its event; nothing mutates mode state".

**Rank 2 — capability flags `ctx.fs.sandboxMode` / `ctx.shell.sandboxMode`.**

- `<DSH>\dsh-fs-sandbox\lib\index.js:111` — `get sandboxMode()`, described at `:99` as "the capability fact".
- `<DSH>\dsh-pwsh-sandbox\lib\index.js:137-139` — `get sandboxMode() { return this.mode }`, initialised at `:134` from `ctx.sandboxPolicy.defaultMode`.
- `<DSH>\dsh-tool-fs\lib\index.js:1066` comment: "`ctx.fs.sandboxMode` (the capability fact — is a confining backend mounted?)".

These answer "is a confining backend mounted at all", not "which mode is live for this session". Cheap and safe as a first probe; **`undefined` means no confining backend**, which is itself a doctor-worthy finding.

**Rank 3 — session projection (durable, per-session history).** `sandboxMode` is a registered projection folded on the `sandbox/mode` event (`:114-119`, `apply: (state, event) => event.type === "sandbox/mode" ? event.data.mode : state`). Reading it gives the session's mode even after a mid-session switch. [V]

**Rank 4 — the injected policy prose.** `renderPolicyContext` output (§Q1.2 C) is content-reliable but prose; it is injected via the same service (`:127`). **Do not parse it** — call `resolve()`.

**Rank 5 — composition / app settings: not reliable.** Greps for `mode|sandbox|workspace` in `<PROF>\cordis.yml` and `<PROF>\cordis.patch.yml` returned **no matches** [V]; the deployment default is supplied by the desktop app, not by a profile config file. A plugin cannot read the mode from disk config on this install.

**Rank 6 — environment variables: there is no mode variable.** Complete `DSH_*` set inside a confined child [V, live `cmd /c set DSH`]:

```
DSH_HOME=C:\Users\神\.dsh
DSH_PROFILE=desktop
DSH_PROFILE_DIR=C:\Users\神\.dsh\profiles\desktop
DSH_SESSION_ID=5593baed-d2d4-473c-aec0-3ec093304135
DSH_SHELL=1
DSH_WEB_URL=http://127.0.0.1:19387
```

Nothing matching `SANDBOX|SBOX|READONLY|READ_ONLY|MODE` exists in the child environment [V]. The pwsh tool description's phrase "Managed `$env:DSH_*` variables expose current harness environment facts" (`dsh-tool-pwsh\lib\index.js:255`) therefore does **not** extend to the sandbox mode. Treat any `DSH_*`-based mode detection as impossible.

**Rank 7 — incidental runtime fingerprints (usable as corroboration only).**

| Fingerprint | Observed value | Why it works |
|---|---|---|
| `TEMP`/`TMP` rewritten to a private `dsh-*` directory | `TEMP=C:\Users\神\AppData\Local\Temp\dsh-rjfrcB` [V] | `<DSH>\dsh-sandbox-local\lib\index.js:416` `const tempDir = mkdtempSync(join(tmpdir(), "dsh-"))`; `<DSH>\dsh-sandbox-windows-acl\lib\runner.js:154-155` `setEnvironmentVariableW("TMP"/"TEMP", privateTempDir)`. Present ⇒ **this process is a Windows workspace-write confined child** |
| Token integrity = Low | `whoami /groups` → `Mandatory Label\Low Mandatory Level  S-1-16-4096` [V] | README `:102`: "Both modes spawn a Low-integrity token". Proves *a* confined token (both modes), not which mode |
| Workspace root DACL shape | explicit `S-1-4-<n>:(OI)(CI)(W,D,DC)` + `Everyone:(CI)(DENY)(DC)` + `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)` [V] | the three edits the grant applies in one `SetNamedSecurityInfoW` call (README `:98`) |

**Guaranteed vs incidental.** *Guaranteed by the plugin contract* (safe to depend on): the `sandboxPolicy` service name and its `resolve()` shape; the three mode ids; `sandboxDenialMarker`/`escalationHintMarker` templates; the `FS_SANDBOX_DENIED` / `SANDBOX_UNAVAILABLE` codes; `rawg`-style capability flags `fs.sandboxMode` / `shell.sandboxMode`. *Incidental* (may change between patch releases): the `Temp\dsh-*` naming, the `S-1-4-*` / `S-1-5-21-*` SID values, the Low-integrity label, `runner.js` arg validation and the exit-127 dialect. **Recommendation for `dsh-env-doctor`: decide from Ranks 1–3, corroborate with Rank 7, never decide from Ranks 5–7 alone.**

### Q1.4 Windows specifics

**Mechanism: ACL-based `WRITE_RESTRICTED` restricted token + Low integrity label. Not a job object, not a path allowlist in the kernel sense.** [V] — `<DSH>\dsh-sandbox-windows-acl\README.md:98`: "The caller's token is duplicated into a `WRITE_RESTRICTED` token whose restricting SIDs carry separate workspace and private-temp capabilities, and that token is lowered to Low integrity. Windows performs the access check twice … and grants write-class access only where both checks pass; separately, the kernel's mandatory-integrity check denies write-class access to every object that is not labeled Low."

Each grant is **one `SetNamedSecurityInfoW` call applying three edits** (README `:66`, `:98`), which is exactly what the live DACL shows:

1. **Capability-SID allow ACE** — deterministic per workspace: `workspaceWriteSid(workspaceRoot)` (`dsh-sandbox-local\lib\index.js:396-402`, `runner.js:131`). Live: `S-1-4-803020457-741359850:(OI)(CI)(W,D,DC)`, SDDL mask `0x110156`, i.e. write + delete + delete-child.
2. **Deny of the ambient parent-directory delete right** — `FILE_DELETE_CHILD` denied to the world SID. Live: `Everyone:(CI)(DENY)(DC)`; SDDL `(D;CI;DT;;;WD)` (`DT` = `DELETE_CHILD`). Rationale (README `:98`): the write-SID intersection cannot co-sign a delete authorized by the parent's `FILE_DELETE_CHILD`, "so a token holding only the intersection could still delete anything its ambient user SIDs control — including files inside ANOTHER granted root." README `:123`: "Inside a granted root, the capability ACE's DELETE bit is the only delete authority."
3. **Low integrity label** — live `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`, so the lowered token matches and writes are permitted (`NW` = no-write-up).

**"Platform temporary areas"** — the phrase in the policy text is literal and narrow:

- The provider creates **one private temp directory per live session/workspace pair**: `mkdtempSync(join(tmpdir(), "dsh-"))` (`dsh-sandbox-local\lib\index.js:416`) with its own revocable SID `tempWriteSid(tempDir)` (`:417`), and rewrites `TMP`/`TEMP` in the child's own environment before spawn (`runner.js:154-155`). Live: `S-1-4-1020697751-157480374-1:(OI)(CI)(W,D,DC)` on `…\Temp\dsh-rjfrcB`.
- The ambient temp root is **never** an implicit grant: `assertTempRootOutsideWorkspace(workspaceRoot, tmpdir())` (`dsh-sandbox-local\lib\index.js:397`, `runner.js:120`; README `:36` "the ambient temp root is never an implicit grant").
- **`read-only` grants no temp area at all**: `runner.js:118` `read-only does not accept --write-sid or --temp-write-sid`, and `dsh-sandbox-local\lib\index.js:359` short-circuits before materialising a grant when `policy.mode === "read-only"`. README `:12`: "`workspace-write` grants both, `read-only` grants neither"; README `:70`: "Under `read-only`, no explicit write grants exist".
- Lifetime: the workspace edits are **standing** (`dispose()` leaves them — README `:66`, `:128`: "workspace ACEs, denies, and labels stand by design (the reuse cache, never revoked)"), while the temp SID and directory are **revocable per session**, and a fork or fresh provider gets a different temp capability (README `:116`, `:132`).

**Two documented consequences a doctor should know** (README `:129`, `:128`):

- A standing Low label **outlives DSH** and widens the tree for *any* other Low-integrity process running as the same user (another product's Low-IL sandbox, a Protected Mode reader) — "the label is the price of the write boundary". So a Low label on the workspace is expected, not damage, and its absence after a session is not a bug either.
- Manual `icacls` cleanup **cannot** revoke these edits on this platform (`ERROR_NONE_MAPPED`, 1332) — revoke through the module. A plugin must never try.

**Scope limit:** confinement is write-side only. README `:32`: "`WRITE_RESTRICTED` intersects write accesses only, so pair this backend with a read-side policy or an AppContainer capability token for stronger confinement." README `:12` also names two boundaries that stay open: hard links alias file objects, and files ACL'd by another AppContainer tool stay unreadable.

---

## Q2 — Judging an ACL anomaly on Windows, without admin rights, conservatively

### Q2.1 Enumerating and interpreting a path's effective permissions

Two reads answer different questions. Use both, for different jobs.

**`icacls <path>` — display view** (human output; rights symbols are stable, prose is localized):

- Owner line prefix, then one ACE per line with flags `(I)` inherited · `(OI)` object inherit · `(CI)` container inherit · `(IO)` inherit-only · `(DENY)` · rights symbols `F`, `M`, `RX`, `W`, `D`, `DC`, `NW`, `S`, `X`.
- Live example (workspace root) [V]:
  ```
  Everyone:(CI)(DENY)(DC)
  S-1-4-803020457-741359850:(OI)(CI)(W,D,DC)
  LAPTOP-9QTTFM1V\CodexSandboxUsers:(I)(OI)(CI)(RX)
  NT AUTHORITY\SYSTEM:(I)(OI)(CI)(F)
  BUILTIN\Administrators:(I)(OI)(CI)(F)
  LAPTOP-9QTTFM1V\神:(I)(OI)(CI)(F)
  Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
  ```
- Failure shape: `Access is denied.` on stderr plus the localized summary `Successfully processed 0 files; Failed processing 1 files`. **Parse the symbols, never the summary line.**

**`Get-Acl` / `$acl.GetAccessRules($true,$true,[SecurityIdentifier])` — machine view** (prefer this for logic):

- `Owner`, `Group`, `Sddl`, and per-rule `AccessControlType` (`Allow`/`Deny`), `FileSystemRights`, `IdentityReference`, `IsInherited`, `InheritanceFlags`, `PropagationFlags`.
- Live SDDL of the workspace root [V]:
  `O:S-1-5-21-…-1001 G:S-1-5-21-…-513 D:AI(D;CI;DT;;;WD)(A;OICI;0x110156;;;S-1-4-803020457-741359850)(A;OICIID;0x1200a9;;;S-1-5-21-…-1002)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;S-1-5-21-…-1001)`
- **Fields that matter**, in priority order: (1) did the read succeed at all; (2) `Owner` and whether it is the current user vs SYSTEM / Administrators / TrustedInstaller / an unresolved SID; (3) explicit vs inherited (`IsInherited`) — only explicit ACEs are candidates for "someone put this here"; (4) deny ACEs with their SID, rights and inheritance; (5) whether the current user's SID appears with the right actually needed; (6) `LowLabel`, recorded but never itself a fault.
- `Group` is **not** a health signal: live `C:\Users\神\Documents` reports `Group=LAPTOP-9QTTFM1V\None` (S-1-5-21-…-513) [V], which is the normal Windows-client default.
- **Locale trap** [V]: `Get-Acl 'C:\System Volume Information'` throws `UnauthorizedAccessException` whose message is localized (`尝试执行未经授权的操作。` = "Attempted to perform an unauthorized operation"). Match on **exception type** (`[System.UnauthorizedAccessException]`), never on message text. The bundled script does exactly this (`:295`, `:310-311`, `:317-318`).
- **The right you actually need cannot be computed by scanning ACEs.** Changing a DACL needs `WRITE_DAC` (`0x40000`), changing an owner needs `WRITE_OWNER` (`0x80000`); effective possession depends on group membership, deny precedence and integrity level. The bundled script therefore asks the OS: `[Dsh.TokenInfo]::HasAccess($FullPath, 0x40000)` (`:380`) and reports `WRITE_DAC={3} WRITE_OWNER={4}` (`:559`). A plugin that scans ACEs will misjudge; use an access check (`[System.Security.AccessControl]` has no direct helper — the pattern is a native `AccessCheck` / `GetEffectiveRightsFromAcl`, or `icacls` on a temporary probe only if a write is permitted).

### Q2.2 NORMAL patterns (must NOT be flagged) vs genuinely SUSPICIOUS

**NORMAL — every one of these was either observed live or named as expected by DSH's own script:**

| # | Pattern | Status |
|---|---|---|
| N1 | No write ACE for the current user on a system path. Live `C:\Program Files`: owner `NT SERVICE\TrustedInstaller`, `BUILTIN\Users:(RX)`, no deny for the user, no Low label [V] | **Normal.** Absence of a write right is not damage — the script's `NOT_THIS_CLASS` verdict reason (`:609-610`) |
| N2 | `Everyone:(CI)(DENY)(DC)` on the workspace root and the private temp dir — SDDL `(D;CI;DT;;;WD)` [V] | **Normal, DSH's own.** SKILL.md: "DSH's `S-1-4-*` grants and the Everyone `DeleteSubdirectoriesAndFiles` deny are expected, not conflicts" |
| N3 | An explicit `S-1-4-*:(OI)(CI)(W,D,DC)` capability ACE on the workspace root [V] | **Normal, DSH's own** standing grant |
| N4 | `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)` on the workspace root / private temp dir [V] | **Normal**, and knowingly persists after the session (README `:129`) |
| N5 | `Group = <machine>\None` (S-1-5-21-…-513) on user-owned paths [V] on `C:\Users\神\Documents` | **Normal.** Never a health signal |
| N6 | Inherited `(I)` ACEs from `C:\Users\<user>` — SYSTEM / Administrators / the user with `(F)` [V] | **Normal profile inheritance** |
| N7 | A foreign sandbox group's explicit read ACE. Live `C:\Users\神\Documents` carries a non-inherited `S-1-5-21-…-1002` = `LAPTOP-9QTTFM1V\CodexSandboxUsers` `(RX)` [V] | **Normal but foreign.** The string `CodexSandboxUsers` appears nowhere in `dsh-sandbox-windows-acl`'s JS (grep: no matches) [V], so this is another product's sandbox ACE. Report informationally; never call it damage, never remove it |
| N8 | Profile junctions (`Application Data`, `Cookies`, `Local Settings`, `My Documents`, `NetHood`, `PrintHood`, `Recent`, `SendTo`, `Templates`, …) [V] | **Normal reparse points.** The script refuses to traverse them; we must too |
| N9 | Paths unreadable by design — live `Get-Acl 'C:\System Volume Information'` → `UnauthorizedAccessException` [V] | **Normal.** The script treats these as `UNREADABLE`/`INCOMPLETE`, and refuses `%LOCALAPPDATA%\Packages`, `%ProgramFiles%\WindowsApps`, `%ProgramW6432%\WindowsApps`, drive roots, `%USERPROFILE%`, `%WINDIR%` outright (`Test-DangerousRoot`, `:236-252`) |
| N10 | A confined child failing a privileged API — live `Get-CimInstance Win32_OperatingSystem` → `拒绝访问` / `HRESULT 0x80041003` [V] | **Normal confinement.** Never evidence of ACL damage |
| N11 | A `read-only`-mode refusal, or any write outside `resolve().workspaceRoot` | **Normal confinement** — see §Q2.4 |

**SUSPICIOUS — only these, in this order, and only on the requested path itself:**

| # | Pattern | Evidence it is real |
|---|---|---|
| S1 | The current user lacks **effective** `WRITE_DAC` or `WRITE_OWNER` on a directory **inside** the user's granted tree (the requested path itself, or a chain member inside `-AllowRoot`) | The script's `PRECONDITION` verdict (`:605-607`); it is the one condition that stops DSH provisioning its grant |
| S2 | An explicit **AppContainer package allow ACE** `S-1-15-2-*` on a directory in the chain — excluding the well-known groups `S-1-15-2-1` and `S-1-15-2-2` | The script's `CULPRIT` verdict; regex verbatim `$PACKAGE_SID = '^S-1-15-2-(?![12]$)'` (`:72`), removed at its source, ancestor first. Other `S-1-15-*` SIDs (live: `S-1-15-3-65536-…` on `C:\Users\神` [V]) are **reported only, never removed** (`:561`, `OTHER_S1_15 SID={0} (reported only)`) |
| S3 | An explicit (non-inherited) **deny** ACE whose identity is the current user's SID, or a group the user belongs to, denying a right the user needs (Write/WriteData/Delete/WriteDAC) on a path in the user's own tree | the classic stray deny — but SKILL.md: "A deny ACE's presence alone does not establish causation, and the script never removes one". Flag as *needs the diagnosis run*, never auto-remove |
| S4 | Broken owner: `Owner` is an unresolved SID, or an AppContainer/package SID on a user-tree directory, or the requested path itself yields `UnauthorizedAccessException` | Owner is readable without admin on objects the user can open; a package SID owning a user directory is not a normal state |
| S5 | An unreadable ACL **on the requested path's own chain inside `-AllowRoot`** | The script counts these (`failed`) and reports `INCOMPLETE`; our plugin must surface the count and refuse a verdict |

### Q2.3 A conservative algorithm

Three invariants, then the decision. The invariants are DSH's own, quoted from `diagnose-windows-sandbox-acl.ps1`:

- **INV-1 — judge only the requested path.** `:566-568`: "The precondition is judged on the requested path itself. Ancestors above the tree DSH grants are not part of that grant, so their ownership and rights would otherwise mark every healthy path as a precondition failure."
- **INV-2 — missing evidence is not evidence.** `:597`: "Some observations failed; missing evidence is not evidence that a right is absent or a repair is safe."
- **INV-3 — a deny ACE is evidence, not attribution.** `:607`: "The reported allow and deny ACEs are evidence, not an attribution to one rule."

```
judge(path, allowRoot):                      # all reads; this plugin never writes ACLs
  # ---- 0. refuse to judge (mirrors Test-DangerousRoot :236-252 / Get-RepairRefusal :262-275)
  if not exists(path):                     return UNDIAGNOSED("path disappeared")
  if path in {drive root, %USERPROFILE%, %WINDIR%,
              %LOCALAPPDATA%\Packages, %ProgramFiles%\WindowsApps, %ProgramW6432%\WindowsApps}:
                                           return OUT_OF_SCOPE("dangerous root")
  for c in path.ancestors:                 # includes a junction used as allowRoot/c
      if c is reparse point:               return OUT_OF_SCOPE("traverses a reparse point: c")
  if not under(path, allowRoot):           return OUT_OF_SCOPE("outside -AllowRoot")

  # ---- 1. observe the requested path itself (INV-1)
  f = observe(path)                        # Get-Acl, catch by EXCEPTION TYPE
  if f.error is UnauthorizedAccessException: return UNREADABLE   # not damage (N9)
  if f.errors:                              return INCOMPLETE     # INV-2
  if f.is_file:                             f = observe(path.parent)   # DSH grants directories

  # ---- 2. observe chain members inside allowRoot, for EVIDENCE only
  chain = [c for c in path.ancestors if under(c, allowRoot)]        # INV-1

  # ---- 3. classify (first match wins)
  if any(explicit_allow_ace(ace) and sid_matches(ace, '^S-1-15-2-(?![12]$)') for c in chain):
        return SUSPECT_PACKAGE_ACE            # S2 — the repairable class
  if not f.effective_WRITE_DAC or not f.effective_WRITE_OWNER:
        return SUSPECT_PRECONDITION(path)     # S1 — the repairable class
  if any(explicit_deny(ace) and sid_is_me_or_my_group(ace)
         and denies_needed_right(ace) for c in chain):
        return NOTIFY_ONLY("explicit deny — evidence, not attribution")   # S3, INV-3
  if f.owner is unresolved or is_package_sid(f.owner):
        return NOTIFY_ONLY("owner looks wrong")                          # S4
  if f.unreadable_observations > 0:
        return INCOMPLETE("N unreadable observations")                   # S5, INV-2
  return OK
```

Hard prohibitions inside the checker, each a direct consequence of a NORMAL pattern: never flag because *a deny exists* (N2); never flag because *the current user has no write ACE* when `Owner ∈ {SYSTEM, Administrators, TrustedInstaller}` (N1); never read `Group` as a signal (N5); never walk into reparse points (N8); never judge ancestors above `allowRoot` (INV-1); never convert an unreadable observation into a fault (N9); never treat a `CodexSandboxUsers`-style foreign sandbox ACE as damage (N7); never treat CIM/WMI/`spawn EPERM`/ConstrainedLanguage failures as ACL symptoms (N10, §Q1.2 E).

### Q2.4 Expected confinement vs real ACL damage — the decision rule

Three questions, in this order.

**Step 1 — Is the failing operation outside what the mode promises?** Read `ctx.sandboxPolicy.resolve({ session })`:

- `read-only` → promises *nothing* writable. Any write denial.
- `workspace-write` → promises writes under `workspaceRoot` **plus** the private temp area. A write denial for any other path.
- `danger-full-access` → promises no restriction; a denial here is never confinement.

If the operation is outside the promise ⇒ **expected confinement**. Correct response is escalation guidance (`sandbox_permissions` + justification, once), never ACL repair. SKILL.md enumerates the expected set verbatim: "writes outside the workspace, any write in `read-only`, piped grandchild `spawn EPERM`, ConstrainedLanguage errors."

**Step 2 — If the operation IS inside the promise, examine the path itself.** Missing effective `WRITE_DAC`/`WRITE_OWNER`, or an explicit `S-1-15-2-*` package allow ACE on the chain ⇒ **real, repairable damage**. Everything else ⇒ not this class: the script's `NOT_THIS_CLASS` reason is explicit that "Other ACL restrictions and causes of the original failure are not ruled out" (`:610`).

**Step 3 — If any observation failed, or the ACL cannot be read** ⇒ **undiagnosed**. Not damage, not OK. Report and stop; do not launch a repair.

**The decisive detail for `dsh-env-doctor`: the denial string does not encode which case you are in.** `[sandbox: file access denied under workspace-write mode]` is produced identically for a by-design refusal and for a real ACL fault — the marker carries only the mode, and the enforcing families deliberately share one vocabulary (§Q1.1). The only thing that separates them is **comparing the attempted path against `resolve().workspaceRoot` and the mode**. That comparison is precisely the part the built-in skill does not do, and it is the plugin's reason to exist.

Corollary: a plugin must not "explain" an ACL failure from the ACL alone. The script's own INCOMPLETE guard exists because an ACL that *looks* wrong may be irrelevant, and an ACL that looks right may not be the cause.

### Q2.5 What repair is safe for a non-admin user, and what must never be attempted

**Safe (reversible, own tree only, no elevation) — and already implemented by the built-in script, so this is what we hand off rather than build:**

1. Add a **FullControl allow ACE for the signed-in user** on a directory in the chain that lacks effective `WRITE_DAC` or `WRITE_OWNER` — bounded so that "an object is modified only when it is that directory or strictly inside it" (`-AllowRoot`). Attribution: SKILL.md "directories on that chain that lack effective `WRITE_DAC` or `WRITE_OWNER` receive a full-control allow ACE for the signed-in user, because DSH cannot provision its workspace grant without them".
2. Remove an **explicit AppContainer package allow ACE** (`S-1-15-2-*` except `…-1`/`…-2`) at its source, ancestor first.
3. Backup **before** every change: `acl-backup-<id>.json` plus a standalone recovery `.ps1` per change under `-Out`; then **verify by re-reading**; a failed repair restores all attempted DACL changes in reverse order and stops. `-Restore <record>` restores exactly one DACL, requires `WRITE_DAC`, and preserves owner and SACL (`:50`, `:370-380`). SKILL.md: "Trust `verification` records, never `completed` actions."
4. Run it **unconfined but not elevated**: SKILL.md — "The script writes permissions, which the confined token cannot do — run it there and it would report the sandbox's own restriction as a missing right — so request approval for that one command and run it unconfined. A confined run of the script is never useful. Unconfined does not elevate the Windows token." README `:175` adds that the extracted/recovery scripts "are user-writable and are not supported elevated entrypoints".

**Never, without admin (the skill's own "Never" list, verbatim):**

- "edit ACLs by hand, change an owner, erase a deny, or replace child permissions recursively";
- "run the script elevated, through UAC or `runas`";
- "widen `-AllowRoot` to reach an ancestor, or repeat a denied or failed call".

**Additional prohibitions our plugin must adopt on top of those:**

- Never write a DACL from inside a confined tool call — the write would fail, or worse, misreport confinement as a missing right.
- Never touch `%WINDIR%`, a drive root, `%USERPROFILE%` root, `WindowsApps`, `%LOCALAPPDATA%\Packages`, or anything reachable through a reparse point.
- Never attempt to revoke DSH's standing edits by hand: README `:128` — manual `icacls` cleanup cannot revoke them on this platform (fails `ERROR_NONE_MAPPED`, 1332); revoke through the module.
- Never present a repair as safe without a backup artifact and a printed rollback command.

---

## Q3 — Boundary with the built-in `diagnose-windows-sandbox-acl` skill

### What actually exists (the premise needs one correction)

The skill is **not** confined to an unreadable archive. It is a plain, readable npm package asset [V]:

| Artifact | Path | Size |
|---|---|---|
| Skill instructions | `<DSH>\dsh-sandbox-windows-acl\assets\diagnose-windows-sandbox-acl\SKILL.md` | 6982 B |
| Bundled command | `<DSH>\dsh-sandbox-windows-acl\assets\diagnose-windows-sandbox-acl\scripts\diagnose-windows-sandbox-acl.ps1` | 45460 B, 798 lines |

The desktop app *also* embeds the same two files, at the same relative path, inside `<APP>\app.asar` (header offset of `SKILL.md` = 51137093, of the script = 51144075; asar data section begins at `8 + 3392056`). So the sibling report's "unreadable `app.asar`" note is true only of the app copy; the npm copy is fully readable, and this report's Q2 rules were derived from it. [V]

Registered name and description match the shipped front matter exactly, including the session catalog entry. [V] SKILL.md warns the resource directory "is deleted when the skill unloads", so the runtime copy is materialised elsewhere — **do not hardcode the package path at runtime**; resolve the skill directory through the skill subsystem.

### What it does, as installed

One mode-less command, `-Path` / `-AllowRoot` / `-Out` (plus `-Restore`), which in a single run:

- inspects the requested path **and every ancestor**, judging the precondition on the requested path only (`:566-568`);
- collects explicit `S-1-15-2-*` package allow ACEs, and — when the caller cannot provision the directory or owns the authorized root — runs a **bounded subtree BFS** (`$SCAN_LIMIT = 2000`, `:75`, `:281-320`) that skips reparse points and managed-application trees and reports `truncated` / `UNREADABLE=n` rather than claiming a complete walk;
- refuses dangerous roots, reparse-point traversals, and anything outside `-AllowRoot` (`:236-275`);
- grants the missing FullControl ACE and removes package ACEs, each backed up, verified by re-read, and rolled back on failure;
- emits verdicts `INCOMPLETE` · `CULPRIT` · `BOTH` · `UNREADABLE` · `PRECONDITION` · `NOT_THIS_CLASS` (`:595-611`) and a final `nextAction` ∈ `verify_original_confined_operation` · `stop` · `restore_pending_then_stop` (`:770`);
- records everything to stdout, to `acl-report-*.jsonl` under `-Out`, and to a `RECAP` line — explicitly because "Tool output keeps only its tail, so read the recap first".

### Hand off to it (do not reimplement)

1. **All ACL repair**, without exception. It owns backup, verification, rollback, dangerous-root and reparse refusal, and revocation-safe DACL writes.
2. **Any conclusion of the form "this ACL is why the operation failed."** It is the only component that checks effective `WRITE_DAC`/`WRITE_OWNER` through the OS, removes `S-1-15-2-*` sources, and refuses to attribute a denial to a specific ACE.
3. **The verdict / `nextAction` vocabulary and the report file format** — read them back; do not invent a parallel taxonomy.
4. **The user-facing approval wording.** SKILL.md is emphatic and worth following verbatim in the plugin's own prompts: write permissions in plain words in the user's language; keep error codes, `WRITE_DAC`/`WRITE_OWNER`, `S-1-15-2-*`, `icacls`, ACL/ACE and switch names out of the request; "Ask once, for one command."

### Keep for `dsh-env-doctor` (the skill's own documented gaps)

1. **Expected-vs-real classification.** The skill restricts itself to denials that "contradict what the active mode promises" and tells the caller to explain expected ones instead. Deciding that requires `ctx.sandboxPolicy.resolve({ session })` — a Cordis service the script cannot see. This is our core function.
2. **Mode / signal reporting** (all of Q1): active mode, resolved workspace root, temp area, enforcement family, plus the incidental fingerprints (Low-IL token, rewritten `TEMP`, the `S-1-4-*` + Everyone-DC + Low-label DACL shape).
3. **Surfacing "we cannot tell"** — the `INCOMPLETE`/`UNREADABLE` conditions — *before* sending the user into an approved repair run that will refuse.
4. **Invoking the command correctly**: one call, `-Path '<failing path>' -AllowRoot '<authorized dir>' -Out '<persistent user-owned dir>'` (never the skill resource directory), unconfined with a single approval, then read the `RECAP` first and report `restore_pending_then_stop` honestly as "rollback unverified — run the printed recovery commands in order, then stop."
5. **Not re-doing**: no second `icacls` parser that emits an "ACL damaged" verdict; no ACE removal; no private backup/rollback implementation; no elevated re-entry point.

---

## Confidence summary

| Claim | Tag | Confidence |
|---|---|---|
| Mode authority is `ctx.sandboxPolicy`, shape `{mode, workspaceRoot}` via `resolve()` | [V] source `dsh-sandbox-policy\lib\index.js:107-155` | Very high |
| No `DSH_*` env var carries the sandbox mode (six vars total) | [V] live `cmd /c set DSH` | Very high |
| Denial marker template `` `[sandbox: file access denied under ${mode} mode]` `` | [V] `dsh-sandbox\lib\index.js:64-66` | Very high |
| `FS_SANDBOX_DENIED` / `SANDBOX_UNAVAILABLE` bodies and codes | [V] `dsh-fs-sandbox:157,164`; `dsh-sandbox:272` | Very high |
| Windows mechanism = `WRITE_RESTRICTED` token + Low integrity + capability SIDs (not job objects) | [V] README `:98`,`:102` + live DACL and token | Very high |
| Grant = capability allow ACE + Everyone `DELETE_CHILD` deny + Low label, one `SetNamedSecurityInfoW` | [V] README `:66`,`:98` + live `icacls`/SDDL | Very high |
| Private temp area `%TEMP%\dsh-*` with its own revocable SID; `TMP`/`TEMP` rewritten | [V] `dsh-sandbox-local:416-417`; `runner.js:154-155` + live probe | Very high |
| `read-only` grants no temp area | [V] `runner.js:118`; `dsh-sandbox-local:359`; README `:12`,`:70` | High |
| Both modes spawn a Low-integrity token | [V] README `:102` (not independently probed in read-only) | High |
| Confined child loses WMI/CIM (`HRESULT 0x80041003`) | [V] live probe | High (observed once) |
| `Get-Acl` throws localized `UnauthorizedAccessException` on unreadable ACLs | [V] live probe | Very high |
| `Group=…\None` on user paths is normal | [V] live probe on two paths | High |
| The two repairable classes are exactly `S-1-15-2-*` package ACEs and missing effective `WRITE_DAC`/`WRITE_OWNER` | [V] script `:72`, `:571-572`, `:598-607` | Very high |
| Built-in skill ships readable in the npm package, also embedded in `app.asar` | [V] directory listing + asar header index | Very high |
| `CodexSandboxUsers` ACE is foreign, not DSH's | [I] from grep absence + naming | Medium-high |

---

## 未验证 / Not verified

Everything below is **not** established by direct observation on this machine. Treat it as inference to confirm before the plugin depends on it.

1. **Read-only mode was never observed.** This session ran `workspace-write` and approvals were disabled, so no mode switch was possible. Consequently: whether a read-only child's `TEMP` stays ambient (source says no temp grant is made — `runner.js:118`, `dsh-sandbox-local:359` — so presumably unrewritten) and whether its token is Low (README `:102` says both modes are) are **source-derived, not measured** [I].
2. **No plugin was built, loaded or run.** Every claim about what a plugin's `ctx` exposes comes from reading the consumers' source, not from executing plugin code. In particular I did not verify that a plugin can reach `sessionProjections` (`dsh-sandbox-policy` injects it at `:105`, but its availability to third-party plugins is untested) [I].
3. **`ctx.sandboxPolicy.resolve()` behaviour when `session` is omitted or the service is absent** — read from source (`:141-145`, guards at `dsh-tool-fs:1086-1087`) but not executed [I].
4. **Environment of the plugin host process itself.** The six `DSH_*` variables were read from a *confined pwsh child*, which is not necessarily the plugin host's environment; a plugin may see a different set [I].
5. **The native layer was not read.** `dsh-sandbox-windows-acl\lib\types-Cl_DXjhk.js` (64309 B) contains the P/Invoke/token/grant implementation. The ACL + restricted-token + Low-integrity description rests on `README.md`, `runner.js` and the live DACL/token probes, not on that file [I].
6. **macOS/Linux backends were not read**, so the cross-platform signal set is unknown; this report is Windows-only by construction.
7. **`CodexSandboxUsers` attribution.** I concluded it is another product's group because the string does not appear in `dsh-sandbox-windows-acl`'s JS and the name references a different tool. I did not inspect that product, nor confirm who created the ACE on `C:\Users\神\Documents` [I].
8. **The `S-1-15-2-1` / `S-1-15-2-2` exclusions** are taken from the script's regex `^S-1-15-2-(?![12]$)` and its comment "except the well-known groups ending in 1 or 2"; I did not map those SIDs to their Windows display names.
9. **Effectiveness of a real repair run** — the script was read, never executed (running it would write ACLs, which this task forbade). Its backup/verify/rollback guarantees are its documented contract [I].
10. **`<APP>\resources\elevate.exe`** — present in the app resources; whether it has any sandbox or ACL role was not determined.
11. **`dsh-fs-observation-policy`, `dsh-permission-presets` and any approval-policy services** were not investigated; they may add further detectable signals or further denial strings.
12. **Skill registration mechanics** — that `diagnose-windows-sandbox-acl` is registered under this exact name in every profile rests on this session's catalog entry plus the shipped `SKILL.md` front matter; the registration path (skill provider vs scanned root) was not traced.
13. **The `pwsh`-vs-`powershell.exe` discrepancy.** The tool description says `pwsh -Command`; the confined child reported Windows PowerShell `5.1.26100.9444`. Whether the harness maps `pwsh` to `powershell.exe` on this machine, or whether the 5.1 report comes from the shim, is unresolved — relevant if the plugin emits PowerShell 7-only syntax.
14. **No repair was attempted and no permission, owner or ACL was modified.** No file outside `docs/research/` was written; no package was installed.
