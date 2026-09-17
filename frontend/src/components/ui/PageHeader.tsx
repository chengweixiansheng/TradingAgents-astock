import { type ReactNode } from "react";

interface Props {
  title: string;
  level?: 1 | 2;
  subtitle?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, actions, level = 1 }: Props) {
  const Heading = level === 2 ? "h2" : "h1";
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <Heading className="text-2xl font-extrabold tracking-tight text-glow">{title}</Heading>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
