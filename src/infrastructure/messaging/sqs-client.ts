import { SQSClient } from '@aws-sdk/client-sqs';

export function createSqsClient(): SQSClient {
    return new SQSClient({
        region: process.env.AWS_REGION ?? 'us-east-1',
        endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
        credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' },
        maxAttempts: 2,
        requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
    });
}
