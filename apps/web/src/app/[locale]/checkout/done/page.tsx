import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AgentMissing } from "@/components/checkout/AgentMissing";
import { DoneView } from "@/components/checkout/DoneView";
import { loadAgent, loadConfig } from "@/components/checkout/loadAgent";
import { param, parseDoneKind, parseTxHash } from "@/components/checkout/rules";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("install");
  return { title: t("meta.doneTitle"), robots: { index: false } };
}

export const dynamic = "force-dynamic";

/** /checkout/done?agent=<slug>&kind=license|escrow&charge=<chargeId>&tx=<hash> */
export default async function DonePage({ searchParams }: PageProps<"/[locale]/checkout/done">) {
  const sp = await searchParams;
  const [{ detail, error }, config] = await Promise.all([loadAgent(param(sp.agent)), loadConfig()]);
  if (!detail) return <AgentMissing error={error} />;
  return <DoneView detail={detail} config={config} kind={parseDoneKind(sp.kind)} chargeId={param(sp.charge)} txHash={parseTxHash(sp.tx)} />;
}
