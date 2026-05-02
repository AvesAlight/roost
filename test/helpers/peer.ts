// @ts-expect-error — irc-framework lacks first-class type defs
import IRC from 'irc-framework'
import { afterAll } from 'bun:test'
import type { ErgoContext } from './ergo.js'

let peerCounter = 0

export interface PeerMessage {
  nick: string
  text: string
}

export interface PeerContext {
  nick: string
  joinChannel(channel: string): Promise<void>
  say(channel: string, text: string): void
  waitForMessage(
    channel: string,
    pred: (msg: PeerMessage) => boolean,
    timeoutMs?: number,
  ): Promise<PeerMessage>
}

export async function connectPeer(ergo: ErgoContext, nick?: string): Promise<PeerContext> {
  const peerNick = nick ?? `peer${++peerCounter}`

  const client = new IRC.Client()

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`peer ${peerNick} connect timed out`)), 5000)
    client.on('registered', () => { clearTimeout(timeout); resolve() })
    client.on('close', () => reject(new Error('peer connection closed during connect')))
    client.connect({
      host: ergo.host,
      port: ergo.port,
      nick: peerNick,
      auto_reconnect: false,
    })
  })

  const messageWaiters: Array<{
    channel: string
    pred: (msg: PeerMessage) => boolean
    resolve: (msg: PeerMessage) => void
    reject: (e: Error) => void
  }> = []

  client.on('message', (event: { nick: string; target: string; message: string }) => {
    const msg: PeerMessage = { nick: event.nick, text: event.message }
    for (let i = messageWaiters.length - 1; i >= 0; i--) {
      const w = messageWaiters[i]
      if (w.channel === event.target && w.pred(msg)) {
        messageWaiters.splice(i, 1)
        w.resolve(msg)
      }
    }
  })

  afterAll(() => {
    client.quit()
  })

  return {
    nick: peerNick,

    joinChannel(channel) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`joinChannel ${channel} timed out`)),
          5000,
        )
        client.on('join', (event: { nick: string; channel: string }) => {
          if (event.nick === peerNick && event.channel === channel) {
            clearTimeout(timeout)
            resolve()
          }
        })
        client.join(channel)
      })
    },

    say(channel, text) {
      client.say(channel, text)
    },

    waitForMessage(channel, pred, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = messageWaiters.findIndex(w => w.resolve === resolve)
          if (idx !== -1) messageWaiters.splice(idx, 1)
          reject(new Error(`waitForMessage on ${channel} timed out after ${timeoutMs}ms`))
        }, timeoutMs)

        messageWaiters.push({
          channel,
          pred,
          resolve: (msg) => { clearTimeout(timer); resolve(msg) },
          reject,
        })
      })
    },
  }
}
