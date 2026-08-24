declare module 'irc-framework' {
  // Shape of the parsed line command_handler.dispatch() receives.
  export interface IrcRawMessage {
    command: string
    params: string[]
    tags?: Record<string, string>
    prefix?: string
    nick?: string
    ident?: string
    hostname?: string
  }

  export interface IrcCommandCache {
    commands: unknown[]
    type?: string
    params?: string[]
    [key: string]: unknown
  }

  // Internal-but-public API — routes every parsed line and buffers BATCH members.
  export interface IrcCommandHandler {
    dispatch(message: IrcRawMessage): void
    cache(id: string): IrcCommandCache
    hasCache(id: string): boolean
  }

  export interface IrcFrameworkClient {
    command_handler: IrcCommandHandler
    requestCap(caps: string[]): void
    connect(opts: {
      host: string
      port: number
      nick: string
      username?: string
      gecos?: string
      auto_reconnect?: boolean
      auto_reconnect_max_retries?: number
      enable_echomessage?: boolean
    }): void
    join(channel: string): void
    part(channel: string): void
    say(target: string, text: string): void
    raw(...args: string[]): void
    whois(nick: string, callback: (event: { channels?: string }) => void): void
    changeNick(nick: string): void
    quit(): void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- irc-framework dispatches events dynamically; any[] needed for handler assignability
    on(event: string, handler: (...args: any[]) => void): void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    removeListener(event: string, handler: (...args: any[]) => void): void
    connection: { write(data: string): void }
    network?: {
      cap?: { enabled?: string[]; available?: Map<string, string> }
      supports?: (name: string) => string | boolean | undefined
    }
  }

  interface IrcNamespace {
    Client: new () => IrcFrameworkClient
  }

  const IRC: IrcNamespace
  export default IRC
}
