/**
 * P4a — the translation half of the delegate shim: OpenAI `chat.completions` in, a DSH `SessionPromptRequest`
 * out, and the answer back out as a completion.
 *
 * ## Why this module is separate from the server
 *
 * The chamber's P4 reads "completions shim over `SessionController['prompt']`", and reading the controller's own
 * types shows that plan was half a plan: `prompt()` returns `{ accepted: true }` — it **admits** a turn and says
 * nothing about the answer. The answer has to be assembled from `follow()`, whose frames carry durable events
 * and provider-chunk `JsonValue`s. So P4 is two jobs with different risk:
 *
 * - **P4a (here)** is a pure translation. No clock, no socket, no harness. It can be exhaustively tested, and
 *   it is the part where being wrong is cheap.
 * - **P4b** is the follow-stream assembly and the HTTP surface: correlate the committed assistant record for
 *   *this* request, serialise concurrent requests per session, and survive a provider that abandons an attempt.
 *   See `docs/p4-delegate-shim.md`.
 *
 * Keeping them apart means the risky half cannot contaminate the testable one, and the translation can be
 * reviewed against the harness types without a running DSH.
 *
 * ## The translation is lossy, deliberately and visibly
 *
 * `PromptContentPart` is `{ type: 'text', text }` — there is no role channel. A chat completion's role
 * structure therefore has to be rendered into text (`[system] …`, `[user] …`), rather than dropped. The
 * alternative — concatenating bodies and losing who said what — reads the same in a test and fails in a
 * conversation, and a system instruction merged into a user turn is a prompt-injection shape nobody intended.
 *
 * @module dsh-delegate/protocol
 */

/** The path the shim serves. OpenAI-compatible clients append nothing to it. */
export const COMPLETIONS_PATH = '/v1/chat/completions'

/** Why a request was refused, as a code a caller can branch on rather than prose they must parse. */
export type DelegateErrorCode =
  /** The body was not a completion request at all, or a field had the wrong type. */
  | 'MALFORMED_REQUEST'
  /** A message carried content this translation cannot carry: an image, a file, or a parts array. */
  | 'UNSUPPORTED_CONTENT'
  /** The request named no messages, so there is nothing to ask. */
  | 'NO_MESSAGES'

/** A refused request. Distinguishable by `code`, never by message text. */
export class DelegateRequestError extends Error {
  /** Stable machine code. Branch on this. */
  readonly code: DelegateErrorCode

  /**
   * @param message - what was refused, in the caller's terms. Must not contain prompt content.
   * @param code - one of {@link DelegateErrorCode}.
   */
  constructor(message: string, code: DelegateErrorCode) {
    super(message, undefined)
    this.name = 'DelegateRequestError'
    this.code = code
  }
}

/** The roles a completion request may carry. */
export type ChatRole = 'system' | 'user' | 'assistant'

/** One message, already reduced to the only form this translation accepts. */
export interface ChatMessage {
  readonly role: ChatRole
  readonly content: string
}

/**
 * The shape this module emits — structurally the harness's `SessionPromptRequest`.
 *
 * Declared here rather than imported because the harness package is not a dependency of this one, and a
 * hand-copied mirror that drifts is worse than an import that does not exist. The source of truth is
 * `@deepseek-ai/dsh-api-session-controller` `src/types.ts` (`SessionPromptRequest`, v0.1.5-rc.2), and P4b
 * should assert the assignment is accepted by the real type the moment the harness is a build dependency.
 */
export interface PromptRequestMirror {
  /** Correlates the admitted turn with the assistant record that answers it. */
  readonly requestId: string
  /** The session the turn is admitted to. */
  readonly sessionId: string
  /** `queue`, never `steer`: a completion is a turn, and steering would interleave it with work in flight. */
  readonly mode: 'queue'
  /** Rendered messages, one part each. */
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  /** Passed through when the caller supplies it, so the agent can date-format against the caller's clock. */
  readonly clientTimeZone?: string
}

/** What a caller hands {@link toPromptRequest}. Written to be the parsed body, not a re-shape of it. */
export interface CompletionBody {
  readonly messages: readonly ChatMessage[]
  readonly sessionId: string
  /** Echoed into the response, and useful in a log line. Never used to pick behaviour. */
  readonly model?: string
  /** Supplied by a caller that needs to correlate its own request; generated otherwise. */
  readonly requestId?: string
  readonly clientTimeZone?: string
}

/** An OpenAI-shaped completion response, as far as this shim can honestly fill it. */
export interface CompletionResponse {
  readonly id: string
  readonly object: 'chat.completion'
  readonly created: number
  readonly model: string
  readonly choices: readonly {
    readonly index: 0
    readonly message: { readonly role: 'assistant'; readonly content: string }
    readonly finish_reason: 'stop'
  }[]
}

/** Roles are a closed set: an unknown role is a malformed request, not a message to guess about. */
const ROLES: readonly ChatRole[] = ['system', 'user', 'assistant']

/**
 * Validate a parsed body and render it as one text part per message.
 *
 * Throws {@link DelegateRequestError} for anything it cannot carry, naming the offending index so a caller
 * fixes the message they got wrong rather than re-reading the whole body.
 */
export function toPromptRequest(body: CompletionBody, now: () => string = () => crypto.randomUUID()): PromptRequestMirror {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new DelegateRequestError('the request carried no messages', 'NO_MESSAGES')
  }
  const content = body.messages.map((message, index) => {
    if (typeof message?.content !== 'string') {
      // A parts array is the common shape here (text + image_url). Refusing it by name is the difference
      // between "this shim does not do images" and a silent `[object Object]` in a prompt.
      throw new DelegateRequestError(
        `message ${index} carried content that is not a string (this shim takes text only)`,
        'UNSUPPORTED_CONTENT',
      )
    }
    if (!ROLES.includes(message.role)) {
      throw new DelegateRequestError(`message ${index} has role ${JSON.stringify(message.role)}, which is not one of ${ROLES.join(', ')}`, 'MALFORMED_REQUEST')
    }
    if (message.content.trim().length === 0) {
      throw new DelegateRequestError(`message ${index} is empty`, 'MALFORMED_REQUEST')
    }
    return { type: 'text' as const, text: `[${message.role}] ${message.content}` }
  })
  const request: PromptRequestMirror = {
    requestId: body.requestId ?? now(),
    sessionId: body.sessionId,
    mode: 'queue',
    content,
    ...(body.clientTimeZone === undefined ? {} : { clientTimeZone: body.clientTimeZone }),
  }
  return request
}

/**
 * Render an answer as a completion response.
 *
 * **`usage` is omitted, not zeroed.** Token counts would have to be invented: the shim does not see the
 * provider's usage, and a fabricated `{ prompt_tokens: 0 }` is a number a caller would bill against.
 * `finish_reason` is always `stop`, because a truncated turn is a failure this translation cannot express —
 * P4b must not hand a partial answer here.
 */
export function toCompletion(text: string, options: { readonly model: string; readonly requestId: string; readonly created: number }): CompletionResponse {
  return {
    id: `chatcmpl-${options.requestId}`,
    object: 'chat.completion',
    created: options.created,
    model: options.model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  }
}
