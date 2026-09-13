# Security audit record

This is a **fork**, maintained because the upstream plugin has no popular
organization behind it. The rule this fork exists to enforce:

> Nothing gets installed from an unvetted individual maintainer. We fork, audit
> the exact commit, install our own fork — and **re-audit before every update**.

## Provenance

| Field | Value |
|---|---|
| Upstream | https://github.com/Wanbinyu/dsh-plugin-git-inspect |
| Upstream maintainer | `Wanbinyu` (individual, 3 followers) — **not** an organization |
| Audited upstream commit | `3e7de5648dd3a8e804da7258991c7ddc47b2a01b` |
| Audited upstream version | `0.3.6` |
| Audit date | 2026-09-13 |
| Fork | https://github.com/navidRashik/dsh-plugin-git-inspect |
| Fork package | `@navidrashik/dsh-plugin-git-inspect` |

### Why a fork and not the original

No plugin in the DSH git/diff ecosystem is backed by a popular organization.
Candidates considered and rejected:

| Candidate | Why rejected |
|---|---|
| `PivotStackIntelligence/dsh-github` (105★) | GitHub "Organization" with **0 followers and 1 repository**, self-branded "Official-grade". Org in name only. |
| `omdsh-dev` / Oh My DSH (3564★) | A real org, but explicitly self-describes as "an **unofficial** catalog". Sidebar plugin, not a diff tool. |
| `dsh-plugin-git-workflow` | No license. Builds a **shell command string**; its hand-rolled `shellQuote()` Windows branch does not escape `^` or `!` — a quoting defect in a tool that can `git commit`. |
| `dsh-github-intelligence` (14★) | Individual maintainer. Lists PRs but cannot diff them. |
| `@deepseek-ai/*` | **No official DeepSeek git plugin exists.** Verified against the published scope. |

`dsh-plugin-git-inspect` was chosen as the base for having the strongest
security architecture of the group, not for popularity (it has 1 star).

## Audit findings — upstream `0.3.6`

**Result: clean. No malicious or unsafe behaviour found.**

| Check | Finding |
|---|---|
| Shell invocation | ✅ None. `ctx.subprocess.spawn` with a fixed `argv` vector. |
| Argument injection | ✅ `--end-of-options` precedes every user-controlled revision. |
| Path injection | ✅ User paths always follow the `--` pathspec separator. |
| Network calls | ✅ None (`fetch`/`http`/socket: absent). |
| Credential access | ✅ No `process.env` reads, no token/secret/`.ssh`/`.netrc` access. |
| Obfuscation | ✅ No `eval`, `new Function`, `atob`, or base64 blobs. |
| Binary artifacts | ✅ None — 17 tracked text files. |
| Lifecycle hooks | ✅ Only `prepare: npm run build` (plain `tsc`). No pre/post-install. |
| Runtime dependencies | ✅ Exactly one: `@deepseek-ai/schemastery`, **published by the official DeepSeek maintainers** (`tianyi@deepseek.com`). |
| Lockfile integrity | ✅ All 113 locked packages resolve to `registry.npmjs.org`. No rogue registry. |
| `.npmrc` | ✅ `legacy-peer-deps=true` only. No registry override, no auth token. |
| CI workflow | ✅ `permissions: contents: read`, no secrets consumed. |
| Write capability | ✅ Read-only by construction: no commit, push, reset, checkout, or stash-mutating tool. |
| Output bounds | ✅ stdout/stderr byte-capped; truncation reported. |
| Cancellation | ✅ Harness abort signal forwarded to the child process. |

Residual risk accepted: upstream ships via GitHub release tarballs rather than
npm. Moot for this fork — we build from audited source.

## Changes made in this fork

Additive only. No upstream security control was removed or weakened.

1. **`git_diff_branch`** — merge-base (`base...head`) diff of the current
   branch. Three-dot semantics deliberately exclude commits that landed on the
   base after the branch point. Base auto-detection tries `origin/main`,
   `origin/master`, `main`, `master`, then the upstream tracking ref, verifying
   each with `merge-base` so an unrelated ref is skipped rather than producing a
   misleading whole-history diff.
2. **`git_diff_pr`** — GitHub pull-request patch via the authenticated `gh` CLI.
3. **`git_pr_info`** — pull-request metadata via `gh`.

### Security properties of the additions

- **Still no shell.** New calls use the same fixed-argv `ctx.subprocess.spawn`.
- **`--end-of-options`** precedes the `base...head` range; paths stay after `--`.
- **Ref validation** (`validateRef`) rejects a leading `-`, shell metacharacters,
  whitespace, `..` ranges, and malformed refs *before* any spawn. This is
  defence in depth layered on top of `--end-of-options`, so the guarantee holds
  even if a future edit drops that flag.
- **Repo validation** (`validateRepo`) enforces `owner/name` and rejects a
  leading `-`. *A real finding from this work:* the `owner/name` pattern alone
  accepts `--flag/x`, because hyphens are legal in GitHub owner names. Caught by
  the test suite and fixed with an explicit leading-hyphen check.
- **PR number validation** rejects non-positive, non-integer, and unsafe values.
- **Credential handling:** the plugin **never reads, stores, forwards, or logs a
  token.** No `GH_TOKEN`/`GITHUB_TOKEN` is injected or read. `gh` uses the
  user's ambient auth, so `gh auth logout` revokes this plugin's access too.
- **Read-only against GitHub:** only `pr diff` and `pr view` are ever spawned. A
  test asserts `merge`, `close`, `comment`, and `checkout` can never appear in
  the argv.
- **New network surface (disclosed):** unlike the git tools, the PR tools reach
  `api.github.com` through `gh`. This is inherent to reading a PR. Use
  `git_diff_branch` only if you want a strictly offline tool.

## Re-audit procedure — REQUIRED BEFORE EVERY UPDATE

Never fast-forward this fork onto upstream without completing these steps.

```sh
git remote add upstream https://github.com/Wanbinyu/dsh-plugin-git-inspect.git
git fetch upstream

# 1. Review EVERY upstream change since the last audited commit.
git diff 3e7de5648dd3a8e804da7258991c7ddc47b2a01b..upstream/main

# 2. Re-run the mechanical checks on the new tree.
grep -rnE "fetch|http|net\.|axios|eval\(|new Function|atob|child_process" src/
grep -rnE "process\.env|token|secret|credential|\.ssh|netrc" src/
grep -oE '"resolved": "https?://[^/]+' package-lock.json | sort -u   # npmjs.org only
python3 -c "import json;print(json.load(open('package.json')).get('scripts'))"  # no pre/post-install
python3 -c "import json;print(json.load(open('package.json')).get('dependencies'))"  # new runtime deps?

# 3. Confirm the invariants still hold.
#    - fixed argv, never a shell string
#    - --end-of-options before every user-controlled revision
#    - user paths after --
#    - no mutating git or gh subcommand
#    - no token read, stored, or logged

# 4. Only then merge, and verify.
git merge upstream/main
npm ci && npm run verify

# 5. Update the provenance block above and `upstream.auditedCommit`
#    in package.json to the newly audited commit.
```

**Escalate instead of merging** if an upstream change introduces: any shell
invocation, a new runtime dependency, a lifecycle script, any network call in
the git tools, any environment/token read, or any mutating git/gh subcommand.

## How the install enforces re-auditing

The plugin is installed into the dsh `web` profile pinned to an exact commit,
in two independent places. Both must be updated by hand to move to a new
version — neither can drift on its own:

1. **`package.json`** — `github:navidRashik/dsh-plugin-git-inspect#<sha>`, and
   `pnpm-lock.yaml` records the tarball with a `sha512` integrity hash.
2. **`pnpm-workspace.yaml` → `allowBuilds`** — keyed by the exact commit
   tarball URL. pnpm refuses to run this package's `prepare` build script under
   any *other* commit until that key is updated.

So a future update cannot install silently: pnpm hard-fails with
`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` until someone edits the allowlist, and
that edit is the checkpoint where the re-audit above must happen.

### Update flow

```sh
# after completing the re-audit procedure above and pushing the new commit
cd ~/.dsh/profiles/web
# 1. bump the pinned sha in package.json
# 2. update the allowBuilds key in pnpm-workspace.yaml to the new tarball URL
# 3. reinstall and restart dsh
pnpm install
```

## Verification performed at install time

| Check | Result |
|---|---|
| `npm run verify` (typecheck + tests + build + pack) | ✅ 18/18 tests |
| Registered tool count in a live harness context | ✅ 13 tools |
| `git_diff_branch` on a real repo | ✅ shows branch changes |
| Merge-base semantics | ✅ a commit landing on the base *after* branching is excluded |
| Base auto-detection | ✅ resolves without an explicit base |
| `stat` mode | ✅ file-level summary |
| Injection guards (`--upload-pack=…`, `$(touch …)`, `a;id`) | ✅ all rejected before spawn; `/tmp/pwned` never created |
| Malformed repo / negative PR number | ✅ rejected |
| `git_pr_info` against `cli/cli#14373` | ✅ real metadata returned |
| `git_diff_pr` (name-only and full patch) | ✅ real patch returned |
| Composed profile config (`dsh web --dump-config`) | ✅ mounted as `git-inspect` |
