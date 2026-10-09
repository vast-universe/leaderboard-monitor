import type { ComponentProps, ReactNode } from "react";

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "green" | "red" | "yellow" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export type ButtonProps = ComponentProps<"button"> & { variant?: "secondary" | "primary" | "danger" | "ghost"; size?: "default" | "compact"; loading?: boolean };
export function Button({ type = "button", variant = "secondary", size = "default", loading = false, disabled, className = "", ...props }: ButtonProps) {
  return <button {...props} type={type} className={`button ${variant === "secondary" ? "" : variant} ${size === "compact" ? "compact" : ""} ${className}`} disabled={disabled || loading} aria-busy={loading || props["aria-busy"]} />;
}

export function Metric({ label, value, foot, tone }: { label: string; value: ReactNode; foot: ReactNode; tone?: string }) {
  return <div className="metric"><span className="muted">{label}</span><div className={`metric-value ${tone ?? ""}`}>{value}</div><small>{foot}</small></div>;
}

export function Panel({ title, aside, children, className = "" }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}><div className="panel-title"><h2>{title}</h2>{aside}</div>{children}</section>;
}
