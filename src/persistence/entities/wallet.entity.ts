import { EntitySchema } from "@mikro-orm/core";

export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletEntity = new EntitySchema<WalletRow>({
  name: "WalletEntity",
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "string", fieldName: "player_id" },
    currency: { type: "string", length: 3 },
    balance: { type: "decimal", precision: 18, scale: 2 },
    version: { type: "integer" },
    createdAt: { type: "datetime", fieldName: "created_at" },
    updatedAt: { type: "datetime", fieldName: "updated_at" },
  },
  uniques: [
    { properties: ["playerId", "currency"] },
  ],
});