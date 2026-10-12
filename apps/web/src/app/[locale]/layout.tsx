import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Figtree, Instrument_Serif } from "next/font/google";
import type { ReactNode } from "react";
import { Footer } from "@/components/layout/Footer";
import { Header, TabBar } from "@/components/layout/Header";
import { themeScript } from "@/components/layout/ThemeToggle";
import { ToastProvider } from "@/components/ui/Toast";
import { routing } from "@/i18n/routing";
import { SessionProvider } from "@/lib/session";
import { WalletProvider } from "@/lib/wallet";
import "@/styles/sv.css";
import "@/styles/app.css";

const figtree = Figtree({ subsets: ["latin", "latin-ext"], weight: ["400", "500", "600", "700", "800"], variable: "--font-figtree", display: "swap" });
const serif = Instrument_Serif({ subsets: ["latin", "latin-ext"], weight: "400", variable: "--font-serif", display: "swap" });

type Props = { children: ReactNode; params: Promise<{ locale: string }> };

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: Omit<Props, "children">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "common.meta" });
  return { title: { default: t("title"), template: "%s · Solvers" }, description: t("description") };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F7F5F0" },
    { media: "(prefers-color-scheme: dark)", color: "#121116" },
  ],
};

export default async function RootLayout({ children, params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations("common");
  // Nonce of this request's Content-Security-Policy (src/proxy.ts, lib/csp.ts): the inline theme script needs it. Reading
  // the request headers also renders every page per request, which a nonce requires.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang={locale === "pt" ? "pt-BR" : "en"} className={`${figtree.variable} ${serif.variable}`}>
      {/* The theme is applied to <body> by a script before paint, so the hydration warning is suppressed here. */}
      <body className="sv" data-theme="light" suppressHydrationWarning>
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: themeScript }} />
        <a className="skip-link" href="#conteudo">
          {t("skipToContent")}
        </a>
        <NextIntlClientProvider>
          <WalletProvider>
            <SessionProvider>
              <ToastProvider>
                <Header />
                <main id="conteudo" className="app-main">
                  {children}
                </main>
                <Footer />
                <TabBar />
              </ToastProvider>
            </SessionProvider>
          </WalletProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
