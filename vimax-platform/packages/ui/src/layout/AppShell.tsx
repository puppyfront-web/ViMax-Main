"use client";

import { type ReactNode } from "react";
import { cn } from "../cn";
import { TopNav, type TopNavProps } from "./TopNav";

export interface AppShellProps {
  /** TopNav configuration. Pass null to hide. */
  topNav?: TopNavProps | null;
  /** Sidebar content. Pass null to hide. */
  sidebar?: ReactNode;
  /** Collapse sidebar to icon-only */
  sidebarCollapsed?: boolean;
  /** Main content */
  children: ReactNode;
  /** Additional class on the shell wrapper */
  className?: string;
}

export function AppShell({
  topNav,
  sidebar,
  sidebarCollapsed = false,
  children,
  className,
}: AppShellProps) {
  const sidebarWidth = sidebarCollapsed ? 56 : 220;

  return (
    <div
      className={cn(
        "flex flex-col h-screen bg-[var(--color-bg)] text-[var(--color-text)]",
        className,
      )}
    >
      {/* Top Navigation */}
      {topNav !== null && <TopNav {...(topNav ?? {})} />}

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        {sidebar && (
          <aside
            className="flex-shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] overflow-y-auto transition-all duration-[var(--transition-normal)]"
            style={{ width: sidebarWidth }}
          >
            {sidebar}
          </aside>
        )}

        {/* Main Content */}
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
