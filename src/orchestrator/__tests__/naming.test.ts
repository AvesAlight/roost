import { describe, it, expect } from 'bun:test'
import {
  defaultProject,
  validateProject,
  issueChannel,
  leadsChannel,
  workerNick,
  reviewerNick,
  pmNick,
  apmNick,
  dispatcherNick,
  repoSlug,
  channelSlug,
  isMultiRepo,
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

  it('throws when multi-mode and project is not set', () => {
    expect(() => defaultProject({})).toThrow(/multi-repo mode.*requires.*config\.project/)
  })
})

describe('isMultiRepo', () => {
  it('is true when config.repo is unset', () => {
    expect(isMultiRepo({ project: 'p' })).toBe(true)
  })
  it('is false when config.repo is set', () => {
    expect(isMultiRepo({ project: 'p', repo: 'org/x' })).toBe(false)
  })
})

describe('repoSlug', () => {
  it.each([
    ['AvesAlight/Roost', 'roost'],
    ['Org/multi-word-name', 'multi-word-name'],
    ['Org/abc123', 'abc123'],
  ])('lowercases the basename of %p → %p', (repo, slug) => {
    expect(repoSlug(repo)).toBe(slug)
  })

  it('throws when the slug would not match the project pattern', () => {
    expect(() => repoSlug('Org/bad name')).toThrow(/cannot derive slug/)
    expect(() => repoSlug('Org/-leading-dash')).toThrow(/cannot derive slug/)
  })
})

describe('channelSlug', () => {
  it('returns undefined in single-repo mode regardless of repo', () => {
    expect(channelSlug({ project: 'p', repo: 'org/x' }, 'org/x')).toBeUndefined()
    expect(channelSlug({ project: 'p', repo: 'org/x' }, 'org/anything-else')).toBeUndefined()
  })

  it('returns the slug in multi-repo mode', () => {
    expect(channelSlug({ project: 'p' }, 'Org/Foo')).toBe('foo')
  })

  it('throws in multi-repo mode when no repo is given', () => {
    expect(() => channelSlug({ project: 'p' }, undefined)).toThrow(/multi-repo mode requires repo/)
  })
})

describe('name helpers', () => {
  it('format names with the project prefix (single-repo: no slug)', () => {
    expect(issueChannel('roost', 196)).toBe('#roost-issue-196')
    expect(leadsChannel('roost')).toBe('#roost-leads')
    expect(workerNick('roost', 196)).toBe('roost-worker-196')
    expect(reviewerNick('roost', 200)).toBe('roost-reviewer-200')
    expect(pmNick('roost')).toBe('roost-pm')
    expect(apmNick('roost')).toBe('roost-apm')
    expect(dispatcherNick('roost')).toBe('roost-dispatcher')
  })

  it('thread the slug segment when set (multi-repo) — slug sits between project and role', () => {
    expect(issueChannel('roost', 196, 'foo')).toBe('#roost-foo-issue-196')
    expect(workerNick('roost', 196, 'foo')).toBe('roost-foo-worker-196')
    expect(reviewerNick('roost', 200, 'foo')).toBe('roost-foo-reviewer-200')
  })

  it('keep the single-repo shape when slug is undefined', () => {
    expect(issueChannel('roost', 196, undefined)).toBe('#roost-issue-196')
    expect(workerNick('roost', 196, undefined)).toBe('roost-worker-196')
    expect(reviewerNick('roost', 200, undefined)).toBe('roost-reviewer-200')
  })
})
