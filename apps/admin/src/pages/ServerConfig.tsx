import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, Card, PageHeader, Skeleton } from "@ddtank/ui";
import { api } from "@/lib/api";
import { SchemaForm } from "@/crud/SchemaForm";
import type { FieldDef, Row } from "@/crud/types";
import { useI18n } from "@/i18n";

const HOST = /^[A-Za-z0-9.-]+$/;
const URL_RE = /^(https?|wss?):\/\/\S+$/;

/** Every network/gameplay setting exposed by GET/PUT /api/admin/server-config. */
export const serverConfigFields: FieldDef[] = [
  // Rede
  { name: "publicHost", label: "公网地址", type: "text", required: true, pattern: HOST, patternMessage: "请输入域名或 IP 地址", hint: "客户端连接使用的域名或 IP 地址", section: "网络" },
  { name: "publicIps", label: "公网 IP 地址", type: "tags", hint: "服务端公布给客户端服务器列表的 IP 地址", section: "网络" },
  { name: "tcpPort", label: "游戏 TCP 端口", type: "number", required: true, min: 1, max: 65535, default: 9200, section: "网络" },
  { name: "wsUrl", label: "WebSocket 地址", type: "text", required: true, pattern: URL_RE, patternMessage: "请使用 ws:// 或 wss://", placeholder: "wss://jogo.exemplo.com/ws/game", hint: "浏览器模拟器的套接字代理地址（socketProxy）", section: "网络" },
  { name: "policyPort", label: "策略服务端口", type: "number", required: true, min: 1, max: 65535, default: 843, hint: "Flash 跨域策略服务，默认端口为 843", section: "网络" },
  { name: "resourceUrl", label: "资源地址（CDN）", type: "text", required: true, pattern: URL_RE, patternMessage: "地址格式不正确", placeholder: "https://cdn.exemplo.com/resource/", hint: "客户端图片、影片与声音资源的根地址", section: "客户端地址" },
  { name: "requestUrl", label: "请求地址", type: "text", required: true, pattern: URL_RE, patternMessage: "地址格式不正确", placeholder: "https://api.exemplo.com/", hint: ".ashx 请求的根地址（Tank.Request）", section: "客户端地址" },
  { name: "flashUrl", label: "客户端影片地址（SWF）", type: "text", pattern: URL_RE, patternMessage: "地址格式不正确", placeholder: "https://cdn.exemplo.com/flash/", section: "客户端地址" },
  // Taxas
  { name: "expRate", label: "经验倍率", type: "number", int: false, step: 0.1, min: 0, max: 100, required: true, default: 1, section: "倍率与容量" },
  { name: "goldRate", label: "金币倍率", type: "number", int: false, step: 0.1, min: 0, max: 100, required: true, default: 1, section: "倍率与容量" },
  { name: "dropRate", label: "掉落倍率", type: "number", int: false, step: 0.1, min: 0, max: 100, required: true, default: 1, section: "倍率与容量" },
  { name: "offerRate", label: "功勋倍率", type: "number", int: false, step: 0.1, min: 0, max: 100, default: 1, section: "倍率与容量" },
  { name: "maxPlayers", label: "在线人数上限", type: "number", min: 1, default: 1000, section: "倍率与容量" },
  // Jogo
  { name: "aimAngles", label: "瞄准表角度", type: "tags", default: ["20", "30", "50", "65"], hint: "游戏页面角度与力度表中显示的角度（度），由 GET /api/public/aim-tables 提供", section: "游戏" },
  // Operação
  { name: "maintenance", label: "维护模式", type: "boolean", hint: "阻止非管理员账号新登录", section: "运行设置" },
  { name: "maintenanceMessage", label: "维护提示", type: "text", section: "运行设置" },
  { name: "motd", label: "每日公告（MOTD）", type: "textarea", hint: "在网站以及进入游戏时的系统聊天中显示", section: "运行设置" },
];

export function ServerConfigPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["admin", "server-config"], queryFn: () => api.get<Row>("/api/admin/server-config") });
  const save = useMutation({
    mutationFn: (body: Row) => api.put<Row>("/api/admin/server-config", body),
    onSuccess: (res) => qc.setQueryData(["admin", "server-config"], res),
  });

  return (
    <div className="max-w-4xl">
      <PageHeader title={t("config.title")} description={t("config.lead")} />
      <Card className="p-6">
        {isLoading ? (
          <Skeleton className="h-96" />
        ) : (
          <SchemaForm
            fields={serverConfigFields}
            mode="edit"
            initial={data}
            onSubmit={async (body) => {
              try {
                await save.mutateAsync(body);
                toast.success(t("config.saved"));
              } catch (e) {
                toast.error(e instanceof ApiError ? e.message : t("common.error"));
              }
            }}
          />
        )}
      </Card>
    </div>
  );
}
