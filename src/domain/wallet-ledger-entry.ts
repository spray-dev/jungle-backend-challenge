import { Money } from "./money.js";

export type LedgerDirection = "DEBIT" | "CREDIT";

export interface LedgerEntryProps {
    id: string;
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    amount: Money;
    balanceBefore: Money;
    balanceAfter: Money;
    createdAt: Date;
}

export class WalletLedgerEntry {
    private readonly _createdAt: Date;
    private constructor(
        public readonly id: string,
        public readonly walletId: string,
        public readonly transactionId: string,
        public readonly direction: LedgerDirection,
        public readonly amount: Money,
        public readonly balanceBefore: Money,
        public readonly balanceAfter: Money,
        createdAt: Date,
    ) { 
        this._createdAt = new Date(createdAt.getTime());
    }
    get createdAt(): Date {
        return new Date(this._createdAt.getTime());
    }

    static create(props: LedgerEntryProps): WalletLedgerEntry {
        if (!props.amount.isPositive()) {
            throw new Error("Ledger amount must be positive");
        }

        if (
            props.balanceBefore.isNegative() ||
            props.balanceAfter.isNegative()
        ) {
            throw new Error("Ledger balances cannot be negative");
        }

        const expectedBalance =
            props.direction === "DEBIT"
                ? props.balanceBefore.subtract(props.amount)
                : props.balanceBefore.add(props.amount);

        if (!expectedBalance.equals(props.balanceAfter)) {
            throw new Error("Inconsistent ledger entry");
        }

        return new WalletLedgerEntry(
            props.id,
            props.walletId,
            props.transactionId,
            props.direction,
            props.amount,
            props.balanceBefore,
            props.balanceAfter,
            new Date(props.createdAt.getTime()),
        );
    }

    isBalanced(): boolean {
        const expectedBalance =
            this.direction === "DEBIT"
                ? this.balanceBefore.subtract(this.amount)
                : this.balanceBefore.add(this.amount);

        return expectedBalance.equals(this.balanceAfter);
    }
}