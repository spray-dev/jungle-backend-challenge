import { MikroORM } from "@mikro-orm/postgresql";
import config from "./mikro-orm.config.js";

const orm = await MikroORM.init(config);

try {
  const result = await orm.em.getConnection().execute(
    "SELECT 1 AS connected",
  );

  console.log(result);
} finally {
  await orm.close();
}