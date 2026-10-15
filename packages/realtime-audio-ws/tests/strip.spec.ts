/**
 * The strip's rows: the plate's stylesheet, its container, and the bootstrap.
 *
 * Two things here cannot be checked any other way. The bootstrap is a *string* — an inline script the page
 * executes — and a string that nothing runs is a feature that nothing checks, which is the same defect class
 * as a build artefact no test reads. So it is executed here for real, through a function with a fake scope,
 * and every path it has is driven: a page whose bundle has not landed yet, and one that is still parsing its
 * body.
 *
 * And the stylesheet is a third file that has to agree with two others — the client's markup, which wears its
 * class names, and the *paint* the running app produces, which no DOM assertion can see. So the paint is
 * asserted against the layer that decides it, and the class names are read out of both files and compared.
 */

import { describe, expect, it } from 'vitest'
import {
  STRIP_ELEMENT_ID,
  STRIP_HEIGHT_PX,
  stripBootstrap,
  stripMarkup,
  stripRows,
  stripStyles,
} from '../src/strip.ts'
import { renderStrip } from '../src/client/index.ts'

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

/** The body of one rule, located by its selector. */
function rule(css: string, selector: string): string {
  const match = new RegExp(`(?:^|\\n)\\s*${selector.replaceAll('.', '\\.')}\\s*\\{([^}]*)\\}`, 'u').exec(css)
  if (match === null) throw new Error(`no rule for ${selector}`)
  return match[1]!
}

/**
 * The layers of a `background` value, split on the commas that are *not* inside a function.
 *
 * A gradient's own colours are comma-separated, so a naive split reads one layer as several and the guard
 * below ends up examining a colour instead of the layer that decides what shows through.
 * @param value - the `background` declaration's value.
 * @returns the layers, topmost first.
 */
function layers(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const character of value) {
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (character === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  out.push(current.trim())
  return out
}

/** Every class name a piece of markup wears. */
function classesIn(markup: string): string[] {
  return [...markup.matchAll(/class="([^"]*)"/gu)].flatMap(match => match[1]!.split(/\s+/u)).filter(Boolean)
}

/** Every class name a stylesheet defines. */
function classesDefined(css: string): string[] {
  return [...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/gu)].map(match => match[1]!)
}

describe('stripRows', () => {
  it('contributes the stylesheet, then the markup, then the bootstrap', () => {
    expect(stripRows()).toEqual([
      { kind: 'style', text: stripStyles() },
      { kind: 'html', placement: 'body', html: stripMarkup() },
      { kind: 'script', placement: 'body', text: stripBootstrap() },
    ])
  })

  it('is opaque, because the page it covers has its own text behind it', () => {
    // The defect this pins, reported from a screenshot of the running app: a wash let the host page's text
    // read *through* the panel, so two texts sat superimposed and neither was legible. Opacity is not
    // decoration here — it is the accessibility requirement — and no DOM test can see what is *behind* an
    // element, which is why this asserts the paint rather than a rendered pixel.
    //
    // The layer that decides it is the LAST one. The brushed top layer is deliberately translucent, and it
    // is only safe because there is a solid plate under it.
    const plate = layers(rule(stripStyles(), '#dsh-realtime-strip').match(/background:([^;]+);/u)![1]!)
    expect(plate.length).toBeGreaterThan(1)
    expect(plate.at(-1)).toMatch(/^linear-gradient\(180deg, #26282c/)
    expect(plate.at(-1)).not.toMatch(/transparent|rgb[a]?\([^)]*\/\s*0?\.\d/)
    // Above the page rather than blended into it.
    expect(rule(stripStyles(), '#dsh-realtime-strip')).toMatch(/box-shadow:/)
  })

  it('gives the app its bottom band back, so the plate never covers the conversation', () => {
    // The whole point of docking rather than floating: a fixed overlay in a page this plugin does not
    // control always overlaps something, so what it overlaps is the page's own chrome. The reservation has
    // to out-specify the host's own `body` rule and stay inside 100%, or it trades an overlap for a
    // scrollbar.
    const reserved = rule(stripStyles(), 'html body')
    expect(reserved).toContain(`padding-bottom: ${String(STRIP_HEIGHT_PX)}px`)
    expect(reserved).toContain('box-sizing: border-box')
    expect(rule(stripStyles(), '.dvr-row')).toContain(`height: ${String(STRIP_HEIGHT_PX)}px`)
  })

  it('carries an element the client can find, and no behaviour of its own', () => {
    const markup = stripMarkup()
    expect(markup).toContain(`id="${STRIP_ELEMENT_ID}"`)
    // Nothing executable in the markup, and nothing designed in it either: the panel is rendered by the
    // bundle and styled by this file's stylesheet, and a row that carried either would be logic or design no
    // test could reach.
    expect(markup).not.toContain('<script')
    expect(markup).not.toContain('onclick')
    expect(markup).not.toContain('style=')
  })

  it('never closes its own element early, and never opens one', () => {
    // The table's own contract: a row's text is spliced into the document's text, so a closing tag inside it
    // ends the element and everything after it becomes markup. A `<` anywhere in the stylesheet opens an
    // element just as surely, which is why it is banned rather than merely discouraged.
    expect(stripBootstrap()).not.toContain('</script')
    expect(stripMarkup()).not.toContain('</style')
    expect(stripStyles()).not.toContain('</style')
    expect(stripStyles()).not.toContain('<')
  })

  it('defines every class the panel wears, so the plate and its markup cannot drift apart', () => {
    // Two files, one design: this one writes the stylesheet and the client writes the markup that wears it.
    // Nothing in either is wrong on its own when a class stops matching — the panel simply renders unstyled,
    // which is the defect the screenshot showed in the first place.
    const defined = new Set(classesDefined(stripStyles()))
    const worn = new Set([
      ...classesIn(stripMarkup()),
      ...classesIn(renderStrip({
        reply: {
          ok: true,
          verb: 'status',
          voice: { open: true },
          settings: [
            { key: 'a.number', field: 'number', kind: 'number', scope: 'live', value: 1 },
            { key: 'a.boolean', field: 'boolean', kind: 'boolean', scope: 'live', value: true },
            { key: 'a.list', field: 'list', kind: 'string-list', scope: 'live', value: ['x'] },
            { key: 'a.secret', field: 'secret', kind: 'string-list', scope: 'live', value: undefined },
            { key: 'a.pick', field: 'sessionId', kind: 'string', scope: 'live', value: 'x', choices: ['x'] },
            { key: 'a.fixed', field: 'fixed', kind: 'string', scope: 'session', value: 'x' },
          ],
        },
        notes: { 'a.number': 'applied' },
        notice: 'something happened',
        noticeLink: 'https://example.invalid/',
        audio: { kind: 'failed', reason: 'no' },
        level: 'all',
        drafts: {},
        connecting: false,
      })),
    ])
    expect([...worn].filter(name => !defined.has(name))).toEqual([])
    // And the guard is not vacuous: it is reading a real set of names out of both files.
    expect(worn.size).toBeGreaterThan(20)
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
