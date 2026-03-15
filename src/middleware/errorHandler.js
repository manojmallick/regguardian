import { logger } from '../utils/logger.js'

/**
 * Global Express error handler — must be last middleware in the chain.
 * Signature must have 4 params for Express to treat it as error handler.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500
  const message = err.message || 'Internal Server Error'

  logger.error('Unhandled Express error', {
    status,
    message,
    path: req.path,
    method: req.method,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined
  })

  res.status(status).json({
    error: message,
    status,
    ts: Date.now()
  })
}
