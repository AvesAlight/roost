import IRC from 'irc-framework'
import type { IrcFrameworkClient } from 'irc-framework'
import { MULTILINE_LINE_BYTES } from './constants.js'
import {
  splitLineForMultiline,
  newBatchId,
  reassembleMultilineBatch,
} from './irc-lib.js'
import type {
  RoostIrcClient,
  ClientConfig,
  ConnectOpts,
  IrcMessage,
  MessageMeta,
  MembershipExtras,
  UnreadInfo,
  SystemKind,
  SystemContent,
  JoinResult,
} from './irc-client.js'

// Cap name (IRCv3 draft) — what the server advertises. We intentionally do NOT
// negotiate it: against ergo, negotiating switches on-join replay to a per-session
// cursor mode that doesn't repeat the same messages on rejoin. That breaks the
// always-replay-on-join contract the rest of the code (and the SIGUSR1 dedupe
// recovery path) relies on. We detect availability from the CAP LS list instead
// and use it purely to gate the explicit CHATHISTORY LATEST query.
const CAP_CHATHISTORY = 'draft/chathistory'
// Batch type — what ergo tags chathistory BATCH start/end with. Not the same string
// as the cap; the spec keeps the type unscoped.
const BATCH_TYPE_CHATHISTORY = 'chathistory'

// Server-side service senders that synthesize PRIVMSGs into channel history for
// membership/admin events ("X joined the channel", "Y set channel modes: …",
// etc.). They're noise for agents — channel_history's contract is the PRIVMSG
// stream, not the membership log (which arrives live via the membership event).
// Ergo-specific; extend if other servers ship similar services.
const HISTORY_SERVICE_SENDERS = new Set(['histserv'])

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const buildMentionRegex = (nick: string) => new RegExp(`\\b${escapeRegex(nick)}\\b`, 'i')

// Canonical "is this a DM" predicate: an IRC PRIVMSG target is a channel iff it
// starts with '#' (we don't care about '&'/'+'/'!' in this codebase). Used by
// both the live message path (event.target) and the chathistory-batch path
// (the original query target). Keeping a single derivation drops the risk of
// the two paths drifting on the DM/channel boundary.
const targetIsDirect = (target: string): boolean => !target.startsWith('#')

// ---- IRC event shapes ------------------------------------------------------

interface JoinEvent { nick: string; channel: string }
interface UserlistEvent { channel: string; users: Array<{ nick: string }> }
interface PartEvent { nick: string; channel: string; message?: string }
interface KickEvent { nick?: string; kicked: string; channel: string; message?: string }
interface QuitEvent { nick: string; message?: string }
interface NickEvent { nick: string; new_nick: string }
interface MessageEvent {
  nick: string
  target: string
  message: string
  type: string
  batch?: { id: string; type: string; params: string[] }
  tags?: Record<string, string>
}
interface BatchCommand {
  command: string
  params: string[]
  nick: string
  tags: Record<string, unknown>
  getServerTime?: () => number | undefined
}
interface BatchEndEvent { id: string; params: string[]; commands: BatchCommand[] }

// ---- Implementation --------------------------------------------------------

interface ChathistoryResolver {
  resolve: (msgs: IrcMessage[] | null) => void
  timer: ReturnType<typeof setTimeout>
}

interface PendingJoinReplay {
  timer: ReturnType<typeof setTimeout>
  done: Promise<void>
  resolve: () => void
}

export class RoostIrcClientImpl implements RoostIrcClient {
  private readonly nick: string
  private readonly nickMentionRegex: RegExp
  private readonly historySize: number
  private readonly joinHistoryLines: number
  private readonly joinHistoryMinutes: number
  private readonly autoJoin: string[]
  private readonly whoisTimeoutMs: number
  private readonly chathistoryDisabled: boolean
  private readonly chathistoryQueryTimeoutMs: number

  private readonly irc: IrcFrameworkClient

  private ircReady = false
  private hasRegistered = false
  private chathistoryCapActive = false
  private readonly joinResolvers = new Map<string, Array<(result: JoinResult) => void>>()
  private readonly namesTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly partResolvers = new Map<string, Array<(ok: boolean) => void>>()
  // Channels for which we expect the server to push an auto-replay chathistory batch on
  // join. Set on self-join, cleared when the matching batch arrives (or after 5s, so a
  // server that sends no batch doesn't block a future explicit query indefinitely).
  // Exposes a Promise (done) so chathistoryLatest can wait for the auto-replay window
  // to close before issuing its own query — otherwise the explicit query's batch is
  // stolen by the pending-join guard and the agent times out into an empty fallback.
  private readonly pendingJoinReplays = new Map<string, PendingJoinReplay>()
  // Explicit `chathistoryLatest` resolvers keyed by lowercased target. At most one per
  // target at a time — chathistoryLatest serializes same-target queries via a Promise
  // chain (chathistoryQueriesByTarget) so the FIFO shift here can never mismatch.
  private readonly chathistoryResolvers = new Map<string, ChathistoryResolver[]>()
  // Per-target serialization chain. Concurrent chathistoryLatest(target, …) calls chain
  // sequentially so each gets its own batch from the server.
  private readonly chathistoryQueriesByTarget = new Map<string, Promise<IrcMessage[] | null>>()
  // If a chathistory query times out, mark the target so the FIRST late batch (if any)
  // is dropped rather than satisfying a subsequent query's resolver. TCP/IRC delivery
  // is FIFO, so dropping one batch is enough.
  private readonly chathistorySkipNextBatch = new Set<string>()
  private multilineMaxLines = 100
  private readonly history = new Map<string, IrcMessage[]>()
  private readonly unread = new Map<string, UnreadInfo>()
  private readonly seenFingerprints = new Map<string, Set<string>>()
  private readonly channelUsers = new Map<string, Set<string>>()
  private pendingRejoinChannels: string[] = []

  private readonly messageHandlers: Array<(msg: IrcMessage, meta: MessageMeta) => void> = []
  private readonly membershipHandlers: Array<(kind: 'join' | 'leave' | 'nick', nick: string, channel: string, extras: MembershipExtras) => void> = []
  private readonly systemHandlers: Array<(kind: SystemKind, content: SystemContent) => void> = []

  constructor(config: ClientConfig) {
    this.nick = config.nick
    this.nickMentionRegex = buildMentionRegex(config.nick)
    this.historySize = config.historySize
    this.joinHistoryLines = config.joinHistoryLines
    this.joinHistoryMinutes = config.joinHistoryMinutes
    this.autoJoin = config.autoJoin
    this.whoisTimeoutMs = config.whoisTimeoutMs ?? 5000
    this.chathistoryDisabled = config.chathistoryDisabled ?? false
    this.chathistoryQueryTimeoutMs = config.chathistoryQueryTimeoutMs ?? 2000
    this.irc = new IRC.Client()
    this.registerHandlers()
  }

  // ---- Public interface --------------------------------------------------

  connect(opts: ConnectOpts): void {
    // See CAP_CHATHISTORY comment — we DON'T negotiate the chathistory cap on purpose.
    // Detection runs against the server's CAP LS advertisement list (network.cap.available).
    this.irc.requestCap(['draft/multiline', 'labeled-response', 'server-time'])
    this.irc.connect({
      host: opts.host,
      port: opts.port,
      nick: opts.nick,
      username: opts.username ?? opts.nick,
      gecos: opts.gecos ?? opts.nick,
      auto_reconnect: opts.autoReconnect ?? false,
      auto_reconnect_max_retries: opts.autoReconnectMaxRetries,
    })
  }

  isReady(): boolean { return this.ircReady }
  isJoined(channel: string): boolean { return this.channelUsers.has(channel.toLowerCase()) }

  async join(channel: string): Promise<JoinResult> {
    channel = channel.toLowerCase()
    if (this.channelUsers.has(channel)) return { ok: true, members: this.getUsers(channel) }
    return new Promise<JoinResult>((resolve) => {
      const list = this.joinResolvers.get(channel) ?? []
      list.push(resolve)
      this.joinResolvers.set(channel, list)
      this.irc.join(channel)
      setTimeout(() => resolve({ ok: false, members: [] }), 5000).unref?.()
    })
  }

  async leave(channel: string): Promise<boolean> {
    channel = channel.toLowerCase()
    return new Promise<boolean>((resolve) => {
      const list = this.partResolvers.get(channel) ?? []
      list.push(resolve)
      this.partResolvers.set(channel, list)
      this.irc.part(channel)
      setTimeout(() => resolve(false), 5000).unref?.()
    })
  }

  say(target: string, text: string): { chunks: number; mode: 'single' | 'multiline' } {
    if (text.length <= MULTILINE_LINE_BYTES && !text.includes('\n')) {
      this.irc.say(target, text)
      return { chunks: 1, mode: 'single' }
    }

    const id = newBatchId()
    const logicalLines = text.split('\n')
    const wireLines: Array<{ body: string; concat: boolean }> = []
    for (const line of logicalLines) {
      const chunks = splitLineForMultiline(line)
      chunks.forEach((chunk, idx) => {
        wireLines.push({ body: chunk, concat: idx > 0 })
      })
    }

    if (wireLines.length > this.multilineMaxLines) {
      this.log(`multiline target=${target} would emit ${wireLines.length} lines, exceeds server max ${this.multilineMaxLines}; sending anyway`)
    }

    this.irc.raw('BATCH', `+${id}`, 'draft/multiline', target)
    for (const { body, concat } of wireLines) {
      const tagStr = concat ? `batch=${id};draft/multiline-concat` : `batch=${id}`
      this.irc.connection.write(`@${tagStr} PRIVMSG ${target} :${body}`)
    }
    this.irc.raw('BATCH', `-${id}`)
    this.log(`multiline outbound to ${target} as batch ${id} (${wireLines.length} lines, ${text.length} bytes)`)
    return { chunks: wireLines.length, mode: 'multiline' }
  }

  async whoisChannels(): Promise<string[] | null> {
    return new Promise<string[] | null>((resolve) => {
      this.irc.whois(this.nick, (event: { channels?: string }) => {
        if (!event.channels) { resolve([]); return }
        const list = event.channels
          .split(' ')
          .map((ch: string) => ch.replace(/^[@+%&~]+/, ''))
          .filter(Boolean)
          .sort()
        resolve(list)
      })
      setTimeout(() => resolve(null), this.whoisTimeoutMs).unref?.()
    })
  }

  getHistory(key: string, limit = 20): IrcMessage[] {
    const buf = this.history.get(key.toLowerCase()) ?? []
    return buf.slice(-limit)
  }

  async chathistoryLatest(target: string, limit: number): Promise<IrcMessage[] | null> {
    if (!this.chathistoryCapActive) return null
    if (limit <= 0) return []
    const key = target.toLowerCase()
    const prev = this.chathistoryQueriesByTarget.get(key) ?? Promise.resolve(null as IrcMessage[] | null)
    const next = prev.catch(() => null).then(() => this.sendChathistoryQuery(target, limit))
    this.chathistoryQueriesByTarget.set(key, next)
    void next.finally(() => {
      if (this.chathistoryQueriesByTarget.get(key) === next) this.chathistoryQueriesByTarget.delete(key)
    })
    return next
  }

  private async sendChathistoryQuery(target: string, limit: number): Promise<IrcMessage[] | null> {
    const key = target.toLowerCase()
    // Wait for any in-flight JOIN auto-replay window for this target to close first.
    // The pending-join guard would otherwise consume the explicit query's batch and the
    // query would time out into an empty fallback.
    const pending = this.pendingJoinReplays.get(key)
    if (pending) await pending.done
    return new Promise<IrcMessage[] | null>((resolve) => {
      const timer = setTimeout(() => {
        const list = this.chathistoryResolvers.get(key)
        if (list) {
          const idx = list.findIndex(r => r.resolve === resolve)
          if (idx !== -1) list.splice(idx, 1)
          if (list.length === 0) this.chathistoryResolvers.delete(key)
        }
        this.chathistorySkipNextBatch.add(key)
        this.log(`chathistory query timed out for ${target} after ${this.chathistoryQueryTimeoutMs}ms — falling back`)
        resolve(null)
      }, this.chathistoryQueryTimeoutMs)
      timer.unref?.()
      const list = this.chathistoryResolvers.get(key) ?? []
      list.push({ resolve, timer })
      this.chathistoryResolvers.set(key, list)
      this.irc.raw('CHATHISTORY', 'LATEST', target, '*', String(limit))
    })
  }

  getUsers(channel: string): string[] {
    const set = this.channelUsers.get(channel.toLowerCase())
    return set ? [...set].sort() : []
  }

  getUnread(): ReadonlyMap<string, UnreadInfo> { return this.unread }
  ackUnread(key: string): void { this.unread.delete(key.toLowerCase()) }
  clearDedupeCache(): void { this.seenFingerprints.clear() }

  quit(): void { this.irc.quit() }

  on(event: 'message', handler: (msg: IrcMessage, meta: MessageMeta) => void): void
  on(event: 'membership', handler: (kind: 'join' | 'leave' | 'nick', nick: string, channel: string, extras: MembershipExtras) => void): void
  on(event: 'system', handler: (kind: SystemKind, content: SystemContent) => void): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- implementation signature required by TS overload pattern
  on(event: string, handler: (...args: any[]) => void): void {
    if (event === 'message') this.messageHandlers.push(handler)
    else if (event === 'membership') this.membershipHandlers.push(handler)
    else if (event === 'system') this.systemHandlers.push(handler)
  }

  // ---- Logging -----------------------------------------------------------

  private log(msg: string): void {
    process.stderr.write(`roost-irc[${this.nick}]: ${msg}\n`)
  }

  // ---- State helpers -----------------------------------------------------

  private pushHistory(key: string, msg: IrcMessage): void {
    const buf = this.history.get(key) ?? []
    buf.push(msg)
    while (buf.length > this.historySize) buf.shift()
    this.history.set(key, buf)
  }

  private msgFingerprint(msg: IrcMessage): string {
    return `${msg.sender}|${msg.ts}|${msg.text}`
  }

  private addFingerprint(msg: IrcMessage): void {
    let set = this.seenFingerprints.get(msg.channel)
    if (!set) {
      set = new Set()
      this.seenFingerprints.set(msg.channel, set)
    }
    const fp = this.msgFingerprint(msg)
    if (set.has(fp)) return
    set.add(fp)
    while (set.size > this.historySize) set.delete(set.values().next().value!)
  }

  private hasFingerprint(msg: IrcMessage): boolean {
    return this.seenFingerprints.get(msg.channel)?.has(this.msgFingerprint(msg)) ?? false
  }

  private ensureChannelSet(channel: string): Set<string> {
    let set = this.channelUsers.get(channel)
    if (!set) {
      set = new Set()
      this.channelUsers.set(channel, set)
    }
    return set
  }

  // Record a message in history and dedupe set. Always sets msg.mention (text-only regex).
  // Increments unread only for non-historical, non-empty-sender messages.
  // Returns true iff the message body contains a nick mention (same value as msg.mention after the call).
  private recordMessage(msg: IrcMessage, historical = false): boolean {
    const isMention = this.nickMentionRegex.test(msg.text)
    msg.mention = isMention
    this.pushHistory(msg.channel, msg)
    this.addFingerprint(msg)
    if (!historical && msg.sender !== '') {
      const prev = this.unread.get(msg.channel)
      this.unread.set(msg.channel, {
        count: (prev?.count ?? 0) + 1,
        lastSender: msg.sender,
        lastPreview: msg.text,
        mentionCount: (prev?.mentionCount ?? 0) + (isMention ? 1 : 0),
        lastMentionSender: isMention ? msg.sender : (prev?.lastMentionSender ?? ''),
        lastMentionPreview: isMention ? msg.text : (prev?.lastMentionPreview ?? ''),
      })
      return isMention
    }
    return false
  }

  // ---- Typed event emitters ----------------------------------------------

  private emitMessage(msg: IrcMessage, meta: MessageMeta): void {
    for (const h of this.messageHandlers) h(msg, meta)
  }

  private emitMembership(kind: 'join' | 'leave' | 'nick', nick: string, channel: string, extras: MembershipExtras = {}): void {
    for (const h of this.membershipHandlers) h(kind, nick, channel, extras)
  }

  private emitSystem(kind: SystemKind, content: SystemContent): void {
    for (const h of this.systemHandlers) h(kind, content)
  }

  // ---- IRC event handler registration ------------------------------------

  private registerHandlers(): void {
    this.irc.on('registered', () => this.handleRegistered())
    this.irc.on('join', (e: JoinEvent) => this.handleJoin(e))
    this.irc.on('userlist', (e: UserlistEvent) => this.handleUserlist(e))
    this.irc.on('part', (e: PartEvent) => this.handlePart(e))
    this.irc.on('kick', (e: KickEvent) => this.handleKick(e))
    this.irc.on('quit', (e: QuitEvent) => this.handleQuit(e))
    this.irc.on('nick', (e: NickEvent) => this.handleNick(e))
    this.irc.on('message', (e: MessageEvent) => this.handleMessage(e))
    this.irc.on('batch end draft/multiline', (e: BatchEndEvent) => this.handleMultilineBatch(e))
    this.irc.on(`batch end ${BATCH_TYPE_CHATHISTORY}`, (e: BatchEndEvent) => this.handleChathistoryBatch(e))
    this.irc.on('socket close', () => this.handleSocketClose())
    this.irc.on('socket error', (err: Error) => this.handleSocketError(err))
    // 432 ERR_ERRONEUSNICKNAME, 433 ERR_NICKNAMEINUSE, 436 ERR_NICKCOLLISION
    for (const code of ['432', '433', '436']) {
      this.irc.on(code, () => {
        if (!this.ircReady) this.emitSystem('registration-failed', { code: Number(code) })
      })
    }
  }

  // ---- IRC event handlers ------------------------------------------------

  private handleRegistered(): void {
    this.log('registered with the IRC server')
    if (!this.parseMultilineCap()) return
    const enabled: string[] = this.irc.network?.cap?.enabled ?? []
    if (!enabled.includes('server-time')) {
      this.log(`server-time NOT enabled (server caps: ${enabled.join(',') || '(none)'})`)
      this.emitSystem('cap-missing', 'server-time cap not enabled by server')
      return
    }
    this.ircReady = true
    this.logChathistoryCap()
    if (this.hasRegistered) {
      this.handleReconnect()
      return
    }
    this.hasRegistered = true
    this.emitSystem('registered', { nick: this.nick })
    for (const ch of this.autoJoin) {
      this.irc.join(ch)
      this.log(`auto-joining ${ch}`)
    }
  }

  private parseMultilineCap(): boolean {
    const enabled: string[] = this.irc.network?.cap?.enabled ?? []
    const available: Map<string, string> = this.irc.network?.cap?.available ?? new Map()
    if (enabled.includes('draft/multiline')) {
      const val = available.get('draft/multiline') || ''
      for (const kv of val.split(',')) {
        if (!kv) continue
        const [k, v] = kv.split('=')
        const n = Number(v)
        if (!Number.isFinite(n) || n <= 0) {
          process.stderr.write(`[roost] draft/multiline cap: ignoring malformed value ${k}=${v}\n`)
          continue
        }
        if (k === 'max-lines') this.multilineMaxLines = n
      }
      this.log(`draft/multiline enabled (max-lines=${this.multilineMaxLines})`)
      return true
    } else {
      this.log(`draft/multiline NOT enabled (server caps: ${enabled.join(',') || '(none)'})`)
      this.emitSystem('cap-missing', 'draft/multiline cap not enabled by server')
      return false
    }
  }

  private logChathistoryCap(): void {
    const available: Map<string, string> = this.irc.network?.cap?.available ?? new Map()
    this.chathistoryCapActive = !this.chathistoryDisabled && available.has(CAP_CHATHISTORY)
    this.log(
      this.chathistoryCapActive
        ? `${CAP_CHATHISTORY} advertised — mid-session channel_history will issue server queries`
        : `${CAP_CHATHISTORY} not advertised${this.chathistoryDisabled ? ' (disabled via config)' : ''} — channel_history falls back to local ring`,
    )
  }

  private handleReconnect(): void {
    const snapshot = this.pendingRejoinChannels
    this.pendingRejoinChannels = []
    const content = snapshot.length > 0
      ? `[roost] reconnected to IRC — rejoining: ${snapshot.join(', ')}`
      : '[roost] reconnected to IRC'
    this.emitSystem('reconnected', content)
    for (const ch of snapshot) {
      this.irc.join(ch)
      this.log(`reconnect-rejoining ${ch}`)
    }
  }

  private handleJoin(event: JoinEvent): void {
    const channel = event.channel.toLowerCase()
    if (event.nick === this.nick) {
      this.log(`joined ${channel}`)
      this.channelUsers.set(channel, new Set([this.nick]))
      this.markPendingJoinReplay(channel)
      // Defer resolution until handleUserlist fires with the complete NAMES list.
      // Guard with a 2s timeout in case the server never sends NAMES.
      if (this.joinResolvers.has(channel)) {
        const timer = setTimeout(() => {
          this.namesTimers.delete(channel)
          const list = this.joinResolvers.get(channel)
          if (list?.length) {
            this.log(`NAMES timeout for ${channel} — resolving with self only`)
            const members = this.getUsers(channel)
            for (const r of list) r({ ok: true, members })
            this.joinResolvers.delete(channel)
          }
        }, 2000)
        timer.unref?.()
        this.namesTimers.set(channel, timer)
      }
      return
    }
    this.ensureChannelSet(channel).add(event.nick)
    this.emitMembership('join', event.nick, channel)
  }

  private handleUserlist(event: UserlistEvent): void {
    const channel = event.channel.toLowerCase()
    const set = new Set<string>()
    for (const u of event.users ?? []) {
      if (u?.nick) set.add(u.nick)
    }
    this.channelUsers.set(channel, set)
    const members = this.getUsers(channel)
    this.log(`userlist for ${channel}: ${members.length} nicks (${members.join(', ')})`)
    const timer = this.namesTimers.get(channel)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.namesTimers.delete(channel)
    }
    const list = this.joinResolvers.get(channel)
    if (list?.length) {
      for (const r of list) r({ ok: true, members })
      this.joinResolvers.delete(channel)
    }
  }

  private handlePart(event: PartEvent): void {
    const channel = event.channel.toLowerCase()
    if (event.nick === this.nick) {
      const list = this.partResolvers.get(channel)
      if (list?.length) {
        for (const r of list) r(true)
        this.partResolvers.delete(channel)
      }
      this.channelUsers.delete(channel)
      this.unread.delete(channel)
      return
    }
    this.channelUsers.get(channel)?.delete(event.nick)
    this.emitMembership('leave', event.nick, channel, {
      reason: event.message ? `parted: ${event.message}` : 'parted',
    })
  }

  private handleKick(event: KickEvent): void {
    const channel = event.channel.toLowerCase()
    const victim = event.kicked
    if (victim === this.nick) {
      this.channelUsers.delete(channel)
      this.unread.delete(channel)
      return
    }
    this.channelUsers.get(channel)?.delete(victim)
    this.emitMembership('leave', victim, channel, {
      reason: `kicked${event.message ? ': ' + event.message : ''}`,
    })
  }

  private handleQuit(event: QuitEvent): void {
    if (event.nick === this.nick) {
      this.channelUsers.clear()
      // don't clear unread on quit — reconnect replays as historical, badges don't double-count
      return
    }
    for (const [chan, set] of this.channelUsers) {
      if (set.delete(event.nick)) {
        this.emitMembership('leave', event.nick, chan, {
          reason: event.message ? `quit: ${event.message}` : 'quit',
        })
      }
    }
  }

  private handleNick(event: NickEvent): void {
    if (event.nick === this.nick) return
    const oldKey = event.nick.toLowerCase()
    const newKey = event.new_nick.toLowerCase()
    let hadState = false

    for (const [, set] of this.channelUsers) {
      if (set.delete(event.nick)) {
        set.add(event.new_nick)
        hadState = true
      }
    }

    const hist = this.history.get(oldKey)
    if (hist !== undefined) {
      this.history.delete(oldKey)
      this.history.set(newKey, hist)
      hadState = true
    }

    const ur = this.unread.get(oldKey)
    if (ur !== undefined) {
      this.unread.delete(oldKey)
      this.unread.set(newKey, ur)
      hadState = true
    }

    if (hadState) {
      this.emitMembership('nick', event.nick, '', { newNick: event.new_nick })
    }
  }

  private handleMessage(event: MessageEvent): void {
    if (event.nick === this.nick) return
    if (event.batch?.type === 'draft/multiline') return
    if (event.batch?.type === BATCH_TYPE_CHATHISTORY) return
    const isDirect = targetIsDirect(event.target)
    const channel = isDirect ? event.nick.toLowerCase() : event.target.toLowerCase()
    const ts = event.tags?.['time'] ?? new Date().toISOString()
    const msg: IrcMessage = { channel, sender: event.nick, text: event.message, ts, isDirect }
    const mention = this.recordMessage(msg)
    this.emitMessage(msg, mention ? { mention: true } : {})
  }

  private handleMultilineBatch(event: BatchEndEvent): void {
    const rawTarget = event.params[0]
    if (!rawTarget) return
    const cmds = event.commands.filter(c => c.command === 'PRIVMSG')
    if (cmds.length === 0) return
    const sender = cmds[0].nick
    if (sender === this.nick) return
    const text = reassembleMultilineBatch(cmds)
    const isDirect = targetIsDirect(rawTarget)
    const channel = isDirect ? sender.toLowerCase() : rawTarget.toLowerCase()
    const serverTimeMs = cmds[0].getServerTime?.()
    const ts = (serverTimeMs ? new Date(serverTimeMs) : new Date()).toISOString()
    const msg: IrcMessage = { channel, sender, text, ts, isDirect }
    const mention = this.recordMessage(msg)
    this.emitMessage(msg, { buffered: cmds.length > 1, chunkCount: cmds.length, ...(mention ? { mention: true } : {}) })
  }

  private handleChathistoryBatch(event: BatchEndEvent): void {
    const target = event.params[0]
    if (!target) return
    const key = target.toLowerCase()

    // Pending-join guard: ergo pushes an auto-replay batch on JOIN even when the
    // agent has an explicit chathistoryLatest() in flight for the same channel.
    // chathistoryLatest awaits the pending-join clear before sending, so we can
    // safely consume this batch as the auto-replay without racing the explicit
    // query's response.
    if (this.pendingJoinReplays.has(key)) {
      this.clearPendingJoinReplay(key)
      this.emitAutoReplayBatch(event.commands, target)
      return
    }

    // A previous query timed out — drop one late batch to keep it from satisfying
    // a subsequent query's resolver with stale data. FIFO socket delivery means a
    // single skip is sufficient.
    if (this.chathistorySkipNextBatch.has(key)) {
      this.chathistorySkipNextBatch.delete(key)
      return
    }

    const list = this.chathistoryResolvers.get(key)
    if (list && list.length > 0) {
      const { resolve, timer } = list.shift()!
      if (list.length === 0) this.chathistoryResolvers.delete(key)
      clearTimeout(timer)
      const msgs = this.parseChathistoryBatch(event.commands, target, { applyJoinFilters: false })
      resolve(msgs)
      return
    }

    this.emitAutoReplayBatch(event.commands, target)
  }

  private emitAutoReplayBatch(commands: BatchCommand[], target: string): void {
    const msgs = this.parseChathistoryBatch(commands, target, { applyJoinFilters: true })
    for (const msg of msgs) {
      if (this.hasFingerprint(msg)) {
        this.log(`chathistory dedup skip ${msg.sender}@${msg.channel} ${msg.ts}`)
        continue
      }
      this.recordMessage(msg, true)
      this.emitMessage(msg, { historical: true, mention: msg.mention })
    }
  }

  private parseChathistoryBatch(
    commands: BatchCommand[],
    target: string,
    opts: { applyJoinFilters: boolean },
  ): IrcMessage[] {
    const cutoffMs = opts.applyJoinFilters && this.joinHistoryMinutes > 0
      ? Date.now() - this.joinHistoryMinutes * 60_000
      : 0
    // Channel batches (target starts with '#') always carry channel messages. Nick-keyed
    // batches always carry DMs between us and that peer; key all rows under the peer nick.
    const isDirect = targetIsDirect(target)
    const channelKey = target.toLowerCase()
    const batch: IrcMessage[] = []
    for (const c of commands) {
      if (c.command !== 'PRIVMSG') continue
      const sender = c.nick
      if (!sender) continue
      if (HISTORY_SERVICE_SENDERS.has(sender.toLowerCase())) continue
      const text = c.params[c.params.length - 1] ?? ''
      const serverTimeMs = c.getServerTime?.()
      if (cutoffMs > 0 && serverTimeMs !== undefined && serverTimeMs < cutoffMs) continue
      const ts = (serverTimeMs ? new Date(serverTimeMs) : new Date()).toISOString()
      const msg: IrcMessage = { channel: channelKey, sender, text, ts, isDirect }
      msg.mention = this.nickMentionRegex.test(text)
      batch.push(msg)
    }
    return opts.applyJoinFilters && this.joinHistoryLines > 0 ? batch.slice(-this.joinHistoryLines) : batch
  }

  // Window we expect ergo's auto-replay chathistory batch to land within after a
  // self-JOIN. chathistoryLatest awaits this window before sending its own query;
  // if no auto-replay arrives (empty channel, no history), the timer fires and the
  // awaiting query proceeds. Tight bound — replays land within ~100ms in practice;
  // anything wider just delays empty-channel queries for no benefit.
  private static readonly PENDING_JOIN_REPLAY_MS = 500

  private markPendingJoinReplay(channel: string): void {
    this.clearPendingJoinReplay(channel)
    let resolveDone!: () => void
    const done = new Promise<void>((r) => { resolveDone = r })
    const timer = setTimeout(() => {
      this.pendingJoinReplays.delete(channel)
      resolveDone()
    }, RoostIrcClientImpl.PENDING_JOIN_REPLAY_MS)
    timer.unref?.()
    this.pendingJoinReplays.set(channel, { timer, done, resolve: resolveDone })
  }

  private clearPendingJoinReplay(channel: string): void {
    const entry = this.pendingJoinReplays.get(channel)
    if (entry !== undefined) {
      clearTimeout(entry.timer)
      entry.resolve()
      this.pendingJoinReplays.delete(channel)
    }
  }

  private handleSocketClose(): void {
    this.log('socket closed')
    if (this.channelUsers.size > 0) {
      this.pendingRejoinChannels = [...this.channelUsers.keys()].sort()
      this.channelUsers.clear()
    }
    // Pre-empt pending resolvers; stale setTimeouts still fire but calling resolve() again is a no-op.
    for (const list of this.joinResolvers.values()) for (const r of list) r({ ok: false, members: [] })
    this.joinResolvers.clear()
    for (const list of this.partResolvers.values()) for (const r of list) r(false)
    this.partResolvers.clear()
    for (const list of this.chathistoryResolvers.values()) {
      for (const r of list) { clearTimeout(r.timer); r.resolve(null) }
    }
    this.chathistoryResolvers.clear()
    this.chathistoryQueriesByTarget.clear()
    this.chathistorySkipNextBatch.clear()
    for (const entry of this.pendingJoinReplays.values()) {
      clearTimeout(entry.timer)
      entry.resolve()
    }
    this.pendingJoinReplays.clear()
    this.chathistoryCapActive = false
    this.ircReady = false
    this.emitSystem('disconnected', '[roost] disconnected from IRC')
  }

  private handleSocketError(err: Error): void {
    this.log(`socket error: ${err.message}`)
  }
}
