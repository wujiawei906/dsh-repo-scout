/**
 * GitHub token discovery.
 *
 * Order: environment variables, then the Harness home's token file. The token
 * file is read on every call, so writing a token there takes effect without
 * restarting anything.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Environment variables consulted in order. */
const ENV_NAMES = ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_ACCESS_TOKEN']

/**
 * Resolve the Harness home directory.
 * @returns `$DSH_HOME`, else `~/.dsh`.
 */
export function resolveDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

/**
 * Candidate token-file paths, most preferred first.
 * @returns Absolute paths.
 */
export function tokenFileCandidates() {
  const home = resolveDshHome()
  return [join(home, 'github-token'), join(home, 'github-token.txt'), join(home, '.github-token')]
}

/**
 * Extract a token from file text.
 *
 * Accepts a bare token on its own line, `GITHUB_TOKEN=...`, or `KEY=value`
 * under a comment header. Comments and blank lines are ignored.
 * @param text - File contents.
 * @returns Token text, or null.
 */
function parseTokenText(text) {
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/u.exec(trimmed)
    const value = (assignment === null ? trimmed : assignment[1]).trim().replace(/^["']|["']$/gu, '')
    if (value !== '') return value
  }
  return null
}

/**
 * Resolve the GitHub token to use.
 * @returns `{ token, source }`; both null when only anonymous access is available.
 */
export async function resolveGitHubAuth() {
  for (const name of ENV_NAMES) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return { token: value.trim(), source: `环境变量 ${name}` }
  }
  for (const file of tokenFileCandidates()) {
    try {
      const token = parseTokenText(await readFile(file, 'utf8'))
      if (token !== null) return { token, source: `令牌文件 ${file}` }
    } catch {
      // Missing or unreadable files simply declare no token.
    }
  }
  return { token: null, source: null }
}

/**
 * Hide a token inside arbitrary text.
 * @param text - Text that may contain the token.
 * @param token - Token to hide.
 * @returns Redacted text.
 */
export function redact(text, token) {
  if (typeof token !== 'string' || token === '') return String(text ?? '')
  return String(text ?? '').split(token).join('***')
}
