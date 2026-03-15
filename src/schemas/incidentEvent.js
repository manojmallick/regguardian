import { z } from 'zod'

export const incidentEventSchema = z.object({
  type: z.enum(['service_failure', 'error_spike', 'blast_radius_update', 'timeline_event', 'severity_change'])
          .default('timeline_event'),
  // Bug fix: min(1) caused silent DLQ drops when user didn't name an explicit service.
  // Default to ['unknown'] so any spoken utterance flows through the pipeline.
  services: z.array(z.string()).default(['unknown']),
  severity: z.enum(['P1', 'P2', 'P3', 'UNKNOWN']).default('UNKNOWN'),
  blastRadius: z.object({
    estimatedUsers: z.number().nonnegative(),
    affectedPct: z.number().min(0).max(100),
  }).optional(),
  doraTrigger: z.boolean().default(false),   // >5% txns affected OR >2hr downtime
  speakerRole: z.enum(['ENGINEER', 'COMPLIANCE', 'EXECUTIVE', 'UNKNOWN']).default('UNKNOWN'),
  ariaResponse: z.string().max(500).default(''),  // what ARIA says aloud
  rawQuote: z.string().default(''),               // verbatim transcript for audit
})

/** @typedef {import('zod').infer<typeof incidentEventSchema>} IncidentEvent */
