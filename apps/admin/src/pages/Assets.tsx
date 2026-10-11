import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, Button, Card, Dialog, DialogContent, EmptyState, Input, PageHeader, Skeleton, Spinner, cn } from "@ddtank/ui";
import { Copy, FileIcon, Folder, Trash2, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { useI18n } from "@/i18n";

export interface Asset {
  key: string;
  name: string;
  url: string;
  size: number;
  contentType: string;
  updatedAt: string;
}

/** Storage folders the client/site read from. */
export const ASSET_FOLDERS = ["images/items", "images/skins", "images/pve", "images/news", "ui", "sounds", "image/equip"];

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function AssetsPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [folder, setFolder] = useState(ASSET_FOLDERS[0]!);
  const [toDelete, setToDelete] = useState<Asset | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const key = ["admin", "assets", folder];

  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => api.get<Asset[]>(`/api/admin/assets?prefix=${encodeURIComponent(folder)}`),
  });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files) {
        const fd = new FormData();
        fd.append("file", f);
        fd.append("folder", folder);
        await api.post("/api/admin/assets", fd);
      }
      return files.length;
    },
    onSuccess: (n) => {
      toast.success(t("assets.uploaded", { n }));
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("field.uploadError")),
  });

  const remove = useMutation({
    mutationFn: (a: Asset) => api.del(`/api/admin/assets/${encodeURIComponent(a.key)}`),
    onSuccess: () => {
      toast.success(t("crud.deleted"));
      setToDelete(null);
      void qc.invalidateQueries({ queryKey: key });
    },
  });

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(new URL(url, location.href).href);
      toast.success(t("assets.copied"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  return (
    <div>
      <PageHeader
        title={t("assets.title")}
        description={t("assets.lead")}
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) upload.mutate(files);
                e.target.value = "";
              }}
            />
            <Button disabled={upload.isPending} onClick={() => fileRef.current?.click()}>
              {upload.isPending ? <Spinner className="size-4" /> : <Upload />} {t("assets.upload")}
            </Button>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        <Card className="h-fit p-2">
          <p className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted">{t("assets.folder")}</p>
          <Input
            aria-label={t("assets.folder")}
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="image/equip/m/cloth/custom/1"
            className="mb-2 font-mono text-xs"
          />
          <ul>
            {ASSET_FOLDERS.map((f) => (
              <li key={f}>
                <button
                  type="button"
                  onClick={() => setFolder(f)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left font-mono text-sm text-muted hover:bg-panel-2 hover:text-ink",
                    folder === f && "bg-panel-2 text-sun",
                  )}
                >
                  <Folder className="size-4" /> {f}
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const files = Array.from(e.dataTransfer.files);
            if (files.length) upload.mutate(files);
          }}
        >
          {isLoading ? (
            <Skeleton className="h-64" />
          ) : !data?.length ? (
            <EmptyState title={t("assets.empty")}>{t("assets.emptyHint")}</EmptyState>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
              {data.map((a) => (
                <li key={a.key} className="group overflow-hidden rounded-2xl border border-line bg-panel">
                  <div className="grid aspect-square place-items-center bg-night-deep bg-starfield p-3">
                    {a.contentType.startsWith("image/") ? (
                      <img src={a.url} alt={a.name} className="max-h-full max-w-full object-contain" loading="lazy" />
                    ) : (
                      <FileIcon className="size-10 text-muted" />
                    )}
                  </div>
                  <div className="p-2.5">
                    <p className="truncate font-mono text-xs" title={a.name}>
                      {a.name}
                    </p>
                    <p className="text-xs text-muted">{fmtSize(a.size)}</p>
                    <div className="mt-2 flex gap-1">
                      <Button size="sm" variant="secondary" className="flex-1" onClick={() => void copy(a.url)}>
                        <Copy /> URL
                      </Button>
                      <Button size="icon" variant="ghost" className="size-8 text-coral" aria-label={t("crud.delete")} onClick={() => setToDelete(a)}>
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <Dialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        {toDelete && (
          <DialogContent title={t("assets.deleteConfirm", { name: toDelete.name })} description={t("crud.deleteBody")}>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setToDelete(null)}>
                {t("crud.cancel")}
              </Button>
              <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(toDelete)}>
                <Trash2 /> {t("crud.delete")}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
