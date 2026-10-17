import { Logger, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { RetryPendingReferenceService, safeRetryErrorCode } from "../../application/services/retry-pending-reference.service.js";

export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PendingReferenceWorker.name);
    private timer?: ReturnType<typeof setTimeout>;
    private active?: Promise<void>;
    private stopped = false;
    constructor(private readonly service: RetryPendingReferenceService) {}
    onModuleInit(): void { this.schedule(); }
    private schedule(): void {
        if (this.stopped) return;
        this.timer = setTimeout(() => {
            this.active = this.service.retryPending().then(() => {}).catch((error: unknown) => {
                this.logger.error({ event: "pending_reference_round_failed", errorCode: safeRetryErrorCode(error) });
            }).finally(() => this.schedule());
        }, 1_000);
        this.timer.unref();
    }
    async onModuleDestroy(): Promise<void> {
        this.stopped = true;
        clearTimeout(this.timer);
        await this.active;
    }
}
