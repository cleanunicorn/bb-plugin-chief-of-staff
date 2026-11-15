// Loading placeholders (#110): grey shapes where content will be, pulsing only when motion is welcome.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** One placeholder shape; size and shape come from `className`. */
export function Skeleton({ className }: { className?: string }) {
  return <div data-skeleton aria-hidden className={cn("rounded-md bg-muted motion-safe:animate-pulse", className)} />;
}

/** A region still loading: its skeletons, and one status line (`label`) for screen readers. */
export function LoadingRegion({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div aria-busy="true" className={className}>
      <span role="status" className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** A task card's outline: title, repository, pill and actions. */
export function CardSkeleton() {
  return (
    <div data-skeleton-card aria-hidden className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-start gap-2">
        <Skeleton className="size-8 shrink-0 rounded-lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3 w-2/5" />
        </div>
      </div>
      <Skeleton className="h-5 w-24 rounded-full" />
      <Skeleton className="h-3 w-3/5" />
      <div className="flex gap-1.5 border-t border-border pt-2">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-7 w-20" />
      </div>
    </div>
  );
}
