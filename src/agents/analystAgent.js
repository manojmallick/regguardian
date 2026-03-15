import { GoogleGenerativeAI } from '@google/generative-ai'
import { incidentAnalysisSchema } from '../schemas/incidentAnalysis.js'
import { pubsubSubscribe, pubsubPublish } from '../services/pubsub.js'
import * as firestoreService from '../services/firestore.js'
import * as vertexSearch from '../services/vertexSearch.js'
import { record } from '../services/monitoring.js'
import { logger } from '../utils/logger.js'

const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// InMemorySessionService — incidentId → chat session
// Shared session per incident = accumulated context across all events
const sessionMap = new Map()

const ANALYST_SYSTEM_PROMPT = `
You are ARIA, Analyst Mode. You receive incident events (from audio) and
visual contexts (from screen analysis) for a live production incident.

After each event, update your analysis:
1. ROOT CAUSE: Most probable cause based on all signals so far
2. SEVERITY: P1 (>10k users), P2 (1k-10k), P3 (<1k), UNKNOWN
3. BLAST RADIUS: Services affected, transactions blocked, user segments
4. DORA TRIGGER: Has Article 11.1(a) threshold been crossed?
   Trigger if: >5% transactions affected OR >2hr downtime
5. REMEDIATION: Immediate steps — use runbook context provided
6. CONFIDENCE: 0-1 — be honest about uncertainty

Output ONLY valid JSON:
{ "rootCause": "...",
  "severity": "P1|P2|P3|UNKNOWN",
  "blastRadius": { "services": ["..."], "estimatedUsers": 0, "transactionsBlocked": 0 },
  "doraTrigger": false,
  "remediationSteps": ["..."],
  "runbookMatches": ["RB-042"],
  "confidence": 0.8 }
`

/**
 * Get or create a Gemini chat session for an incident.
 * One session = shared context for all events in the incident.
 */
function getSession(incidentId) {
  if (!sessionMap.has(incidentId)) {
    const model = gemini.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: ANALYST_SYSTEM_PROMPT
    })
    const chat = model.startChat({ history: [] })
    sessionMap.set(incidentId, { chat, eventCount: 0 })
    logger.info('New analyst session created', { incidentId })
  }
  return sessionMap.get(incidentId)
}

/**
 * Process one incident event through the Analyst Agent.
 * @param {{ type: string, data: object }} payload
 */
async function processEvent(payload) {
  const { incidentId } = payload.data
  const t0 = Date.now()

  // Enrich with runbook context — ADK tool call equivalent
  const runbookContext = await vertexSearch.queryRunbooks(
    payload.data.services?.join(' ') || 'incident', {
      filterServices: payload.data.services
    }
  )

  const sessionCtx = getSession(incidentId)
  sessionCtx.eventCount++

  // Summarise every 20 events to prevent context window overflow
  let inputMessage = JSON.stringify(payload)
  if (sessionCtx.eventCount > 0 && sessionCtx.eventCount % 20 === 0) {
    inputMessage = `[Context summary requested] ${inputMessage}`
  }

  const prompt = `${inputMessage}\n\nRunbook context:\n${runbookContext}`
  const response = await sessionCtx.chat.sendMessage(prompt)
  const text = response.response.text().trim()

  // Strip markdown code fences if present
  const jsonText = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '')

  let analysis
  try {
    analysis = incidentAnalysisSchema.parse(JSON.parse(jsonText))
  } catch (err) {
    logger.error('IncidentAnalysis schema validation failed', {
      incidentId,
      err: err.message,
      raw: text.slice(0, 200)
    })
    return
  }

  const elapsed = Date.now() - t0
  await pubsubPublish('incident-analysis', { ...analysis, incidentId })
  await firestoreService.updateIncident(incidentId, { latestAnalysis: analysis })
  record('agent_latency_ms', elapsed, { incidentId, agent: 'analyst' }).catch(() => {})

  logger.info('IncidentAnalysis published', {
    incidentId,
    severity: analysis.severity,
    doraTrigger: analysis.doraTrigger,
    confidence: analysis.confidence,
    elapsedMs: elapsed
  })
}

/**
 * Start the Analyst Agent — subscribe to both incident events and visual contexts.
 */
export async function startAnalystAgent() {
  pubsubSubscribe('incident-events',  (e) => processEvent({ type: 'audio_signal',  data: e }))
  pubsubSubscribe('visual-contexts',  (e) => processEvent({ type: 'visual_signal', data: e }))
  logger.info('Analyst Agent started')
}
