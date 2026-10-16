/** Minimal JSON fetch client shared by web + admin. Auth token lives in localStorage. */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function createApiClient(opts: { baseUrl?: string; tokenKey: string; onUnauthorized?: () => void }) {
  const base = opts.baseUrl ?? "";

  const getToken = (): string | null => {
    try {
      return localStorage.getItem(opts.tokenKey);
    } catch {
      return null;
    }
  };
  const setToken = (token: string | null) => {
    try {
      if (token) localStorage.setItem(opts.tokenKey, token);
      else localStorage.removeItem(opts.tokenKey);
    } catch {
      /* storage unavailable */
    }
  };

  async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    if (body !== undefined && !isForm) headers.set("Content-Type", "application/json");

    const res = await fetch(base + path, {
      ...init,
      method,
      headers,
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      if (res.status === 401) opts.onUnauthorized?.();
      const msg =
        data && typeof data === "object" && "message" in data ? String((data as { message: unknown }).message) : "";
      throw new ApiError(res.status, res.status >= 500 ? "请求失败，请稍后重试。" : msg || `请求失败（状态码${res.status}）`, data);
    }
    return data as T;
  }

  return {
    getToken,
    setToken,
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
    put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
    patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
    del: <T>(path: string) => request<T>("DELETE", path),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
