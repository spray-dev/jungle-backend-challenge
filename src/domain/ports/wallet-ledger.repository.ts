import { WalletLedgerEntry } from "../wallet-ledger-entry.js";

export interface WalletLedgerRepository {
    insert(entry: WalletLedgerEntry): Promise<void>;
}