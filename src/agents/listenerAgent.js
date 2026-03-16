/**
 * listenerAgent.js — HYBRID ARCHITECTURE (Final Working Version)
 *
 * Root cause history:
 *   v1 wrong SDK (@google/generative-ai has no Live API → used startChat)
 *   v2 wrong systemInstruction format + spurious speechConfig → 1008 immediate close
 *   v3 wrong model name (gemini-2.0-flash-live-001 → 1008 not found on AI Studio)
 *   v4 still wrong model (gemini-2.0-flash-exp → also not available for this key)
 *   v5 native-audio model + TEXT modality → 1007 "Cannot extract voices"
 *   v6 native-audio + AUDIO+TEXT + systemInstruction → 1007 "Invalid argument"
 *   v7 DIAGNOSTIC: native-audio + AUDIO only + NO systemInstruction → ✅ STAYS OPEN
 *   v8 native-audio + AUDIO+TEXT → still 1007 (TEXT modality unsupported)
 *
 * FINAL ARCHITECTURE:
 *   Gemini Live  (gemini-2.5-flash-native-audio-latest, AUDIO only)
 *     → real-time inputTranscription of what participants say
 *     → when turnComplete, fires a generateContent call
 *   Gemini Flash (gemini-2.5-flash, generateContent)
 *     → receives transcript, returns structured JSON incident event
 *   JSON event → Zod validation → Pub/Sub → SSE → browser transcript + DORA report
 *
 * This correctly uses the only bidiGenerateContent models available on this
 * project's API key, while still running the full live voice → AI pipeline.
 */

import { GoogleGenAI } from '@google/genai'
import { incidentEventSchema } from '../schemas/incidentEvent.js'
import { pubsubPublish } from '../services/pubsub.js'
import { sseManager } from '../services/sseManager.js'
import { retryWithBackoff } from '../middleware/retryHandler.js'
import { logger } from '../utils/logger.js'

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

// ── System prompt for structured JSON generation ───────────────────────────────
// Used by the generateContent call (gemini-2.5-flash), NOT the live session.
const ARIA_ANALYST_PROMPT = `
You are ARIA (Automated Regulatory Incident Analyst).
You are analyzing a live transcription from a production incident call at a regulated financial institution.

YOUR ONLY JOB: Convert the transcribed utterance into a structured JSON incident event.

OUTPUT RULES — STRICTLY ENFORCED:
1. ALWAYS output EXACTLY ONE JSON object. Never output prose, markdown, or explanation.
2. NEVER wrap the JSON in backticks or markdown code blocks.
3. If the text says nothing meaningful, still output a valid JSON with type "timeline_event".
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

// ── JSON extraction ─────────────────────────────────────────────────────────────
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

// ── JSON generation from transcript ────────────────────────────────────────────
/**
 * Takes a completed voice transcript and calls gemini-2.5-flash to produce a
 * structured IncidentEvent JSON. This is separate from the Live session so we
 * can use a model that actually supports text output.
 */
async function generateIncidentEvent(transcript, incidentId) {
  try {
    logger.info('Generating incident event from transcript', { incidentId, transcript: transcript.slice(0, 100) })

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      config: {
        systemInstruction: ARIA_ANALYST_PROMPT,
        responseMimeType:  'application/json',
      },
      contents: [{ role: 'user', parts: [{ text: transcript }] }],
    })

    const text = response.text
    if (!text) {
      logger.warn('Empty response from generateContent', { incidentId })
      return
    }

    const json = tryParseCompleteJSON(text)
    if (!json) {
      logger.warn('Could not parse JSON from generateContent response', { incidentId, text: text.slice(0, 200) })
      return
    }

    const result = incidentEventSchema.safeParse(json)
    if (!result.success) {
      logger.warn('IncidentEvent schema mismatch — sending to DLQ', {
        incidentId,
        errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)
      })
      pubsubPublish('incident-events-dlq', {
        raw: json, error: result.error.message, incidentId
      }).catch(() => {})
      return
    }

    // Publish to ADK pipeline
    pubsubPublish('incident-events', {
      ...result.data, incidentId, timestamp: Date.now()
    }).catch(err => logger.error('Pub/Sub publish failed', { incidentId, err: err.message }))

    // Broadcast to browser (transcript + ARIA voice + persona + DORA clock)
    sseManager.broadcast(incidentId, {
      event: 'aria_voice',
      data: {
        text:        result.data.ariaResponse,
        persona:     result.data.speakerRole,
        rawQuote:    result.data.rawQuote,
        doraTrigger: result.data.doraTrigger,
        severity:    result.data.severity,
        services:    result.data.services,
      }
    })

    logger.info('Incident event published', { incidentId, type: result.data.type, severity: result.data.severity })

  } catch (err) {
    logger.error('generateIncidentEvent failed', { incidentId, err: err.message })
  }
}

// ── Main export ────────────────────────────────────────────────────────────────
/**
 * Start a Listener Agent for an incident.
 *
 * Uses gemini-2.5-flash-native-audio-latest for bidirectional audio streaming
 * with inputTranscription. When a speech turn completes, the transcript is
 * forwarded to gemini-2.5-flash generateContent which produces the structured
 * JSON incident event.
 */
export function startListenerAgent(incidentId) {
  let session          = null
  let isConnected      = false
  let isStopped        = false   // prevents reconnect storm after intentional stop()
  let transcriptBuffer = ''      // accumulates inputTranscription across message chunks

  function handleMessage(message) {
    const sc = message.serverContent
    if (!sc) return

    // Accumulate input transcription (real-time transcript of what the participant said)
    const chunk = sc.inputTranscription?.text
    if (chunk) {
      transcriptBuffer += chunk
    }

    // When the model signals turn complete, we have the full utterance
    if (sc.turnComplete && transcriptBuffer.trim()) {
      const transcript = transcriptBuffer.trim()
      transcriptBuffer = ''

      // Fire-and-forget: call gemini-2.5-flash to generate structured JSON
      generateIncidentEvent(transcript, incidentId)
    }
  }

  async function connect() {
    if (isStopped) return
    try {
      logger.info('Connecting to Gemini Live API...', { incidentId })

      session = await ai.live.connect({
        // gemini-2.5-flash-native-audio-latest:
        //   ✓ Only model with bidiGenerateContent on this project's API key
        //   ✓ AUDIO-only responseModalities stays open (confirmed in diagnostic v7)
        //   ✓ Provides inputTranscription of participant speech
        model: 'gemini-2.5-flash-native-audio-latest',
        config: {
          responseModalities: ['AUDIO'],
          // No systemInstruction here — live model handles transcription only.
          // ARIA_ANALYST_PROMPT is used by the separate generateContent call.
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
            if (!isStopped) {
              retryWithBackoff(connect, { maxRetries: 3, baseDelay: 2000 })
                .catch(e => logger.error('Reconnect failed', { incidentId, err: e.message }))
            }
          },
          onclose: (event) => {
            logger.warn('Gemini Live session closed', {
              incidentId,
              code:     event?.code,
              reason:   event?.reason || '(no reason)',
              wasClean: event?.wasClean,
            })
            isConnected = false
            if (!isStopped) {
              retryWithBackoff(connect, { maxRetries: 3, baseDelay: 2000 })
                .catch(e => logger.error('Reconnect failed', { incidentId, err: e.message }))
            }
          }
        }
      })

    } catch (err) {
      logger.error('Gemini Live connect failed', { incidentId, err: err.message })
      isConnected = false
      if (!isStopped) {
        retryWithBackoff(connect, { maxRetries: 3, baseDelay: 2000 })
          .catch(e => logger.error('Final reconnect failed', { incidentId, err: e.message }))
      }
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
      isStopped   = true   // must be set BEFORE close() to block onclose reconnect
      isConnected = false
      try { session?.close?.() } catch (_) {}
      logger.info('ARIA Listener stopped', { incidentId })
    }
  }
}
