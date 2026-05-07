import IRC from 'irc-framework'
import { afterAll } from 'bun:test'
import type { ErgoContext } from './ergo.js'
import { suppressLateRejection } from './tool.js'

let peerCounter = 0

export interface PeerMessage {
  nick: string
  text: string
}

// IMPORTANT: waitForMessage / waitForPart register the waiter when called.
// irc-framework's EventEmitter is synchronous and does NOT replay past events,
// so an event that fires before the waiter is registered is lost forever.
// Always start the wait BEFORE the action that triggers the event:
//
//   const seen = peer.waitForMessage(...)   // register first
//   await mcp.callTool(...)                 // then trigger
//   await seen                              // then await
//
// Calling waitFor* AFTER the trigger races: on fast paths (CI, in-process),
// the event can arrive before the waiter is registered, and the test hangs
// until timeout.
export interface PeerContext {
  nick: string
  joinChannel(channel: string): Promise<void>
  leaveChannel(channel: string): Promise<void>
  say(channel: string, text: string): void
  kick(channel: string, nick: string, reason?: string): void
  changeNick(newNick: string, timeoutMs?: number): Promise<void>
  waitForMessage(
    channel: string,
    pred: (msg: PeerMessage) => boolean,
    timeoutMs?: number,
  ): Promise<PeerMessage>
  waitForPart(channel: string, nick: string, timeoutMs?: number): Promise<void>
}

export async function connectPeer(ergo: ErgoContext, nick?: string): Promise<PeerContext> {
  const peerNick = nick ?? `peer${++peerCounter}`

  const client = new IRC.Client()

  await suppressLateRejection(new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`peer ${peerNick} connect timed out`)), 5000)
    client.on('registered', () => { clearTimeout(timeout); resolve() })
    client.on('close', () => reject(new Error('peer connection closed during connect')))
    client.connect({
      host: ergo.host,
      port: ergo.port,
      nick: peerNick,
      auto_reconnect: false,
      enable_echomessage: true,
    })
  }))

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

  const waitForPart = (channel: string, nick: string, timeoutMs = 5000): Promise<void> =>
    suppressLateRejection(new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.removeListener('part', onPart)
        reject(new Error(`waitForPart ${nick} in ${channel} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const onPart = (event: { nick: string; channel: string }) => {
        if (event.nick === nick && event.channel === channel) {
          client.removeListener('part', onPart)
          clearTimeout(timer)
          resolve()
        }
      }
      client.on('part', onPart)
    }))

  return {
    nick: peerNick,

    joinChannel(channel) {
      return suppressLateRejection(new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`joinChannel ${channel} timed out`)),
          5000,
        )
        const onJoin = (event: { nick: string; channel: string }) => {
          if (event.nick === peerNick && event.channel === channel) {
            client.removeListener('join', onJoin)
            clearTimeout(timeout)
            resolve()
          }
        }
        client.on('join', onJoin)
        client.join(channel)
      }))
    },

    leaveChannel(channel) {
      client.part(channel)
      return waitForPart(channel, peerNick)
    },

    say(channel, text) {
      client.say(channel, text)
    },

    kick(channel, nick, reason) {
      client.raw('KICK', channel, nick, ...(reason ? [reason] : []))
    },

    changeNick(newNick, timeoutMs = 5000) {
      return suppressLateRejection(new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          client.removeListener('nick', onNick)
          reject(new Error(`changeNick to ${newNick} timed out`))
        }, timeoutMs)
        const onNick = (event: { nick: string; new_nick: string }) => {
          if (event.new_nick === newNick) {
            client.removeListener('nick', onNick)
            clearTimeout(timer)
            resolve()
          }
        }
        client.on('nick', onNick)
        client.changeNick(newNick)
      }))
    },

    waitForPart,

    waitForMessage(channel, pred, timeoutMs = 5000) {
      return suppressLateRejection(new Promise<PeerMessage>((resolve, reject) => {
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
      }))
    },
  }
}
