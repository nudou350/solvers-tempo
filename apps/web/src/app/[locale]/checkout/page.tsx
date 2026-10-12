import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { AgentMissing } from "@/components/checkout/AgentMissing";
import { CheckoutView } from "@/components/checkout/CheckoutView";
import { loadAgent, loadConfig } from "@/components/checkout/loadAgent";
import { param, parseKind } from "@/components/checkout/rules";
import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";

export async function generateMetadata({ params }: PageProps<"/[locale]/checkout">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "checkout" });
  return { title: t("meta.title"), robots: { index: false } };
}

// Price, license limit and config are read on every request (a stale price would only bounce off the server).
export const dynamic = "force-dynamic";

/** /checkout?agent=<slug>&type=license|guarantee */
export default async function CheckoutPage({ searchParams }: PageProps<"/[locale]/checkout">) {
  const sp = await searchParams;
  const [{ detail, error }, config] = await Promise.all([loadAgent(param(sp.agent)), loadConfig()]);
  if (!detail) return <AgentMissing error={error} />;
  if (!config) return <AgentMissing error="unavailable" />;
  // A platform Solver is free and has no license: there is nothing to buy.
  if (detail.agent.platform) return <PlatformFree slug={detail.agent.slug} name={detail.agent.name} />;
  let kind = parseKind(sp.type);
  // A Solver without a guarantee offer (or an unknown type) falls back to the license.
  if (kind === "guarantee" && !detail.guarantee) kind = "license";
  return <CheckoutView key={detail.agent.id} detail={detail} config={config} kind={kind} />;
}

function PlatformFree({ slug, name }: { slug: string; name: string }) {
  const t = useTranslations("checkout.platformFree");
  return (
    <section className="wrap" style={{ paddingTop: 56, paddingBottom: 72 }}>
      <Empty icon="gift" title={t("title", { name })} action={<Button href={`/install?agent=${encodeURIComponent(slug)}`} iconRight="arrow-right">{t("action")}</Button>}>
        {t("text")}
      </Empty>
    </section>
  );
}
