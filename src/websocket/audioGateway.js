import { startListenerAgent } from '../agents/listenerAgent.js'
import { logger } from '../utils/logger.js'

/**
 * Audio WebSocket gateway — thin lifecycle handler only.
 * Delegates all business logic to listenerAgent.
 * @param {import('ws').WebSocket} ws
 * @param {string} incidentId
 */
export function audioGateway(ws, incidentId) {
  const agent = startListenerAgent(incidentId)

  // Binary frames = PCM audio chunks from browser
  ws.on('message', (chunk, isBinary) => {
    if (!isBinary) return  // ignore text control frames
    agent.sendAudio(chunk)
  })

  ws.on('close', () => {
    agent.stop()
    logger.info('Audio WS closed', { incidentId })
  })

  ws.on('error', (err) => {
    logger.error('Audio WS error', { incidentId, err: err.message })
    agent.stop()
  })

  // Detect dead connections — ping every 30s
  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping()
    else clearInterval(heartbeat)
  }, 30_000)

  ws.on('close', () => clearInterval(heartbeat))
}
