"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Input, useToast } from "@vimax/ui";
import { useAuth } from "@/features/auth/AuthProvider";
import { useTranslations } from "next-intl";
import { Film, Mail, Lock, User, ArrowRight, UserPlus } from "lucide-react";

export default function SignupPage() {
  const router = useRouter();
  const { signup } = useAuth();
  const { toast } = useToast();
  const t = useTranslations("auth");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || password.length < 6) return;
    setLoading(true);
    try {
      await signup(email.trim(), password, name.trim());
      toast.success(t("signupSuccess"));
      router.push("/");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("signupFailed"));
    } finally { setLoading(false); }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-[var(--color-bg)] p-4 overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-[-20%] right-[-10%] w-[500px] h-[500px] bg-purple-500/4 rounded-full blur-[140px]" />
        <div className="absolute bottom-[-30%] left-[-5%] w-[500px] h-[500px] bg-[var(--color-accent)]/4 rounded-full blur-[140px]" />
      </div>

      <div className="relative z-10 w-full max-w-[400px]">
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex items-center gap-3 no-underline group">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-[var(--gradient-brand)] shadow-[var(--shadow-accent-sm)] group-hover:shadow-[var(--shadow-accent-md)] transition-shadow duration-[var(--duration-base)]">
              <Film className="size-4.5 text-white" />
            </div>
            <span className="text-xl font-bold text-[var(--color-text-primary)] tracking-tight">ViMax</span>
          </Link>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)] mt-6">{t("signupTitle")}</h1>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1.5">{t("signupSubtitle")}</p>
        </div>

        <div className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-surface)] shadow-[var(--shadow-md)] p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-[var(--color-text-tertiary)]">{t("name")}</label>
              <div className="relative">
                <User className="absolute left-3.5 top-1/2 -translate-y-1/2 size-3.5 text-[var(--color-text-quaternary)]" />
                <Input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} className="pl-9" required />
              </div>
            </div>
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
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("passwordMinLength")} className="pl-9" required error={password.length > 0 && password.length < 6 ? t("passwordMinLength") : undefined} />
              </div>
            </div>
            <Button type="submit" loading={loading} className="w-full" size="lg" leftIcon={<UserPlus className="size-4" />} rightIcon={<ArrowRight className="size-4" />}>
              {t("signupButton")}
            </Button>
          </form>
        </div>

        <p className="text-center text-xs text-[var(--color-text-tertiary)] mt-6">
          {t("hasAccount")}{" "}
          <Link href="/login" className="font-semibold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors">{t("loginButton")} →</Link>
        </p>
      </div>
    </div>
  );
}
