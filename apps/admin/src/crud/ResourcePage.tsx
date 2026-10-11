import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ApiError,
  Button,
  Dialog,
  DialogContent,
  EmptyState,
  Input,
  PageHeader,
  Skeleton,
  Spinner,
  Switch,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
  cn,
} from "@ddtank/ui";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Copy, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useI18n, useText } from "@/i18n";
import { getQuery, listQuery, useResourceMutations } from "./api";
import { Cell } from "./Cell";
import { SchemaForm } from "./SchemaForm";
import { WardrobeCheck } from "./WardrobeCheck";
import { copyForCreate } from "./schema";
import { caps, rowId, type ResourceDef, type Row, type RowAction } from "./types";

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

const errMsg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

type DialogState =
  | { kind: "create"; row?: Row }
  | { kind: "edit"; row: Row }
  | { kind: "delete"; row: Row }
  | { kind: "action"; row: Row; action: RowAction }
  | null;

function EditDialogBody({ def, row, onDone }: { def: ResourceDef; row: Row; onDone: () => void }) {
  const { t } = useI18n();
  const id = rowId(def, row);
  const { data, isLoading } = useQuery({ ...getQuery(def, id), placeholderData: row });
  const { update } = useResourceMutations(def);
  if (isLoading && !data) return <Skeleton className="h-64" />;
  return (
    <SchemaForm
      fields={def.fields}
      mode="edit"
      initial={data ?? row}
      footer={def.name === "items" ? (getValues) => <WardrobeCheck getValues={getValues} /> : undefined}
      onCancel={onDone}
      onSubmit={async (body) => {
        try {
          await update.mutateAsync({ id, body });
          toast.success(t("crud.saved"));
          onDone();
        } catch (e) {
          toast.error(errMsg(e, t("common.error")));
        }
      }}
    />
  );
}

export interface ResourcePageProps {
  def: ResourceDef;
  /** Render without the page header (when embedded in a custom page). */
  embedded?: boolean;
  headerActions?: ReactNode;
}

/** Generic list + create/edit/delete + row actions for a ResourceDef. */
export function ResourcePage({ def, embedded, headerActions }: ResourcePageProps) {
  const { t } = useI18n();
  const text = useText();
  const can = caps(def);
  const pageSize = def.pageSize ?? 20;

  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<string | undefined>(def.defaultSort);
  const [dialog, setDialog] = useState<DialogState>(null);
  const dq = useDebounced(q);

  // Reset paging when switching resources or searching.
  useEffect(() => {
    setQ("");
    setPage(1);
    setSort(def.defaultSort);
    setDialog(null);
  }, [def]);
  useEffect(() => setPage(1), [dq]);

  const params = { q: dq || undefined, page, pageSize, sort };
  const { data, isLoading, isFetching, error, refetch } = useQuery(listQuery(def, params));
  const m = useResourceMutations(def);

  const columns = useMemo(() => def.fields.filter((f) => f.list), [def]);
  const singular = text(def.singular);
  const rowTitle = (row: Row) => (def.titleField ? String(row[def.titleField] ?? "") : rowId(def, row));
  const hasRowButtons = can.update || can.delete || (can.create && !!def.copyLabel) || (def.rowActions?.length ?? 0) > 0;

  const toggleSort = (name: string) => {
    setSort((s) => (s === name ? `-${name}` : s === `-${name}` ? undefined : name));
  };

  const total = data?.total ?? 0;
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={text(def.searchPlaceholder) || t("crud.search")}
          className="w-64 pl-9"
          aria-label={t("crud.search")}
        />
      </div>
      {isFetching && !isLoading && <Spinner className="size-4" />}
      {headerActions}
      {can.create && (
        <Button onClick={() => setDialog({ kind: "create" })}>
          <Plus /> {t("crud.new")}
        </Button>
      )}
    </div>
  );

  return (
    <div>
      {embedded ? (
        <div className="mb-4 flex justify-end">{header}</div>
      ) : (
        <PageHeader title={text(def.label)} description={text(def.description)} actions={header} />
      )}

      <div className="rounded-2xl border border-line bg-panel">
        {error ? (
          <div className="flex flex-col items-center gap-3 p-10 text-center">
            <p className="text-coral">{t("crud.loadError")}</p>
            <p className="font-mono text-xs text-muted">{errMsg(error, "")}</p>
            <Button variant="secondary" onClick={() => void refetch()}>
              {t("crud.retry")}
            </Button>
          </div>
        ) : isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !data?.items.length ? (
          <EmptyState title={t("crud.empty")} className="m-4 border-0">
            {t("crud.emptyHint")}
          </EmptyState>
        ) : (
          <Table>
            <THead>
              <Tr className="hover:bg-transparent">
                {columns.map((f) => {
                  const active = sort === f.name ? "asc" : sort === `-${f.name}` ? "desc" : null;
                  return (
                    <Th key={f.name} aria-sort={active === "asc" ? "ascending" : active === "desc" ? "descending" : undefined}>
                      {f.sortable ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(f.name)}
                          className={cn("inline-flex items-center gap-1 uppercase hover:text-ink", active && "text-sun")}
                        >
                          {text(f.label)}
                          {active === "asc" && <ArrowUp className="size-3" />}
                          {active === "desc" && <ArrowDown className="size-3" />}
                        </button>
                      ) : (
                        text(f.label)
                      )}
                    </Th>
                  );
                })}
                {hasRowButtons && <Th className="text-right">{t("crud.actions")}</Th>}
              </Tr>
            </THead>
            <TBody>
              {data.items.map((row) => {
                const id = rowId(def, row);
                return (
                  <Tr key={id}>
                    {columns.map((f) => (
                      <Td key={f.name}>
                        {f.type === "boolean" && f.inlineToggle && can.update ? (
                          <Switch
                            checked={!!row[f.name]}
                            aria-label={text(f.label)}
                            onCheckedChange={(checked) =>
                              m.update.mutate(
                                { id, body: { [f.name]: checked } },
                                { onError: (e) => toast.error(errMsg(e, t("common.error"))) },
                              )
                            }
                          />
                        ) : (
                          <Cell field={f} row={row} />
                        )}
                      </Td>
                    ))}
                    {hasRowButtons && (
                      <Td className="text-right">
                        <div className="inline-flex gap-1">
                          {can.create && def.copyLabel && (
                            <Button size="icon" variant="ghost" aria-label={text(def.copyLabel)} title={text(def.copyLabel)} onClick={() => setDialog({ kind: "create", row: copyForCreate(def, row) })}>
                              <Copy />
                            </Button>
                          )}
                          {def.rowActions
                            ?.filter((a) => !a.visible || a.visible(row))
                            .map((a) => {
                              const Icon = a.icon;
                              return (
                                <Button
                                  key={a.id}
                                  size="sm"
                                  variant={a.tone === "danger" ? "danger" : "secondary"}
                                  onClick={() => setDialog({ kind: "action", row, action: a })}
                                >
                                  {Icon && <Icon />} {text(a.label)}
                                </Button>
                              );
                            })}
                          {can.update && (
                            <Button size="icon" variant="ghost" aria-label={t("crud.edit")} onClick={() => setDialog({ kind: "edit", row })}>
                              <Pencil />
                            </Button>
                          )}
                          {can.delete && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="text-coral"
                              aria-label={t("crud.delete")}
                              onClick={() => setDialog({ kind: "delete", row })}
                            >
                              <Trash2 />
                            </Button>
                          )}
                        </div>
                      </Td>
                    )}
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}

        {total > 0 && (
          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3 text-sm text-muted">
            <span>{t("crud.range", { from, to, total })}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft /> {t("crud.prev")}
              </Button>
              <Button size="sm" variant="secondary" disabled={page >= lastPage} onClick={() => setPage((p) => p + 1)}>
                {t("crud.next")} <ChevronRight />
              </Button>
            </div>
          </div>
        )}
      </div>

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        {dialog?.kind === "create" && (
          <DialogContent title={t("crud.newTitle", { name: singular })} size="lg">
            <SchemaForm
              fields={def.fields}
              mode="create"
              initial={dialog.row}
              footer={def.name === "items" ? (getValues) => <WardrobeCheck getValues={getValues} /> : undefined}
              onCancel={() => setDialog(null)}
              onSubmit={async (body) => {
                try {
                  await m.create.mutateAsync({ ...dialog.row, ...body });
                  toast.success(t("crud.created"));
                  setDialog(null);
                } catch (e) {
                  toast.error(errMsg(e, t("common.error")));
                }
              }}
            />
          </DialogContent>
        )}
        {dialog?.kind === "edit" && (
          <DialogContent title={t("crud.editTitle", { name: rowTitle(dialog.row) || singular })} size="lg">
            <EditDialogBody def={def} row={dialog.row} onDone={() => setDialog(null)} />
          </DialogContent>
        )}
        {dialog?.kind === "delete" && (
          <DialogContent title={t("crud.deleteTitle", { name: rowTitle(dialog.row) })} description={t("crud.deleteBody")}>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDialog(null)}>
                {t("crud.cancel")}
              </Button>
              <Button
                variant="danger"
                disabled={m.remove.isPending}
                onClick={async () => {
                  try {
                    await m.remove.mutateAsync(rowId(def, dialog.row));
                    toast.success(t("crud.deleted"));
                    setDialog(null);
                  } catch (e) {
                    toast.error(errMsg(e, t("common.error")));
                  }
                }}
              >
                <Trash2 /> {t("crud.delete")}
              </Button>
            </div>
          </DialogContent>
        )}
        {dialog?.kind === "action" && (
          <DialogContent
            title={`${text(dialog.action.label)} · ${rowTitle(dialog.row)}`}
            description={dialog.action.fields?.length ? undefined : text(dialog.action.confirm)}
            size={dialog.action.fields?.length ? "lg" : "md"}
          >
            {(() => {
              const { row, action } = dialog;
              const run = async (body?: Row) => {
                try {
                  await m.action.mutateAsync({ id: rowId(def, row), path: action.path, body });
                  toast.success(text(action.success) || t("crud.done"));
                  setDialog(null);
                } catch (e) {
                  toast.error(errMsg(e, t("common.error")));
                }
              };
              return action.fields?.length ? (
                <SchemaForm fields={action.fields} submitLabel={text(action.label)} onCancel={() => setDialog(null)} onSubmit={run} />
              ) : (
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setDialog(null)}>
                    {t("crud.cancel")}
                  </Button>
                  <Button variant={action.tone === "danger" ? "danger" : "primary"} onClick={() => void run()}>
                    {t("crud.confirm")}
                  </Button>
                </div>
              );
            })()}
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
