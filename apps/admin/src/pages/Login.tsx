import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ApiError, Button, Card, Field, Input, LocaleToggle, TrajectoryArc } from "@ddtank/ui";
import { api, meQuery, type AdminUser } from "@/lib/api";
import { useI18n } from "@/i18n";

export function LoginPage() {
  const { t, locale, setLocale } = useI18n();
  const search = useSearch({ strict: false }) as { redirect?: string; denied?: boolean };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(search.denied ? t("login.denied") : null);

  const schema = z.object({ username: z.string().min(1, t("login.required")), password: z.string().min(1, t("login.required")) });
  type Values = z.infer<typeof schema>;
  const { register, handleSubmit, formState } = useForm<Values>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      const res = await api.post<{ token: string; user: AdminUser }>("/api/auth/login", values);
      if (res.user.role !== "admin") {
        setError(t("login.denied"));
        return;
      }
      api.setToken(res.token);
      qc.setQueryData(meQuery.queryKey, res.user);
      const to = search.redirect && search.redirect.startsWith("/") && !search.redirect.startsWith("/login") ? search.redirect : "/";
      void navigate({ to });
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? t("login.invalid") : t("common.error"));
    }
  });

  return (
    <div className="grid min-h-dvh place-items-center bg-starfield animate-drift p-4">
      <div className="relative w-full max-w-sm">
        <TrajectoryArc className="absolute -top-16 left-0 w-full text-sun/30" />
        <Card className="relative p-7">
          <div className="flex items-start justify-between gap-2">
            <h1 className="title-plate text-3xl">
              {t("app.name")}
            </h1>
            <LocaleToggle locale={locale} onChange={setLocale} />
          </div>
          <p className="mt-1 text-sm text-muted">{t("login.lead")}</p>
          <form onSubmit={onSubmit} noValidate className="mt-6 flex flex-col gap-4">
            <Field label={t("login.username")} htmlFor="u" error={formState.errors.username?.message}>
              <Input id="u" autoComplete="username" {...register("username")} />
            </Field>
            <Field label={t("login.password")} htmlFor="p" error={formState.errors.password?.message}>
              <Input id="p" type="password" autoComplete="current-password" {...register("password")} />
            </Field>
            {error && (
              <p role="alert" className="rounded-xl bg-coral/15 p-3 text-sm font-medium text-coral">
                {error}
              </p>
            )}
            <Button type="submit" size="lg" disabled={formState.isSubmitting}>
              {t("login.submit")}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
