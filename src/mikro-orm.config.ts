import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";

import { WalletEntity } from "./persistence/entities/wallet.entity.js";
import { WalletLedgerEntryEntity } from "./persistence/entities/wallet-ledger-entry.entity.js";
import { WagerTransactionEntity } from "./persistence/entities/wager-transaction.entity.js";
import { InboxMessageEntity } from "./persistence/entities/inbox-message.entity.js";
import {
    OutboxMessageEntity,
} from "./persistence/entities/outbox-message.entity.js";

export default defineConfig({
    host: "localhost",
    port: 5433,
    user: "wagering",
    password: "wagering_dev",
    dbName: "wagering",

    entities: [
        WalletEntity,
        WalletLedgerEntryEntity,
        WagerTransactionEntity,
        InboxMessageEntity,
        OutboxMessageEntity,
    ],

    extensions: [Migrator],

    migrations: {
        path: "./dist/migrations",
        pathTs: "./src/migrations",
    },
});