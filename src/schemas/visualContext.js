import { z } from 'zod'

export const visualContextSchema = z.object({
  anomalies: z.array(z.object({
    name: z.string(),                                         // e.g. 'CPU Usage'
    value: z.string(),                                        // e.g. '94.7%'
    direction: z.enum(['spike', 'drop', 'flatline', 'normal']),
  })),
  serviceHealth: z.array(z.object({
    name: z.string(),
    status: z.enum(['red', 'amber', 'green', 'unknown']),
  })),
  runbookTriggers: z.array(z.string()),   // runbook IDs visible on screen
  doraCritical: z.boolean(),
  errorIndicators: z.array(z.string()).optional(),
  ariaObservation: z.string(),            // one sentence ARIA says about screen
})

/** @typedef {import('zod').infer<typeof visualContextSchema>} VisualContext */
