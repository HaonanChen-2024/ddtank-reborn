import { useState } from "react";
import { ApiError, Button, Spinner } from "@ddtank/ui";
import type { WardrobeAsset, WardrobeCheckResult } from "../../../api/src/lib/wardrobe";
import { api } from "@/lib/api";
import { useI18n } from "@/i18n";
import type { Row } from "./types";

/** Only appearance fields are submitted; the current form need not have a saved TemplateID. */
export function wardrobeDraft(values: Row) {
  return { CategoryID: values.CategoryID, Pic: values.Pic, NeedSex: values.NeedSex, Property8: values.Property8 };
}

function AssetPreview({ asset }: { asset: WardrobeAsset }) {
  const { t } = useI18n();
  const [frameIndex, setFrameIndex] = useState(asset.kind === "show" && asset.frames.length > 1 ? 1 : 0);
  const [imageError, setImageError] = useState(false);
  const frame = asset.frames[frameIndex];
  const canPreview = asset.state === "ok" || asset.state === "incompatible";
  const width = Math.max(asset.width ?? 0, frame ? frame.columns * frame.frameWidth : 0);
  const height = Math.max(asset.height ?? 0, frame ? frame.rows * frame.frameHeight : 0);
  return (
    <div className="rounded-xl border border-line p-3">
      <p className="text-sm">{t("wardrobe.layer", { layer: asset.layer })}{asset.hairType && ` · ${t("wardrobe.hairType", { type: asset.hairType.toUpperCase() })}`}</p>
      <p className="break-all font-mono text-xs">{asset.path}</p>
      <p className="my-1 text-sm text-muted">{t(`wardrobe.state.${asset.state}`)}{asset.width !== undefined && ` · ${asset.width}×${asset.height}px`}</p>
      {asset.warnings.filter((warning) => warning !== "pixel-decode-unchecked").map((warning) => <p key={warning} className="text-xs text-sun">{t(`wardrobe.warning.${warning}`)}</p>)}
      {asset.frames.length > 1 && (
        <div className="my-2 flex gap-2">
          {asset.frames.map((candidate, index) => <Button key={candidate.owner} type="button" size="sm" variant={frameIndex === index ? "secondary" : "ghost"} onClick={() => setFrameIndex(index)}>{candidate.owner}</Button>)}
        </div>
      )}
      {frame && <p className="mb-2 text-xs text-muted">{t("wardrobe.grid", { owner: frame.owner, columns: frame.columns, rows: frame.rows, width: frame.frameWidth, height: frame.frameHeight })} · {t(`wardrobe.state.${frame.state}`)}</p>}
      {canPreview && (
        <div className="overflow-auto rounded-lg border border-line bg-night-deep">
          <div className="relative" style={{ width, height }}>
            <img src={asset.url} alt={asset.path} width={asset.width} height={asset.height} style={{ maxWidth: "none" }} onError={() => setImageError(true)} />
            {frame && <div aria-hidden className="pointer-events-none absolute left-0 top-0 border border-sun/60" style={{ width: frame.columns * frame.frameWidth, height: frame.rows * frame.frameHeight, backgroundImage: "linear-gradient(to right, #ffc53166 1px, transparent 1px), linear-gradient(to bottom, #ffc53166 1px, transparent 1px)", backgroundSize: `${frame.frameWidth}px ${frame.frameHeight}px` }} />}
          </div>
        </div>
      )}
      {imageError && <p className="mt-2 text-sm text-coral">{t("wardrobe.imageError")}</p>}
    </div>
  );
}

export function WardrobeResult({ result }: { result: WardrobeCheckResult }) {
  const { t } = useI18n();
  const layers = [...new Set(result.assets.filter((asset) => asset.kind !== "icon").map((asset) => asset.layer))].sort((a, b) => a - b);
  return (
    <div className="mt-3 space-y-3">
      <p className="text-sm">{t(`wardrobe.state.${result.state}`)} · {t("wardrobe.draft", { pic: result.draft.Pic, sex: result.draft.NeedSex, folder: result.pathSex })}</p>
      <p className="text-sm">{t("wardrobe.layers", { layers: layers.join(", ") })}</p>
      {result.assets.map((asset) => <AssetPreview key={`${asset.path}:${asset.sha256 ?? asset.state}`} asset={asset} />)}
    </div>
  );
}

export function WardrobeCheck({ getValues }: { getValues: () => Row }) {
  const { t } = useI18n();
  const [result, setResult] = useState<WardrobeCheckResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function check() {
    setError("");
    setResult(null);
    const draft = wardrobeDraft(getValues());
    setPending(true);
    try { setResult(await api.post<WardrobeCheckResult>("/api/admin/items/wardrobe-check", draft)); }
    catch (failure) { setError(failure instanceof ApiError ? failure.message : t("common.error")); }
    finally { setPending(false); }
  }
  return (
    <section className="w-full rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{t("wardrobe.title")}</h3>
        <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => void check()}>{pending && <Spinner className="size-4" />}{t("wardrobe.check")}</Button>
      </div>
      <p className="mt-2 text-xs text-muted">{t("wardrobe.scope")}</p>
      {error && <p role="alert" className="mt-2 text-sm text-coral">{error}</p>}
      {result && <WardrobeResult result={result} />}
    </section>
  );
}
