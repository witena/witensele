import { describe, expect, it } from 'vitest'
import { BackendFailure } from './errors'
import { IPC_EVENT, IPC_INVOKE, toBackendError } from './ipc-protocol'

describe('ipc-protocol', () => {
  it('uses namespaced channel names that cannot collide with an app channel', () => {
    expect(IPC_INVOKE).toBe('witena:invoke')
    expect(IPC_EVENT).toBe('witena:event')
    expect(IPC_INVOKE).not.toBe(IPC_EVENT)
  })

  describe('toBackendError', () => {
    it('keeps the code, message and details of a BackendFailure', () => {
      const failure = new BackendFailure('not_found', 'chat not found: 42', { id: '42' })

      expect(toBackendError(failure)).toEqual({
        code: 'not_found',
        message: 'chat not found: 42',
        details: { id: '42' }
      })
    })

    it('omits details entirely when the failure carries none', () => {
      const error = toBackendError(new BackendFailure('validation', 'bad input'))

      expect(error).toEqual({ code: 'validation', message: 'bad input' })
      expect('details' in error).toBe(false)
    })

    it('maps an ordinary Error to internal and keeps its message', () => {
      expect(toBackendError(new TypeError('x is not a function'))).toEqual({
        code: 'internal',
        message: 'x is not a function'
      })
    })

    it('maps a non-Error throw to internal', () => {
      expect(toBackendError('boom')).toEqual({ code: 'internal', message: 'boom' })
      expect(toBackendError(undefined)).toEqual({ code: 'internal', message: 'undefined' })
    })
  })
})
