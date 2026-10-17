import { Decimal } from "decimal.js";

export interface MoneyProps {
    amount: string;
    currency: string;
}

export class Money {
    private constructor(
        private readonly value: Decimal,
        public readonly currency: string,
    ) { }

    static from(props: MoneyProps): Money {
        if (!/^-?\d+\.\d{2}$/.test(props.amount)) {
            throw new Error("Invalid money amount");
        }

        const currency = props.currency.trim().toUpperCase();

        if (!/^[A-Z]{3}$/.test(currency)) {
            throw new Error("Invalid currency");
        }

        const value = new Decimal(props.amount);

        return new Money(value, currency);
    }

    static zero(currency: string): Money {
        return Money.from({
            amount: "0.00",
            currency,
        });
    }

    add(other: Money): Money {
        this.assertSameCurrency(other);

        return new Money(
            this.value.plus(other.value),
            this.currency,
        );
    }

    subtract(other: Money): Money {
        this.assertSameCurrency(other);

        return new Money(
            this.value.minus(other.value),
            this.currency,
        );
    }

    negate(): Money {
        return new Money(
            this.value.negated(),
            this.currency,
        );
    }

    isZero(): boolean {
        return this.value.isZero();
    }

    isPositive(): boolean {
        return this.value.isPositive();
    }

    isNegative(): boolean {
        return this.value.isNegative();
    }

    isLessThan(other: Money): boolean {
        this.assertSameCurrency(other);

        return this.value.lessThan(other.value);
    }

    equals(other: Money): boolean {
        this.assertSameCurrency(other);
        return this.value.equals(other.value);
    }

    toJSON(): MoneyProps {
        return {
            amount: this.value.toFixed(2),
            currency: this.currency,
        };
    }

    toString(): string {
        return `${this.value.toFixed(2)} ${this.currency}`;
    }

    private assertSameCurrency(other: Money): void {
        if (this.currency !== other.currency) {
            throw new Error(
                `Currency mismatch: ${this.currency} !== ${other.currency}`,
            );
        }
    }
}
