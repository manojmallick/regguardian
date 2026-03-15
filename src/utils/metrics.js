import { logger } from './logger.js'

// Cloud Monitoring custom metric writer
// Metrics: incident_response_ms, vision_agent_latency_ms, agent_latency_ms, circuit_breaker_open
//
// In production, replace console-based recording with @google-cloud/monitoring API calls.
// The record() function intentionally does not throw — metrics are best-effort.

let monitoringClient = null

async function getClient() {
  if (monitoringClient) return monitoringClient
  try {
    const { MetricServiceClient } = await import('@google-cloud/monitoring')
    monitoringClient = new MetricServiceClient()
    return monitoringClient
  } catch {
    return null
  }
}

/**
 * Record a custom metric to Cloud Monitoring.
 * @param {string} metricName - e.g. 'incident_response_ms'
 * @param {number} value
 * @param {{ incidentId?: string }} [labels]
 */
export async function record(metricName, value, labels = {}) {
  try {
    const projectId = process.env.GCP_PROJECT_ID
    if (!projectId) {
      logger.debug('Metrics: GCP_PROJECT_ID not set — skipping', { metricName, value })
      return
    }

    const client = await getClient()
    if (!client) return

    const projectName = client.projectPath(projectId)
    const now = Date.now()
    const dataPoint = {
      interval: {
        endTime: { seconds: Math.floor(now / 1000), nanos: (now % 1000) * 1e6 }
      },
      value: { int64Value: Math.round(value) }
    }

    const timeSeriesData = {
      metric: {
        type: `custom.googleapis.com/regguardian/${metricName}`,
        labels
      },
      resource: {
        type: 'global',
        labels: { project_id: projectId }
      },
      points: [dataPoint]
    }

    await client.createTimeSeries({ name: projectName, timeSeries: [timeSeriesData] })
    logger.debug('Metric recorded', { metricName, value })
  } catch (err) {
    logger.warn('Metric write failed (non-fatal)', { metricName, err: err.message })
  }
}
