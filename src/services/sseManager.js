import { logger } from '../utils/logger.js'
import * as firestore from './firestore.js'

// incidentId → Set<ExpressResponse>
const connections = new Map()

export const sseManager = {
  /**
   * Register an SSE client connection.
   * Sends all existing report sections immediately (catch-up).
   * @param {string} incidentId
   * @param {import('express').Response} res
   */
  connect(incidentId, res) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    if (!connections.has(incidentId)) connections.set(incidentId, new Set())
    connections.get(incidentId).add(res)

    logger.info('SSE client connected', { incidentId })

    // Heartbeat every 15s — prevents proxy timeout
    const hb = setInterval(() => res.write(':heartbeat\n\n'), 15_000)

    // Catch-up: send all sections written so far
    firestore.getReportSections(incidentId).then(sections => {
      sections.forEach(s => sseManager.sendToClient(res, 'report_section', s))
    }).catch(err => {
      logger.warn('SSE catch-up failed', { incidentId, err: err.message })
    })

    res.on('close', () => {
      clearInterval(hb)
      connections.get(incidentId)?.delete(res)
      logger.info('SSE client disconnected', { incidentId })
    })
  },

  /**
   * Broadcast an event to all SSE clients for an incident.
   * @param {string} incidentId
   * @param {{ event: string, data: object }} payload
   */
  broadcast(incidentId, { event, data }) {
    connections.get(incidentId)?.forEach(res => sseManager.sendToClient(res, event, data))
  },

  /**
   * Send a single SSE event to one client.
   * @param {import('express').Response} res
   * @param {string} event
   * @param {object} data
   */
  sendToClient(res, event, data) {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  },

  /** Return active connection count for an incident (for debug endpoint). */
  connectionCount(incidentId) {
    return connections.get(incidentId)?.size ?? 0
  }
}
