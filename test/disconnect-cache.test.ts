import { describe, it, expect } from 'bun:test'
import { RoostIrcClientImpl } from '../src/irc-client-impl.js'

const config = {
  nick: 'test-bot',
  autoJoin: [],
  historySize: 50,
  joinHistoryLines: 20,
  joinHistoryMinutes: 5,
}

function makeClient() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new RoostIrcClientImpl(config) as any
}

describe('channelUsers cache cleared on disconnect', () => {
  it('isJoined returns false immediately after socket close', () => {
    const client = makeClient()
    client.channelUsers.set('#test', new Set(['test-bot', 'peer']))

    expect(client.isJoined('#test')).toBe(true)

    client.handleSocketClose()

    expect(client.isJoined('#test')).toBe(false)
  })

  it('pendingRejoinChannels captures the channel set for rejoin', () => {
    const client = makeClient()
    client.channelUsers.set('#alpha', new Set(['test-bot']))
    client.channelUsers.set('#beta', new Set(['test-bot']))

    client.handleSocketClose()

    expect(client.pendingRejoinChannels).toEqual(['#alpha', '#beta'])
  })

  it('second socket close (failed reconnect) does not wipe pending list', () => {
    const client = makeClient()
    client.channelUsers.set('#keep', new Set(['test-bot']))

    client.handleSocketClose()
    expect(client.pendingRejoinChannels).toEqual(['#keep'])

    // Second close — channelUsers is already empty; pending list must survive
    client.handleSocketClose()
    expect(client.pendingRejoinChannels).toEqual(['#keep'])
  })

  it('handleReconnect consumes pendingRejoinChannels and clears it', () => {
    const client = makeClient()
    client.channelUsers.set('#ch', new Set(['test-bot']))
    client.handleSocketClose()

    // Simulate reconnect (normally called from handleRegistered on second connect)
    client.hasRegistered = true
    client.handleReconnect()

    expect(client.pendingRejoinChannels).toEqual([])
  })
})
