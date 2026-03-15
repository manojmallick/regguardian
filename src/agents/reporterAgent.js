import { GoogleGenerativeAI } from '@google/generative-ai'
import { reportSectionSchema } from '../schemas/reportSection.js'
import { pubsubSubscribe } from '../services/pubsub.js'
import * as firestoreService from '../services/firestore.js'
import { sseManager } from '../services/sseManager.js'
import { logger } from '../utils/logger.js'

const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

const REPORTER_PROMPT = `
You are ARIA, Reporter Mode. Write a live DORA Article 11 / SOX Section 404
incident report, one section at a time, as the incident unfolds.

Sections (output one per invocation):
- TIMELINE:     Chronological events with timestamps
- BLAST_RADIUS: Services, users, transactions affected
- ROOT_CAUSE:   Most probable cause with confidence score
- REGULATORY:   DORA/SOX obligations — cite exact clause numbers (Art. 11.1(a), not just "DORA")
- REMEDIATION:  Steps taken and pending, runbook references
- SUMMARY:      3 sentences, business language, for C-suite

Determine the most needed section based on the incoming compliance mapping.
If updating an existing section, set isUpdate: true.

Output ONLY valid JSON:
{ "sectionId": "TIMELINE|BLAST_RADIUS|ROOT_CAUSE|REGULATORY|REMEDIATION|SUMMARY",
  "content": "Section content here...",
  "isUpdate": false,
  "confidence": 0.9 }
`

/**
 * Start the Reporter Agent — subscribes to compliance-mappings.
 * Writes report sections to Firestore and broadcasts via SSE.
 */
export async function startReporterAgent() {
  pubsubSubscribe('compliance-mappings', async (mapping) => {
    const { incidentId } = mapping

    const model = gemini.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: REPORTER_PROMPT
    })

    const prompt = `
Compliance mapping received:
${JSON.stringify(mapping, null, 2)}

Write the most appropriate report section based on this data.
For REGULATORY section: include the notification deadline prominently.
For SUMMARY section: write for a C-suite audience, start with business impact.
`

    const response = await model.generateContent(prompt)
    const text = response.response.text().trim()
    const jsonText = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '')

    let section
    try {
      section = reportSectionSchema.parse(JSON.parse(jsonText))
    } catch (err) {
      logger.error('ReportSection schema validation failed', {
        incidentId,
        err: err.message,
        raw: text.slice(0, 200)
      })
      return
    }

    // Persist to Firestore
    await firestoreService.updateReportSection(incidentId, section)

    // Broadcast to all connected SSE clients for this incident
    sseManager.broadcast(incidentId, { event: 'report_section', data: section })

    logger.info('Report section written', {
      incidentId,
      sectionId: section.sectionId,
      isUpdate: section.isUpdate,
      confidence: section.confidence
    })
  })

  logger.info('Reporter Agent started')
}
