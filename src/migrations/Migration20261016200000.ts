import { Migration } from "@mikro-orm/migrations";

export class Migration20261016200000 extends Migration {
    override name = "Migration20261016200000";

    override up(): void {
        this.addSql(`
            create table "inbox_messages" (
                "consumer_name" varchar(255) not null,
                "message_id" varchar(255) not null,
                "payload_hash" varchar(64) not null,
                "received_at" timestamptz not null,
                "processed_at" timestamptz null,
                primary key ("consumer_name", "message_id")
            );
        `);
    }

    override down(): void {
        this.addSql(`
            drop table if exists "inbox_messages";
        `);
    }
}