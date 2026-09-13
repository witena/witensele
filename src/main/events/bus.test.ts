import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '@shared/events'
import { createEventBus } from './bus'

const testEvent = (payload: string): BackendEvent => ({ type: 'system.test', payload })

describe('events/bus', () => {
  it('delivers every event to every listener in subscription order', () => {
    const bus = createEventBus()
    const seen: string[] = []
    bus.subscribe((event) => seen.push(`a:${event.type}`))
    bus.subscribe((event) => seen.push(`b:${event.type}`))

    bus.emit(testEvent('one'))
    bus.emit(testEvent('two'))

    expect(seen).toEqual(['a:system.test', 'b:system.test', 'a:system.test', 'b:system.test'])
  })

  it('passes the event through unchanged', () => {
    const bus = createEventBus()
    const listener = vi.fn()
    bus.subscribe(listener)

    const event = testEvent('payload')
    bus.emit(event)

    expect(listener).toHaveBeenCalledWith(event)
  })

  it('stops delivering after the returned unsubscribe is called', () => {
    const bus = createEventBus()
    const listener = vi.fn()
    const unsubscribe = bus.subscribe(listener)

    bus.emit(testEvent('before'))
    unsubscribe()
    bus.emit(testEvent('after'))

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('unsubscribing twice is harmless', () => {
    const bus = createEventBus()
    const unsubscribe = bus.subscribe(() => {})
    unsubscribe()
    expect(() => unsubscribe()).not.toThrow()
  })

  it('logs a throwing listener and still reaches the others', () => {
    const bus = createEventBus()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const survivor = vi.fn()

    bus.subscribe(() => {
      throw new Error('listener exploded')
    })
    bus.subscribe(survivor)

    expect(() => bus.emit(testEvent('payload'))).not.toThrow()
    expect(survivor).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)

    error.mockRestore()
  })

  it('a listener added during delivery does not receive the event being delivered', () => {
    const bus = createEventBus()
    const late = vi.fn()
    bus.subscribe(() => {
      bus.subscribe(late)
    })

    bus.emit(testEvent('first'))
    expect(late).not.toHaveBeenCalled()

    bus.emit(testEvent('second'))
    expect(late).toHaveBeenCalledTimes(1)
  })
})
