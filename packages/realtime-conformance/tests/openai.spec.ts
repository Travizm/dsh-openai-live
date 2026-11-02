import { describe, expect, it } from 'vitest'
import type { RealtimeTranscript } from 'dsh-realtime'
import { OpenAiLiveAdapter } from 'dsh-realtime-openai'
import type { OpenAiLiveConfig, RealtimeTransport, RealtimeTransportHandlers } from 'dsh-realtime-openai'
import { runConformance } from '../src/index.ts'
import type { ConformanceSubject, ConformanceWire } from '../src/index.ts'

/** A transport the test drives by hand: everything sent is recorded, nothing leaves the process. */
class FakeTransport implements RealtimeTransport {
  readonly sent: string[] = []
  private readonly handlers: RealtimeTransportHandlers

  constructor(handlers: RealtimeTransportHandlers) {
    this.handlers = handlers
  }

  send(frame: string): void {
    this.sent.push(frame)
  }

  close(): void {
    this.handlers.onClose(1000, 'closed by test')
  }

  /** Deliver one server frame. */
  deliver(event: Record<string, unknown>): void {
    this.handlers.onMessage(JSON.stringify(event))
  }
}

/** Let the adapter's async connect settle. */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const CONFIG: OpenAiLiveConfig = {
  apiKey: 'test-key-not-a-real-credential',
  baseURL: 'wss://example.test/v1/live/sessions',
  provider: 'openai-live',
  model: 'gpt-live-1',
  voice: 'marin',
  appendAckTimeoutMs: 50,
  establishTimeoutMs: 50,
}

/**
 * GPT-Live-1 under the same harness Deepgram runs under.
 *
 * The two subjects are deliberately built the same way — fake wire, scripted acknowledgement, no network — so a
 * difference in outcome is a difference in the adapter or its declaration, never in how the test drives it.
 */
function openaiSubject(): ConformanceSubject {
  const transports: FakeTransport[] = []
  const adapter = new OpenAiLiveAdapter(CONFIG, {
    async connect(
      _url: string,
      _headers: Readonly<Record<string, string>>,
      handlers: RealtimeTransportHandlers,
    ): Promise<RealtimeTransport> {
      const transport = new FakeTransport(handlers)
      transports.push(transport)
      return transport
    },
  })

  const open = async ({ ack }: { ack: boolean }): Promise<ConformanceWire> => {
    const transcripts: RealtimeTranscript[] = []
    const opened = adapter.session({
      provider: 'openai-live',
      model: 'gpt-live-1',
      handlers: { onTranscript: transcript => transcripts.push(transcript) },
    })
    await tick()
    const transport = transports.at(-1)
    if (transport === undefined) throw new Error('the adapter opened no transport')
    if (ack) transport.deliver({ type: 'session.started', session: { model: 'gpt-live-1' } })
    const session = await opened

    return {
      session,
      // This provider declares incremental transcripts, so the harness never asks for a fragment's granularity —
      // and the delta frames' shape is not worth guessing for a call that cannot happen.
      deliver: () => transcripts,
      promptWrites: async updates => {
        const writes: string[] = []
        for (const update of updates) {
          await session.appendInstructions(update)
          // The content is somewhere inside the frame the adapter wrote; matching on the whole frame keeps this
          // observation independent of the wire's field names, which are the adapter's business.
          writes.push(transport.sent.at(-1) ?? '')
        }
        return writes
      },
      close: () => session.close(),
    }
  }

  return { route: 'openai-live', adapter, open }
}

describe('conformance — GPT-Live-1', () => {
  it('honours its declaration on every check this harness can exercise', async () => {
    // The second subject, and therefore the C-1 proof: one specification, two providers, both held to the same
    // invariants. A pass here and a fail on Deepgram is the property "swappable" was meant to name.
    await expect(runConformance(openaiSubject())).resolves.toEqual([])
  })
})
