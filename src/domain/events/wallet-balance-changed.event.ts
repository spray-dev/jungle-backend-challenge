import { IntegrationEvent } from './integration-event.js';
import type { MoneyProps } from '../money.js';
import type { WalletMovement } from '../wallet.js';

export interface WalletBalanceChangedData {
    walletId: string;
    transactionId: string;
    direction: 'CREDIT' | 'DEBIT';
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    walletVersion: number;
}
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
    readonly type = 'WalletBalanceChanged';
    readonly version = 1;
    constructor(messageId: string, at: Date, private readonly transactionId: string,
        private readonly movement: WalletMovement) { super(messageId, at); }
    get data(): WalletBalanceChangedData {
        const m = this.movement;
        return { walletId: m.walletId, transactionId: this.transactionId, direction: m.direction,
            money: m.money.toJSON(), balanceBefore: m.balanceBefore.toJSON(),
            balanceAfter: m.balanceAfter.toJSON(), walletVersion: m.walletVersion };
    }
}
