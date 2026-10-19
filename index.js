/**
 * Repo Scout — a Host bundle for the current Harness profile.
 *
 * Two tools turn a described need into a local checkout:
 *   search_github_repositories  — GitHub search, ranked and scored
 *   clone_github_repository     — `git clone` with target checks and automatic
 *                                 recovery from a broken `git` proxy configuration
 */
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { accountStatus, repositorySizeKB, searchRepositories } from './lib/github.js'
import { resolveGitHubAuth } from './lib/auth.js'
import { rankCandidates } from './lib/rank.js'
import { cloneRepository, describeCheckout, inspectTarget, matchesRemote, parseRepository, resolveTarget } from './lib/clone.js'

/** Cordis plugin identity. */
export const name = 'repo-scout'
/** Registry these tools register into. */
export const inject = ['tools']

/**
 * Append one activation line to `$DSH_HOME/repo-scout.log`.
 *
 * The profile loader keeps its own diagnostics; this file is the quickest way to
 * confirm that this bundle really mounted. A write failure never breaks activation.
 */
function noteActivation() {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    appendFileSync(join(home, 'repo-scout.log'), `${new Date().toISOString()} repo-scout activated (pid ${process.pid})\n`, 'utf8')
  } catch {
    // Diagnostics only.
  }
}

/** Longest rendered report handed back to the model. */
const MAX_REPORT_CHARS = 7000

/**
 * Resolve the workspace directory for default clone targets.
 * @param exec - Tool execution context.
 * @returns Absolute directory.
 */
function workspaceOf(exec) {
  const workspace = exec?.agent?.session?.header?.cwd
  if (typeof workspace === 'string' && workspace.trim() !== '') return workspace
  return process.cwd()
}

/**
 * Format a star count for compact display.
 * @param value - Star count.
 * @returns Short text such as `12.3k`.
 */
function stars(value) {
  const count = Number(value) || 0
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
}

/**
 * Render search results.
 * @param value - Tool output value.
 * @returns Bounded report text.
 */
function renderSearch(value) {
  const recommended = value.recommended ?? null
  const lines = []
  lines.push(`GitHub 搜索：${value.query}`)
  lines.push(`共 ${value.totalCount} 个结果${value.incomplete === true ? '（结果不完整）' : ''}，以下是得分最高的 ${value.candidates.length} 个${recommended === null ? '' : `；推荐 ${recommended}`}`)
  const authText = value.authenticated === true
    ? `已使用 token（${value.authSource}）`
    : '匿名（每分钟 10 次，按出口 IP 共享；配置 token 可提高到 30 次/分钟）'
  lines.push(`认证：${authText}${value.rateLimit.remaining === '' ? '' : `；搜索额度剩余 ${value.rateLimit.remaining}${value.rateLimit.limit === '' ? '' : `/${value.rateLimit.limit}`}`}`)
  lines.push('')
  value.candidates.forEach((entry, index) => {
    const flags = [entry.archived ? '已归档' : null, entry.fork ? 'fork' : null, entry.license === '' ? null : entry.license].filter((flag) => flag !== null)
    lines.push(`${index + 1}. ${entry.fullName}　★${stars(entry.stars)}　${entry.language === '' ? '未知语言' : entry.language}　得分 ${entry.score}${flags.length === 0 ? '' : `　[${flags.join(' / ')}]`}`)
    if (entry.description !== '') lines.push(`   ${entry.description}`)
    lines.push(`   ${entry.url}${entry.updatedAt === '' ? '' : `　最近更新 ${entry.updatedAt.slice(0, 10)}`}`)
  })
  if (value.candidates.length === 0) lines.push('没有匹配的仓库；换更通用的关键词、放宽 minStars，或让语言条件为空。')
  const text = lines.join('\n')
  return text.length <= MAX_REPORT_CHARS ? text : `${text.slice(0, MAX_REPORT_CHARS)}\n…（已截断）`
}

/**
 * Render a clone outcome.
 * @param value - Tool output value.
 * @returns Report text.
 */
function renderClone(value) {
  const label = { cloned: '已克隆', exists: '已存在', failed: '失败' }[value.status] ?? value.status
  const lines = [
    `${label}：${value.repository} → ${value.path}`,
    `分支：${value.branch === '' ? '默认分支' : value.branch}${value.authenticated ? '；使用 token 认证' : ''}${value.usedProxyFallback ? '；首次失败后已绕过失效的 git 代理重试' : ''}${(value.mirror ?? '') === '' ? '' : `；经镜像 ${value.mirror}`}`,
    `命令：${value.command}`,
  ]
  if (value.output !== '') lines.push(`输出：${value.output.replace(/\n/gu, '\n    ')}`)
  for (const note of value.notes) lines.push(`说明：${note}`)
  return lines.join('\n')
}

/**
 * Render the GitHub credential status.
 * @param value - Tool output value.
 * @returns Report text.
 */
function renderAccount(value) {
  const lines = []
  lines.push(`GitHub 认证：${value.authenticated === true ? '已配置' : '未配置'}`)
  lines.push(`令牌来源：${value.source}`)
  lines.push(`令牌类型：${value.tokenKind}`)
  if (value.login !== '') lines.push(`账号：${value.login}${value.name === '' ? '' : `（${value.name}）`}`)
  if (value.scopes !== '') lines.push(`令牌权限：${value.scopes}`)
  if (value.searchLimit !== '') {
    const reset = value.resetAt === '' ? '' : new Date(value.resetAt).toLocaleString('zh-CN')
    lines.push(`搜索额度：剩余 ${value.searchRemaining}/${value.searchLimit}${reset === '' ? '' : `，重置于 ${reset}`}`)
  }
  if (value.problem !== '') lines.push(`注意：${value.problem}`)
  return lines.join('\n')
}

/** Output schema fragment shared by one candidate. */
const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fullName: { type: 'string', required: true },
    url: { type: 'string', required: true },
    cloneUrl: { type: 'string', required: true },
    description: { type: 'string', required: true },
    stars: { type: 'integer', required: true },
    forks: { type: 'integer', required: true },
    language: { type: 'string', required: true },
    topics: { type: 'array', required: true, items: { type: 'string' } },
    license: { type: 'string', required: true },
    archived: { type: 'boolean', required: true },
    fork: { type: 'boolean', required: true },
    updatedAt: { type: 'string', required: true },
    defaultBranch: { type: 'string', required: true },
    score: { type: 'number', required: true },
  },
}

/**
 * Register the two repository tools.
 * @param ctx - Plugin context providing the tool registry.
 */
export function apply(ctx) {
  noteActivation()
  ctx.tools.register(defineTool({
    name: 'search_github_repositories',
    description: [
      '在 GitHub 上检索开源仓库并给出排序后的候选列表。',
      '把用户描述的需求提炼成 2–6 个英文/中文关键词作为 query（GitHub 按关键词匹配，不理解整句话），可用 language 限定语言、minStars 过滤低星项目、sort 改排序；默认已排除归档仓库与 fork。',
      '返回每个候选的 fullName、stars、语言、最近更新、许可证、得分 score，以及 recommended 字段（建议优先克隆的仓库）。',
      '找到合适候选后调用 clone_github_repository（用 fullName 即可）。',
    ].join(''),
    parameters: {
      query: { type: 'string', required: true, description: '搜索关键词，如 "markdown editor"、"语音转文字 asr"；也支持 language:/stars: 等 GitHub 限定符。' },
      language: { type: 'string', description: '只看某种语言，如 TypeScript、Python、Rust。' },
      minStars: { type: 'integer', description: '最少 star 数，如 100；默认 0。' },
      sort: { type: 'string', description: 'best-match（默认）/ stars / forks / updated。', enum: ['best-match', 'stars', 'forks', 'updated'] },
      limit: { type: 'integer', description: '返回候选数量，默认 10，最大 30。' },
      includeArchived: { type: 'boolean', description: '是否包含已归档仓库，默认 false。' },
      includeForks: { type: 'boolean', description: '是否包含 fork，默认 false。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          totalCount: { type: 'integer', required: true },
          authenticated: { type: 'boolean', required: true },
          authSource: { type: 'string', required: true },
          incomplete: { type: 'boolean', required: true },
          candidates: { type: 'array', required: true, items: CANDIDATE_SCHEMA },
          recommended: { type: 'string' },
          rateLimit: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              remaining: { type: 'string' },
              limit: { type: 'string' },
              reset: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSearch(value) }],
    },
    execute: async (args, exec) => {
      const result = await searchRepositories({
        query: args.query,
        language: args.language ?? null,
        minStars: args.minStars ?? 0,
        sort: args.sort ?? 'best-match',
        limit: Math.min(Math.max(1, args.limit ?? 10), 30),
        includeArchived: args.includeArchived === true,
        includeForks: args.includeForks === true,
        signal: exec?.signal,
      })
      const ranked = rankCandidates(result.items, { query: result.computedQuery, language: args.language ?? null })
      return {
        query: result.computedQuery,
        totalCount: result.totalCount,
        authenticated: result.authenticated,
        authSource: result.authSource ?? '',
        incomplete: result.incomplete,
        candidates: ranked.candidates,
        ...(ranked.recommended === null ? {} : { recommended: ranked.recommended }),
        rateLimit: {
          remaining: result.rateLimit.remaining ?? '',
          limit: result.rateLimit.limit ?? '',
          reset: result.rateLimit.reset ?? '',
        },
      }
    },
    isConcurrencySafe: () => true,
    timeoutMs: 120000,
    presentCall: () => ({ card: 'generic', title: '检索 GitHub 仓库', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'clone_github_repository',
    description: [
      '把一个 GitHub 仓库克隆到本地。repository 可写 owner/repo（如 "mdx-editor/editor"）或完整 URL。',
      '默认克隆到当前工作区的 repos/<仓库名>，浅克隆（--depth 1）以加快速度；可指定 directory、name、branch、depth=0 取完整历史。',
      '若目标目录已是该仓库的检出，直接返回 exists，不会覆盖；目标非空且不是该仓库时拒绝执行。',
      '当本机的 git 代理配置失效导致连接失败时，会自动绕过代理重试一次；若配置了 GitHub token，遇到认证失败或私有仓库时还会用 token 自动重试（token 通过 git 配置环境传递，不出现在命令行）。',
      '大仓库会自动走 GitHub 镜像（mirror=auto：仓库超过约 120 MB 时优先镜像；直连失败或传输停滞时回退镜像），并用 git 的低速看门狗把"连上但没数据"变成可重试的失败。',
      '克隆后不会安装依赖或执行仓库里的任何代码。',
    ].join(''),
    parameters: {
      repository: { type: 'string', required: true, description: 'owner/repo 或完整仓库地址（https/git@/ssh）。' },
      directory: { type: 'string', description: '克隆到的父目录，默认 <当前工作区>/repos。' },
      name: { type: 'string', description: '目标目录名，默认取仓库名。' },
      branch: { type: 'string', description: '只克隆某个分支/标签。' },
      depth: { type: 'integer', description: '浅克隆深度，默认 1；0 表示完整历史。' },
      keepProxy: { type: 'boolean', description: '为 true 时不做代理绕过重试（当你确认代理可用却仍失败时用）。' },
      mirror: { type: 'string', description: 'auto（默认，按需使用镜像）/ none（只直连）/ 或以 https:// 开头的镜像前缀（强制走该镜像，如 https://ghfast.top）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repository: { type: 'string', required: true },
          url: { type: 'string', required: true },
          path: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['cloned', 'exists', 'failed'] },
          branch: { type: 'string', required: true },
          command: { type: 'string', required: true },
          output: { type: 'string', required: true },
          usedProxyFallback: { type: 'boolean', required: true },
          authenticated: { type: 'boolean', required: true },
          mirror: { type: 'string', required: true },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderClone(value) }],
    },
    execute: async (args, exec) => {
      const parsed = parseRepository(args.repository)
      const directory = args.directory === undefined || args.directory === ''
        ? resolve(workspaceOf(exec), 'repos')
        : resolve(args.directory)
      const target = resolveTarget({ directory, name: args.name ?? null, repository: parsed })
      const notes = []
      const base = { repository: `${parsed.owner}/${parsed.name}`, url: parsed.url, path: target }

      const existing = await inspectTarget(target)
      if (existing.exists && existing.isDirectory) {
        if (existing.isGitRepo && matchesRemote(existing.remote, parsed.url)) {
          return { ...base, status: 'exists', branch: args.branch ?? '', command: 'git clone（未执行）', output: '', usedProxyFallback: false, authenticated: false, mirror: '', notes: [`目标目录已是该仓库的检出：${existing.remote}`] }
        }
        if (existing.empty === false) {
          return { ...base, status: 'failed', branch: args.branch ?? '', command: 'git clone（未执行）', output: '', usedProxyFallback: false, authenticated: false, mirror: '', notes: ['目标目录已存在且非空，且不是该仓库；为免覆盖已有数据，已拒绝克隆'] }
        }
        notes.push('目标目录已存在但为空，直接在其中检出')
      }

      const auth = await resolveGitHubAuth()
      const sizeKB = parsed.host === 'github.com'
        ? await repositorySizeKB(parsed.owner, parsed.name, { signal: exec?.signal })
        : null
      const mirrorMode = typeof args.mirror === 'string' && args.mirror !== '' ? args.mirror : 'auto'
      const { result, usedProxyFallback, authenticated, usedMirror, mirrorPrefix, attempts } = await cloneRepository({
        url: parsed.url,
        target,
        branch: args.branch ?? null,
        depth: args.depth ?? 1,
        keepProxy: args.keepProxy === true,
        token: auth.token,
        mirror: mirrorMode,
        sizeKB,
        signal: exec?.signal,
      })
      if (usedProxyFallback) notes.push('首次克隆因代理连接失败，已用 -c http.proxy= 等覆盖参数直连重试')
      if (authenticated) notes.push(`首次克隆失败后已用 token 认证重试（令牌来自${auth.source}）`)
      if (usedMirror) notes.push(`经镜像 ${mirrorPrefix} 克隆（直连在中慢速链路上会长时间停滞）`)
      if (sizeKB !== null && sizeKB >= 120000 && !usedMirror) notes.push(`仓库较大（GitHub 报告约 ${Math.round(sizeKB / 1024)} MB），但镜像未启用或不可达`)
      if (!usedMirror && attempts.length > 1) notes.push(`尝试过 ${attempts.length} 条通道：${attempts.map((entry) => entry.kind).join(' → ')}`)
      const output = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-6).join('\n').slice(0, 1500)

      if (result.failed) {
        if (result.aborted === true) notes.push('克隆已取消：已终止整棵 git 进程树并清理半成品目录')
        else if (result.timedOut === true) notes.push('克隆超时：仓库较大或链路较慢，可改用镜像地址或后台任务重试')
        const hint = /proxy|Failed to connect|Could not connect/iu.test(`${result.stderr}\n${result.message ?? ''}`)
          ? '网络或代理仍不通：检查代理设置，或在能访问 GitHub 的网络环境下重试'
          : (auth.token === null
              ? '克隆失败：确认仓库名正确；若是私有仓库，请配置 GitHub token 后重试'
              : '克隆失败：确认仓库名正确、当前 token 有该仓库的读取权限')
        notes.push(hint)
        return { ...base, status: 'failed', branch: args.branch ?? '', command: result.printable, output, usedProxyFallback, authenticated, mirror: usedMirror ? mirrorPrefix : '', notes }
      }

      const hint = await describeCheckout(target)
      if (hint !== null) notes.push(hint)
      notes.push('未安装依赖、未执行仓库中的任何代码；需要的话可以用环境检查工具再看一遍')
      return { ...base, status: 'cloned', branch: args.branch ?? '', command: result.printable, output, usedProxyFallback, authenticated, mirror: usedMirror ? mirrorPrefix : '', notes }
    },
    isConcurrencySafe: () => false,
    timeoutMs: 1800000,
    presentCall: () => ({ card: 'generic', title: '克隆 GitHub 仓库', kind: 'write' }),
  }))

  ctx.tools.register(defineTool({
    name: 'github_account_status',
    description: [
      '检查当前 GitHub 访问状态：token 是否配置、来自哪里、是否有效、对应哪个账号、搜索额度还剩多少。',
      '刚配置或更换 token、搜索报 401/403/额度用尽、需要确认能否访问私有仓库时，先调用它。',
      'token 的读取顺序是环境变量 GITHUB_TOKEN / GH_TOKEN / GITHUB_ACCESS_TOKEN，然后是 Harness 主目录下的 github-token 文件。',
    ].join(''),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          authenticated: { type: 'boolean', required: true },
          source: { type: 'string', required: true },
          tokenKind: { type: 'string', required: true },
          login: { type: 'string', required: true },
          name: { type: 'string', required: true },
          scopes: { type: 'string', required: true },
          searchRemaining: { type: 'string', required: true },
          searchLimit: { type: 'string', required: true },
          resetAt: { type: 'string', required: true },
          problem: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderAccount(value) }],
    },
    execute: async (_args, exec) => accountStatus({ signal: exec?.signal }),
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    presentCall: () => ({ card: 'generic', title: '检查 GitHub 账号状态', kind: 'read' }),
  }))
}
