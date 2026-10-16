import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, Card, PageHeader } from "@ddtank/ui";
import { api } from "@/lib/api";
import { SchemaForm } from "@/crud/SchemaForm";
import { ResourcePage } from "@/crud/ResourcePage";
import type { FieldDef, Row } from "@/crud/types";
import { mailBroadcasts } from "@/resources";
import { useI18n } from "@/i18n";

const mailFields: FieldDef[] = [
  {
    name: "target",
    label: "收件人",
    type: "select",
    required: true,
    options: [
      { value: "all", label: "全部玩家" },
      { value: "online", label: "仅在线玩家" },
      { value: "level", label: "按等级范围" },
      { value: "list", label: "昵称列表" },
    ],
    section: "发送目标",
  },
  { name: "levelMin", label: "最低等级", type: "number", min: 1, max: 100, hint: "选择“按等级范围”时生效", section: "发送目标" },
  { name: "levelMax", label: "最高等级", type: "number", min: 1, max: 100, section: "发送目标" },
  { name: "nicknames", label: "昵称列表", type: "tags", hint: "选择“昵称列表”时生效", section: "发送目标" },
  { name: "subject", label: "主题", type: "text", required: true, maxLength: 50, span: 2, section: "邮件内容" },
  { name: "body", label: "内容", type: "textarea", required: true, maxLength: 500, section: "邮件内容" },
  { name: "gold", label: "金币", type: "number", min: 0, default: 0, section: "附件" },
  { name: "money", label: "点券", type: "number", min: 0, default: 0, section: "附件" },
  { name: "giftToken", label: "绑定点券", type: "number", min: 0, default: 0, section: "附件" },
  {
    name: "items",
    label: "物品",
    type: "json",
    default: [],
    hint: "最多 5 项：[{\"templateId\": 11020, \"count\": 1, \"validDays\": 0}]",
    section: "附件",
  },
];

export function MailPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const send = useMutation({
    mutationFn: (body: Row) => api.post<{ recipients: number }>("/api/admin/mail/broadcast", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["resource", mailBroadcasts.name] }),
  });

  return (
    <div className="flex flex-col gap-10">
      <div className="max-w-4xl">
        <PageHeader title={t("mail.title")} description={t("mail.lead")} />
        <Card className="p-6">
          <SchemaForm
            fields={mailFields}
            submitLabel={t("mail.send")}
            onSubmit={async (body) => {
              try {
                const res = await send.mutateAsync(body);
                toast.success(t("mail.sent", { n: res.recipients }));
              } catch (e) {
                toast.error(e instanceof ApiError ? e.message : t("common.error"));
              }
            }}
          />
        </Card>
      </div>
      <section>
        <h2 className="title-plate mb-2 text-2xl">{t("mail.history")}</h2>
        <ResourcePage def={mailBroadcasts} embedded />
      </section>
    </div>
  );
}
