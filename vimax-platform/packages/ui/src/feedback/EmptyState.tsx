"use client";

import { type ReactNode } from "react";
import { cn } from "../cn";
import { Inbox } from "lucide-react";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 py-12 px-4 text-center",
        className,
      )}
    >
      <div className="text-[var(--color-text-dim)]">
        {icon ?? <Inbox className="size-10" />}
      </div>
      <div>
        <h3 className="text-sm font-medium text-[var(--color-text)]">
          {title}
        </h3>
        {description && (
          <p className="mt-1 text-xs text-[var(--color-text-muted)] max-w-sm">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}
