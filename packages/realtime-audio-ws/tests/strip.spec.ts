/**
 * The strip's rows, and the bootstrap it ships.
 *
 * The bootstrap is a *string* — an inline script the page executes — and a string that nothing runs is a
 * feature that nothing checks, which is the same defect class as a build artefact no test reads. So it is
 * executed here for real, through a function with a fake scope, and every path it has is driven: a page
 * whose bundle has not landed yet, and one that is still parsing its body.
 */

import { describe, expect, it } from 'vitest'
import { STRIP_ELEMENT_ID, stripBootstrap, stripMarkup, stripRows } from '../src/strip.ts'

/** A fake page scope: what the bootstrap reads, and what it must not. */
function scope(over: {
  client?: unknown
  readyState?: string
} = {}) {
  const mounted: number[] = []
  const listeners: string[] = []
  const client = over.client === undefined ? { mount: () => { mounted.push(1) } } : over.client
  const global = { __dshRealtimeAudio: client }
  const document = {
    readyState: over.readyState ?? 'complete',
    addEventListener: (type: string) => { listeners.push(type) },
  }
  return { global, document, mounted, listeners }
}

/** Run the shipped bootstrap as the page would: a function over the scope it reads. */
function run(script: string, target: ReturnType<typeof scope>): void {
  // eslint-disable-next-line no-new-func -- executing our own shipped string is the point of this test.
  new Function('globalThis', 'document', script)(target.global, target.document)
}

describe('stripRows', () => {
  it('contributes the markup and then the bootstrap, both in the body', () => {
    expect(stripRows()).toEqual([
      { kind: 'html', placement: 'body', html: stripMarkup() },
      { kind: 'script', placement: 'body', text: stripBootstrap() },
    ])
  })

  it('is opaque, because the page it covers has its own text behind it', () => {
    // The defect this pins, reported from a screenshot of the running app: an 8% wash let the host page's
    // text read *through* the panel, so two texts sat superimposed and neither was legible. Opacity is not
    // decoration here — it is the accessibility requirement — and no DOM test can see what is *behind* an
    // element, which is why this asserts the paint rather than a rendered pixel.
    const markup = stripMarkup()
    expect(markup).not.toMatch(/background:[^;]*transparent/)
    expect(markup).toMatch(/background:color-mix\(in srgb, ?Canvas/)
    // Above the page rather than blended into it.
    expect(markup).toMatch(/box-shadow:/)
  })

  it('carries an element the client can find, and no behaviour of its own', () => {
    const markup = stripMarkup()
    expect(markup).toContain(`id="${STRIP_ELEMENT_ID}"`)
    // Nothing executable in the markup: the panel is rendered by the bundle, and a row that carried logic
    // would be logic no test could reach.
    expect(markup).not.toContain('<script')
    expect(markup).not.toContain('onclick')
  })

  it('never closes its own element early, which would truncate the row', () => {
    // The table's own contract: a `script` row's text is spliced into the document's text, so a closing tag
    // inside it ends the element and everything after it becomes markup.
    expect(stripBootstrap()).not.toContain('</script')
    expect(stripMarkup()).not.toContain('</style')
  })
})

describe('the bootstrap', () => {
  it('mounts the panel through the client bundle', () => {
    const page = scope()
    run(stripBootstrap(), page)
    expect(page.mounted).toHaveLength(1)
    expect(page.listeners).toEqual([])
  })

  it('does nothing when the bundle has not been materialised yet', () => {
    // The module table decides when the bundle exists, and it may land after this row. Doing nothing is
    // correct here: the bundle mounts the panel itself when it applies, and one of the two orderings wins.
    const page = scope({ client: undefined })
    expect(() => { run(stripBootstrap(), page) }).not.toThrow()
    const other = scope({ client: {} })
    expect(() => { run(stripBootstrap(), other) }).not.toThrow()
    expect(other.mounted).toEqual([])
  })

  it('waits for the body when the page is still parsing it', () => {
    const page = scope({ readyState: 'loading' })
    run(stripBootstrap(), page)
    expect(page.mounted).toHaveLength(1)
    expect(page.listeners).toEqual(['DOMContentLoaded'])
  })
})
