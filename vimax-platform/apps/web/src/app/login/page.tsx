"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Input, useToast } from "@vimax/ui";
import { useAuth } from "@/features/auth/AuthProvider";
import { useTranslations } from "next-intl";
import { Film, Mail, Lock, ArrowRight, LogIn } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const { toast } = useToast();
  const t = useTranslations("auth");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setLoading(true);
    try {
      await login(email.trim(), password);
      toast.success(t("loginSuccess"));
      router.push("/");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("loginFailed"));
    } finally { setLoading(false); }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-[var(--color-bg)] p-4 overflow-hidden">
      {/* Ambient */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-[-30%] left-[-10%] w-[600px] h-[600px] bg-[var(--color-accent)]/4 rounded-full blur-[150px]" />
        <div className="absolute bottom-[-20%] right-[-5%] w-[400px] h-[400px] bg-purple-500/4 rounded-full blur-[120px]" />
      </div>

      <div className="relative z-10 w-full max-w-[400px]">
        {/* Logo */}
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex items-center gap-3 no-underline group">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-[var(--gradient-brand)] shadow-[var(--shadow-accent-sm)] group-hover:shadow-[var(--shadow-accent-md)] transition-shadow duration-[var(--duration-base)]">
              <Film className="size-4.5 text-white" />
            </div>
            <span className="text-xl font-bold text-[var(--color-text-primary)] tracking-tight">ViMax</span>
          </Link>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)] mt-6">{t("loginTitle")}</h1>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1.5">{t("loginSubtitle")}</p>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-surface)] shadow-[var(--shadow-md)] p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-[var(--color-text-tertiary)]">{t("email")}</label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 size-3.5 text-[var(--color-text-quaternary)]" />
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("emailPlaceholder")} className="pl-9" required />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-[var(--color-text-tertiary)]">{t("password")}</label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 size-3.5 text-[var(--color-text-quaternary)]" />
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("passwordPlaceholder")} className="pl-9" required />
              </div>
            </div>
            <Button type="submit" loading={loading} className="w-full" size="lg" leftIcon={<LogIn className="size-4" />} rightIcon={<ArrowRight className="size-4" />}>
              {t("loginButton")}
            </Button>
          </form>
        </div>

        <p className="text-center text-xs text-[var(--color-text-tertiary)] mt-6">
          {t("noAccount")}{" "}
          <Link href="/signup" className="font-semibold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors">{t("signupButton")} →</Link>
        </p>
      </div>
    </div>
  );
}
