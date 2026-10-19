/** Candidate ranking for GitHub search results. */

/**
 * Split a GitHub query into plain keywords, dropping qualifiers such as
 * `language:` or `stars:>=`.
 * @param query - Full search text.
 * @returns Lowercased keywords of length greater than one.
 */
export function keywordsOf(query) {
  return String(query ?? '')
    .split(/\s+/u)
    .filter((word) => word !== '' && !/^[\w-]+:/u.test(word))
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 1)
}

/**
 * Count how many keywords appear in a candidate's name, description, or topics.
 * @param item - Raw GitHub repository item.
 * @param keywords - Keywords to look for.
 * @returns Number of distinct keywords found.
 */
function keywordHits(item, keywords) {
  const haystack = `${String(item?.name ?? '')} ${String(item?.description ?? '')} ${(item?.topics ?? []).join(' ')}`.toLowerCase()
  let hits = 0
  for (const word of keywords) if (haystack.includes(word)) hits += 1
  return hits
}

/**
 * Score one repository for the requested need.
 * @param item - Raw GitHub repository item.
 * @param context - `index`, `keywords`, `language`, `now`.
 * @returns Numeric score in the 0–100 range.
 */
function scoreItem(item, context) {
  const { index, keywords, language, now } = context
  const stars = Number(item?.stargazers_count ?? 0)
  const archived = item?.archived === true
  const fork = item?.fork === true
  const description = String(item?.description ?? '')
  let score = 45
  score -= index * 3.5
  score += Math.log10(stars + 1) * 7
  if (archived) score -= 60
  if (fork) score -= 10
  if (description === '') score -= 6
  const updated = Date.parse(String(item?.pushed_at ?? item?.updated_at ?? ''))
  if (Number.isFinite(updated)) {
    const ageDays = (now - updated) / 86400000
    if (ageDays <= 90) score += 10
    else if (ageDays <= 365) score += 5
    else if (ageDays > 730) score -= 6
  }
  if (language !== null && language !== undefined && language !== '' && String(item?.language ?? '').toLowerCase() === String(language).toLowerCase()) {
    score += 5
  }
  score += Math.min(keywordHits(item, keywords) * 4, 12)
  if (item?.license?.spdx_id !== undefined && item.license.spdx_id !== null) score += 2
  return Math.round(Math.max(0, score) * 10) / 10
}

/**
 * Convert a raw GitHub item into the plugin's candidate shape.
 * @param item - Raw GitHub repository item.
 * @param score - Computed score.
 * @returns Candidate record.
 */
function toCandidate(item, score) {
  return {
    fullName: String(item?.full_name ?? ''),
    url: String(item?.html_url ?? ''),
    cloneUrl: String(item?.clone_url ?? ''),
    description: String(item?.description ?? ''),
    stars: Number(item?.stargazers_count ?? 0),
    forks: Number(item?.forks_count ?? 0),
    language: item?.language === null || item?.language === undefined ? '' : String(item.language),
    topics: Array.isArray(item?.topics) ? item.topics.map(String).slice(0, 8) : [],
    license: typeof item?.license?.spdx_id === 'string' ? item.license.spdx_id : '',
    archived: item?.archived === true,
    fork: item?.fork === true,
    updatedAt: String(item?.pushed_at ?? item?.updated_at ?? ''),
    defaultBranch: String(item?.default_branch ?? ''),
    score,
  }
}

/**
 * Rank search results and mark the best usable match.
 * @param items - Raw GitHub items.
 * @param options - `query`, `language`, `now`.
 * @returns `{ candidates, recommended }` where `recommended` is a full name or null.
 */
export function rankCandidates(items, options) {
  const keywords = keywordsOf(options.query)
  const now = options.now ?? Date.now()
  const scored = items.map((item, index) => toCandidate(item, scoreItem(item, { index, keywords, language: options.language, now })))
  scored.sort((left, right) => right.score - left.score)
  const best = scored.find((entry) => !entry.archived && !entry.fork) ?? null
  return { candidates: scored, recommended: best === null ? null : best.fullName }
}
