import { logger } from '../utils/logger.js'

let searchClient = null

async function getClient() {
  if (searchClient) return searchClient
  const { SearchServiceClient } = await import('@google-cloud/discoveryengine').catch(() => null)
  if (!SearchServiceClient) {
    logger.warn('@google-cloud/discoveryengine not installed — using stub vertexSearch')
    return null
  }
  searchClient = new SearchServiceClient({ apiEndpoint: 'discoveryengine.googleapis.com' })
  return searchClient
}

/**
 * Query the runbooks datastore for incident response procedures.
 * @param {string} query
 * @param {{ filterServices?: string[] }} [opts]
 * @returns {Promise<string>} Formatted runbook snippets
 */
export async function queryRunbooks(query, opts = {}) {
  try {
    const projectId = process.env.GCP_PROJECT_ID
    const datastoreId = process.env.VERTEX_SEARCH_DATASTORE_RUNBOOKS
    if (!projectId || !datastoreId || datastoreId === 'your-runbooks-datastore-id') {
      return '[Runbook search not configured — set VERTEX_SEARCH_DATASTORE_RUNBOOKS]'
    }

    const client = await getClient()
    if (!client) return '[Vertex AI Search client unavailable]'

    const servingConfig = client.projectLocationCollectionDataStoreServingConfigPath(
      projectId, 'global', 'default_collection', datastoreId, 'default_search'
    )

    const [response] = await client.search({
      servingConfig,
      query,
      pageSize: 5,
    })

    const snippets = response.results?.map(r => {
      const doc = r.document?.derivedStructData?.fields
      return doc?.title?.stringValue
        ? `**${doc.title.stringValue}**: ${doc.snippets?.listValue?.values?.[0]?.stringValue || ''}`
        : JSON.stringify(r.document?.derivedStructData)
    }).filter(Boolean).join('\n')

    return snippets || '[No runbook results found]'
  } catch (err) {
    logger.warn('queryRunbooks failed', { query, err: err.message })
    return `[Runbook search error: ${err.message}]`
  }
}

/**
 * Query the regulatory corpus for DORA/SOX text.
 * @param {string} query
 * @param {'DORA'|'SOX'|'BOTH'} regulation
 * @returns {Promise<string>} Formatted regulatory text
 */
export async function queryRegulations(query, regulation) {
  try {
    const projectId = process.env.GCP_PROJECT_ID
    const datastoreId = process.env.VERTEX_SEARCH_DATASTORE_REGULATORY
    if (!projectId || !datastoreId || datastoreId === 'your-regulatory-datastore-id') {
      return '[Regulatory search not configured — set VERTEX_SEARCH_DATASTORE_REGULATORY]'
    }

    const client = await getClient()
    if (!client) return '[Vertex AI Search client unavailable]'

    const servingConfig = client.projectLocationCollectionDataStoreServingConfigPath(
      projectId, 'global', 'default_collection', datastoreId, 'default_search'
    )

    const fullQuery = regulation === 'BOTH' ? query : `${regulation} ${query}`
    const [response] = await client.search({ servingConfig, query: fullQuery, pageSize: 5 })

    const snippets = response.results?.map(r => {
      const doc = r.document?.derivedStructData?.fields
      return doc?.title?.stringValue
        ? `**${doc.title.stringValue}**: ${doc.snippets?.listValue?.values?.[0]?.stringValue || ''}`
        : JSON.stringify(r.document?.derivedStructData)
    }).filter(Boolean).join('\n')

    return snippets || '[No regulatory results found]'
  } catch (err) {
    logger.warn('queryRegulations failed', { query, regulation, err: err.message })
    return `[Regulatory search error: ${err.message}]`
  }
}
