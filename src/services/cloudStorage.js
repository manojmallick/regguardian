import { Storage } from '@google-cloud/storage'
import { logger } from '../utils/logger.js'

const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID })
const screenshotBucket = process.env.GCS_BUCKET_SCREENSHOTS || 'regguardian-screenshots'
const reportBucket     = process.env.GCS_BUCKET_REPORTS     || 'regguardian-reports'

/**
 * Archive a screenshot frame to Cloud Storage.
 * Called fire-and-forget — no await in caller.
 * @param {Buffer} frameBuffer
 * @param {string} incidentId
 */
export async function archiveFrame(frameBuffer, incidentId) {
  const filename = `${incidentId}/${Date.now()}.png`
  await storage.bucket(screenshotBucket).file(filename).save(frameBuffer, {
    metadata: { contentType: 'image/png' }
  })
  logger.debug('Frame archived', { incidentId, filename })
}

/**
 * Export a finalized report to Cloud Storage.
 * @param {string} incidentId
 * @param {string} reportContent
 */
export async function exportReport(incidentId, reportContent) {
  const filename = `${incidentId}/report-final.txt`
  await storage.bucket(reportBucket).file(filename).save(reportContent, {
    metadata: { contentType: 'text/plain' }
  })
  logger.info('Report exported', { incidentId, filename })
  return `gs://${reportBucket}/${filename}`
}
