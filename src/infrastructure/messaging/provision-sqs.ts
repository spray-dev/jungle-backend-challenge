import { CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { createSqsClient } from './sqs-client.js';

export async function provisionQueues() {
    const client = createSqsClient();
    try {
        const create = async (name: string) => {
            const result = await client.send(new CreateQueueCommand({ QueueName: name,
                Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' } }));
            if (!result.QueueUrl) throw new Error('Missing queue URL');
            return result.QueueUrl;
        };
        const dlq = await create('wager-transactions-dlq.fifo');
        const attrs = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }));
        if (!attrs.Attributes?.QueueArn) throw new Error('Missing DLQ ARN');
        const input = await create('wager-transactions.fifo');
        await client.send(new SetQueueAttributesCommand({ QueueUrl: input, Attributes: {
            VisibilityTimeout: '60', ReceiveMessageWaitTimeSeconds: '1',
            RedrivePolicy: JSON.stringify({ deadLetterTargetArn: attrs.Attributes.QueueArn, maxReceiveCount: '5' }),
        } }));
        const events = await create('wager-events.fifo');
        return { input, events, dlq };
    } finally { client.destroy(); }
}

if (import.meta.main) {
    provisionQueues().then(({ input, events }) => {
        console.log('WAGER_SQS_QUEUE_URL=' + input);
        console.log('WAGER_SQS_EVENTS_QUEUE_URL=' + events);
    }).catch(() => { console.error('SQS provisioning failed; check endpoint, credentials and queue permissions.'); process.exitCode = 1; });
}
