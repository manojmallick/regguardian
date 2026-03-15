import { z } from 'zod'

export const complianceMappingSchema = z.object({
  doraObligation: z.object({
    triggered: z.boolean(),
    clause: z.string(),                 // e.g. 'Art. 11.1(a)'
    notificationDeadline: z.string(),   // ISO datetime
    reportingType: z.enum(['initial', 'intermediate', 'final', 'none']),
  }),
  soxImpact: z.object({
    controlDeficiency: z.boolean(),
    classification: z.enum(['none', 'significant_deficiency', 'material_weakness']),
    remediationRequired: z.boolean(),
  }),
  reportTemplate: z.string(),           // template text from Firestore
  regulatoryNarrative: z.string(),      // human-readable compliance summary
})

/** @typedef {import('zod').infer<typeof complianceMappingSchema>} ComplianceMapping */
