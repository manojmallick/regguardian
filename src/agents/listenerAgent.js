/**
 * listenerAgent.js
 *
 * FIXED: Uses @google/genai (Live API) instead of @google/generative-ai (no Live API support).
 * Root cause of blank transcript: startChat() was used — it has no receiveMessages().
 * The live session hit the fallback (line 107-110) and returned immediately.
 *
 * Fix: GoogleGenAI.live.connect() → proper bidirectional Live API WebSocket session.
 */

import { GoogleGenAI } from '@google/genai'
import { incidentEventSchema } from '../schemas/incidentEvent.js'
import { pubsubPublish } from '../services/pubsub.js'
import { sseManager } from '../services/sseManager.js'
import { retryWithBackoff } from '../middleware/retryHandler.js'
import { logger } from '../utils/logger.js'

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

// ── System prompt ──────────────────────────────────────────────────────────────
// HARDENED: Very explicit about JSON-only output. Includes complete example.
// Gemini Live in TEXT mode must return ONLY the JSON object — no preamble, no prose.
const ARIA_LISTENER_PROMPT = `
You are ARIA (Automated Regulatory Incident Analyst), running in Listener Mode.
You are participating LIVE in a production incident call at a regulated financial institution.

YOUR ONLY JOB: Convert every utterance you hear into a structured JSON incident event.

OUTPUT RULES — STRICTLY ENFORCED:
1. ALWAYS output EXACTLY ONE JSON object. Never output prose, markdown, or explanation.
2. NEVER wrap the JSON in backticks or markdown code blocks.
3. If the speaker says nothing meaningful, still output a valid JSON with type "timeline_event".
4. Every JSON object MUST include ALL fields shown in the schema below.

SCHEMA — all fields required:
{
  "type":        one of: "service_failure" | "error_spike" | "blast_radius_update" | "timeline_event" | "severity_change",
  "services":    array of service names mentioned (e.g. ["payment-gateway-v2", "postgres-primary"]). Use ["unknown"] if none mentioned,
  "severity":    "P1" (>10k users affected) | "P2" (1k-10k) | "P3" (<1k) | "UNKNOWN",
  "blastRadius": { "estimatedUsers": <number>, "affectedPct": <number 0-100> } — use 0 if unknown,
  "doraTrigger": true if >5% transaction failure rate OR >2 hours downtime mentioned, else false,
  "speakerRole": detect from vocabulary:
    "ENGINEER" — technical terms (kubectl, postgres, 503, latency, CPU, deployment, connection pool),
    "COMPLIANCE" — regulatory language (DORA, SOX, clause, notification, Article 11, regulatory),
    "EXECUTIVE" — business language (revenue, customers, board, impact, timeline),
    "UNKNOWN" — insufficient signal,
  "rawQuote":    verbatim transcript of what was just said (max 200 chars),
  "ariaResponse": your spoken reply as ARIA — max 2 sentences, matches the speakerRole register:
    ENGINEER → technical (service names, commands, metrics),
    COMPLIANCE → regulatory (exact DORA/SOX clause references),
    EXECUTIVE → business (revenue impact, next steps, no jargon)
}

EXAMPLE INPUT: "payment-gateway-v2 is throwing 503 errors, postgres connection pool is exhausted, 73000 users affected, 7.3 percent transaction failure rate"
EXAMPLE OUTPUT:
{"type":"service_failure","services":["payment-gateway-v2","postgres-primary"],"severity":"P1","blastRadius":{"estimatedUsers":73000,"affectedPct":7.3},"doraTrigger":true,"speakerRole":"ENGINEER","rawQuote":"payment-gateway-v2 is throwing 503 errors, postgres connection pool is exhausted, 73000 users affected, 7.3 percent transaction failure rate","ariaResponse":"Payment gateway confirmed down on /api/charge with 503s. Postgres connection pool saturated — 7.3% failure rate crosses DORA Article 11.1(a) threshold."}

EXAMPLE INPUT: "which DORA clause does this trigger and what is the notification deadline"
EXAMPLE OUTPUT:
{"type":"timeline_event","services":["payment-gateway-v2"],"severity":"P1","blastRadius":{"estimatedUsers":73000,"affectedPct":7.3},"doraTrigger":true,"speakerRole":"COMPLIANCE","rawQuote":"which DORA clause does this trigger and what is the notification deadline","ariaResponse":"This triggers DORA Article 11.1(a) — initial notification to competent authority required within 4 hours of incident classification. Deadline is T+4 hours from the moment doraTrigger was confirmed."}

EXAMPLE INPUT: "what is the business impact, what do I tell the board"
EXAMPLE OUTPUT:
{"type":"blast_radius_update","services":["payment-gateway-v2"],"severity":"P1","blastRadius":{"estimatedUsers":73000,"affectedPct":7.3},"doraTrigger":true,"speakerRole":"EXECUTIVE","rawQuote":"what is the business impact, what do I tell the board","ariaResponse":"73,000 customers are currently unable to complete payments, with estimated revenue impact of $240,000 to $290,000 per hour. Engineering is actively executing the fix; regulatory notification is being prepared for DORA compliance."}

Remember: output ONLY the JSON object. No other text.
`

// ── JSON extraction from streaming text ────────────────────────────────────────
function tryParseCompleteJSON(text) {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let lastClose = -1
  for (let i = start; i < trimmed.length; i++) {
    if (trimmed[i] === '{') depth++
    else if (trimmed[i] === '}') {
      depth--
      if (depth === 0) { lastClose = i; break }
    }
  }
  if (lastClose === -1) return null

  try {
    return JSON.parse(trimmed.slice(start, lastClose + 1))
  } catch {
    return null
  }
}

// ── Main export ────────────────────────────────────────────────────────────────
/**
 * Start a Listener Agent for an incident.
 * ONE Live session per incident — reused for all audio chunks.
 * Uses @google/genai Live API (GoogleGenAI.live.connect).
 */
export function startListenerAgent(incidentId) {
  let session  = null
  let isConnected = false
  let jsonBuffer  = ''

  function handleMessage(message) {
    // Extract text from Live API message structure
    const parts = message?.serverContent?.modelTurn?.parts
    const text = parts?.[0]?.text
    if (!text) return

    jsonBuffer += text
    const json = tryParseCompleteJSON(jsonBuffer)
    if (!json) return
    jsonBuffer = ''

    const result = incidentEventSchema.safeParse(json)
    if (!result.success) {
      logger.warn('IncidentEvent schema mismatch — sending to DLQ', {
        incidentId,
        errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)
      })
      pubsubPublish('incident-events-dlq', {
        raw: json,
        error: result.error.message,
        incidentId
      }).catch(() => {})
      return
    }

    // Publish to pipeline
    pubsubPublish('incident-events', {
      ...result.data, incidentId, timestamp: Date.now()
    }).catch(err => logger.error('Pub/Sub publish failed', { incidentId, err: err.message }))

    // Broadcast to browser (transcript + ARIA voice + persona + DORA clock)
    sseManager.broadcast(incidentId, {
      event: 'aria_voice',
      data: {
        text:         result.data.ariaResponse,
        persona:      result.data.speakerRole,
        rawQuote:     result.data.rawQuote,
        doraTrigger:  result.data.doraTrigger,
        severity:     result.data.severity,
        services:     result.data.services,
      }
    })
  }

  async function connect() {
    try {
      logger.info('Connecting to Gemini Live API...', { incidentId })

      session = await ai.live.connect({
        model: 'gemini-2.0-flash-live-001',
        config: {
          responseModalities: ['TEXT'],  // JSON text output — NOT audio
          systemInstruction: {
            parts: [{ text: ARIA_LISTENER_PROMPT }]
          },
          speechConfig: { languageCode: 'en-US' }
        },
        callbacks: {
          onopen: () => {
            isConnected = true
            logger.info('ARIA Listener active — Gemini Live connected', { incidentId })
          },
          onmessage: (message) => {
            handleMessage(message)
          },
          onerror: (error) => {
            logger.error('Gemini Live error', { incidentId, err: String(error) })
            isConnected = false
            retryWithBackoff(connect, { maxRetries: 3, baseDelay: 2000 })
              .catch(e => logger.error('Reconnect failed', { incidentId, err: e.message }))
          },
          onclose: (event) => {
            logger.warn('Gemini Live session closed', { incidentId, code: event?.code })
            isConnected = false
            // Auto-reconnect unless explicitly stopped
            retryWithBackoff(connect, { maxRetries: 3, baseDelay: 2000 })
              .catch(e => logger.error('Reconnect failed', { incidentId, err: e.message }))
          }
        }
      })

    } catch (err) {
      logger.error('Gemini Live connect failed', { incidentId, err: err.message })
      isConnected = false
      retryWithBackoff(connect, { maxRetries: 3, baseDelay: 2000 })
        .catch(e => logger.error('Final reconnect failed', { incidentId, err: e.message }))
    }
  }

  // Connect immediately
  connect()

  return {
    sendAudio(chunk) {
      if (!isConnected || !session) return
      try {
        session.sendRealtimeInput({
          audio: { data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' }
        })
      } catch (err) {
        logger.warn('sendAudio failed', { incidentId, err: err.message })
      }
    },
    stop() {
      isConnected = false
      try { session?.close?.() } catch (_) {}
      logger.info('ARIA Listener stopped', { incidentId })
    }
  }
}
