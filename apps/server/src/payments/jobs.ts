import { every, type Job } from "../lib/jobs.js";
import { checkFloat } from "./float.js";
import { initPayments } from "./index.js";
import { reconcileAll } from "./registry.js";

// Periodic jobs of the payments module (listed by src/jobs.ts):
// - reconcile (every 30 s): expires stale charges, fulfils confirmed ones, resumes interrupted fulfilments from the chain
//   (`purchaseRef`, journal receipts) and finishes interrupted refunds;
// - float balance (every 10 min): Telegram alert when PLATFORM or RELAY is below FLOAT_LOW_BALANCE_UNITS.

export const paymentsJobs: Job[] = [
  every(30_000, "payments: reconcile", () => {
    initPayments();
    return reconcileAll(new Date());
  }),
  every(10 * 60_000, "payments: float balance", () => checkFloat()),
];
