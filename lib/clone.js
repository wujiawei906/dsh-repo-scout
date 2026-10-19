/** Repository address parsing, target checks, and `git clone` with proxy recovery. */
import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { runCommand } from './exec.js'
import { LARGE_REPOSITORY_KB, mirrorUrl, pickMirror } from './mirrors.js'

/**
 * Whether a path exists.
 * @param path - Absolute path.
 * @returns True when stat succeeds.
 */
async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Normalize a remote URL for comparison (ignore `.git`, protocol, and case).
 * @param value - Remote URL.
 * @returns Comparable form.
 */
function normalizeRemote(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^git@([^:]+):/u, 'https://$1/')
    .replace(/^ssh:\/\/git@([^/]+)\//u, 'https://$1/')
    .replace(/\.git$/u, '')
    .replace(/\/+$/u, '')
}

/**
 * Parse `owner/repo`, a GitHub URL, or any git remote into clone inputs.
 * @param input - Address from the caller.
 * @returns `{ owner, name, url, host }`.
 * @throws When the address cannot be understood.
 */
export function parseRepository(input) {
  const text = String(input ?? '').trim()
  if (text === '') throw new Error('仓库地址为空')

  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(text)
  if (shorthand !== null) {
    return { owner: shorthand[1], name: shorthand[2], url: `https://github.com/${shorthand[1]}/${shorthand[2]}.git`, host: 'github.com' }
  }

  const bareHost = /^(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org)\/(.+)$/u.exec(text)
  const remote = /^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/)([^/:]+)[/:](.+)$/u.exec(text)
  const match = remote ?? bareHost
  if (match === null) throw new Error(`无法解析仓库地址：${text}（支持 owner/repo、https、git@、ssh）`)
  const host = match[1]
  const path = match[2].replace(/\.git$/u, '').replace(/\/+$/u, '')
  const name = basename(path)
  if (name === '' || name === '/') throw new Error(`无法从地址中取出仓库名：${text}`)
  const url = remote === null ? `https://${host}/${path}.git` : (/^https?:/u.test(text) ? text : `https://${host}/${path}.git`)
  return { owner: path.split('/').slice(-2, -1)[0] ?? '', name, url, host }
}

/**
 * Inspect an existing target path before cloning.
 * @param target - Absolute target directory.
 * @returns `{ exists, isDirectory, isGitRepo, remote, empty }`.
 */
export async function inspectTarget(target) {
  if (!await pathExists(target)) return { exists: false, isDirectory: false, isGitRepo: false, remote: null, empty: true }
  const info = await lstat(target)
  if (!info.isDirectory()) return { exists: true, isDirectory: false, isGitRepo: false, remote: null, empty: false }
  const isGitRepo = await pathExists(join(target, '.git'))
  let remote = null
  if (isGitRepo) {
    const result = await runCommand('git', ['-C', target, 'config', '--get', 'remote.origin.url'], { timeoutMs: 15000 })
    if (result.code === 0) remote = result.stdout.trim()
  }
  const entries = await readdir(target).catch(() => [])
  return { exists: true, isDirectory: true, isGitRepo, remote, empty: entries.length === 0 }
}

/**
 * Read the proxy-holding git configuration keys.
 * @param signal - Abort signal.
 * @returns Configured keys such as `http.https://github.com.proxy`.
 */
async function proxyConfigKeys(signal) {
  const result = await runCommand('git', ['config', '--list', '--name-only'], { timeoutMs: 15000, signal })
  if (result.code !== 0) return []
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((key) => /^http[.\/]/iu.test(key) && /proxy$/iu.test(key))
}

/**
 * Build `-c key=` overrides that neutralize every proxy git could apply.
 *
 * The configured keys are asked for first, then the host-specific forms git's
 * URL matching would use for this remote are added unconditionally, so a
 * lookup that comes back empty still bypasses an unreachable proxy.
 * @param url - Remote URL being cloned.
 * @param signal - Abort signal.
 * @returns Argument fragments to prepend to the git command.
 */
async function proxyOverrides(url, signal) {
  const keys = new Set(['http.proxy', 'https.proxy'])
  for (const key of await proxyConfigKeys(signal)) keys.add(key)
  try {
    const parsed = new URL(url)
    keys.add(`http.${parsed.protocol}//${parsed.host}.proxy`)
    keys.add(`http.${parsed.host}.proxy`)
  } catch {
    // Non-URL remotes (local paths) need no host-specific keys.
  }
  return [...keys].flatMap((key) => ['-c', `${key}=`])
}

/** Slow-link guard: abort `git clone` when throughput falls below this and stays there. */
const LOW_SPEED = ['-c', 'http.lowSpeedLimit=20000', '-c', 'http.lowSpeedTime=40']

/**
 * Whether a failed clone looks like a proxy problem.
 * @param result - Result from `runCommand`.
 * @returns True for connection-refused-over-proxy style failures.
 */
function isProxyFailure(result) {
  return /proxy|Failed to connect|Could not connect|unable to access/iu.test(`${result.stderr}\n${result.message ?? ''}`)
}

/**
 * Whether a failed clone looks like an authentication or visibility problem.
 * @param result - Result from `runCommand`.
 * @returns True when a token retry could help.
 */
function isAuthFailure(result) {
  return /could not read Username|Authentication failed|Permission denied|terminal prompts disabled|Bad credentials|not found|repository .* not found|403|404/iu.test(`${result.stderr}\n${result.message ?? ''}`)
}

/**
 * Whether a failed clone looks like a stalled or unusably slow transfer.
 *
 * `http.lowSpeedLimit`/`lowSpeedTime` turn "connected but no data" into a normal
 * failure after the configured window, which is what makes mirror fallback
 * possible instead of waiting forever.
 * @param result - Result from `runCommand`.
 * @returns True for stall, timeout, or speed-guard failures.
 */
function isSlowFailure(result) {
  return result.timedOut === true
    || /low speed|Operation too slow|transfer closed|early EOF|unexpected disconnect|timed out/iu.test(`${result.stderr}\n${result.message ?? ''}`)
}

/**
 * Run one `git clone` with the proxy, token, and slow-link recoveries.
 * @param cloneUrl - URL to clone (direct or mirrored).
 * @param options - Clone options.
 * @returns `{ result, usedProxyFallback, authenticated }`.
 */
async function runClone(cloneUrl, options) {
  const { target, branch = null, depth = 1, keepProxy = false, token = null, signal, timeoutMs = 900000 } = options
  const args = ['clone']
  if (Number(depth) > 0) args.push('--depth', String(Math.floor(Number(depth))), '--single-branch')
  if (branch !== null && branch !== undefined && branch !== '') args.push('--branch', String(branch))
  args.push(cloneUrl, target)

  let result = await runCommand('git', [...LOW_SPEED, ...args], { timeoutMs, signal })
  let usedProxyFallback = false
  let authenticated = false
  let overrides = []

  if (result.failed && isProxyFailure(result) && keepProxy !== true) {
    usedProxyFallback = true
    overrides = await proxyOverrides(cloneUrl, signal)
    result = await runCommand('git', [...LOW_SPEED, ...overrides, ...args], { timeoutMs, signal })
  }

  if (result.failed && token !== null && isAuthFailure(result)) {
    authenticated = true
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
    const env = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: header,
      GIT_TERMINAL_PROMPT: '0',
    }
    result = await runCommand('git', [...LOW_SPEED, ...overrides, ...args], { timeoutMs, signal, env })
  }

  return { result, usedProxyFallback, authenticated }
}

/**
 * Clone a repository, recovering from a broken proxy, a stalled link, and a
 * private repository, in that order.
 *
 * Mirror policy, measured on this machine: a direct clone ran at 80–170 KB/s and
 * then stalled with the connection still open, while the same repository through
 * a mirror ran at 2.4–3.7 MB/s. So a repository whose GitHub-reported size is
 * large starts on a mirror, and any direct attempt that fails (or trips the
 * slow-link guard) falls back to a mirror once.
 * @param options - `url`, `target`, `branch`, `depth`, `keepProxy`, `token`, `mirror`, `sizeKB`, `signal`, `timeoutMs`.
 * @returns `{ result, usedProxyFallback, authenticated, usedMirror, mirrorPrefix, attempts }`.
 */
export async function cloneRepository(options) {
  const { url, target, mirror = 'auto', sizeKB = null, ...rest } = options
  const initial = await inspectTarget(target)
  if (initial.exists && initial.isDirectory === false) {
    return {
      result: { failed: true, code: 1, printable: 'git clone', stdout: '', stderr: '', message: '目标路径已存在且不是目录' },
      usedProxyFallback: false, authenticated: false, usedMirror: false, mirrorPrefix: null, attempts: [],
    }
  }

  const isGithub = /^https:\/\/github\.com\//iu.test(url)
  const enabled = mirror !== 'none' && isGithub
  const plan = []
  if (enabled) {
    if (sizeKB !== null && sizeKB >= LARGE_REPOSITORY_KB) plan.push('mirror', 'direct')
    else plan.push('direct', 'mirror')
  } else {
    plan.push('direct')
  }

  let mirrorPrefix = null
  let mirrorProbes = []
  let last = null
  let lastKind = null
  const attempts = []

  for (const kind of plan) {
    if (rest.signal?.aborted === true) break
    let cloneUrl = url
    if (kind === 'mirror') {
      if (mirrorPrefix === null) {
        const picked = await pickMirror({ repositoryUrl: url, signal: rest.signal })
        mirrorProbes = picked.probes
        mirrorPrefix = picked.chosen === null ? '' : picked.chosen.prefix
      }
      if (mirrorPrefix === '') {
        attempts.push({ kind: 'mirror', ok: false, detail: '所有镜像均不可达', slow: false })
        continue
      }
      cloneUrl = mirrorUrl(mirrorPrefix, url)
    }

    await mkdir(dirname(target), { recursive: true })
    const outcome = await runClone(cloneUrl, { target, ...rest })
    last = outcome
    lastKind = kind
    attempts.push({
      kind,
      url: cloneUrl,
      ok: !outcome.result.failed,
      detail: outcome.result.failed ? (outcome.result.message ?? `exit ${outcome.result.code}`) : 'ok',
      slow: isSlowFailure(outcome.result),
    })
    if (!outcome.result.failed) {
      return {
        ...outcome,
        usedMirror: kind === 'mirror',
        mirrorPrefix: kind === 'mirror' ? mirrorPrefix : null,
        mirrorProbes,
        attempts,
      }
    }
    if (!initial.exists) await rm(target, { recursive: true, force: true }).catch(() => undefined)
  }

  const effectiveMirror = lastKind === 'mirror' && typeof mirrorPrefix === 'string' && mirrorPrefix !== '' ? mirrorPrefix : null
  return {
    ...(last ?? { result: { failed: true, code: 1, printable: 'git clone', stdout: '', stderr: '', message: '没有可用的克隆通道' }, usedProxyFallback: false, authenticated: false }),
    usedMirror: effectiveMirror !== null,
    mirrorPrefix: effectiveMirror,
    mirrorProbes,
    attempts,
  }
}

/**
 * Suggest a follow-up environment check when the checkout declares dependencies.
 * @param target - Cloned directory.
 * @returns Note text, or null.
 */
export async function describeCheckout(target) {
  const entries = await readdir(target).catch(() => [])
  const hints = []
  if (entries.includes('package.json')) hints.push('Node.js 项目（package.json）')
  if (entries.includes('requirements.txt') || entries.includes('pyproject.toml')) hints.push('Python 项目')
  if (entries.includes('Dockerfile') || entries.includes('docker-compose.yml')) hints.push('含容器配置')
  if (entries.includes('README.md') || entries.includes('README')) hints.push('有 README')
  if (hints.length === 0) return null
  return `仓库内容：${hints.join('、')}`
}

/**
 * Resolve the clone destination for one repository.
 * @param options - `directory` (parent), `name` (override), `repository` (parsed).
 * @returns Absolute target path.
 */
export function resolveTarget(options) {
  const parent = resolve(options.directory)
  const name = options.name === undefined || options.name === null || options.name === '' ? options.repository.name : String(options.name)
  if (!/^[A-Za-z0-9_.-]+$/u.test(name)) throw new Error(`非法的目标目录名：${name}`)
  return join(parent, name)
}

/**
 * Whether an existing checkout already points at the requested remote.
 * @param remote - Configured `origin` URL.
 * @param url - Requested clone URL.
 * @returns True when both addresses denote the same repository.
 */
export function matchesRemote(remote, url) {
  return normalizeRemote(remote) === normalizeRemote(url)
}
