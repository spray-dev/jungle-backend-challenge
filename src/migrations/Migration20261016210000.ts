import { Migration } from "@mikro-orm/migrations";

export class Migration20261016210000 extends Migration {
    override name = "Migration20261016210000";

    override up(): void {
        this.addSql(`
            create table "outbox_messages" (
                "id" uuid not null,
                "event_type" varchar(128) not null,
                "event_version" integer not null,
                "payload" jsonb not null,
                "created_at" timestamptz not null,
                "attempts" integer not null default 0,
                "next_attempt_at" timestamptz not null,
                "published_at" timestamptz null,

                constraint "outbox_messages_pkey"
                    primary key ("id"),

                constraint "outbox_event_version_positive"
                    check ("event_version" >= 1),

                constraint "outbox_attempts_nonnegative"
                    check ("attempts" >= 0)
            );
        `);

        this.addSql(`
            create index "outbox_pending_idx"
            on "outbox_messages" (
                "next_attempt_at",
                "created_at"
            )
            where "published_at" is null;
        `);
    }

    override down(): void {
        this.addSql(`
            drop table if exists "outbox_messages";
        `);
    }
}