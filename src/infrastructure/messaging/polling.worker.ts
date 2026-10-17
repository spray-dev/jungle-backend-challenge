import { Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';

// Schedule only after completion: a slow iteration can never overlap the next one.
export class PollingWorker implements OnModuleInit, OnModuleDestroy {
    protected readonly logger: Logger;
    private timer?: ReturnType<typeof setTimeout>;
    private active?: Promise<void>;
    private stopped = false;
    private started = false;
    constructor(private readonly name: string, private readonly run: (() => Promise<void>) | undefined,
        private readonly intervalMs: number, private readonly dispose: () => void = () => {}) {
        this.logger = new Logger(name);
    }
    onModuleInit(): void {
        if (this.started || this.stopped) return;
        this.started = true;
        if (!this.run) { this.logger.warn({ event: 'worker_disabled', worker: this.name, reason: 'queue_url_not_configured' }); return; }
        this.logger.log({ event: 'worker_started', worker: this.name });
        this.schedule(0);
    }
    private schedule(delay: number): void {
        if (this.stopped) return;
        this.timer = setTimeout(() => {
            this.active = Promise.resolve().then(() => this.run!()).catch(() => {
                this.logger.error({ event: 'worker_iteration_failed', worker: this.name });
            }).finally(() => this.schedule(this.intervalMs));
        }, delay);
        this.timer.unref();
    }
    async onModuleDestroy(): Promise<void> {
        this.stopped = true;
        clearTimeout(this.timer);
        await this.active;
        this.dispose();
    }
}
