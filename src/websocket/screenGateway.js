import { createVisionAgent } from '../agents/visionAgent.js'
import { logger } from '../utils/logger.js'

/**
 * Screen WebSocket gateway — thin lifecycle handler only.
 * Delegates all business logic to visionAgent.
 * @param {import('ws').WebSocket} ws
 * @param {string} incidentId
 */
export function screenGateway(ws, incidentId) {
  const agent = createVisionAgent(incidentId)

  // Binary frames = PNG screenshot chunks from browser
  ws.on('message', (frame, isBinary) => {
    if (!isBinary) return  // ignore text control frames
    agent.processFrame(frame)  // no await — visionAgent handles its own async
  })

  ws.on('close', () => {
    agent.stop()
    logger.info('Screen WS closed', { incidentId })
  })

  ws.on('error', (err) => {
    logger.error('Screen WS error', { incidentId, err: err.message })
    agent.stop()
  })
}
