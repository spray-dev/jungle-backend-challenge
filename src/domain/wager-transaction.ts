import { Money } from "./money.js";
import type { LedgerDirection } from "./wallet-ledger-entry.js";

export enum WagerTransactionKind {
    Opening = "OPENING",
    Bet = "BET",
    Win = "WIN",
    Loss = "LOSS",
    Refund = "REFUND",
    Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
    Pending = "PENDING",
    PendingReference = "PENDING_REFERENCE",
    Processed = "PROCESSED",
    Rejected = "REJECTED",
    Failed = "FAILED",
}

export enum FailureCode {
    CurrencyMismatch = "CURRENCY_MISMATCH",
    PlayerMismatch = "PLAYER_MISMATCH",
    InvalidAmount = "INVALID_AMOUNT",
    InsufficientFunds = "INSUFFICIENT_FUNDS",
    ReferenceNotFound = "REFERENCE_NOT_FOUND",
    ReferenceNotReady = "REFERENCE_NOT_READY",
    ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
    InvalidReference = "INVALID_REFERENCE",
    ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",
    IdempotencyConflict = "IDEMPOTENCY_CONFLICT",
    InfrastructureFailure = "INFRASTRUCTURE_FAILURE",
}

export interface CreateWagerTransactionProps {
    id: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: Money;
    referenceExternalTransactionId?: string;
    createdAt: Date;
}

export interface WagerTransactionState
    extends CreateWagerTransactionProps {
    status: WagerTransactionStatus;
    referenceTransactionId?: string;
    failureCode?: FailureCode;
    processedAt?: Date;
    observedBalance?: Money;
}

export class WagerTransaction {
    private constructor(
        public readonly id: string,
        public readonly providerId: string,
        public readonly externalTransactionId: string,
        public readonly idempotencyKey: string,
        public readonly payloadHash: string,
        public readonly walletId: string,
        public readonly playerId: string,
        public readonly roundId: string,
        public readonly gameId: string,
        public readonly kind: WagerTransactionKind,
        public readonly money: Money,
        public readonly referenceExternalTransactionId: string | undefined,
        public readonly createdAt: Date,
        private _status: WagerTransactionStatus,
        private _referenceTransactionId?: string,
        private _failureCode?: FailureCode,
        private _processedAt?: Date,
        private _observedBalance?: Money,
    ) { }

    static create(
        props: CreateWagerTransactionProps,
    ): WagerTransaction {
        const requiresReference =
            props.kind === WagerTransactionKind.Refund ||
            props.kind === WagerTransactionKind.Rollback;

        if (
            requiresReference &&
            !props.referenceExternalTransactionId?.trim()
        ) {
            throw new Error(
                `${props.kind} requires a reference transaction`,
            );
        }

        return new WagerTransaction(
            props.id,
            props.providerId,
            props.externalTransactionId,
            props.idempotencyKey,
            props.payloadHash,
            props.walletId,
            props.playerId,
            props.roundId,
            props.gameId,
            props.kind,
            props.money,
            props.referenceExternalTransactionId,
            new Date(props.createdAt.getTime()),
            WagerTransactionStatus.Pending,
        );
    }

    static rehydrate(
        state: WagerTransactionState,
    ): WagerTransaction {
        return new WagerTransaction(
            state.id,
            state.providerId,
            state.externalTransactionId,
            state.idempotencyKey,
            state.payloadHash,
            state.walletId,
            state.playerId,
            state.roundId,
            state.gameId,
            state.kind,
            state.money,
            state.referenceExternalTransactionId,
            new Date(state.createdAt.getTime()),
            state.status,
            state.referenceTransactionId,
            state.failureCode,
            state.processedAt
                ? new Date(state.processedAt.getTime())
                : undefined,
            state.observedBalance,
        );
    }

    get observedBalance(): Money | undefined {
        return this._observedBalance;
    }

    get status(): WagerTransactionStatus {
        return this._status;
    }

    get referenceTransactionId(): string | undefined {
        return this._referenceTransactionId;
    }

    get failureCode(): FailureCode | undefined {
        return this._failureCode;
    }

    get processedAt(): Date | undefined {
        return this._processedAt
            ? new Date(this._processedAt.getTime())
            : undefined;
    }

    isTerminal(): boolean {
        return (
            this._status === WagerTransactionStatus.Processed ||
            this._status === WagerTransactionStatus.Rejected ||
            this._status === WagerTransactionStatus.Failed
        );
    }

    affectsBalance(): boolean {
        return this.kind !== WagerTransactionKind.Loss;
    }

    requiresReference(): boolean {
        return (
            this.kind === WagerTransactionKind.Refund ||
            this.kind === WagerTransactionKind.Rollback
        );
    }

    matchesPayload(payloadHash: string): boolean {
        return this.payloadHash === payloadHash;
    }

    markProcessed(
        referenceTransactionId: string | undefined,
        at: Date,
        observedBalance?: Money,
    ): void {
        this.assertNotTerminal();

        this._referenceTransactionId =
            referenceTransactionId;

        this._observedBalance = observedBalance;
        this._status = WagerTransactionStatus.Processed;
        this._processedAt = new Date(at.getTime());
    }

    markPendingReference(): void {
        this.assertNotTerminal();

        this._status =
            WagerTransactionStatus.PendingReference;
    }

    reject(code: FailureCode, observedBalance?: Money): void {
        this.assertNotTerminal();

        this._observedBalance = observedBalance;
        this._status = WagerTransactionStatus.Rejected;
        this._failureCode = code;
    }

    fail(code: FailureCode): void {
        this.assertNotTerminal();

        this._status = WagerTransactionStatus.Failed;
        this._failureCode = code;
    }

    validateReference(reference: WagerTransaction): FailureCode | undefined {
        return this.validateReferenceStructure(reference) ?? (reference.status === WagerTransactionStatus.Processed
            ? undefined : FailureCode.InvalidReference);
    }

    validateReferenceStructure(reference: WagerTransaction): FailureCode | undefined {
        const allowed = this.kind === WagerTransactionKind.Refund
            ? [WagerTransactionKind.Bet]
            : [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund];
        if (!this.requiresReference() || reference.id === this.id ||
            reference.providerId !== this.providerId || reference.playerId !== this.playerId ||
            reference.walletId !== this.walletId || reference.roundId !== this.roundId ||
            reference.externalTransactionId !== this.referenceExternalTransactionId ||
            reference.money.currency !== this.money.currency || !reference.money.equals(this.money) ||
            !allowed.includes(reference.kind)) {
            return FailureCode.InvalidReference;
        }
        return undefined;
    }

    ledgerDirectionFor(
        reference?: WagerTransaction,
    ): LedgerDirection {
        switch (this.kind) {
            case WagerTransactionKind.Opening:
            case WagerTransactionKind.Win:
            case WagerTransactionKind.Refund:
                return "CREDIT";

            case WagerTransactionKind.Bet:
                return "DEBIT";

            case WagerTransactionKind.Loss:
                throw new Error(
                    "LOSS does not produce a ledger entry",
                );

            case WagerTransactionKind.Rollback:
                if (!reference) {
                    throw new Error(
                        "ROLLBACK requires the referenced transaction",
                    );
                }

                const referenceDirection =
                    reference.ledgerDirectionFor();

                return referenceDirection === "DEBIT"
                    ? "CREDIT"
                    : "DEBIT";
        }
    }

    private assertNotTerminal(): void {
        if (this.isTerminal()) {
            throw new Error(
                `Transaction in status ${this._status} is terminal`,
            );
        }
    }
}
