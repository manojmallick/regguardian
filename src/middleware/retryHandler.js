/**
 * Retry an async function with exponential backoff + jitter.
 * @param {Function} fn - Async function to retry
 * @param {{ maxRetries?: number, baseDelay?: number }} [opts]
 * @returns {Promise<*>}
 */
export async function retryWithBackoff(fn, { maxRetries = 3, baseDelay = 1000 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt === maxRetries) throw err
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 100
      await new Promise(r => setTimeout(r, delay))
    }
  }
}
