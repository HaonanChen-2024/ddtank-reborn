import { useId, useMemo, type ReactNode } from "react";
import { Controller, useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button, Field, cn } from "@ddtank/ui";
import { useI18n, useText } from "@/i18n";
import { FieldInput } from "./FieldInput";
import { buildSchema, fieldInForm, fromFormValues, toFormValues, type FormMode } from "./schema";
import type { FieldDef, Row } from "./types";

export interface SchemaFormProps {
  fields: FieldDef[];
  mode?: FormMode;
  initial?: Row;
  submitLabel?: string;
  onSubmit: (payload: Row) => Promise<unknown> | void;
  onCancel?: () => void;
  /** Extra content rendered next to the buttons; getValues reads the current unsaved form. */
  footer?: ReactNode | ((getValues: () => Row) => ReactNode);
  className?: string;
}

/**
 * Generic form generated from FieldDef[]: zod validation, typed inputs, sections.
 * The payload handed to onSubmit is already converted to API shape (json parsed, dates ISO...).
 */
export function SchemaForm({ fields, mode = "create", initial, submitLabel, onSubmit, onCancel, footer, className }: SchemaFormProps) {
  const { t } = useI18n();
  const text = useText();
  const uid = useId();

  const schema = useMemo(() => buildSchema(fields, mode, t, text), [fields, mode, t, text]);
  const defaultValues = useMemo(() => toFormValues(fields, initial, mode), [fields, initial, mode]);

  const { control, handleSubmit, formState, getValues } = useForm<Row>({
    resolver: zodResolver(schema) as unknown as Resolver<Row>,
    defaultValues,
    values: defaultValues,
    resetOptions: { keepDirtyValues: false },
  });

  const visible = fields.filter((f) => fieldInForm(f, mode));
  // Group by section, preserving order of first appearance.
  const sections: { title?: string; fields: FieldDef[] }[] = [];
  for (const f of visible) {
    const title = f.section ? text(f.section) : undefined;
    let s = sections.find((x) => x.title === title);
    if (!s) sections.push((s = { title, fields: [] }));
    s.fields.push(f);
  }

  const submit = handleSubmit(async (values) => {
    await onSubmit(fromFormValues(fields, values, mode));
  });

  return (
    <form onSubmit={submit} noValidate className={cn("flex flex-col gap-6", className)}>
      {sections.map((s, i) => (
        <fieldset key={s.title ?? i} className={cn(s.title && "rounded-2xl border border-line p-4 pt-2")}>
          {s.title && <legend className="px-2 font-display text-lg text-sun">{s.title}</legend>}
          <div className="grid gap-4 sm:grid-cols-2">
            {s.fields.map((f) => {
              const id = `${uid}-${f.name}`;
              const error = formState.errors[f.name]?.message;
              return (
                <Field
                  key={f.name}
                  label={text(f.label) + (f.required && !f.readOnly ? " *" : "")}
                  htmlFor={id}
                  hint={text(f.hint)}
                  error={typeof error === "string" ? error : undefined}
                  className={cn((f.span === 2 || ["textarea", "json", "tags", "image"].includes(f.type)) && "sm:col-span-2")}
                >
                  <Controller
                    control={control}
                    name={f.name}
                    render={({ field }) => (
                      <FieldInput
                        field={f}
                        id={id}
                        mode={mode}
                        value={f.readOnly ? initial?.[f.name] ?? field.value : field.value}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        invalid={!!error}
                      />
                    )}
                  />
                </Field>
              );
            })}
          </div>
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {typeof footer === "function" ? footer(getValues) : footer}
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("crud.cancel")}
          </Button>
        )}
        <Button type="submit" disabled={formState.isSubmitting}>
          {submitLabel ?? (mode === "create" ? t("crud.create") : t("crud.save"))}
        </Button>
      </div>
    </form>
  );
}

