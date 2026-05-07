// @ts-expect-error — irc-framework lacks first-class type defs
import IRC from 'irc-framework'
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
} from './irc-client.js'

const CAP_CHATHISTORY = 'chathistory'

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

export class RoostIrcClientImpl implements RoostIrcClient {
  private readonly nick: string
  private readonly historySize: number
  private readonly joinHistoryLines: number
  private readonly joinHistoryMinutes: number
  private readonly autoJoin: string[]
  private readonly whoisTimeoutMs: number

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- irc-framework ships no types; see #156
  private readonly irc: any

  private ircReady = false
  private hasRegistered = false
  private readonly joinResolvers = new Map<string, Array<(ok: boolean) => void>>()
  private readonly partResolvers = new Map<string, Array<(ok: boolean) => void>>()
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
    this.historySize = config.historySize
    this.joinHistoryLines = config.joinHistoryLines
    this.joinHistoryMinutes = config.joinHistoryMinutes
    this.autoJoin = config.autoJoin
    this.whoisTimeoutMs = config.whoisTimeoutMs ?? 5000
    this.irc = new IRC.Client()
    this.registerHandlers()
  }

  // ---- Public interface --------------------------------------------------

  connect(opts: ConnectOpts): void {
    this.irc.requestCap(['draft/multiline', 'labeled-response', CAP_CHATHISTORY, 'server-time'])
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

  async join(channel: string): Promise<boolean> {
    channel = channel.toLowerCase()
    if (this.channelUsers.has(channel)) return true
    return new Promise<boolean>((resolve) => {
      const list = this.joinResolvers.get(channel) ?? []
      list.push(resolve)
      this.joinResolvers.set(channel, list)
      this.irc.join(channel)
      setTimeout(() => resolve(false), 5000).unref?.()
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

  // Record a message in history and dedupe set; increment unread unless historical.
  private recordMessage(msg: IrcMessage, historical = false): void {
    this.pushHistory(msg.channel, msg)
    this.addFingerprint(msg)
    if (!historical) {
      const prev = this.unread.get(msg.channel)
      this.unread.set(msg.channel, { count: (prev?.count ?? 0) + 1, lastSender: msg.sender, lastPreview: msg.text })
    }
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
    this.irc.on('batch end chathistory', (e: BatchEndEvent) => this.handleChathistoryBatch(e))
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
        const [k, v] = kv.split('=')
        const n = Number(v)
        if (!Number.isFinite(n) || n <= 0) continue
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
    const enabled: string[] = this.irc.network?.cap?.enabled ?? []
    this.log(
      enabled.includes(CAP_CHATHISTORY)
        ? `chathistory cap active — will replay up to ${this.joinHistoryLines} msgs / ${this.joinHistoryMinutes}min on join`
        : `chathistory cap NOT active — no history replay on join`,
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
      const list = this.joinResolvers.get(channel)
      if (list?.length) {
        for (const r of list) r(true)
        this.joinResolvers.delete(channel)
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
    this.log(`userlist for ${channel}: ${set.size} nicks (${[...set].sort().join(', ')})`)
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
    let firstChan: string | null = null
    for (const [chan, set] of this.channelUsers) {
      if (set.delete(event.nick)) {
        set.add(event.new_nick)
        if (!firstChan) firstChan = chan
      }
    }
    if (firstChan) {
      this.emitMembership('nick', event.nick, firstChan, { newNick: event.new_nick })
    }
  }

  private handleMessage(event: MessageEvent): void {
    if (event.nick === this.nick) return
    if (event.batch?.type === 'draft/multiline') return
    if (event.batch?.type === CAP_CHATHISTORY) return
    const isDirect = event.target === this.nick
    const channel = isDirect ? event.nick.toLowerCase() : event.target.toLowerCase()
    const ts = event.tags?.['time'] ?? new Date().toISOString()
    const msg: IrcMessage = { channel, sender: event.nick, text: event.message, ts, isDirect }
    this.recordMessage(msg)
    this.emitMessage(msg, {})
  }

  private handleMultilineBatch(event: BatchEndEvent): void {
    const rawTarget = event.params[0]
    if (!rawTarget) return
    const cmds = event.commands.filter(c => c.command === 'PRIVMSG')
    if (cmds.length === 0) return
    const sender = cmds[0].nick
    if (sender === this.nick) return
    const text = reassembleMultilineBatch(cmds)
    const isDirect = rawTarget === this.nick
    const channel = isDirect ? sender.toLowerCase() : rawTarget.toLowerCase()
    const serverTimeMs = cmds[0].getServerTime?.()
    const ts = (serverTimeMs ? new Date(serverTimeMs) : new Date()).toISOString()
    const msg: IrcMessage = { channel, sender, text, ts, isDirect }
    this.recordMessage(msg)
    this.emitMessage(msg, { buffered: cmds.length > 1, chunkCount: cmds.length })
  }

  private handleChathistoryBatch(event: BatchEndEvent): void {
    const target = event.params[0]
    if (!target) return
    const msgs = this.parseChathistoryBatch(event.commands, target)
    for (const msg of msgs) {
      if (this.hasFingerprint(msg)) {
        this.log(`chathistory dedup skip ${msg.sender}@${msg.channel} ${msg.ts}`)
        continue
      }
      this.recordMessage(msg, true)
      this.emitMessage(msg, { historical: true })
    }
  }

  private parseChathistoryBatch(commands: BatchCommand[], target: string): IrcMessage[] {
    const cutoffMs = this.joinHistoryMinutes > 0 ? Date.now() - this.joinHistoryMinutes * 60_000 : 0
    const batch: IrcMessage[] = []
    for (const c of commands) {
      if (c.command !== 'PRIVMSG') continue
      const sender = c.nick
      if (!sender || sender === this.nick) continue
      const text = c.params[c.params.length - 1] ?? ''
      const isDirect = target === this.nick
      const channel = isDirect ? sender.toLowerCase() : target.toLowerCase()
      const serverTimeMs = c.getServerTime?.()
      if (cutoffMs > 0 && serverTimeMs !== undefined && serverTimeMs < cutoffMs) continue
      const ts = (serverTimeMs ? new Date(serverTimeMs) : new Date()).toISOString()
      batch.push({ channel, sender, text, ts, isDirect })
    }
    return this.joinHistoryLines > 0 ? batch.slice(-this.joinHistoryLines) : batch
  }

  private handleSocketClose(): void {
    this.log('socket closed')
    if (this.channelUsers.size > 0) {
      this.pendingRejoinChannels = [...this.channelUsers.keys()].sort()
      this.channelUsers.clear()
    }
    // Pre-empt pending resolvers; stale setTimeouts still fire but calling resolve() again is a no-op.
    for (const list of this.joinResolvers.values()) for (const r of list) r(false)
    this.joinResolvers.clear()
    for (const list of this.partResolvers.values()) for (const r of list) r(false)
    this.partResolvers.clear()
    this.ircReady = false
    this.emitSystem('disconnected', '[roost] disconnected from IRC')
  }

  private handleSocketError(err: Error): void {
    this.log(`socket error: ${err.message}`)
  }
}
