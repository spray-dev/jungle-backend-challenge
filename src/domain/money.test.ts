import { expect, test } from "bun:test";
import { Money } from "./money.js";

test("Money armazena a moeda normalizada e permite operações com a mesma moeda", () => {
    const money = Money.from({ amount: "25.00", currency: " brl " });
    expect(money.currency).toBe("BRL");
    expect(money.add(Money.from({ amount: "10.00", currency: "BRL" })).toJSON())
        .toEqual({ amount: "35.00", currency: "BRL" });
    expect(money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
});

for (const amount of ['', 'NaN', 'Infinity', '1e2', '1.001', '1', '1.0']) {
    test('Money rejects invalid amount ' + JSON.stringify(amount), () => {
        expect(() => Money.from({ amount, currency: 'BRL' })).toThrow('Invalid money amount');
    });
}
for (const currency of ['', 'BR', 'BRLL', '123', 'B$L']) {
    test('Money rejects invalid currency ' + JSON.stringify(currency), () => {
        expect(() => Money.from({ amount: '1.00', currency })).toThrow('Invalid currency');
    });
}
test('Money rejects mismatched currencies in arithmetic and comparison', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow('Currency mismatch');
    expect(() => brl.subtract(usd)).toThrow('Currency mismatch');
    expect(() => brl.isLessThan(usd)).toThrow('Currency mismatch');
});
test('Money serializes exactly two decimals after arithmetic including zero and negative values', () => {
    const a = Money.from({ amount: '1.10', currency: 'BRL' });
    const b = Money.from({ amount: '0.10', currency: 'BRL' });
    for (const [money, amount] of [[a.add(b), '1.20'], [a.subtract(b), '1.00'],
        [a.negate(), '-1.10'], [Money.zero('BRL'), '0.00']] as const) {
        expect(money.toJSON()).toEqual({ amount, currency: 'BRL' });
        expect(money.toString()).toBe(amount + ' BRL');
    }
});

test('Money.equals rejects mismatched currencies', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => brl.equals(usd)).toThrow('Currency mismatch: BRL !== USD');
});
