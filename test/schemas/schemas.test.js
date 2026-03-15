import { test } from 'node:test'
import assert from 'node:assert/strict'
import { incidentEventSchema } from '../../src/schemas/incidentEvent.js'
import { visualContextSchema } from '../../src/schemas/visualContext.js'
import { incidentAnalysisSchema } from '../../src/schemas/incidentAnalysis.js'
import { complianceMappingSchema } from '../../src/schemas/complianceMapping.js'
import { reportSectionSchema } from '../../src/schemas/reportSection.js'

// ─── IncidentEvent ────────────────────────────────────────────────────────────

test('incidentEvent: valid service_failure passes', () => {
  const result = incidentEventSchema.safeParse({
    type: 'service_failure',
    services: ['payment-gateway-v2'],
    severity: 'P1',
    blastRadius: { estimatedUsers: 73000, affectedPct: 7.3 },
    doraTrigger: true,
    speakerRole: 'ENGINEER',
    ariaResponse: 'Payment gateway is failing on /api/charge with 503 errors.',
    rawQuote: 'payment-gateway-v2 is throwing 503s'
  })
  assert.ok(result.success, JSON.stringify(result.error?.issues))
})

test('incidentEvent: invalid type rejected', () => {
  const result = incidentEventSchema.safeParse({
    type: 'unknown_type',
    services: ['svc'],
    severity: 'P1',
    doraTrigger: false,
    speakerRole: 'ENGINEER',
    ariaResponse: 'test',
    rawQuote: 'test'
  })
  assert.ok(!result.success)
})

test('incidentEvent: empty services array rejected', () => {
  const result = incidentEventSchema.safeParse({
    type: 'service_failure',
    services: [],
    severity: 'P1',
    doraTrigger: false,
    speakerRole: 'ENGINEER',
    ariaResponse: 'test',
    rawQuote: 'test'
  })
  assert.ok(!result.success)
})

test('incidentEvent: ariaResponse over 300 chars rejected', () => {
  const result = incidentEventSchema.safeParse({
    type: 'timeline_event',
    services: ['svc'],
    severity: 'UNKNOWN',
    doraTrigger: false,
    speakerRole: 'UNKNOWN',
    ariaResponse: 'A'.repeat(301),
    rawQuote: 'test'
  })
  assert.ok(!result.success)
})

test('incidentEvent: blastRadius is optional', () => {
  const result = incidentEventSchema.safeParse({
    type: 'timeline_event',
    services: ['svc'],
    severity: 'P3',
    doraTrigger: false,
    speakerRole: 'UNKNOWN',
    ariaResponse: 'Monitoring.',
    rawQuote: 'nothing critical'
  })
  assert.ok(result.success)
})

// ─── VisualContext ────────────────────────────────────────────────────────────

test('visualContext: valid context passes', () => {
  const result = visualContextSchema.safeParse({
    anomalies: [{ name: 'CPU Usage', value: '94.7%', direction: 'spike' }],
    serviceHealth: [{ name: 'payment-gateway', status: 'red' }],
    runbookTriggers: ['RB-042'],
    doraCritical: true,
    errorIndicators: ['503 Service Unavailable'],
    ariaObservation: 'CPU is at 94.7% and payment gateway shows red.'
  })
  assert.ok(result.success, JSON.stringify(result.error?.issues))
})

test('visualContext: invalid direction rejected', () => {
  const result = visualContextSchema.safeParse({
    anomalies: [{ name: 'CPU', value: '90%', direction: 'exploding' }],
    serviceHealth: [],
    runbookTriggers: [],
    doraCritical: false,
    ariaObservation: 'test'
  })
  assert.ok(!result.success)
})

test('visualContext: errorIndicators is optional', () => {
  const result = visualContextSchema.safeParse({
    anomalies: [],
    serviceHealth: [{ name: 'svc', status: 'green' }],
    runbookTriggers: [],
    doraCritical: false,
    ariaObservation: 'All systems nominal.'
  })
  assert.ok(result.success)
})

// ─── IncidentAnalysis ─────────────────────────────────────────────────────────

test('incidentAnalysis: valid analysis passes', () => {
  const result = incidentAnalysisSchema.safeParse({
    rootCause: 'payment-gateway-v2 overload due to DB connection pool exhaustion',
    severity: 'P1',
    blastRadius: { services: ['payment-gateway-v2', 'postgres-primary'], estimatedUsers: 73000, transactionsBlocked: 15200 },
    doraTrigger: true,
    remediationSteps: ['Scale payment-gateway-v2 to 10 replicas', 'Increase DB pool size'],
    runbookMatches: ['RB-042', 'RB-017'],
    confidence: 0.82
  })
  assert.ok(result.success, JSON.stringify(result.error?.issues))
})

test('incidentAnalysis: confidence out of range rejected', () => {
  const result = incidentAnalysisSchema.safeParse({
    rootCause: 'test',
    severity: 'P2',
    blastRadius: { services: [], estimatedUsers: 0, transactionsBlocked: 0 },
    doraTrigger: false,
    remediationSteps: [],
    runbookMatches: [],
    confidence: 1.5  // invalid
  })
  assert.ok(!result.success)
})

// ─── ComplianceMapping ────────────────────────────────────────────────────────

test('complianceMapping: valid DORA triggered mapping passes', () => {
  const result = complianceMappingSchema.safeParse({
    doraObligation: {
      triggered: true,
      clause: 'Art. 11.1(a)',
      notificationDeadline: '2026-03-15T16:00:00Z',
      reportingType: 'initial'
    },
    soxImpact: { controlDeficiency: true, classification: 'significant_deficiency', remediationRequired: true },
    reportTemplate: 'DORA Article 11 initial notification template...',
    regulatoryNarrative: 'This incident triggers DORA Art. 11.1(a) notification within 4 hours.'
  })
  assert.ok(result.success, JSON.stringify(result.error?.issues))
})

test('complianceMapping: invalid classification rejected', () => {
  const result = complianceMappingSchema.safeParse({
    doraObligation: { triggered: false, clause: '', notificationDeadline: '', reportingType: 'none' },
    soxImpact: { controlDeficiency: false, classification: 'catastrophic_failure', remediationRequired: false },
    reportTemplate: '',
    regulatoryNarrative: ''
  })
  assert.ok(!result.success)
})

// ─── ReportSection ────────────────────────────────────────────────────────────

test('reportSection: valid TIMELINE passes', () => {
  const result = reportSectionSchema.safeParse({
    sectionId: 'TIMELINE',
    content: 'T+0: payment-gateway-v2 503 errors detected\nT+8m: database also failing',
    isUpdate: false,
    confidence: 0.9
  })
  assert.ok(result.success, JSON.stringify(result.error?.issues))
})

test('reportSection: all section IDs valid', () => {
  const ids = ['TIMELINE', 'BLAST_RADIUS', 'ROOT_CAUSE', 'REGULATORY', 'REMEDIATION', 'SUMMARY']
  for (const id of ids) {
    const result = reportSectionSchema.safeParse({
      sectionId: id, content: 'content', isUpdate: false, confidence: 0.5
    })
    assert.ok(result.success, `Failed for sectionId: ${id}`)
  }
})

test('reportSection: invalid sectionId rejected', () => {
  const result = reportSectionSchema.safeParse({
    sectionId: 'EXECUTIVE_BRIEF',
    content: 'test',
    isUpdate: false,
    confidence: 0.5
  })
  assert.ok(!result.success)
})

test('reportSection: confidence 0 and 1 are valid boundaries', () => {
  for (const confidence of [0, 1]) {
    const result = reportSectionSchema.safeParse({
      sectionId: 'SUMMARY', content: 'test', isUpdate: true, confidence
    })
    assert.ok(result.success, `Failed for confidence: ${confidence}`)
  }
})
