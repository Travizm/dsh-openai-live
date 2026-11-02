/**
 * Adapter conformance — one suite, run against every registered adapter.
 *
 * C-1 of the voice-seam chamber (`docs/voice-seam-chamber.md`) says "swappable" is an adjective until one
 * specification is run against two implementations. This package is that specification: it holds a provider's
 * *declaration* against what its adapter actually does, and reports every contradiction rather than the first.
 *
 * What it can and cannot see today, stated here so a gap is not mistaken for coverage:
 *
 * - **Exercisable** — `appendThinking`, `appAuthoredSpeech` and `inputMute` (each has a seam method), transcript
 *   granularity (a delivered utterance), and prompt-update semantics (the text the adapter writes).
 * - **Declared-only** — `functionCalls` and `usageReporting` have no seam method and no event source on a fake
 *   wire, so they are held against nothing. A `false` on either is currently unfalsifiable here. That is a
 *   limitation of the seam's surface, not a pass, and it is why the harness reports nothing about them.
 *
 * The harness is deliberately a pure function over a subject: the adapter-specific wiring (a fake socket, a
 * scripted ack) lives in the subject, and every invariant lives here, so adding a provider adds no assertions
 * that a passing provider could have chosen for itself.
 *
 * @module dsh-realtime-conformance
 */
import { REALTIME_ERROR_CODES, RealtimeError, auditCapabilities } from 'dsh-realtime'
import type {
  BooleanCapability,
  CapabilityExercise,
  RealtimeAdapter,
  RealtimeSession,
  RealtimeTranscript,
} from 'dsh-realtime'

/** The invariants this harness can report on. Named so a failure says which one broke. */
export type ConformanceCheck =
  | 'declaration-present'
  | 'route-id'
  | 'refusal-parity'
  | 'transcript-granularity'
  | 'prompt-update-honesty'
  | 'ack-gating'

/** One contradiction between what a provider declared and what its adapter did. */
export interface ConformanceFailure {
  /** Which invariant broke. */
  readonly check: ConformanceCheck
  /** What was observed, in the words a reader needs to fix it. */
  readonly detail: string
}

/**
 * A live session plus the three observations the harness cannot make for itself.
 *
 * These exist because the seam's contract is about *behaviour* while its surface is about *methods*: a subject
 * has to say what its handlers saw and what the provider would be running. Every method here is an observation
 * of the adapter under test, never a place to assert.
 */
export interface ConformanceWire {
  /** The session the adapter returned. */
  readonly session: RealtimeSession
  /** Deliver one provider utterance and return the fragments the handlers observed. */
  deliver(text: string, kind: RealtimeTranscript['kind']): readonly RealtimeTranscript[]
  /**
   * Write each update in order and return the prompt texts the adapter put on the wire.
   *
   * A returning value, not a merged prompt: how the provider accumulates updates is the provider's business, and
   * what the adapter can be held to is what it wrote. `append` therefore means one write per update, each
   * carrying that update; `replace` means a write carrying the whole prompt.
   */
  promptWrites(updates: readonly string[]): Promise<readonly string[]>
  /** Release the session. */
  close(): Promise<void>
}

/** One adapter, plus the wiring needed to drive it deterministically. */
export interface ConformanceSubject {
  /** The route the adapter is registered under. */
  readonly route: string
  /** The adapter under test. */
  readonly adapter: RealtimeAdapter
  /**
   * Open a session over the subject's own fake wire.
   * @param options - `ack: false` withholds the provider's acknowledgement, so a session that resolves anyway
   *   resolved on the socket rather than on the provider and is not live.
   */
  open(options: { readonly ack: boolean }): Promise<ConformanceWire>
}

/** Capabilities with a seam method, so they can be exercised rather than merely read. */
const CALL_BASED: readonly {
  readonly capability: BooleanCapability
  readonly call: (wire: ConformanceWire) => Promise<void>
}[] = [
  {
    capability: 'appendThinking',
    call: async wire => {
      await wire.session.appendThinking('conformance probe')
    },
  },
  {
    capability: 'appAuthoredSpeech',
    call: async wire => {
      await wire.session.appendCommentary('conformance probe')
    },
  },
  {
    capability: 'inputMute',
    call: async wire => {
      wire.session.muteInput()
      wire.session.unmuteInput()
    },
  },
]

/** The two updates every subject is asked to write, in order. Named separately so the newest one needs no
 * fallback: under `noUncheckedIndexedAccess` an indexed read is `string | undefined`, and an unreachable `?? ''`
 * is a branch no test could ever cover. */
const FIRST_UPDATE = 'first conformance rule'
const LAST_UPDATE = 'second conformance rule'
const UPDATES = [FIRST_UPDATE, LAST_UPDATE] as const

/**
 * Hold one adapter's declaration against what it does.
 *
 * Returns every contradiction found, in check order; an empty array is the pass. A provider that declares
 * nothing stops the run after recording that, because an undeclared provider has made no claim and inventing
 * assertions on its behalf would fail every adapter that predates the declaration.
 * @param subject - the adapter and the wiring needed to drive it.
 * @returns failures, empty when the declaration was honoured throughout.
 */
export async function runConformance(subject: ConformanceSubject): Promise<readonly ConformanceFailure[]> {
  const failures: ConformanceFailure[] = []
  const info = subject.adapter.providerInfo(subject.route)
  if (info.id !== subject.route) {
    failures.push({ check: 'route-id', detail: `providerInfo(${subject.route}).id is ${info.id}` })
  }

  const declared = info.capabilities
  if (declared === undefined) {
    failures.push({
      check: 'declaration-present',
      detail: `${subject.route} declares no capabilities, so no claim can be held against it`,
    })
    return failures
  }

  if (await settlesWithoutAck(subject)) {
    failures.push({
      check: 'ack-gating',
      detail: `${subject.route} produced a session before the provider acknowledged its settings`,
    })
  }

  const wire = await subject.open({ ack: true })
  try {
    const audit = auditCapabilities(declared, await exercised(wire))
    for (const divergence of audit.divergences) {
      failures.push({ check: 'refusal-parity', detail: divergence })
    }

    if (declared.transcriptDeltas === false) {
      for (const kind of ['input', 'output'] as const) {
        for (const fragment of wire.deliver('conformance probe', kind)) {
          if (!fragment.final) {
            failures.push({
              check: 'transcript-granularity',
              detail: `${subject.route} declares transcriptDeltas: false but emitted a non-final ${kind} fragment`,
            })
          }
        }
      }
    }

    const writes = await wire.promptWrites(UPDATES)
    if (declared.promptUpdate === 'append') {
      if (writes.length !== UPDATES.length) {
        failures.push({
          check: 'prompt-update-honesty',
          detail: `${subject.route} declares append, but wrote ${writes.length} prompt(s) for ${UPDATES.length} updates`,
        })
      }
      UPDATES.forEach((update, index) => {
        const write = writes[index]
        if (write === undefined || !write.includes(update)) {
          failures.push({
            check: 'prompt-update-honesty',
            detail: `${subject.route} declares append, but update ${String(index + 1)} was not written across`,
          })
        }
      })
    }
    if (declared.promptUpdate === 'replace') {
      const last = writes.at(-1) ?? ''
      if (!last.includes(LAST_UPDATE)) {
        failures.push({
          check: 'prompt-update-honesty',
          detail: `${subject.route} declares replace, but its final write does not carry the last update`,
        })
      }
    }
  } finally {
    await wire.close()
  }

  return failures
}

/** Exercise every capability that has a seam method, recording what the adapter did. */
async function exercised(wire: ConformanceWire): Promise<readonly CapabilityExercise[]> {
  const outcomes: CapabilityExercise[] = []
  for (const { capability, call } of CALL_BASED) {
    try {
      await call(wire)
      outcomes.push({ capability, outcome: 'used' })
    } catch (error) {
      // Only a capability refusal is an answer. Anything else is the harness failing to ask the question, and
      // reporting it as a declaration mismatch would blame the provider for the probe.
      if (error instanceof RealtimeError && error.code === REALTIME_ERROR_CODES.CAPABILITY_UNSUPPORTED) {
        outcomes.push({ capability, outcome: 'refused' })
        continue
      }
      throw error
    }
  }
  return outcomes
}

/**
 * Did the subject hand back a session without the provider's acknowledgement?
 *
 * Bounded by one macrotask rather than a duration: the question is whether `open()` settled *at all* without an
 * ack, and a session that needs an ack cannot settle inside a timer that never fires. A rejection counts as the
 * right answer — refusing to open is exactly what an unacknowledged session should do.
 */
async function settlesWithoutAck(subject: ConformanceSubject): Promise<boolean> {
  let handedBack = false
  const probe = subject.open({ ack: false })
  void probe.then(
    () => {
      handedBack = true
    },
    () => {
      // Refusing to open without an acknowledgement is the correct answer, not a settlement. Counting it as one
      // would fail every adapter that does the right thing, which is the defect this branch was written to catch
      // one layer up.
    },
  )
  await new Promise(resolve => setTimeout(resolve, 0))
  return handedBack
}
