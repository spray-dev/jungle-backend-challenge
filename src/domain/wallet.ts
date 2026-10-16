import { Money } from "./money.js";

export interface OpenWalletProps {
    id: string;
    playerId: string;
    initialBalance: Money;
}

export interface WalletState {
    id: string;
    playerId: string;
    currency: string;
    balance: Money;
    version: number;
    createdAt: Date;
    updatedAt: Date;
}

// Dados da mudança em memória; ainda não representam um lançamento persistido.
export interface WalletMovement {
    readonly walletId: string;
    readonly direction: "DEBIT" | "CREDIT";
    readonly money: Money;
    readonly balanceBefore: Money;
    readonly balanceAfter: Money;
    readonly walletVersion: number;
}

export class Wallet {
    private constructor(
        public readonly id: string,
        public readonly playerId: string,
        public readonly currency: string,
        private _balance: Money,
        private _version: number,
        private readonly _createdAt: Date,
        private _updatedAt: Date,
    ) {}

    static open(props: OpenWalletProps): Wallet {
        if (props.initialBalance.isNegative() && !props.initialBalance.isZero()) {
            throw new Error("Initial balance cannot be negative");
        }

        const now = new Date();
        return new Wallet(
            props.id,
            props.playerId,
            props.initialBalance.currency,
            props.initialBalance,
            1,
            now,
            now,
        );
    }

    // O estado já persistido é confiável; não reaplica abertura nem movimentações.
    static rehydrate(state: WalletState): Wallet {
        return new Wallet(
            state.id,
            state.playerId,
            state.currency,
            state.balance,
            state.version,
            new Date(state.createdAt.getTime()),
            new Date(state.updatedAt.getTime()),
        );
    }

    get balance(): Money {
        return this._balance;
    }

    get version(): number {
        return this._version;
    }

    get createdAt(): Date {
        return new Date(this._createdAt.getTime());
    }

    get updatedAt(): Date {
        return new Date(this._updatedAt.getTime());
    }

    debit(money: Money): WalletMovement | null {
        return this.applyMovement("DEBIT", money);
    }

    credit(money: Money): WalletMovement | null {
        return this.applyMovement("CREDIT", money);
    }

    private applyMovement(direction: WalletMovement["direction"], money: Money): WalletMovement | null {
        this.assertSameCurrency(money);

        // Decimal admite zero com sinal: -0.00 também não movimenta saldo.
        if (money.isZero()) {
            return null;
        }

        if (money.isNegative()) {
            throw new Error("Movement amount cannot be negative");
        }

        if (direction === "DEBIT" && this._balance.isLessThan(money)) {
            throw new Error("Insufficient balance");
        }

        const balanceBefore = this._balance;
        const balanceAfter = direction === "DEBIT"
            ? balanceBefore.subtract(money)
            : balanceBefore.add(money);

        // A precisão atual do Money não pode arredondar a movimentação silenciosamente.
        const expectedChange = direction === "DEBIT" ? money.negate() : money;
        if (!balanceAfter.subtract(balanceBefore).equals(expectedChange)) {
            throw new Error("Movement exceeds money precision");
        }

        this._balance = balanceAfter;
        this._version += 1;
        this._updatedAt = new Date();

        return Object.freeze({
            walletId: this.id,
            direction,
            money,
            balanceBefore,
            balanceAfter,
            walletVersion: this._version,
        });
    }

    private assertSameCurrency(money: Money): void {
        if (this.currency !== money.currency) {
            throw new Error(`Currency mismatch: ${this.currency} !== ${money.currency}`);
        }
    }
}
