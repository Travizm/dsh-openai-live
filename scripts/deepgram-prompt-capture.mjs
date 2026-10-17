#!/usr/bin/env node
/**
 * P1c — capture the prompt Deepgram actually sends to an LLM.
 *
 * This is the test that can settle `promptUpdate`, and it is model-independent: instead of asking the agent what
 * it was told (which a model can answer however it likes), it reads the request the provider makes to a
 * bring-your-own endpoint. The `messages` array carries the system prompt as the provider currently holds it:
 *
 *   turn 1 → capture A            (the prompt from Settings)
 *   UpdatePrompt(…) → wait for the ack
 *   turn 2 → capture B
 *
 *   B equals the update          → Replace
 *   B contains the update and A  → Append
 *
 * which no amount of probing the *answer* could distinguish, and which the documentation contradicts itself
 * about.
 *
 * It answers a chat completion with a fixed line so the provider's turn completes and the next request carries a
 * fresh prompt. Nothing here is an LLM: the point is the request, not the reply.
 *
 * usage:  node scripts/deepgram-prompt-capture.mjs [--port 8787] [--out captures.jsonl]
 *         then point the provider at it: DEEPGRAM_PROBE_ENDPOINT=https://<public-url>/v1/chat/completions
 *
 * NOTE: binding is loopback only. Reaching it from Deepgram's cloud needs a tunnel, which is an externally visible
 * action and is deliberately not started by this script.
 */
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const portIndex = process.argv.indexOf('--port')
const PORT = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8787
const outIndex = process.argv.indexOf('--out')
const OUT = outIndex >= 0 ? process.argv[outIndex + 1] : 'captures.jsonl'

/** The system prompt as the provider holds it, pulled out of whatever shape the request uses. */
function systemPromptOf(body) {
  // Chat-completions shape: a `system` message, or `instructions` on some providers.
  if (typeof body.instructions === 'string') return body.instructions
  const messages = Array.isArray(body.messages) ? body.messages : []
  const system = messages.filter(message => message?.role === 'system')
  return system.map(message => String(message.content ?? '')).join('\n')
}

const server = createServer((request, response) => {
  const url = (request.url ?? '').split('?')[0]
  if (url === '/health') { response.writeHead(200).end('ok'); return }
  if (url !== '/v1/chat/completions') { response.writeHead(404).end(); return }

  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    let body = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* recorded as unparsed below */ }
    const entry = {
      at: new Date().toISOString(),
      model: typeof body.model === 'string' ? body.model : undefined,
      systemPrompt: systemPromptOf(body),
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      userTurns: Array.isArray(body.messages) ? body.messages.filter(m => m?.role === 'user').length : 0,
    }
    appendFileSync(OUT, `${JSON.stringify(entry)}\n`)
    console.log(`capture ${entry.userTurns} user turn(s) · prompt ${entry.systemPrompt.length} chars: ${entry.systemPrompt.slice(0, 120)}`)

    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      id: `chatcmpl-capture-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: entry.model ?? 'capture',
      choices: [{ index: 0, message: { role: 'assistant', content: 'captured' }, finish_reason: 'stop' }],
    }))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`prompt capture on http://127.0.0.1:${PORT}/v1/chat/completions → ${OUT}`)
  console.log('loopback only — expose it deliberately if the provider has to reach it')
})
