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
    host: process.env.WAGER_DB_HOST ?? "localhost",
    port: Number(process.env.WAGER_DB_PORT ?? "5433"),
    user: process.env.WAGER_DB_USER ?? "wagering",
    password: process.env.WAGER_DB_PASSWORD ?? "wagering_dev",
    dbName: process.env.WAGER_DB_NAME ?? "wagering",

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
