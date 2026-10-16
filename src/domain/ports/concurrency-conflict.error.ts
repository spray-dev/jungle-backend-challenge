// Conflito recuperável: o chamador deve reler o estado em uma nova transação.
export class ConcurrencyConflictError extends Error {
    override readonly name = "ConcurrencyConflictError";
}
