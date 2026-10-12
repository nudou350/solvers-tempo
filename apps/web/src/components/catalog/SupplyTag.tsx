import type { AgentSupply } from "@solvers/api-client";
import { useTranslations } from "next-intl";
import { Chip } from "@/components/ui/Chip";

/**
 * Badge for cards and lists of Solvers with a license limit: "3 of 10 left" or "Sold out". The limit is the current
 * one (the creator can raise it), so the wording never promises scarcity. Unlimited (or no `supply`): nothing.
 */
export function SupplyTag({ supply }: { supply?: AgentSupply }) {
  const t = useTranslations("catalog.supply");
  if (!supply || supply.max == null || supply.left == null) return null;
  if (supply.left === 0) {
    return (
      <Chip tone="red" icon="lock">
        {t("soldOut")}
      </Chip>
    );
  }
  return (
    <Chip tone="brand" icon="tag">
      {t("left", { left: supply.left, max: supply.max })}
    </Chip>
  );
}
