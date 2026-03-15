import { z } from 'zod'

export const reportSectionSchema = z.object({
  sectionId: z.enum(['TIMELINE', 'BLAST_RADIUS', 'ROOT_CAUSE', 'REGULATORY', 'REMEDIATION', 'SUMMARY']),
  content: z.string(),
  isUpdate: z.boolean(),     // true = replaces existing section, false = new
  confidence: z.number().min(0).max(1),
})

/** @typedef {import('zod').infer<typeof reportSectionSchema>} ReportSection */
