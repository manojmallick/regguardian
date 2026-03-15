import { GoogleGenerativeAI } from '@google/generative-ai'
import { visualContextSchema } from '../schemas/visualContext.js'
import { pubsubPublish } from '../services/pubsub.js'
import * as cloudStorage from '../services/cloudStorage.js'
import * as vertexSearch from '../services/vertexSearch.js'
import { record } from '../services/monitoring.js'
import { logger } from '../utils/logger.js'

const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

const ARIA_VISION_PROMPT = `
You are ARIA, Vision Mode. Analysing a live dashboard screenshot from
a production incident at a financial institution.

Extract:
1. Metric anomalies: name + value + direction (spike/drop/flatline/normal)
2. Service health: each visible service + status (red/amber/green/unknown)
3. Error indicators: alert banners, error dialogs, exception text visible on screen
4. Runbook triggers: which provided runbook conditions are visible on screen
5. DORA signals: metrics showing >5% transaction failure or >2hr downtime patterns

Output ONLY valid JSON:
{ "anomalies": [{ "name": "...", "value": "...", "direction": "spike|drop|flatline|normal" }],
  "serviceHealth": [{ "name": "...", "status": "red|amber|green|unknown" }],
  "runbookTriggers": ["RB-042"],
  "doraCritical": false,
  "errorIndicators": ["optional error text"],
  "ariaObservation": "One sentence ARIA says about the screen" }
`

/**
 * Create a Vision Agent for an incident.
 * Maintains isProcessing flag — drops stale frames rather than queuing.
 * @param {string} incidentId
 * @returns {{ processFrame: (buffer: Buffer) => Promise<void>, stop: () => void }}
 */
export function createVisionAgent(incidentId) {
  let isProcessing = false  // prevent concurrent frame processing — NOT a queue

  return {
    async processFrame(frameBuffer) {
      if (isProcessing) {
        logger.debug('Vision busy — frame dropped', { incidentId })
        return  // drop stale frame, never queue
      }
      isProcessing = true
      const t0 = Date.now()

      try {
        // 1. Archive (fire-and-forget — explicitly no await)
        cloudStorage.archiveFrame(frameBuffer, incidentId)
          .catch(err => logger.warn('Frame archive failed', { incidentId, err: err.message }))

        // 2. Ground with runbooks BEFORE vision call
        const runbookContext = await vertexSearch.queryRunbooks(
          'production incident dashboard monitoring metrics'
        )

        // 3. Gemini vision call (standard generateContent, NOT Live API)
        const model = gemini.getGenerativeModel({ model: 'gemini-2.0-flash' })
        const result = await model.generateContent([
          { text: ARIA_VISION_PROMPT + '\n\nRelevant runbooks:\n' + runbookContext },
          { inlineData: { mimeType: 'image/png', data: frameBuffer.toString('base64') } }
        ])

        const responseText = result.response.text().trim()
        // Strip potential markdown code fences
        const jsonText = responseText.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '')
        const parsed = JSON.parse(jsonText)

        // 4. Validate + publish
        const context = visualContextSchema.parse(parsed)
        const elapsed = Date.now() - t0
        await pubsubPublish('visual-contexts', {
          ...context, incidentId, timestamp: Date.now(), processingMs: elapsed
        })
        record('vision_agent_latency_ms', elapsed, { incidentId }).catch(() => {})
        logger.info('VisualContext published', { incidentId, processingMs: elapsed })

      } catch (err) {
        logger.error('Vision frame error', { incidentId, err: err.message })
      } finally {
        isProcessing = false  // always release the lock
      }
    },

    stop() {
      logger.info('Vision agent stopped', { incidentId })
    }
  }
}
