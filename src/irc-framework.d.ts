declare module 'irc-framework' {
  export interface IrcFrameworkClient {
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
    network?: { cap?: { enabled?: string[]; available?: Map<string, string> } }
  }

  interface IrcNamespace {
    Client: new () => IrcFrameworkClient
  }

  const IRC: IrcNamespace
  export default IRC
}
