import { expect, test } from "bun:test";
import { Money } from "./money.js";

test("Money armazena a moeda normalizada e permite operações com a mesma moeda", () => {
    const money = Money.from({ amount: "25.00", currency: " brl " });
    expect(money.currency).toBe("BRL");
    expect(money.add(Money.from({ amount: "10.00", currency: "BRL" })).toJSON())
        .toEqual({ amount: "35.00", currency: "BRL" });
    expect(money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
});
