import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AgentMissing } from "@/components/checkout/AgentMissing";
import { InstallView } from "@/components/checkout/InstallView";
import { loadAgent, loadConfig } from "@/components/checkout/loadAgent";
import { param } from "@/components/checkout/rules";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("install");
  return { title: t("meta.installTitle") };
}

export const dynamic = "force-dynamic";

// `agent` is optional: without it the setup is generic (the connector is the same for every Solver).
export default async function InstallPage({ searchParams }: PageProps<"/[locale]/install">) {
  const slug = param((await searchParams).agent);
  const config = await loadConfig();
  const connectorUrl = config?.connectorUrl ?? null;
  if (!slug) return <InstallView detail={null} connectorUrl={connectorUrl} />;
  const { detail, error } = await loadAgent(slug);
  if (!detail) return <AgentMissing error={error} />;
  return <InstallView key={detail.agent.id} detail={detail} connectorUrl={connectorUrl} />;
}
