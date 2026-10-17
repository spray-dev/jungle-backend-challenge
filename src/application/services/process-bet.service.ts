import { EntityManager } from "@mikro-orm/postgresql";
import { WagerTransactionKind } from "../../domain/wager-transaction.js";
import { ProcessWagerService, processWagerInTransaction, createWagerRepositories, type WagerRepositoryFactory } from "./process-wager.service.js";
export { createWagerRepositories as createBetRepositories } from "./process-wager.service.js";
export type { WagerRepositories as BetRepositories, WagerRepositoryFactory as BetRepositoryFactory } from "./process-wager.service.js";

// Retain the BET-only contract without duplicating processing or retry logic.
export function processBetInTransaction(tx: EntityManager, id: string, repositories: WagerRepositoryFactory = createWagerRepositories) {
    return processWagerInTransaction(tx, id, repositories, [WagerTransactionKind.Bet]);
}
export class ProcessBetService extends ProcessWagerService {
    constructor(em: EntityManager, repositories: WagerRepositoryFactory = createWagerRepositories, maxAttempts = 5) {
        super(em, repositories, maxAttempts, [WagerTransactionKind.Bet]);
    }
}
