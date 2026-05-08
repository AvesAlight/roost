export class GhError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'GhError'
  }
}

async function spawnGh(args: string[]): Promise<unknown> {
  const proc = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, errOut] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new GhError(
      `gh failed (exit ${exitCode}): gh ${args.join(' ')}\n${errOut.trim()}`
    )
  }
  const trimmed = out.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

async function ghApi(endpoint: string, paginate = false): Promise<unknown> {
  const args = ['api']
  if (paginate) args.push('--paginate')
  args.push(endpoint)
  return spawnGh(args)
}

export interface GhLabel {
  name?: string
}

export interface GhCheckRun {
  status?: string
  conclusion?: string
}

export interface GhStatus {
  state?: string
}

export interface GhComment {
  id?: number
  html_url?: string
  user?: { login?: string }
  body?: string
  path?: string
  line?: number
  original_line?: number
}

export interface GhReview {
  id?: number
  html_url?: string
  user?: { login?: string }
  body?: string
  state?: string
}

export interface GhPr {
  title?: string
  html_url?: string
  draft?: boolean
  merged_at?: string | null
  state?: string
  labels?: GhLabel[]
  head?: { ref?: string; sha?: string }
}

export interface GhIssue {
  title?: string
  html_url?: string
  state?: string
  labels?: GhLabel[]
}

export interface FetchedPr {
  title: string | null
  url: string | null
  head_ref: string | null
  head_oid: string | null
  is_draft: boolean
  merged_at: string | null
  state: string | null
  labels: GhLabel[]
  ci_state: string | null
}

export function aggregateCi(runs: GhCheckRun[], statuses: GhStatus[]): string | null {
  const states = new Set<string>()
  for (const run of runs) {
    const status = (run.status ?? '').toUpperCase()
    if (['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING'].includes(status)) {
      states.add('PENDING')
      continue
    }
    const conclusion = (run.conclusion ?? '').toUpperCase()
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) states.add('SUCCESS')
    else if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion)) states.add('FAILURE')
    else states.add('PENDING')
  }
  for (const st of statuses) {
    const s = (st.state ?? '').toUpperCase()
    if (s === 'SUCCESS') states.add('SUCCESS')
    else if (['FAILURE', 'ERROR'].includes(s)) states.add('FAILURE')
    else states.add('PENDING')
  }
  if (states.size === 0) return null
  if (states.has('FAILURE')) return 'FAILURE'
  if (states.has('PENDING')) return 'PENDING'
  return 'SUCCESS'
}

export function labelNames(labels: GhLabel[] | null | undefined): string[] {
  if (!labels) return []
  return labels
    .map(l => (typeof l === 'string' ? l : l.name ?? ''))
    .filter(Boolean)
    .sort()
}

export async function fetchPr(repo: string, number: number): Promise<FetchedPr> {
  const pr = (await ghApi(`repos/${repo}/pulls/${number}`) ?? {}) as GhPr
  const head = pr.head ?? {}
  const sha = head.sha

  let runs: GhCheckRun[] = []
  let statuses: GhStatus[] = []
  if (sha) {
    const checkResp = await ghApi(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, true)
    if (checkResp && typeof checkResp === 'object' && !Array.isArray(checkResp)) {
      runs = ((checkResp as Record<string, unknown>).check_runs ?? []) as GhCheckRun[]
    } else if (Array.isArray(checkResp)) {
      runs = checkResp as GhCheckRun[]
    }
    const combined = (await ghApi(`repos/${repo}/commits/${sha}/status`) ?? {}) as Record<string, unknown>
    statuses = (combined.statuses ?? []) as GhStatus[]
  }

  return {
    title: pr.title ?? null,
    url: pr.html_url ?? null,
    head_ref: head.ref ?? null,
    head_oid: sha ?? null,
    is_draft: Boolean(pr.draft),
    merged_at: pr.merged_at ?? null,
    state: pr.state ? pr.state.toUpperCase() : null,
    labels: pr.labels ?? [],
    ci_state: aggregateCi(runs, statuses),
  }
}

export async function fetchPrReviewComments(repo: string, number: number): Promise<GhComment[]> {
  return (await ghApi(`repos/${repo}/pulls/${number}/comments?per_page=100`, true) ?? []) as GhComment[]
}

export async function fetchPrConversationComments(repo: string, number: number): Promise<GhComment[]> {
  return (await ghApi(`repos/${repo}/issues/${number}/comments?per_page=100`, true) ?? []) as GhComment[]
}

export async function fetchPrReviews(repo: string, number: number): Promise<GhReview[]> {
  return (await ghApi(`repos/${repo}/pulls/${number}/reviews?per_page=100`, true) ?? []) as GhReview[]
}

export async function fetchPrLinkedIssues(repo: string, number: number): Promise<number[]> {
  const [owner, name] = repo.split('/', 2)
  const query = (
    'query($owner:String!,$name:String!,$number:Int!){' +
    'repository(owner:$owner,name:$name){' +
    'pullRequest(number:$number){' +
    'closingIssuesReferences(first:25){nodes{number}}}}}'
  )
  const result = await spawnGh([
    'api', 'graphql',
    '-f', `query=${query}`,
    '-F', `owner=${owner}`,
    '-F', `name=${name}`,
    '-F', `number=${number}`,
  ])
  if (!result) return []
  const r = result as Record<string, unknown>
  const nodes = (
    ((r.data as Record<string, unknown> | undefined)?.repository as Record<string, unknown> | undefined)
      ?.pullRequest as Record<string, unknown> | undefined
  )?.closingIssuesReferences as { nodes?: Array<{ number?: number }> } | undefined
  return (nodes?.nodes ?? [])
    .filter(n => n.number != null)
    .map(n => n.number as number)
    .sort((a, b) => a - b)
}

export async function fetchIssue(repo: string, number: number): Promise<GhIssue> {
  return (await ghApi(`repos/${repo}/issues/${number}`) ?? {}) as GhIssue
}

export async function fetchIssueComments(repo: string, number: number): Promise<GhComment[]> {
  return (await ghApi(`repos/${repo}/issues/${number}/comments?per_page=100`, true) ?? []) as GhComment[]
}
