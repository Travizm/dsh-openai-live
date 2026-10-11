import { describe, expect, it } from 'vitest'
import { TransportRegistry } from '../src/transport.ts'

describe('TransportRegistry', () => {
  it('reports nothing when no plugin has declared a transport', () => {
    // Empty is a fault for a voice plugin rather than a quiet state: nothing can carry a microphone. The
    // registry reports the fact; deciding it is wrong belongs to whoever asks.
    expect(new TransportRegistry().snapshot()).toEqual([])
  })

  it('reports the transports in force, oldest first', () => {
    // A second declaration must not displace the first, and a reader that found one route where there were two
    // would be reporting on whichever plugin happened to load last.
    const registry = new TransportRegistry()
    registry.add(() => ({ path: '/first', clients: 0 }))
    registry.add(() => ({ path: '/second', clients: 1 }))

    expect(registry.snapshot()).toEqual([
      { path: '/first', clients: 0 },
      { path: '/second', clients: 1 },
    ])
  })

  it('reads the report when it is asked, not when the transport was declared', () => {
    // A client count is a fact about now. A captured one would go on describing a connection that has since
    // gone, which is the failure this whole registry exists to make visible.
    let clients = 0
    const registry = new TransportRegistry()
    registry.add(() => ({ path: '/audio', clients }))

    clients = 2
    expect(registry.snapshot()).toEqual([{ path: '/audio', clients: 2 }])
  })

  it('withdraws a declaration with its disposer, and only that one', () => {
    const registry = new TransportRegistry()
    const release = registry.add(() => ({ path: '/first', clients: 0 }))
    registry.add(() => ({ path: '/second', clients: 0 }))

    release()

    expect(registry.snapshot()).toEqual([{ path: '/second', clients: 0 }])
  })

  it('cannot withdraw somebody else’s transport by releasing a stale disposer twice', () => {
    const registry = new TransportRegistry()
    const stale = registry.add(() => ({ path: '/first', clients: 0 }))
    stale()
    registry.add(() => ({ path: '/second', clients: 0 }))

    stale()

    expect(registry.snapshot()).toEqual([{ path: '/second', clients: 0 }])
  })
})
