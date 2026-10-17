import { EntityManager } from "@mikro-orm/postgresql";
import { AcceptWagerService, acceptWagerInTransaction, type AcceptWagerCommand } from "./accept-wager.service.js";
export { IdempotencyConflictError } from "./accept-wager.service.js";
export type { AcceptWagerResult as AcceptBetResult } from "./accept-wager.service.js";

// Compatibility boundary for existing BET-only callers.
export type AcceptBetCommand = Omit<AcceptWagerCommand, "kind">;
export function acceptBetInTransaction(tx: EntityManager, command: AcceptBetCommand) {
    return acceptWagerInTransaction(tx, { ...command, kind: "BET" });
}
export class AcceptBetService {
    constructor(private readonly em: EntityManager) {}
    execute(command: AcceptBetCommand) {
        return new AcceptWagerService(this.em).execute({ ...command, kind: "BET" });
    }
}
