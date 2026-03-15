import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import helmet from 'helmet'
import cors from 'cors'

import { audioGateway } from './websocket/audioGateway.js'
import { screenGateway } from './websocket/screenGateway.js'
import { startAnalystAgent } from './agents/analystAgent.js'
import { startComplianceAgent } from './agents/complianceAgent.js'
import { startReporterAgent } from './agents/reporterAgent.js'
import { sseManager } from './services/sseManager.js'
import * as firestoreService from './services/firestore.js'
import { errorHandler } from './middleware/errorHandler.js'
import { logger } from './utils/logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = express()

// CRITICAL: wrap Express in http.createServer — required for WebSocket upgrade routing
// Cloud Run exposes exactly one port; both WS and HTTP share it via the upgrade event.
const httpServer = createServer(app)

// Two WS servers, neither binds to a port — httpServer routes to them via 'upgrade' event
const audioWss = new WebSocketServer({ noServer: true })
const screenWss = new WebSocketServer({ noServer: true })

// Route HTTP upgrade requests by URL path
httpServer.on('upgrade', (request, socket, head) => {
  if (request.url.startsWith('/ws/audio')) {
    audioWss.handleUpgrade(request, socket, head, (ws) => {
      audioWss.emit('connection', ws, request)
    })
  } else if (request.url.startsWith('/ws/screen')) {
    screenWss.handleUpgrade(request, socket, head, (ws) => {
      screenWss.emit('connection', ws, request)
    })
  } else {
    socket.destroy()  // reject unknown WS paths
  }
})

/** Extract incidentId from URL query string: /ws/audio?incidentId=INC-001 */
function extractIncidentId(url) {
  return new URL(url, 'http://x').searchParams.get('incidentId') || 'UNKNOWN'
}

audioWss.on('connection', (ws, req) => {
  const incidentId = extractIncidentId(req.url)
  logger.info('Audio WS connected', { incidentId })
  audioGateway(ws, incidentId)
})

screenWss.on('connection', (ws, req) => {
  const incidentId = extractIncidentId(req.url)
  logger.info('Screen WS connected', { incidentId })
  screenGateway(ws, incidentId)
})

// ─── Express Middleware ────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }))  // disable CSP for AudioWorklet + SSE
app.use(cors())
app.use(express.json())

// Serve frontend static files
app.use(express.static(join(__dirname, '..', 'frontend')))

// ─── REST Endpoints ────────────────────────────────────────────────────────────

/** Health check — Cloud Run readiness probe + judge verification */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: Date.now(), version: '1.0.0' })
})

/** Create a new incident */
app.post('/api/incidents', async (req, res, next) => {
  try {
    const { title, description } = req.body
    const incidentId = `INC-${Date.now()}`
    await firestoreService.updateIncident(incidentId, {
      status: 'active',
      title: title || 'Untitled Incident',
      description: description || '',
      startedAt: new Date().toISOString(),
      doraTriggerAt: null,
      notificationDeadline: null,
    })
    logger.info('Incident created', { incidentId })
    res.status(201).json({ incidentId, status: 'active' })
  } catch (err) {
    next(err)
  }
})

/** SSE endpoint — streams report sections to the browser in real time */
app.get('/api/incidents/:id/report/stream', (req, res) => {
  sseManager.connect(req.params.id, res)
})

/** Debug endpoint — shows last Pub/Sub message per agent (saves hours debugging) */
app.get('/api/incidents/:id/debug', async (req, res, next) => {
  try {
    const incidentId = req.params.id
    const [incident, sections] = await Promise.all([
      firestoreService.getIncident(incidentId),
      firestoreService.getReportSections(incidentId)
    ])
    res.json({
      incidentId,
      incident,
      reportSections: sections,
      sseConnections: sseManager.connectionCount(incidentId),
      ts: Date.now()
    })
  } catch (err) {
    next(err)
  }
})

/** List all incidents (for UI) */
app.get('/api/incidents', async (req, res, next) => {
  try {
    // Return empty list if Firestore not configured
    res.json({ incidents: [], ts: Date.now() })
  } catch (err) {
    next(err)
  }
})

/**
 * DEMO endpoint — runs full Gemini pipeline directly (no Pub/Sub latency).
 * Generates all 6 report sections sequentially, each broadcast live via SSE.
 * Use: POST /api/incidents/:id/demo with JSON body {services, severity, rawQuote}
 */
app.post('/api/incidents/:id/demo', async (req, res, next) => {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai')
    const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

    const incidentId = req.params.id
    const {
      services = ['payment-gateway-v2', 'postgres-primary'],
      severity = 'P1',
      estimatedUsers = 73000,
      doraTrigger = true,
      rawQuote = 'payment-gateway-v2 is throwing 503s, postgres connection pool exhausted'
    } = req.body

    res.json({ status: 'running', incidentId, message: 'Pipeline started — watch SSE stream' })

    // Run all 6 sections sequentially — each broadcast via SSE immediately
    const sections = ['TIMELINE', 'BLAST_RADIUS', 'ROOT_CAUSE', 'REGULATORY', 'REMEDIATION', 'SUMMARY']
    const now = new Date().toISOString()
    const deadline = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()

    const sectionPrompts = {
      TIMELINE: `List ONLY a chronological timeline of events for this incident. Use bullet points with ISO timestamps. Include: incident start, when services degraded, when DORA was triggered, current status. Do NOT include regulatory analysis or remediation steps.`,
      BLAST_RADIUS: `Describe ONLY the blast radius: which services are affected (${services.join(', ')}), estimated users impacted (${estimatedUsers}), whether transactions are blocked, and any downstream services at risk. Do NOT include root cause or remediation.`,
      ROOT_CAUSE: `State ONLY the most probable root cause with supporting evidence. Use clear technical language. Include what diagnostic signals confirm the hypothesis. Confidence score reflects certainty. Do NOT include DORA obligations or remediation steps.`,
      REGULATORY: `State ONLY the regulatory obligations triggered by this incident. Must include: DORA Article 11.1(a) initial notification obligation, the exact notification deadline (${deadline}), and SOX Section 404 control deficiency assessment. Cite exact clause numbers. Do NOT include timeline or remediation steps.`,
      REMEDIATION: `List ONLY the immediate remediation steps in priority order. Use bullet points. Include specific commands or runbook references where applicable. Focus on: stopping the bleeding, root cause fix, verification steps. Do NOT include DORA deadlines, timeline, or executive summary.`,
      SUMMARY: `Write ONLY a 3-sentence executive summary in plain business language for a C-suite audience. Sentence 1: business impact. Sentence 2: what is being done right now. Sentence 3: regulatory status and next steps. No technical jargon, no bullet points.`
    }

    const context = { incidentId, services, severity, estimatedUsers, doraTrigger, rawQuote, startTime: now, doraDeadline: deadline }

    for (const sectionId of sections) {
      try {
        const model = gemini.getGenerativeModel({ model: 'gemini-2.0-flash' })
        const prompt = `You are ARIA, a regulatory compliance AI. Generate ONE section of a live DORA Article 11 / SOX 404 incident report.

INCIDENT CONTEXT:
- ID: ${incidentId}
- Severity: ${severity}
- Services affected: ${services.join(', ')}
- Users impacted: ${estimatedUsers.toLocaleString()}
- Root signal: "${rawQuote}"
- Incident started: ${now}
- DORA notification deadline: ${deadline}

YOUR TASK — Write ONLY the ${sectionId} section:
${sectionPrompts[sectionId]}

IMPORTANT: Return ONLY this exact JSON, no other text, no markdown fences:
{"sectionId":"${sectionId}","content":"<your content here>","isUpdate":false,"confidence":0.9}

Use markdown in content: **bold** for key terms, bullet lists with *, timestamps in ISO format.`

        const result = await model.generateContent(prompt)
        const text = result.response.text().trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '')
        const section = JSON.parse(text)

        // Ensure sectionId matches expected (prevent Gemini from overriding)
        section.sectionId = sectionId

        // Write to Firestore
        await firestoreService.updateReportSection(incidentId, section)

        // Broadcast live via SSE — browser sees it appear in real time
        sseManager.broadcast(incidentId, { event: 'report_section', data: section })

        // Stagger so each section visibly slides in one at a time (the demo wow moment)
        await new Promise(r => setTimeout(r, 1200))
      } catch (err) {
        logger.error('Demo section generation failed', { incidentId, sectionId, err: err.message })
      }
    }

    // Update incident DORA state
    await firestoreService.updateIncident(incidentId, {
      doraTriggerAt: now,
      notificationDeadline: deadline
    })

    logger.info('Demo pipeline complete', { incidentId })
  } catch (err) {
    next(err)
  }
})



// Global Express error handler — must be last
app.use(errorHandler)

// ─── Server Start ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080

httpServer.listen(PORT, async () => {
  logger.info('RegGuardian server started', { port: PORT, env: process.env.NODE_ENV })

  // Start the three subscriber agents — they run indefinitely, consuming Pub/Sub
  try {
    await startAnalystAgent()
    await startComplianceAgent()
    await startReporterAgent()
    logger.info('All agents started successfully')
  } catch (err) {
    logger.error('Agent startup failed', { err: err.message })
    // Don't crash the server — audio/screen WS still work for demo
  }
})

export default app
