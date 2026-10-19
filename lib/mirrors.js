/**
 * GitHub mirror handling.
 *
 * Why this exists: on some networks a direct `git clone` from github.com runs at
 * 80–170 KB/s and then stalls completely while the TCP connection stays open.
 * The same repository through a mirror measured 2.4–3.7 MB/s. A mirror is a
 * `https://<proxy>/https://github.com/owner/repo.git` prefix that speaks the
 * normal git smart-HTTP protocol, so nothing else about the clone changes.
 */

/** Mirror prefixes tried in order. Each accepts `<prefix>/<full github url>`. */
export const DEFAULT_MIRRORS = [
  'https://ghfast.top',
  'https://gh-proxy.com',
  'https://ghproxy.net',
]

/** Repositories at or above this GitHub-reported size (KiB) start on a mirror. */
export const LARGE_REPOSITORY_KB = 120000

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
 * Build the mirrored clone URL.
 * @param prefix - Mirror prefix such as `https://ghfast.top`.
 * @param url - Original `https://github.com/...` URL.
 * @returns Mirrored URL.
 */
export function mirrorUrl(prefix, url) {
  return `${String(prefix).replace(/\/+$/u, '')}/${url}`
}

/**
 * Whether a string looks like a mirror prefix this module can use.
 * @param value - Candidate prefix.
 * @returns True for an http(s) URL.
 */
export function isMirrorPrefix(value) {
  return typeof value === 'string' && /^https?:\/\/[^/\s]+/u.test(value)
}

/**
 * Probe one mirror with the git smart-HTTP handshake.
 * @param prefix - Mirror prefix.
 * @param options - `repositoryUrl`, `signal`, `timeoutMs`.
 * @returns `{ prefix, ok, status, ms, error }`.
 */
export async function probeMirror(prefix, options) {
  const base = mirrorUrl(prefix, options.repositoryUrl).replace(/\/+$/u, '')
  const target = `${base}/info/refs?service=git-upload-pack`
  const started = Date.now()
  try {
    const response = await fetch(target, {
      redirect: 'follow',
      signal: withTimeout(options.signal, options.timeoutMs ?? 6000),
      headers: { 'user-agent': 'dsh-repo-scout' },
    })
    return { prefix, ok: response.ok, status: response.status, ms: Date.now() - started }
  } catch (error) {
    return {
      prefix,
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: String(error?.message ?? error).slice(0, 200),
    }
  }
}

/**
 * Probe every candidate mirror and pick the fastest reachable one.
 * @param options - `repositoryUrl`, `candidates`, `signal`, `timeoutMs`.
 * @returns `{ chosen, probes }` where `chosen` is a probe record or null.
 */
export async function pickMirror(options) {
  const candidates = Array.isArray(options.candidates) && options.candidates.length > 0
    ? options.candidates
    : DEFAULT_MIRRORS
  const probes = await Promise.all(candidates.map((prefix) => probeMirror(prefix, options)))
  const reachable = probes.filter((probe) => probe.ok).sort((left, right) => left.ms - right.ms)
  return { chosen: reachable[0] ?? null, probes }
}
