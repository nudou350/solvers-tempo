import type { db } from "../db/index.js";

/** A drizzle transaction of the server database. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What the mirror writers need: the database itself or a transaction (both are drizzle `PgDatabase`s). */
export type Q = Pick<Tx, "select" | "insert" | "update" | "delete">;
