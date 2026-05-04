import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const BIN_DIR = join(import.meta.dirname, '../bin')

function isShellScript(file: string): boolean {
  try {
    const first = readFileSync(join(BIN_DIR, file), { encoding: 'utf8' }).split('\n')[0]
    return /^#!\s*(\/usr\/bin\/env\s+)?(ba)?sh\b/.test(first)
  } catch {
    return false
  }
}

const shellScripts = readdirSync(BIN_DIR).filter(isShellScript)

describe.if(Bun.which('shellcheck') !== null)('shellcheck bin/', () => {
  for (const script of shellScripts) {
    it(script, async () => {
      const proc = Bun.spawn(['shellcheck', join(BIN_DIR, script)], { stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(stdout + stderr).toBe('')
      expect(exitCode).toBe(0)
    })
  }
})
