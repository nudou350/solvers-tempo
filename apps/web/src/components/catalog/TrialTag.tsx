"use client";
import { useTranslations } from "next-intl";
import { Chip } from "@/components/ui/Chip";
import { useMyTrials } from "@/lib/hooks";

/**
 * Discreet badge of cards and lists: the Solver has a free trial. With `agentId` and a signed-in user who already
 * started the trial, shows what is left ("Trial: 2 of 3 left") or that it is used up.
 */
export function TrialTag({ agentId }: { agentId?: string }) {
  const t = useTranslations("catalog.trialTag");
  const trials = useMyTrials();
  const mine = agentId ? trials?.get(agentId) : undefined;
  if (mine && mine.usesLeft <= 0) {
    return (
      <Chip tone="warn" icon="lock">
        {t("exhausted")}
      </Chip>
    );
  }
  if (mine) {
    return (
      <Chip tone="brand" icon="gift">
        {t("left", { n: mine.usesLeft, total: mine.uses })}
      </Chip>
    );
  }
  return (
    <Chip tone="plain" icon="gift">
      {t("free")}
    </Chip>
  );
}
