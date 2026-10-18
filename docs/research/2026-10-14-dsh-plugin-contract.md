# DSH Plugin Authoring Contract — Research Findings

**Verification environment (this machine, all read-only inspection):**

- dsh CLI `0.2.0-rc.2` — `C:\Users\神\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\package.json:2` (`name`/`version`), `bin = lib/bin.js`
- Plugin manager `@deepseek-ai/dsh-plugin-manager@0.2.0-rc.2` — nested at `C:\Users\神\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-plugin-manager\` (NOT at the npm root; the top-level `@deepseek-ai` dir has no plugin-manager)
- node `v24.21.0`, pnpm `12.8.1`, npm `11.19.0` (measured via `cmd /c`)
- Profile used as the worked example: `C:\Users\神\.dsh\profiles\desktop\` (pnpm workspace, `nodeLinker: hoisted`)
- Path abbreviations below: `<DSH>` = `C:\Users\神\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`, `<PM>` = that dsh's `dsh-plugin-manager`, `<BOOT>` = that dsh's `dsh-app-boot`, `<PROF>` = `C:\Users\神\.dsh\profiles\desktop`

Claims are tagged **[V]** = read directly from source/config/binary on this machine, or **[I]** = inference (mechanism reasoned from verified code, not itself executed). Nothing here was executed against a real install; no file outside `.tmp/` was modified.

---

## 0. The one-paragraph answer

A DSH plugin is an ordinary npm package that (a) declares `dsh.bundle.patch` in `package.json` to become a **profile layer**, and (b) ships a `cordis.patch.yml` containing one top-level `- insert:` list whose rows point at module specifiers inside the package. That patch file — not any code hook — defines what actually loads. Rows export a Cordis plugin (`apply`, optional `name`/`inject`/`Config`). Tools come from a row that injects `tools` and calls `ctx.tools.register(...)`; skills come from either a row calling `ctx.skills.register/registerProvider` or files on a scanned skill root; web UI comes from `dsh.client` + a built `lib/client.js`. `dsh plugin add` runs pnpm in the profile dir, then — **after** the install, not before it — validates `peerDependencies` on `@deepseek-ai/dsh*` and appends the package name to `dsh.profile.bundles`; all automatic.

> ⚠️ **2026-10-14 实测修订（票 #9）**：本文有 4 处推断被真机实测推翻或改写 —— ①手写注册对象的 `parameters` 必须是完整 JSON Schema（简写 DSL 会被模型侧拒收）；②`ctx.tools`/`ctx.skills` 不经 `inject` 直接读会抛错，`ctx.get()` 又不会等服务；③`peerDependencies` 检查发生在 pnpm 装完之后（失败会回滚）；④`--dump-config` 会写 profile 的 `cordis.yml`。逐条证据见文末 **「实测回填」**。

---

## A. Minimum viable plugin — layout, fields, copy-pasteable manifest

### A.1 Directory layout

```
dsh-hello/
├── package.json            # required
├── cordis.patch.yml        # required to be a profile layer (dsh.bundle.patch target)
├── lib/
│   ├── index.js            # host/agent half (main)
│   └── client.js           # OPTIONAL web half (built bundle; see C.iii)
├── bundled-skills/         # OPTIONAL skills (only if you wire a provider/root yourself)
│   └── hello/SKILL.md
└── README.md
```

Evidence for this shape, as a real shipped plugin: `<PROF>\node_modules\dsh-mattpocock-skills-deck\package.json:12-35` (`type: module`, `main: lib/index.js`, `exports` with `.`, `./client`, `./tools`, `./cordis.patch.yml`, `./package.json`; `files` = `["lib","shared","cordis.patch.yml","bundled-skills","scripts/","CHANGELOG.md"]`). A minimal in-box client plugin shows the same packaging: `<DSH>\dsh-client-ui-brand-official\package.json:13-27` (`type: module`, `main: lib/index.js`, `exports { ".": {types,default}, "./client": {types,default}, "./package.json" }`) and `files: ["lib/index.js","lib/client.js","lib/types/**/*.d.ts"]` (:51-55).

### A.2 Field-by-field contract

| Field | Required? | What it must contain | Proof |
|---|---|---|---|
| `name` | Yes | Valid npm package name (scoped allowed). Also the identity used in compat diagnostics. | `<BOOT>\lib\index.js:330` `PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/` ; `:303-305` reads `name`/`version` to build the exemption key |
| `version` | Yes | Exact SemVer. Needed to build the `name@version` exemption key; a mismatch with no name/version throws. | `<BOOT>\lib\index.js:263` `Plugin manifest ${field} must be a non-empty string when dsh peers are incompatible` |
| `type` | Yes in practice | `"module"`. Every examined plugin and every in-box package uses ESM (`<PROF>\...\dsh-mattpocock-skills-deck\package.json:12`; `<DSH>\dsh-client-ui-brand-official\package.json:13`). | [V] manifests; [I] CJS untested |
| `main` | Yes | Entry file, e.g. `lib/index.js`. Used when a patch row names the bare package. | [V] both example manifests above; `<DSH>\dsh-plugin-manager\package.json` `main: lib/index.js` |
| `exports` | Strongly recommended | At minimum `".": "./lib/index.js"` and `"./package.json": "./package.json"`. Subpath exports are how patch rows address extra rows: `"./tools": "./lib/platform/deckToolsRow.js"` is what makes the row name `'dsh-mattpocock-skills-deck/tools'` resolvable. | `<PROF>\...\dsh-mattpocock-skills-deck\package.json:18-24`; `<PROF>\...\cordis.patch.yml:12-13` |
| `engines.dsh` | **Optional, and NOT enforced** | A SemVer range like `">=0.2.0-rc.2"`. | [V] present at `<PROF>\...\dsh-mattpocock-skills-deck\package.json:9-11`. Type declares it: `<DSH>\dsh-package-manifest\lib\types\types.d.ts:55-57` `dsh?: string` with the comment at `:22` "DSH compatibility is **declarative until a reader enforces it**". Grep of `<BOOT>\lib\index.js` shows enforcement keys off `peerDependencies`, never `engines` (`:289-301`). **[I] `engines.dsh` is documentation only today** |
| `dsh.bundle.patch` | **Yes — this is the activation switch** | One path string, or an ordered array of path strings, relative to the package root. | `<BOOT>\lib\index.js:495-499` `bundlePatchFiles`; `:507-509` `bundlePatchPaths` joins each to `packageDir`; type at `<DSH>\dsh-package-manifest\lib\types\types.d.ts:66-69` |
| `dsh.client` | Only for web UI | `{ platform: "web", inject?: string[], immediately?: boolean, external?: string[] }` | `<DSH>\dsh-package-manifest\lib\types\types.d.ts:76-89`; real values in `<PROF>\...\dsh-mattpocock-skills-deck\package.json:54-58` |
| `files` | Yes for publishing | npm allowlist. If your patch file or `lib/` is excluded, the published package cannot activate. The deck ships `cordis.patch.yml` and `bundled-skills` explicitly. | `<PROF>\...\dsh-mattpocock-skills-deck\package.json:28-35` |
| `dependencies` | As needed | Packages your code imports. Must NOT contain a second copy of DSH tool/API packages it needs to share identity with — see G.1. | `<PROF>\...\dsh-mattpocock-skills-deck\package.json:25-27` (only `dsh-plugin-update`) |
| `peerDependencies` | **This is what the compatibility check reads** | Any `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` name you depend on, with a range that must match the running runtime. Anything else in `peerDependencies` is ignored by the check. | `<BOOT>\lib\index.js:289-301` — only names equal to `@deepseek-ai/dsh` or starting `@deepseek-ai/dsh-` are inspected |
| `private` | — | `true` prevents publication (for local profile projects). | `<DSH>\dsh-package-manifest\lib\types\types.d.ts:16-17` |
| `icon` | Optional | SVG/PNG/JPEG/WebP path, ≤256 KiB, must resolve inside the package dir. | `<DSH>\dsh-package-manifest\lib\types\types.d.ts:14-15`; cap enforced at `<BOOT>\lib\index.js:1852` `MAX_ICON_BYTES = 256 * 1024` |

### A.3 Copy-pasteable minimal `package.json`

```json
{
  "name": "dsh-hello",
  "version": "0.1.0",
  "description": "Minimal DSH plugin: one host tool and one web row.",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./tools": "./lib/tools.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": [
    "lib",
    "cordis.patch.yml",
    "README.md"
  ],
  "engines": {
    "dsh": ">=0.2.0-rc.2"
  },
  "peerDependencies": {
    "@deepseek-ai/dsh-tools": "*",
    "@deepseek-ai/cordis": "*"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "license": "MIT"
}
```

If you also want a web half, add `"dsh": { "bundle": {...}, "client": { "platform": "web", "immediately": false, "inject": [] } }` (shape from `package.json:54-58` of the deck, and `types.d.ts:76-89`).

**Warning on `peerDependencies` ranges [V mechanism / I outcome]:** the runtime version compared against is `@deepseek-ai/dsh-app-boot`'s own version read from `<BOOT>\package.json` (`<BOOT>\lib\index.js:271-275` `getDshRuntimeVersion()`), i.e. `0.2.0-rc.2` here. Prereleases DO participate in range matching (`:300`, `includePrerelease: true`). `"*"` satisfies. A range that excludes the runtime makes the plugin **refuse to mount** with a hard error. If you are unsure, declare no `peerDependencies` at all — the check returns `undefined` when the field is absent (`:289` `if (!Object.hasOwn(fields, "peerDependencies")) return void 0`), and the plugin loads unchecked.

---

## B. What `dsh plugin --profile desktop add <pkg>` does end-to-end

CLI surface: `dsh plugin --profile <name> <pnpm-args...>` — `<DSH>\lib\bin.js:105` usage string; `:116` `program.command("plugin")` whose description is "manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory"; `:236` `process.exit(await runPlugin(invocation.profile, invocation.args, options.packageManager))`.

Call chain (all line numbers are exact reads):

1. **`runPlugin(profile, args, packageManager)`** — `<DSH>\lib\plugin-BGnVfe_D.js:63-99`.
   - `:64-69` For `profile === "desktop"` it first calls `requireDesktopProfile(...)`, which throws `"Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop."` if `<PROF>\package.json` is missing (`:10-12`).
   - `:70-71` An arg named `allow-version`, `revoke-version`, or `version-exemptions` is intercepted by DSH itself and never reaches pnpm (`:14-56`, `versionCommand`).
   - `:72-79` Builds `context = { profile, dir, installAnchor: INSTALL_ANCHOR, cwd: process.cwd() }` and `options = { ...packageManager, execution: "cli", outputBytes: 16384, lockWaitMs: 120000, lookupTimeoutMs: 120000, onOutput }`.
   - `:90-93` For desktop it takes the profile write lock (`withFileLock(join(dir,"package.json"), …, {waitMs:120000})`) and calls **`runProfilePnpm`**; other profiles go through `runPluginCommand` (`<PM>\lib\types\operations.js:526-537`, which creates the profile from a template when absent and takes the same lock).
   - `:94` exit 127 → `"dsh: pnpm was not found; install pnpm and make it available on PATH."`
   - `:95` each refused package → prints the exact remedy `dsh plugin --profile <p> allow-version <name>@<version> --dsh-version <runtime> --accept-risk`
   - `:96` nonzero → `dsh: plugin command failed; diagnostics: <logPath>`
   - `:97` git-hosted spec → tells you to add the exact key under `allowBuilds` in `<profile>\pnpm-workspace.yaml`

2. **`runProfilePnpm(context, args, options)`** — `<PM>\lib\types\operations.js:246-519`. Sequence:

   | Step | What happens | Lines |
   |---|---|---|
   | 0 | Refuses to start if `.plugin-manager/run.json` names a still-live run from a dead process | `:249`, `:173-199` |
   | 1 | Creates `<PROF>\.plugin-manager\logs\operation-XXXX\pnpm.log`; snapshots `package.json` **and** `pnpm-lock.yaml` in memory for rollback | `:250-254`, `:263` |
   | 2 | **Pre-install preflight.** For each named positional of `add`/`install`/`i` (`:100-101`, `:105-111`): a `file:`/path spec is read from disk; a registry spec runs real `pnpm view <spec> name version peerDependencies --json … --config.fetch-retries=0` (`:123-143`). Then `evaluatePluginCompatibility(...)` runs on that manifest. Any unsatisfied `@deepseek-ai/dsh*` peer **aborts before pnpm runs**: `dsh: installation rejected: …` + `dsh: nothing was installed.` | `:296-319`, `:286-293` |
   | 3 | Runs **`pnpm <your args>` with `cwd` = the profile dir** (`execa(options.command ?? 'pnpm', [...options.args ?? [], ...args.map(anchorPathSpec)], { cwd: dir, … })`); relative path args are anchored to the *invoking* cwd, not the profile (`:19-24` `anchorPathSpec`). CLI runs inherit stdio, so you see pnpm's own output | `:325-332`, `:19-24` |
   | 4 | Post-run validation — for each direct dependency (`dependencies` + `devDependencies` + `optionalDependencies`, `:200-204`) that this run touched, plus every bundle component row package it reaches (`:206-235` `bundleComponentManifests`): `evaluatePluginCompatibility`. A failure **restores** `package.json` + `pnpm-lock.yaml`, then reinstalls (`pnpm install --frozen-lockfile`, or `--config.lockfile=false` if there was no lockfile), and exits **1** with `dsh: installation rejected: …`. An *untouched* incompatible dependency only warns and stays installed (startup denies it). | `:443-505` |
   | 5 | **`reconcile(before, dir, anchor, options)`** — activation | `:44-72`, called at `:503-504` |

3. **What `reconcile` decides** — `<PM>\lib\types\operations.js:44-72`:
   - `:52` a previously listed bundle is **dropped** the moment its package stops resolving or stops declaring a bundle.
   - `:57-60` a newly added direct dependency whose `dsh.bundle` is `undefined` prints **exactly**:
     `dsh: warning: <name> declares no dsh.bundle — installed as a plain dependency, not a profile layer`
     and is *not* added to the bundle list.
   - `:62-63` a real bundle has **every** patch file it declares loaded via `loadOverlayPatches` — this is where a malformed `cordis.patch.yml` fails the install.
   - `:64-66` then its name is pushed to the bundle list.
   - `:70-71` the profile `package.json` is rewritten atomically with the new ordered `dsh.profile.bundles`.
   - `bundleManifest` (`:31-35`) is what classifies the package: it returns `undefined` unless `manifest.dsh?.bundle?.patch !== undefined`. **A `dsh.bundle` object without a `patch` key is treated as no bundle at all.**

4. **The `engines.dsh` compatibility check: it does not exist.** The check is `evaluatePluginCompatibility` in `<BOOT>\lib\index.js:286-313`, and it walks only `peerDependencies` entries named `@deepseek-ai/dsh` or starting `@deepseek-ai/dsh-` (`:294`). `workspace:^`, `workspace:~`, `workspace:*` are treated as "the current runtime" (`:295-299`). Failure produces `<BOOT>\lib\index.js:322`:

   > `Plugin <name>@<version> is incompatible with dsh <runtime>: peerDependencies {...}. Running it may cause crashes or data loss. Update the plugin or install a plugin version compatible with this dsh runtime. To accept this risk explicitly, grant the exact-version exemption for <name>@<version> on dsh <runtime> with `dsh plugin allow-version` or the plugin manager, then retry the installation or restart dsh. Exact-version exemption: <active|not active>.`

5. **How the name lands in `dsh.profile.bundles`:** only by step 5 above. Confirmed live: `<PROF>\package.json:4-15` lists 10 dependencies and `:16-33` lists exactly 12 bundles (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, then the 10 installed plugins in install order). The author never edits that list.

6. **Idempotence / existing state:** install takes a 120 s lock on `<PROF>\package.json` (`<DSH>\lib\plugin-BGnVfe_D.js:90-93`), and refuses if another dsh process holds it or if a `.plugin-manager/run.json` record names a live pnpm tree (`<PM>\lib\types\operations.js:173-199`).

---

## C. Registering things

### C.i A server/agent-side **tool**

A patch row names a module; that module exports a Cordis plugin. The loader accepts a function, a class, or an object with `apply` — `<DSH>\cordis-plugin-loader\lib\index.js:1447` `isApplicable = (value) => object && typeof value === 'object' && typeof value.apply === 'function'`. `inject` is resolved from the plugin export and merged into the fiber's injection: `<DSH>\cordis-plugin-loader\lib\index.js:628` `Inject.resolve(fiber.entry.options.inject, fiber.inject)`; a plugin's own `Config` export is applied at `:951`.

The working in-repo example is the deck's tool row: `<PROF>\node_modules\dsh-mattpocock-skills-deck\lib\platform\deckToolsRow.js`

- `:31` `export const name = 'dsh-mattpocock-skills-deck-tools'` (must match the row `id` in `cordis.patch.yml:12`)
- `:32` `export const inject = ['tools']`
- `:319-329` `export function apply(ctx) { if (!ctx?.tools || typeof ctx.tools.register !== 'function') throw … ; for (const d of SEVEN) { … ctx.tools.register(raw) } }`
- `:141-154` `toRawRegistration` shows the **raw registration object** shape the registry accepts: `{ name, description, parameters, timeoutMs, output: { schema, render }, execute }` — all plain data, no `defineTool` factory. The deck's file header at `:11-18` explains *why*: importing a separate copy of the tool package yields a different identity than the host's and every call fails with `Cannot read properties of undefined (reading 'prepare')`.

Two authoring paths, both valid:

**(a) Hand-rolled raw registration** (zero framework deps, exactly what the deck does):
```js
// lib/tools.js
export const name = 'dsh-hello-tools'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register({
    name: 'hello_greet',
    description: 'Return a greeting for a name.',
    // 实测更正（2026-10-14）：手写注册对象的 parameters 必须是完整 JSON Schema，顶层 type 必须是
    // "object"。下面这种简写 DSL 只适用于 defineTool 那条路；写成简写时模型侧直接拒收：
    //   INVALID_REQUEST: Invalid schema for function 'hello_greet':
    //   schema must be a JSON Schema of 'type: "object"', got 'type: null'.
    parameters: {
      type: 'object',
      properties: {
        who: { type: 'string', description: 'Name to greet' },
        times: { type: 'integer' },
      },
      required: ['who'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      return `hello ${args.who}`.repeat(args.times ?? 1)
    },
  })
}
```
Parameter DSL (`string|number|integer|boolean|null|array|object|json|oneOf`) and the full `defineTool` form are documented at `<DSH>\dsh-tools\README.md:30-60`; the Typed shape is `ToolDefinition { output: ToolOutputDefinition; execute(args, exec): Promise<unknown>; timeoutMs?: number }` at `<DSH>\dsh-tools\lib\types\index.d.ts:115-158`.

**(b) `defineTool` from `@deepseek-ai/dsh-tools`** — nicer types, and it validates args before `execute` (`<DSH>\dsh-tools\README.md:32` `Model arguments are validated before execution; invalid input becomes a normal error result`). Cost: you must declare `@deepseek-ai/dsh-tools` as a peer and read G.1 first.

Registering is all that is needed for visibility: `<DSH>\dsh-tools\README.md:28` — "Registering a tool is enough to make it visible — the registry feeds its schemas into the system-prompt assembly automatically."

### C.ii A **skill catalog entry**

There is **no `package.json` field for skills**. Skills reach the catalog by one of two verified routes.

**Route 1 — files on a scanned root (no code).** Provider `<DSH>\dsh-skill-filesystem\lib\index.js` scans, in rank order: `<projectRoot>/.dsh/skills` (100), `<projectRoot>/.agents/skills` (200), `config.customSkillDirs` (300), `<dshHome>/skills` (400), `<agentsHome>/skills` (500), and finally `config.bundledSkillDir`, or — when `includeDefaultRoots` is true — `process.env.DSH_BUNDLED_SKILL_DIR` at rank 600. `<DSH>\dsh-skill-filesystem\lib\index.js:21-25` (rank constants), `:84-85` (`const bundledSkillDir = config.bundledSkillDir ?? (this.includeDefaultRoots ? process.env.DSH_BUNDLED_SKILL_DIR : void 0)`), `:181-184` (pushed at `BUNDLED_SKILL_RANK`, which is `600` — `<DSH>\dsh-skill\lib\index.js:23`). README table: `<DSH>\dsh-skill-filesystem\README.md:46-56`.

> **[V] gotcha:** `DSH_BUNDLED_SKILL_DIR` is **read but never set anywhere in the installed tree** — a recursive grep across every `@deepseek-ai/*` package found exactly one occurrence, that read at `dsh-skill-filesystem\lib\index.js:84`. So a plugin cannot rely on it; it must either set it before the provider is constructed, pass `bundledSkillDir` through a Cordis row `config`, or register a provider (Route 2).

**Discovery shape:** `<name>/SKILL.md` directory bundles or flat `<name>.md`, at the **top level** of a scanned root — nested `**/SKILL.md` is deliberately not discovered (`<DSH>\dsh-skill-filesystem\README.md:36`).

**Required frontmatter:** `name` and `description` (README:36 — "required `name` and `description`, plus optional `whenToUse`, `metadata`, `disable-model-invocation`, and `user-invocable`"). A malformed boolean for the two flags **drops the whole skill with a warning** rather than defaulting to permitted (README:38).

Real example, including the `disable-model-invocation` key the task mentions — `<PROF>\node_modules\dsh-mattpocock-skills-deck\bundled-skills\wayfinder\SKILL.md:1-7`:
```markdown
---
name: wayfinder
description: Plan a huge chunk of work (more than one agent session can hold) as a shared map of decision tickets…
disable-model-invocation: true
---

A loose idea has arrived, too big for one agent session…
```
The deck ships 27 such directories (`<PROF>\...\bundled-skills\` — `ask-matt`, `wayfinder`, `research`, `wizard`, `tdd`, …).

**Route 2 — in-process registration (what the deck actually does).** `<PROF>\node_modules\dsh-mattpocock-skills-deck\lib\bootstrap.js`:
- `:8-9` `const skills = ctx.get('skills'); if (!skills || typeof skills.registerProvider !== 'function') return`
- `:11-65` locates its own `bundled-skills` directory by candidate probing (including `node_modules/dsh-mattpocock-skills-deck/bundled-skills` under each `~/.dsh/profiles/*`), and bails with `[bundled] dir not found, skip provider` if none is found
- `:182` `dispose = skills.registerProvider(createBundledProvider)`
- `:3-5` documents the choice: rank 350 deliberately outranks the home directories at 400/500

The registry API (`<DSH>\dsh-skill\lib\index.js`): `registerProvider(create)` at `:147`, `register(skill)` at `:193`. Types at `<DSH>\dsh-skill\lib\types\index.d.ts`: `SkillCandidate extends SkillSummary` adds `rank: number` (lower wins, `:63-67`) and an opaque `locator` passed back to `provider.get()`; `SkillRegistration = Omit<SkillDefinition,'invocation'|'provider'> & { invocation?, provider? }` (`:78-84`) — omit `invocation` and both model and user surfaces are permitted (`:79-81`); `SkillSummary` requires `name`, `description`, `invocation`, `source`, `provider` (`:44-60`). README: `<DSH>\dsh-skill\README.md:52-55` — "Plugins register an in-memory skill with `ctx.skills.register(...)`; the registry fills in a default invocation policy and the `runtime` provider label… A provider contributes its catalog with `ctx.skills.registerProvider(...)`; registration is synchronous, and the returned disposer removes the provider."

### C.iii A **client/web UI** row

Declare `dsh.client` in `package.json` (shape: `<DSH>\dsh-package-manifest\lib\types\types.d.ts:76-89`):
```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": false, "inject": [], "external": [] }
}
```
- `platform` — `"web"` is the value the Web consumer selects (types.d.ts:78, `<DSH>\dsh-client-modules\README.md:34`)
- `inject` — **informational package-name dependencies, explicitly *not* Cordis service injection** (`types.d.ts:79-80`). For a third-party plugin it is normally `[]` (`<PROF>\...\dsh-mattpocock-skills-deck\package.json:57`)
- `immediately` — boot phase-one registration barrier; absent means the shared application batch (`types.d.ts:81-82`). The deck sets `true` (package.json:56)
- `external` — exact non-baseline module-table requests beyond the frozen `PLATFORM_MODULES` baseline (React, Cordis, static UI libs). `types.d.ts:83-88`; `<DSH>\dsh-client-modules\README.md:46` — "Composition rejects malformed requests, missing suppliers, self-requests, and synchronous request cycles"

**Serving:** the host composes a boot graph from enabled Loader entries and serves each bundle from `GET /plugins` — `<DSH>\dsh-client-modules\lib\index.js:201` `const PLUGIN_ROUTE = "/plugins"`, `:204` combo URL builder producing `??<id>/client.js,…&rev=<rev>`, `:367` `fileName: "client.js"`. A row's bundle is **its package's `lib/client.js`**, and `<id>/client` and the bare id resolve to the same exports (`<DSH>\dsh-client-modules\README.md:38`).

**Build requirement (hard):** `<DSH>\dsh-client-modules\README.md:50` — "The host serves built client bundles, so `pnpm run build` must have produced each `lib/client.js` before launch; a missing bundle fails activation loudly with one build instruction and a package/path list." The published artifact is not your source module but a wrapped kernel module. Real produced file, `<DSH>\dsh-client-ui-brand-official\lib\client.js:1-3,42-46`:
```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-brand-official",
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    …
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```
The client row is a Cordis plugin **in the browser**, using browser services. Example body — `<DSH>\dsh-client-ui-brand-official\lib\client.js:27-40`: `const inject = ["slots"]`, and `apply(ctx)` calls `ctx.slots.inject("sidebar.brand.mark", …)` / `ctx.slots.register({ name: "sidebar.brand.mark" }, Component)`.

In-box packages build this with **tsdown** (`<DSH>\dsh-client-ui-brand-official\package.json:56-59` — `"bundle": "tsdown"`, `"watch": "tsdown --watch"`; the deck uses `"prepare": "node ../scripts/build.mjs --pkg-only"` at `:16`). A third-party template has no in-box preset available, so **[I]** the practical path is to copy the `window.__ModuleLoader__.load({id, factory})` wrapper shape by hand or configure your bundler to emit it, writing `exports.apply`/`exports.inject`.

**Server side of a hybrid plugin:** if your web UI needs to talk to host code, the installed examples do it over the connection RPC (`ctx.connection.rpc.call('/api', 'dsws', {...})`, `<PROF>\...\lib\platform\deckToolsRow.js:235`) or same-origin `fetch('/api/dsws', …)` (`:261`). **[I]** that is the host↔page channel; there is no documented plain-object bridge.

---

## D. The exact `cordis.patch.yml` insert format — and yes, `dsh plugin add` writes nothing

**Shape (copy this).** A bundle patch is a top-level YAML **array** of loader patch entries; the one you need is a single `- insert:` whose value is the row list. Verbatim from the deck, `<PROF>\node_modules\dsh-mattpocock-skills-deck\cordis.patch.yml:8-14`:

```yaml
- insert:
    - id: dsh-mattpocock-skills-deck
      name: 'dsh-mattpocock-skills-deck'
      config: {}
    - id: dsh-mattpocock-skills-deck-tools
      name: 'dsh-mattpocock-skills-deck/tools'
      config: {}
```

Row semantics verified elsewhere: `name` may be an absolute filesystem path, a `file:` URL, or a package specifier, and patch loading converts absolute / patch-relative `./` `../` names to file URLs inside `insert` rows and nested groups (`<BOOT>\README.md:65`). `disabled` may be a `!!js` expression evaluated against the loader context — `<DSH>\dsh-base\cordis.patch.yml:22` `disabled: !!js "!ctx.get('profileContext')"`. The `id` is the handle the profile's *user* layer targets to override or disable, and **an id-targeted patch replaces the row's whole `config` rather than merging** (`<BOOT>\README.md:205`, `<DSH>\dsh-base\cordis.patch.yml:6-7`) — so keep row configs small and complete.

For a new plugin, the matching file is:
```yaml
# dsh-hello bundle layer: one tool row + the host entry.
- insert:
    - id: dsh-hello
      name: 'dsh-hello'
      config: {}
    - id: dsh-hello-tools
      name: 'dsh-hello/tools'
      config: {}
```

**Does `dsh plugin add` write it? No — and it does not need to.** `reconcile` only *reads* the patch files: `<PM>\lib\types\operations.js:62-63` `for (const file of bundlePatchPaths(...)) loadOverlayPatches('dsh', file)`, then `:64-66` appends the bundle name. The only file it writes is the profile's `package.json` (`:70-71` → `saveManifest` at `:40-41`, atomic, mode `0600`). The deck's own comment states the same expectation, `<PROF>\...\cordis.patch.yml:6-7`: *"由 `dsh plugin --profile <name> add` 自动装配（包声明 `dsh.bundle.patch`）, 无需手动编辑任何文件"* — "auto-wired by `dsh plugin add` (the package declares `dsh.bundle.patch`), no need to edit any file by hand." **[V] reconciled precisely:** *you* must author and ship `cordis.patch.yml`; *DSH* then discovers and activates it automatically. The `insert:` rows go in **your** file, never in the profile's user `cordis.patch.yml`.

**However**, if your plugin needs a row that is *disabled by default* or wants to expose a toggle, the convention is to ship the row with `disabled: true` and let the user enable it by id from the profile patch — exactly how the in-box plugin manager does it (`<DSH>\dsh-base\cordis.patch.yml:16-18` `id: tool-plugin-manager … disabled: true`, and `<PROF>\cordis.patch.yml:23-30` shows users flipping `disabled: false` by bare id for `better-sidebar`, `dsh-context`, `modlens`, `furongjun1999-dsh-memory`).

---

## E. Local dev loop

Exact commands (verified CLI surface; `dsh` and `pnpm` here are `.ps1` shims and the machine's PowerShell ExecutionPolicy blocks them — run through `cmd /c` or an unrestricted shell):

```bat
:: 1. scaffold (no DSH scaffolder exists — make the files yourself)
mkdir dsh-hello && cd dsh-hello
::    write package.json, cordis.patch.yml, lib/index.js, lib/tools.js

:: 2. install into the desktop profile from the plugin's own directory
::    (a relative path arg is anchored to the INVOKING cwd, not the profile)
dsh plugin --profile desktop add .

:: 3. see it load — confirm the bundle list and the resolved layer
type "%USERPROFILE%\.dsh\profiles\desktop\package.json"        :: expect "dsh-hello" in dsh.profile.bundles
dsh --profile desktop --dump-default-config                    :: composed entry list, grouped per source file
type "%USERPROFILE%\.dsh\profiles\desktop\.plugin-manager\logs\operation-*\pnpm.log"

:: 4. iterate
::    - edit lib/*.js         -> restart the app (module code is cached; see below)
::    - edit cordis.patch.yml -> picked up live, no restart (profile patch watch)
::    - edit the profile's own cordis.patch.yml (row enable/disable/config) -> applied live
::    for a web half: rebuild lib/client.js, then the page swaps the plugin in

:: 5. uninstall
dsh plugin --profile desktop remove dsh-hello
```

Evidence for each:

- **Step 1:** there is no `dsh create`/`init`/scaffold command. The only subcommand is `plugin` (`<DSH>\lib\bin.js:116`), and no template/template-scaffold package exists in `<DSH>` (grep found none). **[I]** scaffolding is by hand or by copying the deck's layout.
- **Step 2:** path anchoring is `anchorPathSpec(argument, context.cwd)` with `context.cwd = process.cwd()` (`<DSH>\lib\plugin-BGnVfe_D.js:78`) applied to every arg (`<PM>\lib\types\operations.js:325`); the regex accepts `.`, `..`, `./x`, `file:`, `link:` (`:19-24`). The pnpm process itself runs with `cwd: dir` = the profile (`:326`).
- **Step 3:** `--dump-default-config` prints the composed entry list with `!!js` verbatim, grouped under comments naming each source file and the patch layers that changed it (`<BOOT>\README.md:73`). Diagnostics log path is printed on failure (`<DSH>\lib\plugin-BGnVfe_D.js:96`) and every run writes `<PROF>\.plugin-manager\logs\operation-*\pnpm.log` (`<PM>\lib\types\operations.js:250-254`).
- **Step 4 (HMR — the precise answer):** the base bundle enables `dsh-hmr` when the launcher supplies `profileContext` (`<DSH>\dsh-base\cordis.patch.yml:28-32`, `disabled: !!js "!ctx.get('profileContext')"`, `config: { root: [] }`). HMR watches "the profile manifest and both user patch files" and re-reads the ordered bundle layers (`<BOOT>\README.md:63`). So:
  - **`cordis.patch.yml` content and bundle selection changes apply live** (`<BOOT>\lib\index.js:487` — the profile patch layer is "hot-reloaded on long-lived surfaces").
  - **Module code changes need a restart**: `<DSH>\dsh-hmr\README.md:89` — "Replacing installed package versions still requires a restart through Plugin Manager." and `<DSH>\dsh-plugin-manager\README.md:130` — "Package replacements require restarting the process to load a fresh JavaScript module generation." `root: []` means **module** directories are not watched, only explicit configuration (`<DSH>\dsh-hmr\README.md:43`).
  - **For a web half there IS a real HMR path**, but it needs a rebuild watcher: `<DSH>\dsh-client-hmr\README.md:32` — `pnpm run dev:web` "starts the host and the rebuild watchers together (`--no-serve` attaches only the watchers to a host started elsewhere, as does any watch process using the shared Client tsdown preset); rebuilt plugins are then swapped into the running browser automatically". `:36` each successful reload re-executes the bundle and remounts with fresh state; dependent plugins reload too. `:48` React state inside the reloaded plugin is lost; session/workspace/connection state survives.
- **Step 5:** removal deselects and unloads the bundle **before** pnpm runs (`<DSH>\dsh-plugin-manager\README.md:92`), so a failed removal retains partial changes and diagnostics.

---

## F. Publishing

1. **`files` must include everything needed to load.** npm's allowlist governs the tarball. Ship at minimum `lib/`, your `cordis.patch.yml`, and any bundled skill directory. Compare `<PROF>\...\dsh-mattpocock-skills-deck\package.json:28-35` (ships `lib`, `shared`, `cordis.patch.yml`, `bundled-skills`, `scripts/`, `CHANGELOG.md`) — note `shared` and `bundled-skills` are *outside* `lib`, so a naive `files: ["lib"]` would break both the tool row's imports (`deckToolsRow.js:28-29` imports `../../shared/...`) and skill discovery.
2. **A build step must run before publish — for the client half, mandatorily; for the host half, only if you author in TS.** `<DSH>\dsh-client-modules\README.md:50` is explicit that the host serves **built** `lib/client.js` and a missing bundle "fails activation loudly with one build instruction and a package/path list." The in-box pattern is `"bundle": "tsdown"` / `"watch": "tsdown --watch"` (`<DSH>\dsh-client-ui-brand-official\package.json:56-59`) in `scripts` — npm runs neither automatically on publish, so wire them to `prepublishOnly`/`prepare` yourself (`prepare` DOES run on `npm publish`, and also on git installs). The deck uses exactly that: `"build"` and `"prepare"` both `node ../scripts/build.mjs --pkg-only` (`package.json:14-17`).
3. **A git-hosted plugin builds on install via `prepare`, which pnpm blocks** until allowed — the CLI says so verbatim and names the file: `<DSH>\lib\plugin-BGnVfe_D.js:97` → add the exact key under `allowBuilds` in `<PROF>\pnpm-workspace.yaml`. Current file: `<PROF>\pnpm-workspace.yaml:14-19` (already has `better-sqlite3`, `onnxruntime-node`, `protobufjs`, `sharp`, `@roarpeng/graphflow`). A git dependency therefore costs your users a manual approval + retry; **an npm tarball with everything pre-built avoids it entirely.**
4. **What makes `dsh plugin add <name>` resolvable:** nothing DSH-specific. The `<name>` is a pnpm spec passed straight through (`<PM>\lib\types\operations.js:325`), resolved by pnpm against its own registry config, in the profile directory. The manager reads `pnpm config get registry` per plan (`:545-552`) and by default also asks `https://registry.npmmirror.com/` (`<DSH>\dsh-plugin-manager\README.md:79`). So: publish to a registry pnpm can reach, and the bare name works. **Fresh account / scope notes [I — standard npm, not DSH code]:** an unscoped name is public by default; a scoped `@you/dsh-hello` needs `npm publish --access public` (the in-box packages encode this as `"publishConfig": { "access": "public" }`, `<DSH>\dsh-client-ui-brand-official\package.json:5-7`) — the deck ships unscoped. Also plan for `minimumReleaseAge`: `<PROF>\pnpm-workspace.yaml:6-13` shows the profile excluding several recent versions from that cutoff, i.e. **a freshly published version can be refused as too new** until it ages out, and the fix on the user side is an entry in `minimumReleaseAgeExclude`. Shipping a `CHANGELOG.md` and keywords (`"dsh"`, `"dsh-plugin"` — see `package.json:36-49` of the deck) is the discoverability convention.

---

## G. Constraints and gotchas provable from the code

**G.1 — Never let a bundle row import a *second copy* of a DSH tool/API package.** This is the single most expensive trap, and the deck documents it after being burned. `<PROF>\...\lib\platform\deckToolsRow.js:11-18`: putting a tool package in the published dependency list means install pulls a second copy; the row then builds its tools from *that* copy, which is not the one the host holds, and **every** tool call fails with `Cannot read properties of undefined (reading 'prepare')`. The remedy they adopted is to hand-roll plain data objects (`:141-154`) and to declare **no** tool-package dependency (`package.json:25-27` ships only `dsh-plugin-update`). Express host packages as `peerDependencies` instead — they are supplied by the profile/installation and resolved by the interception layer (`<BOOT>\lib\index.js:1242-1350`, the profile-resolution region). `pnpm-workspace.yaml` sets `autoInstallPeers: false` (`<PROF>\pnpm-workspace.yaml:5`), so peers are not auto-added at install either.

**G.2 — A declared DSH peer range that excludes the runtime is a hard, total block.** `evaluatePluginCompatibility` returns an issue, and preflight denies the row (`<BOOT>\lib\index.js:2075-2089`: `row.disabled = true`, and a group is turned off too). At layer-load time the *bundle itself* is skipped: `<BOOT>\lib\index.js:930-931` throws, caught at `:940-945` into `skippedBundles`, printed once per start as `dsh: skipping profile bundle "<name>": <reason>` (`:516`). Prefer omitting `peerDependencies` if you cannot test the range.

**G.3 — Exemptions do not carry over.** They live in `<PROF>\compatibility.json`, keyed by exact `package@version` → list of exact runtime versions (`<BOOT>\lib\index.js:326-350`; `<DSH>\dsh-plugin-manager\README.md:65`). Neither a plugin upgrade nor a DSH upgrade inherits permission. Grants require `--accept-risk` and print a data-loss warning (`<DSH>\lib\plugin-BGnVfe_D.js:36`).

**G.4 — `dsh.bundle` without `patch` = not a bundle.** Classification is `manifest.dsh?.bundle?.patch === undefined` → treated as a plain dependency (`<PM>\lib\types\operations.js:34` `bundleManifest`, `:58-60`). It will install, print the `declares no dsh.bundle` warning, and never load.

**G.5 — Build scripts are blocked by pnpm and must be approved per package name.** Windows/pnpm here is `12.8.1`; the failure mode is surfaced as `pendingBuilds` with a Web/agent retry path, approval persists **by package name** in the profile, and approval "permits commands with the host user's permissions" (`<DSH>\dsh-plugin-manager\README.md:58`, file `<PROF>\pnpm-workspace.yaml:14-19`). A failed run restores `package.json` and `pnpm-lock.yaml` but deliberately **not** `pnpm-workspace.yaml` (README:58).

**G.6 — Rollback is partial by design.** On a compatibility refusal after pnpm ran, the manifest+lockfile are restored and `node_modules` is reinstalled, but "already permitted build-script effects may remain" (README:63) and `<PM>\lib\types\operations.js:239` notes downloaded modules stay on disk. A **failed removal** retains its partial changes (README:94).

**G.7 — Concurrency: one writer at a time.** All installs take a file lock on `<PROF>\package.json` (120 s) and cross-process pnpm runs are tracked in `<PROF>\.plugin-manager\run.json`; a successor waits up to five seconds for a recorded run and otherwise refuses with a diagnostic naming the pid and the record (`<PM>\lib\types\operations.js:173-199`; README:92). If you see `does not name a package run; delete it once no earlier package operation is still running in this profile`, that is this mechanism.

**G.8 — `dsh plugin --profile desktop` demands the app be closed.** `requireDesktopProfile` refuses when the profile is uninitialized and the message tells you to open Desktop once and **fully quit it** before running the command (`<DSH>\lib\plugin-BGnVfe_D.js:10-12`).

**G.9 — Client `external` must be exact and cycle-free.** Composition rejects malformed requests, missing suppliers, self-requests, and synchronous request cycles; every unbundled `require(spec)` that misses the frozen `PLATFORM_MODULES` table throws `client-modules: require("<spec>") missed the module table` (`<DSH>\dsh-client-modules\lib\index.js:705`). Anything you import that is not React/Cordis/static-UI must be either bundled into your `client.js` or declared in `dsh.client.external` and actually exported as `<pkg>/client` by a package that is also loaded.

**G.10 — Node/pnpm floor.** Measured here: node `v24.21.0`, pnpm `12.8.1`, npm `11.19.0`. `engines.node`/`engines.npm` are part of the declared-but-unenforced engine map (`<DSH>\dsh-package-manifest\lib\types\types.d.ts:55-63`). Neither the dsh CLI nor the plugin manager declares an `engines` field at all (`<DSH>\package.json`, `<DSH>\dsh-plugin-manager\package.json` — both show `engines :` empty). **[I]** target modern ESM Node and do not assume a specific pnpm.

**G.11 — Local profile projects should set `"private": true`.** `<DSH>\dsh-package-manifest\lib\types\types.d.ts:16-17` names that as the purpose. Note the live desktop profile has no `private` guard on `name: dsh-profile-desktop` — it does have `"private": true` at `<PROF>\package.json:3`.

**G.12 — What a plugin must NOT do.**
- Must not rely on `engines.dsh` for gating (unread — see A.2).
- Must not write to `dsh.profile.bundles` itself; that list is manager-owned (`reconcile`, `<PM>\lib\types\operations.js:70-71`).
- Must not put `insert:` rows into the profile's user `cordis.patch.yml` as its own delivery mechanism — the bundle patch is the contract.
- Must not import a second copy of a host tool/API package (G.1).
- Must not assume profile patches deep-merge: an id-targeted override **replaces the whole `config`** (`<BOOT>\README.md:205`), so nest defensively.
- Should not hold a row's `id` differently from the module's exported `name` if you want the row to be toggleable by id (deck matches them exactly: `cordis.patch.yml:12` `id: dsh-mattpocock-skills-deck-tools` ↔ `deckToolsRow.js:31` `export const name = 'dsh-mattpocock-skills-deck-tools'`).

---

## Open questions / not verified

1. **No end-to-end install was executed.** Every claim above is read from code, config, or shipped artifacts. The single most valuable next experiment: scaffold the `.tmp`-style `dsh-hello` package, `dsh plugin --profile desktop add .`, and read `--dump-default-config` — that would convert most **[I]** tags to **[V]**.
2. **No official plugin template or `create-dsh-plugin` scafolder is installed.** Grep found none; **[I]** that none is published.
3. **`engines.dsh` enforcement could exist outside `<BOOT>`** (e.g. in a Rust/Electron layer inside `resources\app.asar`). I read only the readable JS tree; the asar itself is an archive. Everything enforcing compatibility in the readable tree uses `peerDependencies`.
4. **The client-half build pipeline for third-party packages is undocumented.** The in-box preset drives `tsdown`; the deck hand-writes its build. A third-party toolchain that emits the `window.__ModuleLoader__.load({id, factory})` wrapper is **[I]**.
5. **`DSH_BUNDLED_SKILL_DIR` has no setter in the installed tree** — how (or whether) a packaged plugin is *supposed* to populate it is unresolved; the deck's answer is `registerProvider` (C.ii Route 2).

---

## 实测回填（ticket #9 · 2026-10-14）

**实验设置.** 最小插件 `dsh-hello`（0.1.0 → 0.1.2：一个主行 + 一个工具行，**零 DSH 依赖**），`npm pack` 成 tarball，装进两个一次性 profile —`hello-exp`（`dsh hello-exp --from-default-profile web --dump-config` 创建）与 `hello-hl`（`--from-default-profile headless`）——再用 `dsh hello-hl "<任务>"` 跑一问。**desktop profile 全程未动。**

### 被改写 / 推翻的四条

**1. C.i(a) 的 `parameters` 简写是错的，必须给完整 JSON Schema** [V]
简写（`{ who: { type:'string', required:true } }`）到模型侧被直接拒收，headless 退出码 1：

```
dsh: INVALID_REQUEST: Invalid schema for function 'hello_greet': schema must be a JSON Schema of 'type: "object"', got 'type: null'.
```

改成 `{ type:'object', properties:{…}, required:['who'], additionalProperties:false }` 后同一问成功。→ 简写 DSL 属于 `defineTool` 那条路。

**2. 服务访问：`ctx.X` 需要 `inject`，`ctx.get()` 既不等也不抛** [V]（原文完全没写这条）
- 主行直接读 `ctx.tools`（写成 `ctx?.tools` 也一样）→ `Error: cannot get property "tools" without inject`，该行不激活，启动时 `dsh: warning: 1 entry did not activate`。
- 换 `ctx.get('skills')` 不抛，但服务未就绪时返回 `undefined` → 技能注册被**静默跳过**（apply.log `hasSkills=false`）。
- 加 `export const inject = ['skills']` 后正常：apply.log 记录到运行时技能服务 API `collectCache|collectCacheMaxEntries|ctx|layers|name|nextProviderOrder|nextScopeId|revision|scopeIds`，紧接着 `skills.register(hello-skill) ok`。→ C.ii **Route 2 由 [I] 升 [V]**。

**3. `peerDependencies` 检查发生在 pnpm 装完之后，失败会回滚** [V — 修正 B 节]
负面对照包 `dsh-hello-badpeer`（`"@deepseek-ai/dsh-tools": ">=99.0.0"`）实测：pnpm 先把它装上了（`+ dsh-hello-badpeer`、`Done in 458ms using pnpm v11.7.0`），随后 manager 才拒绝：

```
dsh: installation rejected: Plugin dsh-hello-badpeer@0.1.0 is incompatible with dsh 0.2.0-rc.2: peerDependencies {"@deepseek-ai/dsh-tools":">=99.0.0"}. … Exact-version exemption: not active.
dsh: restored package.json, pnpm-lock.yaml, and node_modules.
dsh: to accept the risk, run: dsh plugin --profile hello-exp allow-version dsh-hello-badpeer@0.1.0 --dsh-version 0.2.0-rc.2 --accept-risk
```

退出码 1，复验 profile 的 `package.json` 里确实没有它。→ 对**本地 tarball 规格**，"pnpm 之前就中止"不成立；中止在装完之后 + 自动回滚。

**4. `--dump-config` 会写盘** [V]（原文未提）
`prepareProfile` 每次都写 `<profile>/cordis.yml`。在沙箱（workspace-write）里跑会失败：

```
Error: EPERM: operation not permitted, open 'C:\Users\神\.dsh\profiles\hello-exp\cordis.yml'
```

注意这是**子进程里的普通 EPERM**，不是工具侧那个 `[sandbox: file access denied under workspace-write mode]` 标记 —— 与 `dsh-env-doctor` 的"沙箱检测"设计直接相关：插件看不到那个标记。

### 被证实的三条（[I] → [V]）

**5. `dsh.bundle.patch` 是激活开关，`reconcile` 自动登记** [V]
装完 profile `package.json`：`"dependencies": { "dsh-hello": "file:…/dsh-hello-0.1.0.tgz" }`，`dsh.profile.bundles` = `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-hello"]` —— 全程没手改任何文件。

**6. patch 写法与组合** [V]
`dsh --profile hello-exp --dump-config` 的组合树末尾（1260-1266 行）出现：

```yaml
# == dsh-hello
- id: dsh-hello
  name: dsh-hello
  config: {}
- id: dsh-hello-tools
  name: dsh-hello/tools
  config: {}
```

`.` 与 `./tools` 两个子路径导出都解析成功。

**7. 手写注册对象 + 零 DSH 依赖，工具真能被 agent 调到** [V]
headless 一问打印 `hello world`、退出码 0；插件自己写的 `call.log`：

```
2026-10-14T09:29:25.756Z execute who=world times=1 -> hello world
```

同进程 apply.log 有 `[tools] register(hello_greet) ok`。→ G.1 那条"血泪坑"的反面确认：**这条路可行**，失败模式与 deck 当年的 `prepare` 错无关。

### 顺手测到的

**8. `remove` 干净、重装幂等** [V]：`dsh plugin --profile hello-exp remove dsh-hello` → 退出 0，`dependencies`/`bundles` 都没了，`node_modules/dsh-hello` 也没了；再 add 一次，bundles 里仍只有一条 `dsh-hello`。

**9. headless 是最便宜的真机验证台** [V]：`dsh <profile> --from-default-profile headless --dump-config` 可用；`dsh <profile> "<任务>"` 答完一问即退出 —— 无服务器、无 UI、无 GUI 交互面。运行时 node v24.18.1。

**10. `files` 白名单实测** [V]：`npm pack` 出 3.1 KB / 6 个文件的 tarball，`lib/`、`cordis.patch.yml`、`bundled-skills/hello/SKILL.md`、`README.md`、`package.json` 全在包内。

### 仍未验证

- **文件系统根那条路（C.ii Route 1）**：`bundled-skills/<name>/SKILL.md` 只证明了形状与打包，没证明它被任何扫描根收进技能目录（`DSH_BUNDLED_SKILL_DIR` 仍无 setter）。要证明得靠 row `config.bundledSkillDir` 或 `config.customSkillDirs`。
- **技能在模型侧真的可见**：`register` 被接受（不抛错），但我没在模型侧确认它出现在技能目录里。
- **客户端行（C.iii）与 HMR**：整条没测（本次没有 web 半）。
- **装进真实 desktop profile 后 UI 侧是否正常**：未测 —— 本次实验同时证明了"不改 desktop 也能把机制验完"。
