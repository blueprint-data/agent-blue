import type { ReactElement, ReactNode } from "react";

export function StatusBadge({ label, tone }: { label: string; tone?: string }): ReactElement {
  return <span className={`status-badge ${tone ?? "neutral"}`}>{label}</span>;
}

export function AppShellCard(props: {
  title: string;
  subtitle?: string;
  action?: ReactElement;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h3>{props.title}</h3>
          {props.subtitle ? <p>{props.subtitle}</p> : null}
        </div>
        {props.action}
      </div>
      <div className="card-body">{props.children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions
}: {
  title: string;
  subtitle: string;
  actions?: ReactElement;
}): ReactElement {
  return (
    <header className="page-header">
      <div>
        <span className="eyebrow">Admin panel</span>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      {actions}
    </header>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone
}: {
  label: string;
  value: string;
  hint: string;
  tone?: string;
}): ReactElement {
  return (
    <div className={`stat-card ${tone ?? ""}`.trim()}>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{hint}</p>
    </div>
  );
}

export function DetailItem({
  label,
  value,
  multiline = false
}: {
  label: string;
  value: string;
  multiline?: boolean;
}): ReactElement {
  return (
    <div className={`detail-item ${multiline ? "full-width" : ""}`}>
      <span>{label}</span>
      <strong className={multiline ? "multiline" : ""}>{value}</strong>
    </div>
  );
}
