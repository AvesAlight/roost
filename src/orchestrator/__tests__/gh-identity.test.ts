import { describe, it, expect, afterEach } from 'bun:test'
import { pinGhIdentity, type GhIdentityDeps } from '../gh-identity.js'
import type { OrchestratorConfig } from '../config.js'

const noop = () => {}

// Indirection so TS doesn't narrow `process.env.GH_TOKEN` to `undefined` after
// a `delete` earlier in the same test — pinGhIdentity (an opaque async call
// from TS's point of view) is what actually reassigns it.
const ghToken = () => process.env.GH_TOKEN

const savedGhToken = process.env.GH_TOKEN

afterEach(() => {
  if (savedGhToken === undefined) delete process.env.GH_TOKEN
  else process.env.GH_TOKEN = savedGhToken
})

describe('pinGhIdentity', () => {
  it('no-ops when agent_logins is unset — nothing configured to pin', async () => {
    delete process.env.GH_TOKEN
    const deps: GhIdentityDeps = {
      resolveToken: async () => { throw new Error('should not be called') },
      verifyLogin: async () => { throw new Error('should not be called') },
    }
    await pinGhIdentity({ project: 'p' }, noop, deps)
    expect(ghToken()).toBeUndefined()
  })

  it('no-ops when agent_logins is empty', async () => {
    delete process.env.GH_TOKEN
    const deps: GhIdentityDeps = {
      resolveToken: async () => { throw new Error('should not be called') },
      verifyLogin: async () => { throw new Error('should not be called') },
    }
    await pinGhIdentity({ project: 'p', agent_logins: [] }, noop, deps)
    expect(ghToken()).toBeUndefined()
  })

  it('skips the pin (does not throw) when agent_logins has more than one entry — can\'t infer an identity, but this is a supported config shape (roost init --agent-login is repeatable)', async () => {
    delete process.env.GH_TOKEN
    const config: OrchestratorConfig = { project: 'p', agent_logins: ['BotOne', 'BotTwo'] }
    const deps: GhIdentityDeps = {
      resolveToken: async () => { throw new Error('should not be called') },
      verifyLogin: async () => { throw new Error('should not be called') },
    }
    const logs: string[] = []
    await pinGhIdentity(config, (msg: string) => logs.push(msg), deps)
    expect(ghToken()).toBeUndefined()
    expect(logs.some(l => l.includes('BotOne, BotTwo') && l.includes('skipping the boot pin'))).toBe(true)
  })

  it('pins process.env.GH_TOKEN when the resolved token verifies as the configured login', async () => {
    delete process.env.GH_TOKEN
    const config: OrchestratorConfig = { project: 'p', agent_logins: ['TeakBuilds'] }
    const deps: GhIdentityDeps = {
      resolveToken: async (login) => { expect(login).toBe('TeakBuilds'); return 'tok-for-teakbuilds' },
      verifyLogin: async (token) => { expect(token).toBe('tok-for-teakbuilds'); return 'TeakBuilds' },
    }
    await pinGhIdentity(config, noop, deps)
    expect(ghToken()).toBe('tok-for-teakbuilds')
  })

  it('throws and does not set GH_TOKEN when the login has no stored credential on this box', async () => {
    delete process.env.GH_TOKEN
    const config: OrchestratorConfig = { project: 'p', agent_logins: ['TeakBuilds'] }
    const deps: GhIdentityDeps = {
      resolveToken: async () => { throw new Error('gh-identity: no stored gh credential for login "TeakBuilds"') },
      verifyLogin: async () => { throw new Error('should not be called') },
    }
    await expect(pinGhIdentity(config, noop, deps)).rejects.toThrow(/no stored gh credential/)
    expect(ghToken()).toBeUndefined()
  })

  it('pins successfully when the confirmed login differs only in case from the configured one', async () => {
    delete process.env.GH_TOKEN
    const config: OrchestratorConfig = { project: 'p', agent_logins: ['teakbuilds'] }
    const deps: GhIdentityDeps = {
      resolveToken: async () => 'tok',
      // gh api user returns GitHub's canonical casing, which may not match
      // how an operator typed agent_logins — logins are case-insensitive.
      verifyLogin: async () => 'TeakBuilds',
    }
    await pinGhIdentity(config, noop, deps)
    expect(ghToken()).toBe('tok')
  })

  it('throws and does not set GH_TOKEN when gh api user reports a different login than configured', async () => {
    delete process.env.GH_TOKEN
    const config: OrchestratorConfig = { project: 'p', agent_logins: ['TeakBuilds'] }
    const deps: GhIdentityDeps = {
      resolveToken: async () => 'tok-for-someone-else',
      verifyLogin: async () => 'AlexSc',
    }
    await expect(pinGhIdentity(config, noop, deps)).rejects.toThrow(/confirmed login "AlexSc", expected "TeakBuilds"/)
    expect(ghToken()).toBeUndefined()
  })

  it('logs a pin confirmation line on success', async () => {
    delete process.env.GH_TOKEN
    const config: OrchestratorConfig = { project: 'p', agent_logins: ['TeakBuilds'] }
    const logs: string[] = []
    const deps: GhIdentityDeps = {
      resolveToken: async () => 'tok',
      verifyLogin: async () => 'TeakBuilds',
    }
    await pinGhIdentity(config, (msg: string) => logs.push(msg), deps)
    expect(logs.some(l => l.includes('pinned gh identity to "TeakBuilds"'))).toBe(true)
  })
})
