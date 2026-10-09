import type { ReactNode } from "react";

export function PageTitle({ title, subtitle, actions, icon }: { title: string; subtitle?: string; actions?: ReactNode; icon?: ReactNode }) {
  return <div className="page-title"><div className="page-title-content">{icon && <span className="page-title-icon" aria-hidden="true">{icon}</span>}<div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div></div>{actions && <div className="actions">{actions}</div>}</div>;
}
