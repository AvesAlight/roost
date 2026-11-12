import * as fs from 'node:fs'
import { writeFile, readFile } from 'node:fs/promises'

// Atomic exclusive-create primitives for two lock flavors used in this project:
//
// Sentinel locks (O_EXCL-create based, shell-only) — the lock has no content;
// existence == "held". Used when you just need mutual exclusion with no data to
// store. The shell claim is a builtin exclusive create (`set -C; : > file`), not
// `mkdir`: uutils coreutils (Ubuntu 25.10+) lets two concurrent mkdir calls on
// one path both succeed. See bin/_lock-lib.sh for the shell API.
//
// Data-bearing locks (O_EXCL writeFile, this module) — the lock file carries
// content (a PID record, a session ID). O_EXCL / `wx` makes the create atomic:
// exactly one writer wins; all others see EEXIST.
//
// Neither flavor uses advisory file locking (flock/lockf) — those require
// persistent open fds and break across process restarts. Sentinel and O_EXCL
// are both crash-safe: the file either exists or it doesn't, independent of
// who holds a fd.

export type ExclusiveCreateResult = { created: true } | { created: false; existing: string }

// Atomic exclusive create. Returns { created: true } if this caller created the
// file, { created: false, existing } if the file already existed (EEXIST).
// Does not mkdir the parent dir — caller is responsible. Does not retry or
// remove stale files — callers handle domain semantics (liveness checks, etc).
// Throws on any error other than EEXIST.
export async function exclusiveCreate(
  path: string,
  content: string,
  options?: { mode?: number },
): Promise<ExclusiveCreateResult> {
  try {
    await writeFile(path, content, { flag: 'wx', mode: options?.mode })
    return { created: true }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    const existing = await readFile(path, 'utf8')
    return { created: false, existing }
  }
}

// Sync variant for callers that can't await (e.g. MCP startup in irc-server.ts).
export function exclusiveCreateSync(
  path: string,
  content: string,
  options?: { mode?: number },
): ExclusiveCreateResult {
  try {
    fs.writeFileSync(path, content, { flag: 'wx', mode: options?.mode })
    return { created: true }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    const existing = fs.readFileSync(path, 'utf8')
    return { created: false, existing }
  }
}
