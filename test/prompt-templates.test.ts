// Smoke test for the slash-command prompt templates we ship under `prompts/`.
// The slash-command argument parser treats `$<digit><wordchar>` as a single
// variable name, so a template like `#$0-$5issue-$1` silently leaves `$5issue`
// unsubstituted. This test catches that class of bug by asserting:
//
//   (1) Every `$<digit>` reference in a prompt template is followed by a
//       non-word character (or end of string), so `$N` is parsed as a
//       positional and the following literal text begins cleanly.
//   (2) After substituting the documented positional set, no literal
//       `$<digit>` remains anywhere in the rendered output.
//
// The contract for which positionals each template consumes is read from the
// per-template fixture below — keep it in sync with the `argument-hint`
// frontmatter when you add a positional.
import { describe, it, expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const PROMPTS_DIR = join(import.meta.dir, '..', 'prompts')

interface TemplateCase {
  name: string
  file: string
  positionals: Record<string, string>
}

const cases: TemplateCase[] = [
  {
    name: 'worker (single-repo)',
    file: 'worker.md',
    positionals: {
      '$0': 'proj', '$1': '42', '$2': 'org/repo', '$3': 'feat/x',
      '$4': 'alex', '$5': 'proj-worker-42', '$6': '#proj-issue-42',
    },
  },
  {
    name: 'worker (multi-repo)',
    file: 'worker.md',
    positionals: {
      '$0': 'proj', '$1': '42', '$2': 'org/foo', '$3': 'feat/x',
      '$4': 'alex', '$5': 'proj-worker-foo-42', '$6': '#proj-foo-issue-42',
    },
  },
  {
    name: 'reviewer (single-repo)',
    file: 'reviewer.md',
    positionals: {
      '$0': 'proj', '$1': '42', '$2': '40', '$3': 'feat/x',
      '$4': 'https://example/pr/42', '$5': 'alex',
      '$6': 'proj-reviewer-42', '$7': '#proj-issue-40',
    },
  },
  {
    name: 'reviewer (multi-repo)',
    file: 'reviewer.md',
    positionals: {
      '$0': 'proj', '$1': '42', '$2': '40', '$3': 'feat/x',
      '$4': 'https://example/pr/42', '$5': 'alex',
      '$6': 'proj-reviewer-foo-42', '$7': '#proj-foo-issue-40',
    },
  },
]

// Mimic claude-code's `$<digit>...` substitution: only swap `$N` when N is a
// digit and the next char is not a word char (or end of string). This keeps
// the test honest about what the runtime parser actually does.
function render(template: string, positionals: Record<string, string>): string {
  return template.replace(/\$(\d+)(?=\W|$)/g, (whole, num: string) => {
    const key = `$${num}`
    return Object.prototype.hasOwnProperty.call(positionals, key) ? positionals[key] : whole
  })
}

describe('prompt template positionals', () => {
  for (const c of cases) {
    it(`${c.name}: every \`$<digit>\` is followed by a non-word char (parser substitutes it)`, async () => {
      const body = await readFile(join(PROMPTS_DIR, c.file), 'utf8')
      // Strip the YAML frontmatter — argument-hint lives there as docs, not
      // as a substitution target.
      const stripped = body.replace(/^---\n[\s\S]*?\n---\n/, '')
      const bad = stripped.match(/\$\d+\w/g) ?? []
      expect(bad).toEqual([])
    })

    it(`${c.name}: no literal \`$<digit>\` survives substitution of the documented positionals`, async () => {
      const body = await readFile(join(PROMPTS_DIR, c.file), 'utf8')
      const stripped = body.replace(/^---\n[\s\S]*?\n---\n/, '')
      const rendered = render(stripped, c.positionals)
      const leftover = rendered.match(/\$\d+/g) ?? []
      expect(leftover).toEqual([])
    })
  }
})
