import { GoogleGenerativeAI } from '@google/generative-ai'
import { complianceMappingSchema } from '../schemas/complianceMapping.js'
import { pubsubSubscribe, pubsubPublish } from '../services/pubsub.js'
import * as vertexSearch from '../services/vertexSearch.js'
import * as firestoreService from '../services/firestore.js'
import { logger } from '../utils/logger.js'

const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

const COMPLIANCE_SYSTEM_PROMPT = `
You are ARIA, Compliance Mode. Map incident analysis to regulatory requirements.

DORA Article 11 obligations:
- Art. 11.1(a): Initial notification to competent authority within 4 hours of classification
- Art. 11.1(b): Intermediate report within 72 hours
- Art. 11.1(c): Final report within 1 month
- Major incident threshold: >5% transactions OR >2hr downtime

SOX Section 404:
- Assess if incident = control deficiency
- Classify: significant deficiency vs material weakness
- Flag if remediation required before next quarterly assessment

ALWAYS cite exact clause text. ALWAYS compute notificationDeadline as ISO datetime.

Output ONLY valid JSON:
{ "doraObligation": {
    "triggered": false,
    "clause": "Art. 11.1(a)",
    "notificationDeadline": "<ISO datetime>",
    "reportingType": "initial|intermediate|final|none"
  },
  "soxImpact": {
    "controlDeficiency": false,
    "classification": "none|significant_deficiency|material_weakness",
    "remediationRequired": false
  },
  "reportTemplate": "<template text>",
  "regulatoryNarrative": "<human-readable summary>" }
`

/**
 * Start the Compliance Agent — subscribes to incident-analysis.
 * Skips P3 non-regulatory incidents to avoid unnecessary processing.
 */
export async function startComplianceAgent() {
  pubsubSubscribe('incident-analysis', async (analysis) => {
    // Optimisation: skip non-regulatory P3 incidents
    if (!analysis.doraTrigger && analysis.severity === 'P3') {
      logger.debug('Skipping compliance agent — non-regulatory P3', { incidentId: analysis.incidentId })
      return
    }

    const incidentId = analysis.incidentId

    // Enrich with regulatory text — tool call equivalent
    const regulatoryContext = await vertexSearch.queryRegulations(
      'DORA Article 11 major incident notification threshold', 'DORA'
    )

    const soxContext = await vertexSearch.queryRegulations(
      'SOX Section 404 control deficiency material weakness', 'SOX'
    )

    // Fetch report template
    const reportTemplate = await firestoreService.getComplianceTemplate('DORA_ARTICLE_11')

    const model = gemini.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: COMPLIANCE_SYSTEM_PROMPT
    })

    const prompt = `
Incident analysis:
${JSON.stringify(analysis, null, 2)}

DORA regulatory text:
${regulatoryContext}

SOX regulatory text:
${soxContext}

Report template:
${reportTemplate}

Current time (incident start reference): ${new Date().toISOString()}
`

    const response = await model.generateContent(prompt)
    const text = response.response.text().trim()
    const jsonText = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '')

    let mapping
    try {
      mapping = complianceMappingSchema.parse(JSON.parse(jsonText))
    } catch (err) {
      logger.error('ComplianceMapping schema validation failed', {
        incidentId,
        err: err.message,
        raw: text.slice(0, 200)
      })
      return
    }

    await pubsubPublish('compliance-mappings', { ...mapping, incidentId })

    logger.info('ComplianceMapping published', {
      incidentId,
      doraTriggered: mapping.doraObligation.triggered,
      soxClassification: mapping.soxImpact.classification
    })
  })

  logger.info('Compliance Agent started')
}
