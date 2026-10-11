import { describe, expect, it } from 'vitest'
import { SteeringRegistry } from '../src/steering.ts'

describe('SteeringRegistry', () => {
  it('reports nothing when nobody has declared a claim', () => {
    // Empty is an answer, not an absence: it says a delegation raised now would be answered by nobody.
    expect(new SteeringRegistry().snapshot()).toEqual([])
  })

  it('reports the claims in force, oldest first', () => {
    // Ordered, because a reader rendering this wants a stable list and declaration order is the only order
    // that is stable without treating one plugin's name as a rank.
    const registry = new SteeringRegistry()
    registry.add({ owner: 'realtime-responder', sessionId: () => 'session-a' })
    registry.add({ owner: 'another-responder', sessionId: () => 'session-b' })

    expect(registry.snapshot()).toEqual([
      { owner: 'realtime-responder', sessionId: 'session-a' },
      { owner: 'another-responder', sessionId: 'session-b' },
    ])
  })

  it('reads the session when it is asked, not when the claim was made', () => {
    // The session is a **live** setting. A responder pointed at another conversation must read differently
    // here from the moment that change lands; a value captured at declaration would go on describing where
    // it used to point, which is the one thing a status surface must never do.
    let session = 'session-a'
    const registry = new SteeringRegistry()
    registry.add({ owner: 'realtime-responder', sessionId: () => session })

    session = 'session-b'
    expect(registry.snapshot()).toEqual([{ owner: 'realtime-responder', sessionId: 'session-b' }])
  })

  it('withdraws a claim with its disposer, and only that claim', () => {
    const registry = new SteeringRegistry()
    const release = registry.add({ owner: 'one', sessionId: () => 'session-a' })
    registry.add({ owner: 'two', sessionId: () => 'session-b' })

    release()

    expect(registry.snapshot()).toEqual([{ owner: 'two', sessionId: 'session-b' }])
  })

  it('cannot withdraw somebody else’s claim by releasing a stale disposer twice', () => {
    // The reason the token is never reused, tested as behaviour rather than asserted as a property: a
    // recycled token would let a disposer held from an earlier claim remove the claim that took its slot,
    // and a plugin disposed and remounted would silently stop being reported.
    const registry = new SteeringRegistry()
    const stale = registry.add({ owner: 'one', sessionId: () => 'session-a' })
    stale()
    registry.add({ owner: 'two', sessionId: () => 'session-b' })

    stale()

    expect(registry.snapshot()).toEqual([{ owner: 'two', sessionId: 'session-b' }])
  })
})
