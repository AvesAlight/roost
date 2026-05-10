import { describe, it, expect } from 'bun:test'
import {
  defaultProject,
  validateProject,
  issueChannel,
  leadsChannel,
  workerNick,
  reviewerNick,
  leadPmNick,
  watcherNick,
  dispatcherNick,
} from '../naming.js'

describe('validateProject', () => {
  it.each(['roost', 'my-project', 'a1b2', 'p'])('accepts %p', (s) => {
    expect(() => validateProject(s)).not.toThrow()
  })

  it.each(['', 'Foo', 'foo bar', '-foo', 'foo!', 'a/b'])('rejects %p', (s) => {
    expect(() => validateProject(s)).toThrow(/invalid project/)
  })
})

describe('defaultProject', () => {
  it('returns the explicit project when set', () => {
    expect(defaultProject({ project: 'roost', repo: 'AvesAlight/roost' })).toBe('roost')
  })

  it('falls back to lowercased basename of repo', () => {
    expect(defaultProject({ repo: 'AvesAlight/Roost' })).toBe('roost')
  })

  it('throws when project invalid', () => {
    expect(() => defaultProject({ project: 'BAD NAME' })).toThrow(/invalid project/)
  })

  it('throws when no project and no parseable repo', () => {
    expect(() => defaultProject({})).toThrow(/no project/)
  })
})

describe('name helpers', () => {
  it('format names with the project prefix', () => {
    expect(issueChannel('roost', 196)).toBe('#roost-issue-196')
    expect(leadsChannel('roost')).toBe('#roost-leads')
    expect(workerNick('roost', 196)).toBe('roost-worker-196')
    expect(reviewerNick('roost', 200)).toBe('roost-reviewer-200')
    expect(leadPmNick('roost')).toBe('roost-lead-pm')
    expect(watcherNick('roost')).toBe('roost-watcher')
    expect(dispatcherNick('roost')).toBe('roost-dispatcher')
  })
})
