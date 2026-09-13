import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SubprocessOutputRead } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'tool-git-inspect'
export const inject = ['tools', 'subprocess', 'systemPrompt']

export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_OUTPUT_BYTES = 200_000
export const DEFAULT_STDERR_MAX_BYTES = 16_384
export const DEFAULT_GRACE_MS = 1_000
export const DEFAULT_LOG_COUNT = 20
export const DEFAULT_MAX_LOG_COUNT = 100
export const DEFAULT_BLAME_LINE_COUNT = 50
export const DEFAULT_MAX_BLAME_LINE_COUNT = 200

export interface Config {
  timeoutMs?: number
  maxOutputBytes?: number
  stderrMaxBytes?: number
  graceMs?: number
  defaultLogCount?: number
  maxLogCount?: number
  defaultBlameLineCount?: number
  maxBlameLineCount?: number
}

export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  maxOutputBytes: z.number().default(DEFAULT_MAX_OUTPUT_BYTES),
  stderrMaxBytes: z.number().default(DEFAULT_STDERR_MAX_BYTES),
  graceMs: z.number().default(DEFAULT_GRACE_MS),
  defaultLogCount: z.number().default(DEFAULT_LOG_COUNT),
  maxLogCount: z.number().default(DEFAULT_MAX_LOG_COUNT),
  defaultBlameLineCount: z.number().default(DEFAULT_BLAME_LINE_COUNT),
  maxBlameLineCount: z.number().default(DEFAULT_MAX_BLAME_LINE_COUNT),
})

type ResolvedConfig = Required<Config>
type GitOperation = 'status' | 'diff' | 'diff_stat' | 'log' | 'show' | 'refs' | 'conflicts' | 'blame' | 'stash_list' | 'worktree_list' | 'diff_branch' | 'merge_base' | 'upstream' | 'pr_diff' | 'pr_view'

export interface GitResult {
  operation: GitOperation
  cwd: string
  stdout: string
  stderr: string
  truncated: boolean
}

const gitOutputSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    operation: { type: 'string' as const, required: true as const },
    cwd: { type: 'string' as const, required: true as const },
    stdout: { type: 'string' as const, required: true as const },
    stderr: { type: 'string' as const, required: true as const },
    truncated: { type: 'boolean' as const, required: true as const },
  },
}

const GIT_PREFIX = [
  '--no-pager',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotepath=false',
] as const

export function buildStatusArgs(): string[] {
  return [
    ...GIT_PREFIX,
    'status',
    '--short',
    '--branch',
    '--untracked-files=normal',
  ]
}

export function buildDiffArgs(staged: boolean, path?: string): string[] {
  return [
    ...GIT_PREFIX,
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    ...(staged ? ['--cached'] : []),
    '--',
    ...(path === undefined ? [] : [path]),
  ]
}

export function buildDiffStatArgs(staged: boolean, path?: string): string[] {
  return [
    ...GIT_PREFIX,
    'diff',
    '--stat',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    ...(staged ? ['--cached'] : []),
    '--',
    ...(path === undefined ? [] : [path]),
  ]
}

export function buildLogArgs(maxCount: number, path?: string): string[] {
  return [
    ...GIT_PREFIX,
    'log',
    '--no-color',
    '--decorate=short',
    '--oneline',
    '-n',
    String(maxCount),
    '--',
    ...(path === undefined ? [] : [path]),
  ]
}

export function buildShowArgs(revision: string, path?: string): string[] {
  return [
    ...GIT_PREFIX,
    'show',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--format=fuller',
    '--end-of-options',
    revision,
    '--',
    ...(path === undefined ? [] : [path]),
  ]
}

export function buildDiffBranchArgs(base: string, head: string, statOnly: boolean, path?: string): string[] {
  return [
    ...GIT_PREFIX,
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    ...(statOnly ? ['--stat'] : []),
    '--end-of-options',
    // Three-dot: diff from the MERGE BASE of base..head, i.e. only what this
    // branch introduced — not unrelated commits that landed on base meanwhile.
    `${base}...${head}`,
    '--',
    ...(path === undefined ? [] : [path]),
  ]
}

export function buildMergeBaseArgs(base: string, head: string): string[] {
  return [
    ...GIT_PREFIX,
    'merge-base',
    '--end-of-options',
    base,
    head,
  ]
}

export function buildUpstreamArgs(): string[] {
  return [
    ...GIT_PREFIX,
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]
}

export function buildPrDiffArgs(pr: number, repo: string | undefined, nameOnly: boolean): string[] {
  return [
    'pr',
    'diff',
    String(pr),
    ...(nameOnly ? ['--name-only'] : []),
    ...(repo === undefined ? [] : ['--repo', repo]),
  ]
}

export function buildPrViewArgs(pr: number, repo: string | undefined): string[] {
  return [
    'pr',
    'view',
    String(pr),
    '--json',
    'number,title,state,isDraft,author,baseRefName,headRefName,additions,deletions,changedFiles,url,mergeable',
    ...(repo === undefined ? [] : ['--repo', repo]),
  ]
}

export function buildRefsArgs(maxCount: number): string[] {
  return [
    ...GIT_PREFIX,
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short) %(objectname:short) %(committerdate:iso-strict)',
    '--count',
    String(maxCount),
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ]
}

export function buildConflictsArgs(path?: string): string[] {
  return [
    ...GIT_PREFIX,
    'diff',
    '--name-only',
    '--diff-filter=U',
    '--no-ext-diff',
    '--no-color',
    '--',
    ...(path === undefined ? [] : [path]),
  ]
}

export function buildBlameArgs(path: string, startLine: number, lineCount: number): string[] {
  return [
    ...GIT_PREFIX,
    'blame',
    '--no-progress',
    '--date=short',
    '-L',
    `${startLine},+${lineCount}`,
    '--',
    path,
  ]
}

export function buildStashListArgs(maxCount: number): string[] {
  return [
    ...GIT_PREFIX,
    'stash',
    'list',
    '--format=%gd %h %ci %s',
    '-n',
    String(maxCount),
  ]
}

export function buildWorktreeListArgs(): string[] {
  return [
    ...GIT_PREFIX,
    'worktree',
    'list',
    '--porcelain',
  ]
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`git-inspect: ${name} must be a positive integer`)
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    stderrMaxBytes: config.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES,
    graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
    defaultLogCount: config.defaultLogCount ?? DEFAULT_LOG_COUNT,
    maxLogCount: config.maxLogCount ?? DEFAULT_MAX_LOG_COUNT,
    defaultBlameLineCount: config.defaultBlameLineCount ?? DEFAULT_BLAME_LINE_COUNT,
    maxBlameLineCount: config.maxBlameLineCount ?? DEFAULT_MAX_BLAME_LINE_COUNT,
  }
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  assertPositiveInteger('maxOutputBytes', resolved.maxOutputBytes)
  assertPositiveInteger('stderrMaxBytes', resolved.stderrMaxBytes)
  assertPositiveInteger('graceMs', resolved.graceMs)
  assertPositiveInteger('defaultLogCount', resolved.defaultLogCount)
  assertPositiveInteger('maxLogCount', resolved.maxLogCount)
  assertPositiveInteger('defaultBlameLineCount', resolved.defaultBlameLineCount)
  assertPositiveInteger('maxBlameLineCount', resolved.maxBlameLineCount)
  if (resolved.defaultLogCount > resolved.maxLogCount) {
    throw new Error('git-inspect: defaultLogCount must not exceed maxLogCount')
  }
  if (resolved.defaultBlameLineCount > resolved.maxBlameLineCount) {
    throw new Error('git-inspect: defaultBlameLineCount must not exceed maxBlameLineCount')
  }
  return resolved
}

function optionalPath(path: string | undefined): string | undefined {
  if (path !== undefined && path.trim().length === 0) {
    throw new Error('path must be a non-empty string when given')
  }
  return path
}

function requiredRevision(revision: string): string {
  if (revision.trim().length === 0) throw new Error('revision must be a non-empty string')
  return revision
}

function requiredPath(path: string): string {
  if (path.trim().length === 0) throw new Error('path must be a non-empty string')
  return path
}

// Defence in depth. Every git call already uses a fixed argv vector (no shell)
// and puts `--end-of-options` before user-controlled revisions, so neither
// shell metacharacters nor a leading `-` can be reinterpreted. These checks
// reject malformed refs early with a clear message instead of deferring to a
// confusing git error, and keep the guarantee if a future edit ever drops
// `--end-of-options`.
const REF_FORBIDDEN = /[\x00-\x20~^:?*[\\\]"'`$;|&<>()!{}]/
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

export function validateRef(name: string, value: string): string {
  const ref = value.trim()
  if (ref.length === 0) throw new Error(`git-inspect: ${name} must be a non-empty git ref`)
  if (ref.length > 255) throw new Error(`git-inspect: ${name} is too long (max 255 characters)`)
  if (ref.startsWith('-')) throw new Error(`git-inspect: ${name} must not start with "-"`)
  if (REF_FORBIDDEN.test(ref)) throw new Error(`git-inspect: ${name} contains characters that are not valid in a git ref`)
  if (ref.includes('..')) throw new Error(`git-inspect: ${name} must be a single ref, not a range`)
  if (ref.endsWith('.lock') || ref.endsWith('/') || ref.endsWith('.')) throw new Error(`git-inspect: ${name} is not a well-formed git ref`)
  if (ref.includes('//')) throw new Error(`git-inspect: ${name} is not a well-formed git ref`)
  if (ref === '@') throw new Error(`git-inspect: ${name} must not be the bare "@" ref`)
  return ref
}

export function validateRepo(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const repo = value.trim()
  if (repo.length === 0) throw new Error('git-inspect: repo must be a non-empty "owner/name" string when given')
  // A hyphen is legal inside a GitHub owner name, so REPO_PATTERN alone would
  // accept "--flag/x". gh receives this as the value of --repo rather than as
  // a bare word, but reject a leading "-" anyway so the argv can never be
  // reinterpreted as an option if the call shape changes.
  if (repo.startsWith('-')) throw new Error('git-inspect: repo must not start with "-"')
  if (!REPO_PATTERN.test(repo)) throw new Error('git-inspect: repo must look like "owner/name"')
  return repo
}

export function validatePrNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('git-inspect: pr must be a positive integer')
  return value
}

function boundedLogCount(value: number | undefined, config: ResolvedConfig): number {
  const count = value ?? config.defaultLogCount
  assertPositiveInteger('maxCount', count)
  return Math.min(count, config.maxLogCount)
}

function boundedBlameRange(
  startLine: number | undefined,
  lineCount: number | undefined,
  config: ResolvedConfig,
): { startLine: number; lineCount: number } {
  const start = startLine ?? 1
  const count = lineCount ?? config.defaultBlameLineCount
  assertPositiveInteger('startLine', start)
  assertPositiveInteger('lineCount', count)
  return { startLine: start, lineCount: Math.min(count, config.maxBlameLineCount) }
}

function normalize(text: string): string {
  return text.replaceAll('\r\n', '\n')
}

function collected(handle: { collected: { stdout?: { readFrom(fromByte: number): SubprocessOutputRead }; stderr?: { readFrom(fromByte: number): SubprocessOutputRead } } }): {
  stdout: SubprocessOutputRead
  stderr: SubprocessOutputRead
} {
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined) {
    throw new Error('git-inspect: subprocess did not provide collected output streams')
  }
  return { stdout, stderr }
}

async function runGit(
  ctx: Context,
  exec: ToolRunContext,
  operation: GitOperation,
  argv: readonly string[],
  config: ResolvedConfig,
): Promise<GitResult> {
  if (exec.signal.aborted) throw new Error(`git ${operation} was aborted before start`)
  const cwd = exec.agent?.session.header.cwd?.trim() || process.cwd()
  const executable = await ctx.subprocess.resolveExecutable('git', undefined, exec.signal)
  const handle = ctx.subprocess.spawn({
    argv: [executable, ...argv],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: config.maxOutputBytes },
      stderr: { maxBytes: config.stderrMaxBytes },
    },
    graceMs: config.graceMs,
    signal: exec.signal,
    env: {
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
    },
  })

  let outcome: { exitCode: number | null; signal: string | null }
  try {
    outcome = await handle.done
  } catch (error: unknown) {
    throw new Error(`git ${operation} could not start: ${String(error)}`, { cause: error })
  }
  if (exec.signal.aborted) throw new Error(`git ${operation} was aborted`)
  const streams = collected(handle)
  if (outcome.signal !== null || outcome.exitCode === null) {
    throw new Error(`git ${operation} was terminated by ${outcome.signal ?? 'an unknown signal'}`)
  }
  const stdout = normalize(streams.stdout.text)
  const stderr = normalize(streams.stderr.text)
  if (outcome.exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || 'no diagnostic output'
    throw new Error(`git ${operation} failed with exit code ${outcome.exitCode}: ${detail}`)
  }
  return {
    operation,
    cwd,
    stdout,
    stderr,
    truncated: streams.stdout.lossy || streams.stderr.lossy,
  }
}

/**
 * Run the GitHub CLI with a fixed argv vector.
 *
 * Credential model: `gh` is invoked as an already-authenticated CLI. This
 * plugin never reads, stores, forwards, or logs a token — no GH_TOKEN or
 * GITHUB_TOKEN is injected here, and none is read from the environment. The
 * child inherits whatever ambient auth the user's own `gh` already has, so
 * revoking `gh auth` revokes this plugin's access too.
 *
 * Unlike the git tools, this one does reach the network (api.github.com via
 * gh). It stays read-only: only `pr diff` and `pr view` are ever spawned.
 */
async function runGh(
  ctx: Context,
  exec: ToolRunContext,
  operation: GitOperation,
  argv: readonly string[],
  config: ResolvedConfig,
): Promise<GitResult> {
  if (exec.signal.aborted) throw new Error(`gh ${operation} was aborted before start`)
  const cwd = exec.agent?.session.header.cwd?.trim() || process.cwd()
  let executable: string
  try {
    executable = await ctx.subprocess.resolveExecutable('gh', undefined, exec.signal)
  } catch (error: unknown) {
    throw new Error(
      'git-inspect: the GitHub CLI (`gh`) was not found on PATH. Install it from https://cli.github.com and run `gh auth login` to use the pull-request tools.',
      { cause: error },
    )
  }
  const handle = ctx.subprocess.spawn({
    argv: [executable, ...argv],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: config.maxOutputBytes },
      stderr: { maxBytes: config.stderrMaxBytes },
    },
    graceMs: config.graceMs,
    signal: exec.signal,
    env: {
      GIT_TERMINAL_PROMPT: '0',
      GH_PROMPT_DISABLED: '1',
      GH_PAGER: 'cat',
      GH_NO_UPDATE_NOTIFIER: '1',
      CLICOLOR: '0',
      NO_COLOR: '1',
    },
  })

  let outcome: { exitCode: number | null; signal: string | null }
  try {
    outcome = await handle.done
  } catch (error: unknown) {
    throw new Error(`gh ${operation} could not start: ${String(error)}`, { cause: error })
  }
  if (exec.signal.aborted) throw new Error(`gh ${operation} was aborted`)
  const streams = collected(handle)
  if (outcome.signal !== null || outcome.exitCode === null) {
    throw new Error(`gh ${operation} was terminated by ${outcome.signal ?? 'an unknown signal'}`)
  }
  const stdout = normalize(streams.stdout.text)
  const stderr = normalize(streams.stderr.text)
  if (outcome.exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || 'no diagnostic output'
    if (/auth|login|credential|unauthorized|HTTP 401/i.test(detail)) {
      throw new Error(`gh ${operation} failed: not authenticated. Run \`gh auth login\`. Detail: ${detail}`)
    }
    throw new Error(`gh ${operation} failed with exit code ${outcome.exitCode}: ${detail}`)
  }
  return {
    operation,
    cwd,
    stdout,
    stderr,
    truncated: streams.stdout.lossy || streams.stderr.lossy,
  }
}

export const BASE_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master'] as const

/**
 * Pick a base ref for a branch diff when the caller did not name one.
 *
 * Tries the conventional integration branches first, then the branch's own
 * upstream tracking ref. Every candidate is verified with `merge-base`, so a
 * ref that exists but shares no history is skipped rather than producing a
 * misleading whole-history diff.
 */
async function detectBase(ctx: Context, exec: ToolRunContext, config: ResolvedConfig): Promise<string> {
  for (const candidate of BASE_CANDIDATES) {
    try {
      await runGit(ctx, exec, 'merge_base', buildMergeBaseArgs(candidate, 'HEAD'), config)
      return candidate
    } catch {
      // Candidate missing or unrelated to HEAD — try the next one.
    }
  }
  try {
    const upstream = await runGit(ctx, exec, 'upstream', buildUpstreamArgs(), config)
    const ref = upstream.stdout.trim()
    if (ref.length > 0) return validateRef('upstream', ref)
  } catch {
    // No upstream configured.
  }
  throw new Error(
    'git-inspect: could not auto-detect a base branch (tried origin/main, origin/master, main, master, and the upstream tracking ref). Pass base explicitly, e.g. base: "develop".',
  )
}

function renderResult(value: Pick<GitResult, 'stdout' | 'stderr' | 'truncated'>): string {
  const body = value.stdout.trimEnd()
  const stderr = value.stderr.trim()
  const sections = [body]
  if (stderr.length > 0) sections.push(`stderr:\n${stderr}`)
  if (value.truncated) sections.push('Output was truncated at the configured limit; narrow the path or reduce the requested history.')
  return sections.filter(section => section.length > 0).join('\n\n') || '(no output)'
}

function callView(title: string, rawInput?: unknown): GenericCallView {
  return {
    card: 'generic',
    title,
    kind: 'read',
    ...(rawInput === undefined ? {} : { rawInput }),
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:git-inspect',
    order: 104,
    text: 'Use git_status, git_diff, git_diff_stat, git_log, git_show, git_refs, git_conflicts, git_blame, git_stash_list, and git_worktree_list for read-only repository inspection. For "what did this branch change" or pre-pull-request review, use git_diff_branch, which diffs from the merge base with the base branch rather than the raw branch tip. For a GitHub pull request, use git_diff_pr for the patch and git_pr_info for its metadata; both go through the authenticated GitHub CLI. These tools do not commit, push, reset, create stashes, switch worktrees, merge or comment on pull requests, or modify files.',
  })

  ctx.tools.register(defineTool({
    name: 'git_status',
    description: 'Show the current Git branch and working-tree status. Read-only; does not modify the repository.',
    parameters: {},
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: gitOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    execute: (args, exec) => runGit(ctx, exec, 'status', buildStatusArgs(), resolved),
    presentCall: () => callView('Git status'),
  }))

  ctx.tools.register(defineTool({
    name: 'git_diff_stat',
    description: 'Show a compact file-level summary of working-tree or staged changes. Read-only; use staged=true for the index.',
    parameters: {
      staged: { type: 'boolean', description: 'Show the staged index summary instead of the working-tree summary.' },
      path: { type: 'string', description: 'Limit the summary to one repository-relative path.' },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: gitOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    execute: (args, exec) => {
      const path = optionalPath(args.path)
      return runGit(ctx, exec, 'diff_stat', buildDiffStatArgs(args.staged === true, path), resolved)
    },
    presentCall: args => callView(args.staged === true ? 'Git staged diff stat' : 'Git diff stat', args.path),
  }))

  ctx.tools.register(defineTool({
    name: 'git_diff',
    description: 'Show a bounded, no-color Git diff for the working tree or index. Read-only; use staged=true for the index.',
    parameters: {
      staged: { type: 'boolean', description: 'Show the staged index diff instead of the working-tree diff.' },
      path: { type: 'string', description: 'Limit the diff to one repository-relative path.' },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: gitOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    execute: (args, exec) => {
      const path = optionalPath(args.path)
      return runGit(ctx, exec, 'diff', buildDiffArgs(args.staged === true, path), resolved)
    },
    presentCall: args => callView(args.staged === true ? 'Git staged diff' : 'Git diff', args.path),
  }))

  ctx.tools.register(defineTool({
    name: 'git_log',
    description: 'Show recent Git commits in compact one-line form. Read-only and capped by the plugin configuration.',
    parameters: {
      maxCount: { type: 'number', description: `Maximum commits to show, capped at ${resolved.maxLogCount}.` },
      path: { type: 'string', description: 'Limit history to one repository-relative path.' },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: gitOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    execute: (args, exec) => {
      const path = optionalPath(args.path)
      return runGit(ctx, exec, 'log', buildLogArgs(boundedLogCount(args.maxCount, resolved), path), resolved)
    },
    presentCall: args => callView(`Git log (${boundedLogCount(args.maxCount, resolved)} commits)`, args.path),
  }))

  ctx.tools.register(defineTool({
    name: 'git_show',
    description: 'Show one Git revision, optionally limited to a repository-relative path. Read-only and output-bounded.',
    parameters: {
      revision: { type: 'string', required: true, description: 'Commit, tag, or other Git revision to display.' },
      path: { type: 'string', description: 'Limit the revision output to one repository-relative path.' },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: gitOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    execute: (args, exec) => {
      const revision = requiredRevision(args.revision)
      const path = optionalPath(args.path)
      return runGit(ctx, exec, 'show', buildShowArgs(revision, path), resolved)
    },
    presentCall: args => callView(`Git show ${args.revision}`, args.path),
  }))

  ctx.tools.register(defineTool({
    name: 'git_diff_branch',
    description: 'Show what the current branch changed relative to a base branch, using the merge base (base...head) so commits that landed on the base afterwards are excluded. This is the "diff of my branch" / pre-pull-request review view. Read-only. When base is omitted the plugin auto-detects origin/main, origin/master, main, master, or the upstream tracking ref.',
    parameters: {
      base: { type: 'string', description: 'Base branch or ref to compare against, e.g. "main" or "origin/main". Auto-detected when omitted.' },
      head: { type: 'string', description: 'Head ref to compare; defaults to HEAD (the current branch).' },
      stat: { type: 'boolean', description: 'Show only the file-level +/- summary instead of the full patch.' },
      path: { type: 'string', description: 'Limit the diff to one repository-relative path.' },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: gitOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    execute: async (args, exec) => {
      const head = args.head === undefined ? 'HEAD' : validateRef('head', args.head)
      const base = args.base === undefined
        ? await detectBase(ctx, exec, resolved)
        : validateRef('base', args.base)
      const path = optionalPath(args.path)
      const result = await runGit(ctx, exec, 'diff_branch', buildDiffBranchArgs(base, head, args.stat === true, path), resolved)
      if (result.stdout.trim().length === 0) {
        return { ...result, stdout: `(no changes between ${base} and ${head})` }
      }
      return { ...result, stdout: `# diff ${base}...${head}\n\n${result.stdout}` }
    },
    presentCall: args => callView(`Git branch diff (${args.base ?? 'auto'}...${args.head ?? 'HEAD'})`, args.path),
  }))

  ctx.tools.register(defineTool({
    name: 'git_diff_pr',
    description: 'Show the diff of a GitHub pull request through the authenticated GitHub CLI (`gh`). Read-only: it never checks out, merges, comments on, or modifies the pull request. Requires `gh` on PATH and a completed `gh auth login`; this tool reads no token itself and reaches api.github.com only through gh.',
    parameters: {
      pr: { type: 'number', required: true, description: 'Pull-request number, e.g. 3920.' },
      repo: { type: 'string', description: 'Target repository as "owner/name". Defaults to the repository of the current working directory.' },
      nameOnly: { type: 'boolean', description: 'List only the changed file names instead of the full patch.' },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: gitOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    execute: async (args, exec) => {
      const pr = validatePrNumber(args.pr)
      const repo = validateRepo(args.repo)
      return runGh(ctx, exec, 'pr_diff', buildPrDiffArgs(pr, repo, args.nameOnly === true), resolved)
    },
    presentCall: args => callView(`GitHub PR #${args.pr} diff`, args.repo),
  }))

  ctx.tools.register(defineTool({
    name: 'git_pr_info',
    description: 'Show metadata for a GitHub pull request (title, state, draft flag, author, base and head branches, additions/deletions, changed-file count, mergeability, URL) through the authenticated GitHub CLI. Read-only; pairs with git_diff_pr for review context.',
    parameters: {
      pr: { type: 'number', required: true, description: 'Pull-request number.' },
      repo: { type: 'string', description: 'Target repository as "owner/name". Defaults to the repository of the current working directory.' },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: gitOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    execute: async (args, exec) => {
      const pr = validatePrNumber(args.pr)
      const repo = validateRepo(args.repo)
      return runGh(ctx, exec, 'pr_view', buildPrViewArgs(pr, repo), resolved)
    },
    presentCall: args => callView(`GitHub PR #${args.pr} info`, args.repo),
  }))

  ctx.tools.register(defineTool({
    name: 'git_refs',
    description: 'List recent local branches, remote-tracking branches, and tags. Read-only and capped by the plugin configuration.',
    parameters: {
      maxCount: { type: 'number', description: `Maximum refs to show, capped at ${resolved.maxLogCount}.` },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: gitOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    execute: (args, exec) => runGit(ctx, exec, 'refs', buildRefsArgs(boundedLogCount(args.maxCount, resolved)), resolved),
    presentCall: args => callView(`Git refs (${boundedLogCount(args.maxCount, resolved)} refs)`, args.maxCount),
  }))

  ctx.tools.register(defineTool({
    name: 'git_conflicts',
    description: 'List unresolved merge-conflict paths in the index. Read-only and optionally limited to one repository-relative path.',
    parameters: {
      path: { type: 'string', description: 'Limit conflict inspection to one repository-relative path.' },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: gitOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    execute: (args, exec) => {
      const path = optionalPath(args.path)
      return runGit(ctx, exec, 'conflicts', buildConflictsArgs(path), resolved)
    },
    presentCall: args => callView('Git conflicts', args.path),
  }))

  ctx.tools.register(defineTool({
    name: 'git_blame',
    description: 'Show bounded line attribution for one tracked file. Read-only; the requested line count is capped by plugin configuration.',
    parameters: {
      path: { type: 'string', required: true, description: 'Repository-relative tracked file to inspect.' },
      startLine: { type: 'number', description: 'First one-based line to inspect; defaults to 1.' },
      lineCount: { type: 'number', description: `Number of lines to inspect, capped at ${resolved.maxBlameLineCount}.` },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: gitOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    execute: (args, exec) => {
      const path = requiredPath(args.path)
      const range = boundedBlameRange(args.startLine, args.lineCount, resolved)
      return runGit(ctx, exec, 'blame', buildBlameArgs(path, range.startLine, range.lineCount), resolved)
    },
    presentCall: args => {
      const range = boundedBlameRange(args.startLine, args.lineCount, resolved)
      return callView(`Git blame ${range.startLine},+${range.lineCount}`, args.path)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_stash_list',
    description: 'List recent stash entries without creating, applying, or dropping a stash. Read-only and capped by plugin configuration.',
    parameters: {
      maxCount: { type: 'number', description: `Maximum stash entries to show, capped at ${resolved.maxLogCount}.` },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: gitOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    execute: (args, exec) => runGit(ctx, exec, 'stash_list', buildStashListArgs(boundedLogCount(args.maxCount, resolved)), resolved),
    presentCall: args => callView(`Git stashes (${boundedLogCount(args.maxCount, resolved)} entries)`, args.maxCount),
  }))

  ctx.tools.register(defineTool({
    name: 'git_worktree_list',
    description: 'List registered Git worktrees in stable porcelain format. Read-only; does not add, move, lock, or remove worktrees.',
    parameters: {},
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: gitOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    execute: (args, exec) => runGit(ctx, exec, 'worktree_list', buildWorktreeListArgs(), resolved),
    presentCall: () => callView('Git worktrees'),
  }))
}
