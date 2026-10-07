/**
 * The replay transport: a `RealtimeTransportFactory` that plays a recording instead of opening a
 * socket.
 *
 * This is the design that makes keyless CI worth having. A fake *adapter* would verify the test
 * author's idea of an adapter; this verifies the **shipping adapter and session** end to end — the
 * same handshake, the same translation, the same append correlation, the same teardown — with no
 * network and no credential. The only thing replaced is the bytes' origin.
 *
 * @module dsh-realtime-replay/transport
 */

import type { RealtimeTransport, RealtimeTransportFactory, RealtimeTransportHandlers } from 'dsh-realtime-openai'
import type { RecordedFrame } from './types.ts'

/** A transport that delivers a recording and keeps everything the session tried to send. */
export class ReplayTransportFactory implements RealtimeTransportFactory {
  /** Every client frame the session sent, in order. The assertion surface for a replay test. */
  readonly sent: string[] = []

  /** Every endpoint the adapter dialled. Nothing was ever connected to them. */
  readonly urls: string[] = []

  /** Every header set the adapter supplied, including its authorization line. */
  readonly headers: Array<Readonly<Record<string, string>>> = []

  /** Whether the session released the transport. */
  closed = false

  private readonly recording: readonly RecordedFrame[]

  /**
   * @param recording - the frames to deliver, in order.
   */
  constructor(recording: readonly RecordedFrame[]) {
    this.recording = recording
  }

  /**
   * Hand back a transport and schedule the recording.
   *
   * Delivery happens on a **macrotask**, not synchronously. A real provider speaks only after the
   * client addresses it, and `session.start` is sent in the same microtask chain that `connect`
   * resolves in — delivering synchronously would hand the session a `session.started` before it had
   * asked for one, which no real provider can do.
   * @param url - endpoint the adapter dialled; recorded, never connected to.
   * @param headers - headers the adapter supplied; recorded, never transmitted.
   * @param handlers - frame and lifecycle callbacks.
   * @returns the transport.
   */
  async connect(
    url: string,
    headers: Readonly<Record<string, string>>,
    handlers: RealtimeTransportHandlers,
  ): Promise<RealtimeTransport> {
    this.urls.push(url)
    this.headers.push({ ...headers })

    const transport: RealtimeTransport = {
      send: (frame: string) => {
        this.sent.push(frame)
        this.acknowledge(frame, handlers)
      },
      close: () => {
        this.closed = true
      },
    }

    setTimeout(() => {
      for (const frame of this.recording) {
        // A real transport stops delivering once the peer has gone, so playback stops with it. A
        // recording whose tail continues past `session.closed` therefore replays only up to that point.
        if (this.closed) return
        handlers.onMessage(JSON.stringify(frame.event))
      }
    }, 0)

    return transport
  }

  /**
   * Answer one client frame the way a provider would.
   *
   * A recording captures one direction of one conversation, so it cannot contain an answer to a
   * request that had not been made when it was recorded. Client context appends are therefore
   * acknowledged **here**, deterministically — which is what makes replay a server rather than a
   * player, and what lets a replay test drive the client half of the conversation.
   *
   * Everything else is recorded and ignored: `session.start` is answered by the recording's own
   * `session.started`, and audio frames are never acknowledged by this protocol.
   * @param frame - the client frame just sent.
   * @param handlers - the callbacks to answer through.
   */
  private acknowledge(frame: string, handlers: RealtimeTransportHandlers): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(frame)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const request = parsed as { type?: unknown; event_id?: unknown }
    if (typeof request.type !== 'string') return
    const acknowledged = ACKNOWLEDGED_APPENDS.get(request.type)
    if (acknowledged === undefined) return

    const eventId = typeof request.event_id === 'string' ? request.event_id : undefined
    // On a macrotask, so the acknowledgement cannot arrive before the send has returned — which is
    // what a real provider does, and what makes the session's pending map mean anything.
    setTimeout(() => {
      if (this.closed) return
      handlers.onMessage(JSON.stringify({
        type: acknowledged,
        ...eventId === undefined ? {} : { client_event_id: eventId },
      }))
    }, 0)
  }
}

/**
 * The client events the provider acknowledges, mapped to their acknowledgement.
 *
 * An exact map rather than a suffix test: `session.input_audio.append` also ends in `.append`, and
 * this protocol **never** acknowledges microphone input. A suffix test invented
 * `session.input_audio.appended` — an event that does not exist — which is exactly the kind of
 * plausible-looking fiction a replay server must not produce.
 */
const ACKNOWLEDGED_APPENDS: ReadonlyMap<string, string> = new Map([
  ['session.instructions.append', 'session.instructions.appended'],
  ['session.thinking.append', 'session.thinking.appended'],
  ['session.commentary.append', 'session.commentary.appended'],
])
