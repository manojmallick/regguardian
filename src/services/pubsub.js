import { PubSub } from '@google-cloud/pubsub'
import { logger } from '../utils/logger.js'

const client = new PubSub({ projectId: process.env.GCP_PROJECT_ID })

/**
 * Publish a message to a Pub/Sub topic.
 * @param {string} topicName
 * @param {object} data
 */
export async function pubsubPublish(topicName, data) {
  const buffer = Buffer.from(JSON.stringify(data))
  await client.topic(topicName).publishMessage({ data: buffer })
}

/**
 * Subscribe to a Pub/Sub topic.
 * ACK after successful processing. On handler failure → nack → redelivered by Pub/Sub.
 * @param {string} topicName
 * @param {(data: object) => Promise<void>} handler
 */
export function pubsubSubscribe(topicName, handler) {
  const subscriptionName = `${topicName}-sub`
  const sub = client.subscription(subscriptionName, {
    flowControl: { maxMessages: 5 }  // don't flood agents with backlog
  })

  sub.on('message', async (message) => {
    const data = JSON.parse(message.data.toString())
    try {
      await handler(data)
      message.ack()
    } catch (err) {
      logger.error('Pub/Sub handler failed — nacking', {
        subscription: subscriptionName,
        err: err.message
      })
      message.nack()  // Pub/Sub redelivers after ack deadline
    }
  })

  sub.on('error', (err) =>
    logger.error('Pub/Sub subscription error', {
      subscription: subscriptionName,
      err: err.message
    })
  )

  logger.info('Subscribed to Pub/Sub topic', { topic: topicName, subscription: subscriptionName })
  return sub
}
