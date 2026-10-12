// Periodic jobs shared by every module: each area exports `Job`s and src/jobs.ts lists them.

export type Job = { name: string; start(): void; stop(): void };

/** Runs `fn` every `ms` (never overlapping itself); errors are logged, not thrown. */
export function every(ms: number, name: string, fn: () => Promise<number | void>): Job {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const n = await fn();
      if (typeof n === "number" && n > 0) console.log(`[jobs] ${name}: ${n}`);
    } catch (e) {
      console.error(`[jobs] ${name} failed:`, (e as Error).message);
    } finally {
      running = false;
    }
  };
  return {
    name,
    start() {
      if (!timer) timer = setInterval(() => void tick(), ms);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
