import { MikroORM } from "@mikro-orm/postgresql";
import config from "../mikro-orm.config.js";

const databases = new Set<string>();

// Each suite owns a disposable database. Ledger protection stays enabled throughout.
export async function createTestOrm(): Promise<MikroORM> {
    const dbName = "wagering_test_" + crypto.randomUUID().replaceAll("-", "");
    const admin = await MikroORM.init({ ...config, dbName: "postgres" });
    try {
        await admin.em.getConnection().execute(`create database "${dbName}"`);
        databases.add(dbName);
    } finally { await admin.close(); }
    let orm: MikroORM | undefined;
    try {
        orm = await MikroORM.init({ ...config, dbName, preferTs: true,
            migrations: { ...config.migrations, snapshot: false } });
        await orm.migrator.up();
        return orm;
    } catch (error) {
        await orm?.close(true);
        await dropDatabase(dbName);
        throw error;
    }
}

async function dropDatabase(dbName: string): Promise<void> {
    if (!databases.has(dbName) || !/^wagering_test_[a-f0-9]{32}$/.test(dbName)) {
        throw new Error("Refusing to drop a database not created by this suite");
    }
    const admin = await MikroORM.init({ ...config, dbName: "postgres" });
    try {
        await admin.em.getConnection().execute(`drop database "${dbName}"`);
        databases.delete(dbName);
    } finally { await admin.close(); }
}

export async function closeTestOrm(orm: MikroORM | undefined): Promise<void> {
    if (!orm) return;
    const dbName = orm.config.get("dbName");
    await orm.close(true);
    if (!dbName) throw new Error("Missing test database name");
    await dropDatabase(dbName);
}
