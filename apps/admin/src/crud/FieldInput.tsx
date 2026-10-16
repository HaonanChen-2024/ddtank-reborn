import { useRef, useState, type KeyboardEvent } from "react";
import { Button, Input, NativeSelect, Spinner, Switch, Textarea, cn } from "@ddtank/ui";
import { ImageUp, X } from "lucide-react";
import { toast } from "sonner";
import { uploadFile } from "@/lib/api";
import { useI18n, useText } from "@/i18n";
import type { FieldDef } from "./types";

interface Props {
  field: FieldDef;
  id: string;
  value: unknown;
  onChange: (v: unknown) => void;
  onBlur?: () => void;
  invalid?: boolean;
  mode: "create" | "edit";
}

function TagsInput({ id, value, onChange, invalid, placeholder }: { id: string; value: string[]; onChange: (v: string[]) => void; invalid?: boolean; placeholder?: string }) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const parts = draft.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length) onChange([...value, ...parts.filter((p) => !value.includes(p))]);
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div
      className={cn(
        "flex min-h-10 flex-wrap items-center gap-1.5 rounded-xl border-2 border-line bg-night-deep/60 px-2 py-1.5 focus-within:border-sun",
        invalid && "border-coral",
      )}
    >
      {value.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 rounded-lg bg-panel-2 px-2 py-0.5 font-mono text-xs">
          {tag}
          <button type="button" aria-label={`移除 ${tag}`} onClick={() => onChange(value.filter((t) => t !== tag))}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={commit}
        placeholder={value.length ? "" : placeholder}
        className="min-w-24 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted/60"
      />
    </div>
  );
}

function ImageInput({ id, value, onChange, folder, invalid }: { id: string; value: string; onChange: (v: string) => void; folder?: string; invalid?: boolean }) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const res = await uploadFile(file, folder);
      onChange(res.url);
    } catch {
      toast.error(t("field.uploadError"));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  return (
    <div className="flex items-center gap-3">
      <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-xl border-2 border-line bg-night-deep">
        {value ? <img src={value} alt="" className="size-full object-contain" /> : <ImageUp className="size-6 text-muted" />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder="https://…" aria-invalid={invalid} />
        <div>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? <Spinner className="size-4" /> : <ImageUp />} {busy ? t("field.uploading") : t("field.upload")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function FieldInput({ field: f, id, value, onChange, onBlur, invalid, mode }: Props) {
  const { t } = useI18n();
  const text = useText();
  const common = { id, onBlur, "aria-invalid": invalid, disabled: f.readOnly, placeholder: f.placeholder };

  switch (f.type) {
    case "boolean":
      return (
        <div className="flex h-10 items-center gap-3">
          <Switch id={id} checked={!!value} onCheckedChange={(c) => onChange(c)} disabled={f.readOnly} />
          <span className="text-sm text-muted">{value ? t("crud.yes") : t("crud.no")}</span>
        </div>
      );
    case "number":
      return (
        <Input
          {...common}
          type="number"
          inputMode="decimal"
          step={f.step ?? (f.int === false ? "any" : 1)}
          min={f.min}
          max={f.max}
          value={value === null || value === undefined || Number.isNaN(value) ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.valueAsNumber)}
          className="font-mono"
        />
      );
    case "select":
      return (
        <NativeSelect {...common} value={value === null || value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value)}>
          {!f.required && <option value="">{t("field.select")}</option>}
          {(f.options ?? []).map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {text(o.label)}
            </option>
          ))}
        </NativeSelect>
      );
    case "textarea":
      return <Textarea {...common} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} rows={4} />;
    case "json":
      return (
        <Textarea
          {...common}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          rows={6}
          spellCheck={false}
          className="font-mono text-xs"
        />
      );
    case "tags":
      return (
        <TagsInput
          id={id}
          value={Array.isArray(value) ? (value as string[]) : []}
          onChange={onChange}
          invalid={invalid}
          placeholder={f.placeholder ?? t("field.tagsHint")}
        />
      );
    case "image":
      return <ImageInput id={id} value={String(value ?? "")} onChange={onChange} folder={f.uploadFolder} invalid={invalid} />;
    case "date":
    case "datetime":
      return (
        <Input
          {...common}
          type={f.type === "date" ? "date" : "datetime-local"}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "password":
      return (
        <Input
          {...common}
          type="password"
          autoComplete="new-password"
          placeholder={mode === "edit" ? t("field.passwordKeep") : f.placeholder}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "color":
      return (
        <div className="flex items-center gap-2">
          <input type="color" value={String(value || "#ffc531")} onChange={(e) => onChange(e.target.value)} className="h-10 w-12 rounded-lg bg-transparent" aria-label={text(f.label)} />
          <Input {...common} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className="font-mono" />
        </div>
      );
    default:
      return <Input {...common} value={String(value ?? "")} maxLength={f.maxLength} onChange={(e) => onChange(e.target.value)} />;
  }
}
