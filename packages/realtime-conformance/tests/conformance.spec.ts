import { describe, expect, it } from 'vitest'
import { REALTIME_ERROR_CODES, RealtimeAdapter, RealtimeError } from 'dsh-realtime'
import type {
  BooleanCapability,
  RealtimeCapabilities,
  RealtimeProviderInfo,
  RealtimeSession,
  RealtimeSessionOptions,
  RealtimeTranscript,
} from 'dsh-realtime'
import { AGENT_ENDPOINT, DeepgramAdapter } from 'dsh-realtime-deepgram'
import type { SocketLike } from 'dsh-realtime-deepgram'
import { runConformance } from '../src/index.ts'
import type { ConformanceSubject, ConformanceWire } from '../src/index.ts'

type Listener = (...args: never[]) => void

/** A socket the test drives by hand: nothing arrives unless this file says so. */
class FakeSocket implements SocketLike {
  readonly sent: (string | Uint8Array)[] = []
  closes = 0
  private readonly listeners = new Map<string, Listener[]>()

  send(data: string | Uint8Array): void {
    this.sent.push(data)
  }
  close(): void {
    this.closes += 1
  }
  on(event: 'open' | 'message' | 'close' | 'error', listener: Listener): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }
  emit(event: 'open' | 'message' | 'close' | 'error', ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as (...a: unknown[]) => void)(...args)
  }
  frame(type: string, extra: Record<string, unknown> = {}): void {
    this.emit('message', JSON.stringify({ type, ...extra }))
  }
  /** Every frame this socket was asked to send, decoded. */
  writes(): Record<string, unknown>[] {
    return this.sent.filter((item): item is string => typeof item === 'string').map(item => JSON.parse(item) as Record<string, unknown>)
  }
}

/**
 * Deepgram, driven end to end: a fake socket, a scripted acknowledgement, and nothing else.
 *
 * This is the L5 adapter under the chamber's own conformance harness rather than its own tests, which is the
 * point — the invariants are the harness's, not the provider's.
 */
function deepgramSubject(): ConformanceSubject {
  const sockets: FakeSocket[] = []
  const adapter = new DeepgramAdapter(
    { apiKey: 'test-key', think: { model: 'gpt-4o-mini', prompt: 'You are a probe.' } },
    (url: string, _headers: Readonly<Record<string, string>>) => {
      expect(url).toBe(AGENT_ENDPOINT)
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
  )

  const open = async ({ ack }: { ack: boolean }): Promise<ConformanceWire> => {
    const transcripts: RealtimeTranscript[] = []
    const opened = adapter.session({
      provider: 'deepgram',
      model: 'gpt-4o-mini',
      handlers: { onTranscript: transcript => transcripts.push(transcript) },
    })
    const socket = sockets.at(-1)
    if (socket === undefined) throw new Error('the adapter opened no socket')
    socket.emit('open')
    if (ack) socket.frame('SettingsApplied')
    const session = await opened
    const socketForSession = sockets.at(-1)
    if (socketForSession === undefined) throw new Error('the adapter opened no socket')

    return {
      session,
      deliver: (text, kind) => {
        transcripts.length = 0
        socketForSession.frame('ConversationText', { role: kind === 'input' ? 'user' : 'assistant', content: text })
        return [...transcripts]
      },
      promptWrites: async updates => {
        const writes: string[] = []
        for (const update of updates) {
          const pending = session.appendInstructions(update)
          const last = socketForSession.writes().at(-1)
          if (typeof last?.['prompt'] === 'string') writes.push(last['prompt'])
          socketForSession.frame('PromptUpdated')
          await pending
        }
        return writes
      },
      close: () => session.close(),
    }
  }

  return { route: 'deepgram', adapter, open }
}

/**
 * A subject whose adapter is whatever the test says it is.
 *
 * The harness's own guard: every check must be shown to FAIL on a subject that breaks it, or a suite that
 * passes everywhere and a suite that checks nothing are indistinguishable.
 */
function fakeSubject(options: {
  capabilities?: RealtimeCapabilities
  infoId?: string
  settlesWithoutAck?: boolean
  transcripts?: readonly RealtimeTranscript[]
  writes?: readonly string[]
  throwOn?: readonly BooleanCapability[]
  throwOther?: boolean
}): ConformanceSubject {
  const transcripts = options.transcripts ?? [{ kind: 'input' as const, text: 'x', final: true }]
  const writes = options.writes ?? ['first conformance rule', 'second conformance rule']
  const capabilities = options.capabilities ?? {
    appendThinking: true,
    appAuthoredSpeech: true,
    functionCalls: false,
    usageReporting: false,
    transcriptDeltas: false,
    inputMute: true,
    promptUpdate: 'append' as const,
  }

  const refuse = (): never => {
    if (options.throwOther === true) throw new Error('not a capability answer')
    throw new RealtimeError('declared unavailable', REALTIME_ERROR_CODES.CAPABILITY_UNSUPPORTED)
  }
  const declared = (capability: keyof RealtimeCapabilities): boolean =>
    (options.throwOn ?? []).some(name => name === capability)

  const session = {
    id: 'fake',
    started: {
      provider: 'fake',
      model: 'fake',
      inputAudio: { sampleRate: 24_000, channels: 1, encoding: 'pcm16' },
      outputAudio: { sampleRate: 24_000, channels: 1, encoding: 'pcm16' },
    },
    sendAudio: () => {},
    muteInput: () => (declared('inputMute') ? refuse() : undefined),
    unmuteInput: () => {},
    appendCommentary: async () => (declared('appAuthoredSpeech') ? refuse() : undefined),
    appendThinking: async () => (declared('appendThinking') ? refuse() : undefined),
    appendInstructions: async () => {},
    close: async () => {},
  } as unknown as RealtimeSession

  const adapter = new (class extends RealtimeAdapter {
    override providerInfo(provider: string): RealtimeProviderInfo {
      return { id: options.infoId ?? provider, name: 'fake', capabilities }
    }
    override async session(_options: RealtimeSessionOptions): Promise<RealtimeSession> {
      return session
    }
  })()

  return {
    route: 'fake',
    adapter,
    open: async ({ ack }) => {
      // The honest fake withholds the session until it is acknowledged; the dishonest one hands it back anyway,
      // which is the only thing `settlesWithoutAck` exists to let a test choose.
      if (!ack && options.settlesWithoutAck !== true) await new Promise<never>(() => {})
      return {
        session,
        deliver: () => transcripts,
        promptWrites: async () => writes,
        close: async () => {},
      }
    },
  }
}

describe('conformance — Deepgram', () => {
  it('honours its declaration on every check it can exercise, except one it cannot yet', async () => {
    const failures = await runConformance(deepgramSubject())
    // The finding, not a pass: `appAuthoredSpeech` is declared `false` while `appendCommentary` resolves.
    // Under Deepgram that call sends `InjectAgentMessage`, so the agent says a line the application did not
    // author — a silent degradation of the C-2 class, surfaced here rather than in a user's session. Disposing
    // of it is a decision (refuse the call, or narrow the declaration), and it is deliberately NOT made in the
    // commit that adds this suite.
    expect(failures).toEqual([
      {
        check: 'refusal-parity',
        detail: 'appAuthoredSpeech: declared false, but the adapter used it',
      },
    ])
  })
})

describe('conformance — the harness bites', () => {
  it('passes a subject that honours its declaration', async () => {
    expect(await runConformance(fakeSubject({}))).toEqual([])
  })

  it('reports a route whose id does not match the route it was asked about', async () => {
    const failures = await runConformance(fakeSubject({ infoId: 'someone-else' }))
    expect(failures).toContainEqual({ check: 'route-id', detail: 'providerInfo(fake).id is someone-else' })
  })

  it('stops at an undeclared provider, because no claim was made', async () => {
    const subject = fakeSubject({})
    const undeclared: ConformanceSubject = {
      ...subject,
      adapter: new (class extends RealtimeAdapter {
        override providerInfo(provider: string): RealtimeProviderInfo {
          return { id: provider, name: 'undeclared' }
        }
        override session(): Promise<RealtimeSession> {
          return Promise.reject(new Error('never opened'))
        }
      })(),
    }
    expect(await runConformance(undeclared)).toEqual([
      { check: 'declaration-present', detail: 'fake declares no capabilities, so no claim can be held against it' },
    ])
  })

  it('reports a session handed back before the provider acknowledged its settings', async () => {
    const failures = await runConformance(fakeSubject({ settlesWithoutAck: true }))
    expect(failures.some(failure => failure.check === 'ack-gating')).toBe(true)
  })

  it('accepts a refusal to open as the right answer when the provider never acknowledged', async () => {
    const subject = fakeSubject({})
    const refusing: ConformanceSubject = {
      ...subject,
      open: async ({ ack }) => {
        if (!ack) throw new RealtimeError('no acknowledgement', REALTIME_ERROR_CODES.NETWORK)
        return subject.open({ ack })
      },
    }
    const failures = await runConformance(refusing)
    expect(failures.some(failure => failure.check === 'ack-gating')).toBe(false)
  })

  it('reports a capability declared available that the adapter refuses', async () => {
    const failures = await runConformance(fakeSubject({ throwOn: ['appendThinking'] }))
    expect(failures).toContainEqual({
      check: 'refusal-parity',
      detail: 'appendThinking: declared true, but the adapter refused it',
    })
  })

  it('reports a capability declared unavailable that the adapter uses', async () => {
    const failures = await runConformance(
      fakeSubject({
        capabilities: {
          appendThinking: false,
          appAuthoredSpeech: true,
          functionCalls: false,
          usageReporting: false,
          transcriptDeltas: false,
          inputMute: true,
          promptUpdate: 'append',
        },
      }),
    )
    expect(failures).toContainEqual({
      check: 'refusal-parity',
      detail: 'appendThinking: declared false, but the adapter used it',
    })
  })

  it('rethrows anything that is not a capability answer, rather than blaming the provider for the probe', async () => {
    await expect(runConformance(fakeSubject({ throwOn: ['appendThinking'], throwOther: true }))).rejects.toThrow(
      'not a capability answer',
    )
  })

  it('reports a non-final fragment from a provider that declares no deltas', async () => {
    const failures = await runConformance(
      fakeSubject({ transcripts: [{ kind: 'output', text: 'partial', final: false }] }),
    )
    expect(failures).toContainEqual({
      check: 'transcript-granularity',
      detail: 'fake declares transcriptDeltas: false but emitted a non-final input fragment',
    })
  })

  it('reports an append-declaring provider that writes fewer prompts than updates', async () => {
    const failures = await runConformance(fakeSubject({ writes: ['first conformance rule'] }))
    expect(failures).toContainEqual({
      check: 'prompt-update-honesty',
      detail: 'fake declares append, but wrote 1 prompt(s) for 2 updates',
    })
  })

  it('reports an append-declaring provider that drops an update', async () => {
    const failures = await runConformance(fakeSubject({ writes: ['first conformance rule', ''] }))
    expect(failures).toContainEqual({
      check: 'prompt-update-honesty',
      detail: 'fake declares append, but update 2 was not written across',
    })
  })

  it('reports a replace-declaring provider whose final write loses the newest rule', async () => {
    const failures = await runConformance(
      fakeSubject({
        capabilities: {
          appendThinking: true,
          appAuthoredSpeech: true,
          functionCalls: false,
          usageReporting: false,
          transcriptDeltas: false,
          inputMute: true,
          promptUpdate: 'replace',
        },
        writes: ['stale'],
      }),
    )
    expect(failures).toContainEqual({
      check: 'prompt-update-honesty',
      detail: 'fake declares replace, but its final write does not carry the last update',
    })
  })

  it('accepts a replace-declaring provider whose final write carries the newest rule', async () => {
    const failures = await runConformance(
      fakeSubject({
        capabilities: {
          appendThinking: true,
          appAuthoredSpeech: true,
          functionCalls: false,
          usageReporting: false,
          transcriptDeltas: false,
          inputMute: true,
          promptUpdate: 'replace',
        },
        writes: ['first conformance rule + second conformance rule'],
      }),
    )
    expect(failures.some(failure => failure.check === 'prompt-update-honesty')).toBe(false)
  })

  it('reports a replace-declaring provider that wrote nothing at all', async () => {
    const failures = await runConformance(
      fakeSubject({
        capabilities: {
          appendThinking: true,
          appAuthoredSpeech: true,
          functionCalls: false,
          usageReporting: false,
          transcriptDeltas: false,
          inputMute: true,
          promptUpdate: 'replace',
        },
        writes: [],
      }),
    )
    expect(failures).toContainEqual({
      check: 'prompt-update-honesty',
      detail: 'fake declares replace, but its final write does not carry the last update',
    })
  })

  it('says nothing about transcript granularity when the provider declares deltas', async () => {
    const failures = await runConformance(
      fakeSubject({
        capabilities: {
          appendThinking: true,
          appAuthoredSpeech: true,
          functionCalls: false,
          usageReporting: false,
          transcriptDeltas: true,
          inputMute: true,
          promptUpdate: 'append',
        },
        transcripts: [{ kind: 'output', text: 'partial', final: false }],
      }),
    )
    expect(failures.some(failure => failure.check === 'transcript-granularity')).toBe(false)
  })

  it('holds an unknown prompt update to nothing, and does not report it as a failure', async () => {
    const failures = await runConformance(
      fakeSubject({
        capabilities: {
          appendThinking: true,
          appAuthoredSpeech: true,
          functionCalls: false,
          usageReporting: false,
          transcriptDeltas: false,
          inputMute: true,
          promptUpdate: 'unknown',
        },
        writes: [],
      }),
    )
    expect(failures.some(failure => failure.check === 'prompt-update-honesty')).toBe(false)
  })
})
