import { Firestore } from '@google-cloud/firestore'
import { logger } from '../utils/logger.js'

const db = new Firestore({ projectId: process.env.GCP_PROJECT_ID })

const INCIDENTS = process.env.FIRESTORE_COLLECTION_INCIDENTS || 'incidents'
const REPORTS   = process.env.FIRESTORE_COLLECTION_REPORTS   || 'reports'
const RUNBOOKS  = process.env.FIRESTORE_COLLECTION_RUNBOOKS  || 'runbooks'

/**
 * Create or update an incident document.
 * @param {string} incidentId
 * @param {object} data
 */
export async function updateIncident(incidentId, data) {
  await db.collection(INCIDENTS).doc(incidentId).set(
    { ...data, updatedAt: Firestore.FieldValue.serverTimestamp() },
    { merge: true }
  )
}

/**
 * Get an incident document.
 * @param {string} incidentId
 */
export async function getIncident(incidentId) {
  const doc = await db.collection(INCIDENTS).doc(incidentId).get()
  return doc.exists ? doc.data() : null
}

/**
 * Write or update a report section.
 * @param {string} incidentId
 * @param {{ sectionId: string, content: string, confidence: number, isUpdate: boolean }} section
 */
export async function updateReportSection(incidentId, section) {
  await db
    .collection(INCIDENTS).doc(incidentId)
    .collection('sections').doc(section.sectionId)
    .set({
      ...section,
      updatedAt: Firestore.FieldValue.serverTimestamp()
    }, { merge: true })
}

/**
 * Get all report sections for an incident, ordered by updatedAt.
 * @param {string} incidentId
 * @returns {Promise<object[]>}
 */
export async function getReportSections(incidentId) {
  const snap = await db
    .collection(INCIDENTS).doc(incidentId)
    .collection('sections')
    .get()
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

/**
 * Query past incidents involving specified services.
 * @param {string[]} serviceNames
 * @param {number} [maxResults=3]
 * @returns {Promise<object[]>}
 */
export async function queryPastIncidents(serviceNames, maxResults = 3) {
  try {
    const snap = await db.collection(INCIDENTS)
      .where('status', '==', 'resolved')
      .limit(50)
      .get()

    // Filter in memory — Firestore array-contains-any limited to 10 values
    const matched = snap.docs
      .map(d => d.data())
      .filter(d => {
        const services = d.latestAnalysis?.blastRadius?.services || []
        return serviceNames.some(s => services.includes(s))
      })
      .slice(0, maxResults)

    return matched
  } catch (err) {
    logger.warn('queryPastIncidents failed', { err: err.message })
    return []
  }
}

/**
 * Get a compliance report template.
 * @param {'DORA_ARTICLE_11'|'SOX_404'} templateType
 * @returns {Promise<string>}
 */
export async function getComplianceTemplate(templateType) {
  try {
    const doc = await db.collection('complianceTemplates').doc(templateType).get()
    return doc.exists ? doc.data().structure : `[Template ${templateType} not found in Firestore]`
  } catch (err) {
    logger.warn('getComplianceTemplate failed', { templateType, err: err.message })
    return `[Template ${templateType} unavailable]`
  }
}
