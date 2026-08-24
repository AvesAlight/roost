// Shared by offline unit tests that drive RoostIrcClientImpl directly (no socket/ergo) and
// need to reach into its internals — the constructor wires everything eagerly.
import { RoostIrcClientImpl } from '../../src/irc-client-impl.js'

export const config = {
  nick: 'test-bot',
  autoJoin: [],
  historySize: 50,
  joinHistoryLines: 20,
  joinHistoryMinutes: 5,
}

export function makeClient() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new RoostIrcClientImpl(config) as any
}
