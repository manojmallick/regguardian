import CircuitBreaker from 'opossum'
import { logger } from '../utils/logger.js'

/**
 * Wrap an async function with a circuit breaker.
 * @param {Function} fn - The async function to protect
 * @param {string} name  - Service name for logging
 * @param {object} [opts] - opossum options to override defaults
 * @returns {Function} Protected function (circuit breaker .fire)
 */
export function createCircuitBreaker(fn, name, opts = {}) {
  const breaker = new CircuitBreaker(fn, {
    timeout: 5000,                    // fail if > 5s
    errorThresholdPercentage: 50,     // open if 50% of calls fail
    resetTimeout: 30000,              // try half-open after 30s
    ...opts
  })

  breaker.on('open',     () => logger.warn('Circuit OPEN — fallback active', { service: name }))
  breaker.on('halfOpen', () => logger.info('Circuit testing...', { service: name }))
  breaker.on('close',    () => logger.info('Circuit CLOSED — restored', { service: name }))
  breaker.fallback(() => ({ fallback: true, mode: 'batch' }))

  return breaker.fire.bind(breaker)
}
