/** Minimal GitHub REST client: repository search, account state, rate-limit handling. */
import { resolveGitHubAuth } from './auth.js'

/** API base. */
const API_BASE = 'https://api.github.com'

/** Longest a rate-limited request waits before giving up, in milliseconds. */
const MAX_RATE_LIMIT_WAIT_MS = 15000

/**
 * Combine an optional caller signal with a timeout.
 * @param signal - Caller abort signal.
 * @param timeoutMs - Deadline for this request.
 * @returns A signal that aborts on either condition.
 */
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return timeout
  return AbortSignal.any([signal, timeout])
}

/**
 * Build request headers for an optional token.
 * @param token - Token text, or null.
 * @returns Header object.
 */
function headersFor(token) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-repo-scout',
    'x-github-api-version': '2022-11-28',
  }
  if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`
  return headers
}

/**
 * Classify a token by its prefix, for display only.
 * @param token - Token text.
 * @returns Short human label.
 */
function tokenKind(token) {
  if (typeof token !== 'string' || token === '') return '匿名'
  if (token.startsWith('github_pat_')) return 'fine-grained PAT'
  if (token.startsWith('ghp_')) return 'classic PAT'
  if (token.startsWith('gho_') || token.startsWith('ghu_') || token.startsWith('ghs_') || token.startsWith('ghr_')) return 'GitHub OAuth/App 令牌'
  return '自定义令牌'
}

/**
 * Turn a rate-limit or API failure into an actionable message.
 * @param status - HTTP status.
 * @param body - Parsed error body, when present.
 * @param headers - Response headers.
 * @param tokenSource - Where the token came from, for the hint.
 * @returns Human-readable failure reason.
 */
function describeFailure(status, body, headers, tokenSource) {
  const remaining = headers.get('x-ratelimit-remaining')
  const reset = headers.get('x-ratelimit-reset')
  const resetText = reset === null ? '' : `，额度约在 ${new Date(Number(reset) * 1000).toLocaleString('zh-CN')} 重置`
  if (status === 401) {
    return `GitHub 拒绝了令牌（HTTP 401）：${tokenSource === null ? '当前是匿名访问' : `令牌来自${tokenSource}，可能已过期或被撤销`}`
  }
  if (status === 403 || status === 429) {
    if (remaining === '0') {
      return `GitHub 搜索额度已用尽${resetText}。${tokenSource === null ? '配置一个 token 可把上限提到每分钟 30 次。' : '令牌的额度也用完了，稍后再试。'}`
    }
    return `GitHub 拒绝了这次请求（HTTP ${status}${body?.message === undefined ? '' : `：${body.message}`}）${resetText}`
  }
  if (status === 422) return `GitHub 无法理解这组搜索条件${body?.message === undefined ? '' : `：${body.message}`}`
  return `GitHub 请求失败：HTTP ${status}${body?.message === undefined ? '' : `：${body.message}`}`
}

/**
 * Wait for a short rate-limit window, when one is imminent.
 * @param headers - Response headers.
 * @returns Milliseconds to wait, or 0.
 */
function rateLimitWait(headers) {
  const retryAfter = Number(headers.get('retry-after') ?? '0')
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, MAX_RATE_LIMIT_WAIT_MS)
  const reset = Number(headers.get('x-ratelimit-reset') ?? '0')
  if (!Number.isFinite(reset) || reset <= 0) return 0
  const wait = reset * 1000 - Date.now()
  return wait > 0 && wait <= MAX_RATE_LIMIT_WAIT_MS ? wait : 0
}

/**
 * Pause for a bounded period.
 * @param ms - Milliseconds.
 * @returns Resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Search GitHub repositories.
 * @param options - `query`, `language`, `minStars`, `sort`, `includeArchived`, `includeForks`, `limit`, `signal`, `timeoutMs`.
 * @returns `{ totalCount, incomplete, items, rateLimit, authenticated, authSource, computedQuery }`.
 * @throws When GitHub rejects the request or the network fails.
 */
export async function searchRepositories(options) {
  const {
    query,
    language = null,
    minStars = 0,
    sort = 'best-match',
    includeArchived = false,
    includeForks = false,
    limit = 10,
    signal,
    timeoutMs = 25000,
  } = options

  const terms = [String(query ?? '').trim()]
  if (terms[0] === '') throw new Error('搜索关键词为空')
  if (language !== null && language !== undefined && language !== '') terms.push(`language:${language}`)
  if (Number(minStars) > 0) terms.push(`stars:>=${Math.floor(Number(minStars))}`)
  if (includeArchived !== true && !/archived:/u.test(terms[0])) terms.push('archived:false')
  if (includeForks !== true && !/fork:/u.test(terms[0])) terms.push('fork:false')

  const params = new URLSearchParams({
    q: terms.join(' '),
    per_page: String(Math.min(Math.max(1, Math.floor(Number(limit) || 10)), 100)),
  })
  if (sort !== 'best-match') {
    params.set('sort', String(sort))
    params.set('order', 'desc')
  }

  const auth = await resolveGitHubAuth()
  const url = `${API_BASE}/search/repositories?${params.toString()}`
  const request = () => fetch(url, { headers: headersFor(auth.token), signal: withTimeout(signal, timeoutMs), redirect: 'follow' })

  let response
  try {
    response = await request()
    if (!response.ok && (response.status === 403 || response.status === 429)) {
      const wait = rateLimitWait(response.headers)
      if (wait > 0) {
        await sleep(wait + 300)
        response = await request()
      }
    }
  } catch (error) {
    throw new Error(`无法连接 GitHub API：${String(error?.message ?? error)}（检查网络或代理设置）`)
  }

  if (!response.ok) {
    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    throw new Error(describeFailure(response.status, body, response.headers, auth.source))
  }

  const payload = await response.json()
  return {
    totalCount: Number(payload?.total_count ?? 0),
    incomplete: payload?.incomplete_results === true,
    items: Array.isArray(payload?.items) ? payload.items : [],
    rateLimit: {
      remaining: response.headers.get('x-ratelimit-remaining') ?? '',
      limit: response.headers.get('x-ratelimit-limit') ?? '',
      reset: response.headers.get('x-ratelimit-reset') ?? '',
    },
    authenticated: auth.token !== null,
    authSource: auth.source,
    computedQuery: terms.join(' '),
  }
}

/**
 * Read the account state and search allowance for the configured token.
 * @param options - `signal` and `timeoutMs`.
 * @returns `{ authenticated, source, tokenKind, login, name, scopes, searchRemaining, searchLimit, resetAt, problem }`.
 */
export async function accountStatus(options = {}) {
  const auth = await resolveGitHubAuth()
  const status = {
    authenticated: auth.token !== null,
    source: auth.source ?? '未配置（匿名访问）',
    tokenKind: tokenKind(auth.token),
    login: '',
    name: '',
    scopes: '',
    searchRemaining: '',
    searchLimit: '',
    resetAt: '',
    problem: '',
  }

  const rate = await fetch(`${API_BASE}/rate_limit`, {
    headers: headersFor(auth.token),
    signal: withTimeout(options.signal, options.timeoutMs ?? 20000),
  }).catch(() => null)
  if (rate !== null && rate.ok) {
    try {
      const body = await rate.json()
      status.searchRemaining = String(body?.resources?.search?.remaining ?? '')
      status.searchLimit = String(body?.resources?.search?.limit ?? '')
      const reset = Number(body?.resources?.search?.reset ?? 0)
      status.resetAt = reset > 0 ? new Date(reset * 1000).toISOString() : ''
    } catch {
      // A malformed body only costs the display fields.
    }
  }

  if (auth.token === null) {
    status.problem = '尚未配置 token，只能匿名搜索（每分钟 10 次，按出口 IP 共享）'
    return status
  }

  const user = await fetch(`${API_BASE}/user`, {
    headers: headersFor(auth.token),
    signal: withTimeout(options.signal, options.timeoutMs ?? 20000),
  }).catch(() => null)
  if (user === null) {
    status.problem = '无法连接 GitHub API，token 有效性未能验证'
    return status
  }
  if (user.status === 401) {
    status.problem = `令牌无效或已过期（来自 ${auth.source}）`
    return status
  }
  if (!user.ok) {
    status.problem = `校验令牌时 GitHub 返回 HTTP ${user.status}`
    return status
  }
  const profile = await user.json().catch(() => null)
  status.login = String(profile?.login ?? '')
  status.name = String(profile?.name ?? '')
  status.scopes = user.headers.get('x-oauth-scopes') ?? ''
  return status
}

/**
 * Read a repository's GitHub-reported size (compressed, in KiB).
 *
 * Used to decide whether a clone should start on a mirror: repositories whose
 * reported size is large are exactly where a slow direct link turns into a
 * multi-minute stall.
 * @param owner - Repository owner.
 * @param repo - Repository name.
 * @param options - `signal`.
 * @returns Size in KiB, or null when unknown.
 */
export async function repositorySizeKB(owner, repo, options = {}) {
  const auth = await resolveGitHubAuth()
  try {
    const response = await fetch(`${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: headersFor(auth.token),
      signal: withTimeout(options.signal, 15000),
    })
    if (!response.ok) return null
    const body = await response.json()
    const size = Number(body?.size)
    return Number.isFinite(size) && size > 0 ? size : null
  } catch {
    return null
  }
}
