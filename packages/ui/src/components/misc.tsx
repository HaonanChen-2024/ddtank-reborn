import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="加载中"
      className={cn("inline-block size-5 animate-spin rounded-full border-[3px] border-line border-t-sun", className)}
    />
  );
}

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("animate-pulse rounded-xl bg-panel-2/70", className)} {...props} />;
}

/** Dashed artillery arc: the shot trajectory, used as hero ornament / divider. */
export function TrajectoryArc({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 400 120" fill="none" className={cn("pointer-events-none", className)} aria-hidden>
      <path d="M8 112 Q 200 -40 392 104" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="2 12" />
      <circle cx="392" cy="104" r="7" fill="currentColor" />
    </svg>
  );
}

export function EmptyState({ title, children, className }: { title: string; children?: ReactNode; className?: string }) {
  return (
    <div
      className={cn("flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-line p-10 text-center", className)}
    >
      <p className="font-display text-lg text-ink">{title}</p>
      {children && <div className="text-sm text-muted">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="title-plate text-3xl sm:text-4xl">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
