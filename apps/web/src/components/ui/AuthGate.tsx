"use client";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useErrorText } from "@/lib/error-text";
import { useSession } from "@/lib/session";
import { Button } from "./Button";
import { Empty } from "./Empty";
import type { IconName } from "./Icon";
import { Loading } from "./Spinner";
import { useToast } from "./Toast";

export type AuthGateProps = {
  icon?: IconName;
  title: string;
  text: string;
  /** Extra actions next to "Sign in" (e.g. "How to publish"). */
  actions?: ReactNode;
  children?: ReactNode;
};

/** Shows `children` only with a signed-in session. Signed out: the "Sign in to see..." state with the sign-in button. */
export function AuthGate({ icon = "lock", title, text, actions, children }: AuthGateProps) {
  const { status, signIn, signingIn } = useSession();
  const toast = useToast();
  const t = useTranslations("common.ui");
  const errorText = useErrorText();
  if (status === "loading") return <Loading />;
  if (status === "signed-out")
    return (
      <Empty
        icon={icon}
        title={title}
        action={
          <>
            <Button
              loading={signingIn}
              onClick={() => signIn().catch((e: unknown) => toast({ tone: "bad", title: t("signInFailed"), text: errorText(e) }))}
            >
              {t("signIn")}
            </Button>
            {actions}
          </>
        }
      >
        {text}
      </Empty>
    );
  return <>{children}</>;
}
