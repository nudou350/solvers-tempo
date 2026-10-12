import { numberToUnits, unitsToNumber } from "@solvers/shared";
import { env } from "../env.js";

// Payment-token amounts at the API edge. Base units (bigint) everywhere inside; numbers only for display fields.

/** Base units -> whole stablecoin units as a number (display fields such as `priceUsdc`). */
export const displayUnits = (units: bigint | number | string): number => unitsToNumber(units, env.PAYMENT_TOKEN_DECIMALS);

/** A human/manifest price (number of whole units) -> base units. */
export const unitsFromNumber = (amount: number): bigint => numberToUnits(amount, env.PAYMENT_TOKEN_DECIMALS);

/** Amount with the token symbol for messages ("12.5 USD"). */
export const formatUnits = (units: bigint): string => `${displayUnits(units)} ${env.PAYMENT_TOKEN_SYMBOL}`;
