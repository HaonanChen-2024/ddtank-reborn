import { afterEach, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "../../../packages/ui/src/api";

afterEach(() => vi.unstubAllGlobals());

it("shows Chinese for unexpected server failures while retaining status and diagnostic body", async () => {
  const body = { message: 'Failed query: insert into private_table', detail: 'diagnostic' };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 500 })));
  const client = createApiClient({ tokenKey: "test" });
  const error = await client.get("/api/auth/register").catch(value => value);
  expect(error).toBeInstanceOf(ApiError);
  expect(error.message).toBe("请求失败，请稍后重试。");
  expect(error.status).toBe(500);
  expect(error.body).toEqual(body);
});

it("keeps translated business failures and unauthorized handling", async () => {
  const unauthorized = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "密码错误。" }), { status: 401 })));
  const client = createApiClient({ tokenKey: "test", onUnauthorized: unauthorized });
  await expect(client.get("/api/auth/login")).rejects.toMatchObject({ status: 401, message: "密码错误。" });
  expect(unauthorized).toHaveBeenCalledOnce();
});
