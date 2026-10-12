import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type EmptyProps = {
  icon?: IconName;
  title: ReactNode;
  children?: ReactNode;
  /** Buttons/links (e.g. <Button href="/">Explore specialists</Button>). */
  action?: ReactNode;
  /** Inside a card (default) or standalone. */
  bare?: boolean;
};

/** Empty (and error) state: icon, title, text and action. */
export function Empty({ icon = "sparkles", title, children, action, bare }: EmptyProps) {
  return (
    <div className={["empty", bare ? "" : "card"].filter(Boolean).join(" ")}>
      <span className="empty-ic">
        <Icon name={icon} />
      </span>
      <h3 className="h4">{title}</h3>
      {children ? <p className="muted small">{children}</p> : null}
      {action ? <div className="row wrapx" style={{ justifyContent: "center" }}>{action}</div> : null}
    </div>
  );
}
