// Structured JSON logger with incidentId correlation
// Cloud Logging indexes on structured JSON fields

export const logger = {
  info:  (msg, meta = {}) => console.log(JSON.stringify({ level: 'INFO',  message: msg, ...meta, ts: Date.now() })),
  warn:  (msg, meta = {}) => console.warn(JSON.stringify({ level: 'WARN',  message: msg, ...meta, ts: Date.now() })),
  error: (msg, meta = {}) => console.error(JSON.stringify({ level: 'ERROR', message: msg, ...meta, ts: Date.now() })),
  debug: (msg, meta = {}) => process.env.NODE_ENV !== 'production' &&
                              console.log(JSON.stringify({ level: 'DEBUG', message: msg, ...meta, ts: Date.now() })),
}
