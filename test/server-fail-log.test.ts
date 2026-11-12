import { describe, it, expect, spyOn } from 'bun:test'
import { makeClient } from './helpers/offline-client.js'

// A server FAIL (e.g. a rejected multiline batch) means the message was dropped;
// the client has to say so rather than fail silently.
describe('server FAIL replies', () => {
  it('are logged with their code and description', () => {
    const client = makeClient()
    const write = spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      client.irc.command_handler.dispatch({
        command: 'FAIL',
        params: ['BATCH', 'MULTILINE_MAX_LINES', '200', 'multiline batch has too many lines'],
        tags: {},
      })
      const logged = write.mock.calls.map(c => String(c[0])).join('')
      expect(logged).toContain('server FAIL BATCH MULTILINE_MAX_LINES 200 multiline batch has too many lines')
    } finally {
      write.mockRestore()
    }
  })
})
