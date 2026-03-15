import { z } from 'zod'

export const incidentAnalysisSchema = z.object({
  rootCause: z.string(),
  severity: z.enum(['P1', 'P2', 'P3', 'UNKNOWN']),
  blastRadius: z.object({
    services: z.array(z.string()),
    estimatedUsers: z.number(),
    transactionsBlocked: z.number(),
  }),
  doraTrigger: z.boolean(),
  remediationSteps: z.array(z.string()),
  runbookMatches: z.array(z.string()),
  confidence: z.number().min(0).max(1),
})

/** @typedef {import('zod').infer<typeof incidentAnalysisSchema>} IncidentAnalysis */
