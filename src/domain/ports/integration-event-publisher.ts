import type {
    IntegrationEventEnvelope,
} from "../events/integration-event.js";

export interface IntegrationEventPublisher {
    publish(
        event: IntegrationEventEnvelope<unknown>,
    ): Promise<void>;
}