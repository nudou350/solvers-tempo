import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";

// Same text for non-admins and for an address that does not exist: the area does not reveal it is here.
export default async function AdminNotFound() {
  const t = await getTranslations("common.notFound");
  return (
    <section className="wrap sec">
      <Empty icon="search" title={t("title")} action={<Button href="/">{t("home")}</Button>}>
        {t("body")}
      </Empty>
    </section>
  );
}
