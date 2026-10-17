import { Controller, Get, Inject, ServiceUnavailableException, type OnModuleDestroy } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient, ListQueuesCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

@Controller('health')
export class HealthController implements OnModuleDestroy {
    private readonly sqs = new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1',
        endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566', maxAttempts: 1,
        credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' } });
    private readonly queueUrls = [process.env.WAGER_SQS_QUEUE_URL, process.env.WAGER_SQS_EVENTS_QUEUE_URL]
        .map(url => url?.trim()).filter((url): url is string => !!url);
    constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}
    @Get('live')
    live(): { status: 'ok' } { return { status: 'ok' }; }
    @Get('ready')
    async ready() {
        const checks = await Promise.allSettled([
            this.orm.em.fork().transactional(async tx => {
                await tx.execute("set local statement_timeout = '2000ms'");
                await tx.execute('select 1');
            }),
            this.queueUrls.length
                ? Promise.all(this.queueUrls.map(QueueUrl => this.sqs.send(new GetQueueAttributesCommand({
                    QueueUrl, AttributeNames: ['QueueArn'],
                }), { abortSignal: AbortSignal.timeout(2500) })))
                : this.sqs.send(new ListQueuesCommand({ MaxResults: 1 }), { abortSignal: AbortSignal.timeout(2500) }),
        ]);
        const dependencies = { postgres: checks[0].status === 'fulfilled', sqs: checks[1].status === 'fulfilled' };
        if (!dependencies.postgres || !dependencies.sqs) throw new ServiceUnavailableException({ status: 'not_ready', dependencies });
        return { status: 'ready', dependencies };
    }
    onModuleDestroy() { this.sqs.destroy(); }
}
