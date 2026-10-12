import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";

/** Creates the profile on first access (its date becomes "member since") and returns the row. */
export async function ensureProfile(wallet: string) {
  await db.insert(schema.userProfiles).values({ wallet }).onConflictDoNothing();
  const [row] = await db.select().from(schema.userProfiles).where(eq(schema.userProfiles.wallet, wallet));
  return row!;
}
