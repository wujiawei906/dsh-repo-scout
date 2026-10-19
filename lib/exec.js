/**
 * Subprocess helper: bounded output, cancellable, never throwing.
 *
 * Uses `spawn` instead of `execFile` so the child keeps a pid the abort path can
 * hand to the OS process-tree killer. `git` spawns `git-remote-https` and
 * `index-pack`, which outlive a plain `kill()` of the direct child; those orphans
 * keep pack and lock files open, so the next attempt cannot even remove the
 * directory.
 */
import { spawn } from 'node:child_process'

/** Longest captured stdout/stderr tail kept per command. */
const MAX_OUTPUT_CHARS = 8000

/**
 * Keep the tail of captured text.
 * @param value - Raw captured stream.
 * @returns Bounded text.
 */
function bound(value) {
  const text = String(value ?? '')
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return `…[truncated ${text.length - MAX_OUTPUT_CHARS} chars]…\n${text.slice(-MAX_OUTPUT_CHARS)}`
}

/** Whether a command name needs a Windows command shell to resolve (.cmd/.bat shims). */
function needsShell(command) {
  if (process.platform !== 'win32') return false
  return !/[\\/]/u.test(command)
}

/**
 * Terminate a child process together with everything it spawned.
 * @param child - Spawned child process.
 */
function killTree(child) {
  if (child === null || child === undefined || child.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' })
        .on('error', () => undefined)
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    // Fall through to the direct kill below.
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // Already gone.
  }
}

/**
 * Run one program and capture its result without ever rejecting.
 * @param command - Executable name or absolute path.
 * @param args - Argument vector.
 * @param options - `cwd`, `env` additions, `timeoutMs`, and an abort `signal`.
 * @returns `{ command, args, printable, code, stdout, stderr, failed, timedOut, aborted, missing, message }`.
 */
export function runCommand(command, args = [], options = {}) {
  const { cwd, env, timeoutMs = 600000, signal } = options
  const useShell = needsShell(command)
  const file = useShell ? (process.env.ComSpec ?? 'cmd.exe') : command
  const argv = useShell ? ['/d', '/s', '/c', command, ...args] : args
  const printable = [command, ...args].map((part) => (/\s/u.test(part) ? `"${part}"` : part)).join(' ')

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, argv, {
        cwd,
        env: env === undefined ? process.env : { ...process.env, ...env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        command, args, printable, code: 1, stdout: '', stderr: '',
        failed: true, timedOut: false, aborted: false, missing: false,
        message: String(error?.message ?? error).slice(0, 400),
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null

    const finish = (code, extra = {}) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      resolve({
        command, args, printable, code,
        stdout: bound(stdout),
        stderr: bound(stderr),
        failed: code !== 0,
        timedOut: extra.timedOut === true,
        aborted: extra.aborted === true,
        missing: extra.missing === true,
        message: extra.message,
      })
    }

    const onAbort = () => {
      killTree(child)
      finish(1, { aborted: true, message: '已取消' })
    }

    if (signal !== undefined) {
      if (signal.aborted) {
        killTree(child)
        finish(1, { aborted: true, message: '已取消' })
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    timer = setTimeout(() => {
      killTree(child)
      finish(1, { timedOut: true, message: `超时（${timeoutMs} ms）` })
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => {
      const missing = error?.code === 'ENOENT' || error?.code === 'EINVAL'
      finish(1, { missing, message: String(error?.message ?? error).slice(0, 400) })
    })
    child.on('close', (code) => finish(code === null ? 1 : code))
  })
}
