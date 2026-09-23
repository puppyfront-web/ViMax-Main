"use client";

import { type ReactNode, useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { AppShell, TopNav, ErrorBoundary, cn } from "@vimax/ui";
import { useAuth } from "@/features/auth/AuthProvider";
import { useTheme } from "@/features/theme/ThemeProvider";
import { useLocaleSwitch } from "@/i18n/locale";
import { useTranslations } from "next-intl";
import { LogIn, UserPlus, User, Sun, Moon, Globe } from "lucide-react";
import { CmdKSearch } from "@/features/search/CmdKSearch";
import { KeyboardShortcuts } from "@/features/shortcuts/KeyboardShortcuts";

export function AppLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, isLoading, logout } = useAuth();
  const { resolved, setTheme } = useTheme();
  const { locale, switchLocale } = useLocaleSwitch();
  const t = useTranslations("nav");
  const tc = useTranslations("common");

  // Prevent hydration mismatch by deferring theme icon render to client
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Skip AppShell for login/signup pages
  const isAuthPage = pathname === "/login" || pathname === "/signup";
  if (isAuthPage) {
    return <ErrorBoundary>{children}</ErrorBoundary>;
  }

  const navLinks = [
    { label: t("home"), href: "/", active: pathname === "/" },
    { label: t("explore"), href: "/explore", active: pathname === "/explore" },
    { label: tc("assets"), href: "/assets", active: pathname === "/assets" },
    { label: t("studio"), href: "/studio/image", active: pathname === "/studio/image" },
    { label: t("models"), href: "/settings/models", active: pathname === "/settings/models" },
  ];

  return (
    <ErrorBoundary>
      <CmdKSearch />
      <KeyboardShortcuts />
      <AppShell
        topNav={{
          navLinks,
          actions: (
            <>
              {/* Language switcher */}
              <button
                onClick={() => switchLocale(locale === "zh-CN" ? "en" : "zh-CN")}
                className="flex items-center gap-1 px-1.5 py-1 rounded-md text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-elevated)] transition-colors"
                title={locale === "zh-CN" ? "Switch to English" : "切换到中文"}
              >
                <Globe className="size-3.5" />
                {locale === "zh-CN" ? "EN" : "中文"}
              </button>

              {/* Theme toggle — defer render to prevent hydration mismatch */}
              <button
                onClick={() => setTheme(resolved === "dark" ? "light" : "dark")}
                className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-elevated)] transition-colors"
                title={mounted ? (resolved === "dark" ? t("switchLight") : t("switchDark")) : undefined}
                suppressHydrationWarning
              >
                {mounted ? (
                  resolved === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />
                ) : (
                  <span className="block size-3.5" />
                )}
              </button>

              {isLoading ? (
                <div className="w-7 h-7 rounded-full bg-[var(--color-surface-elevated)] animate-pulse" />
              ) : user ? (
                <div className="flex items-center gap-2">
                  <Link
                    href="/settings"
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-elevated)] transition-colors no-underline"
                  >
                    <User className="size-3.5" />
                    <span className="max-w-[100px] truncate">{user.name}</span>
                  </Link>
                  <button
                    onClick={logout}
                    className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors px-2 py-1"
                  >
                    {tc("logout")}
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <Link
                    href="/login"
                    className={cn(
                      "flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors no-underline",
                      pathname === "/login"
                        ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
                        : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]",
                    )}
                  >
                    <LogIn className="size-3" />
                    {tc("login")}
                  </Link>
                  <Link
                    href="/signup"
                    className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors no-underline"
                  >
                    <UserPlus className="size-3" />
                    {tc("signup")}
                  </Link>
                </div>
              )}
            </>
          ),
        }}
        sidebar={null}
      >
        {children}
      </AppShell>
    </ErrorBoundary>
  );
}
