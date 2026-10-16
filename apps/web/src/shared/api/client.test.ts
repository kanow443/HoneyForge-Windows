import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, queryString, request } from "./client";
describe("операторский API-клиент", () => {
  beforeEach(() => {
    document.cookie = "hf_csrf=; max-age=0";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            new Response(JSON.stringify({ ok: true }), { status: 200 }),
          ),
        ),
    );
  });
  it("отправляет cookie и CSRF на каждый изменяющий запрос", async () => {
    document.cookie = "hf_csrf=csrf-from-cookie";
    await api.stop("deployment-id");
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/deployments/deployment-id/stop",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({
          "X-CSRF-Token": "csrf-from-cookie",
        }),
      }),
    );
  });
  it("сохраняет переданный ключ повторного deploy", async () => {
    document.cookie = "hf_csrf=csrf";
    const body = {
      name: "lab",
      host_id: "h",
      profile_version_id: "v",
      port: 8080,
    };
    await api.deploy(body, "same-submit-key");
    await api.deploy(body, "same-submit-key");
    for (const call of vi.mocked(fetch).mock.calls)
      expect(call[1]?.headers).toMatchObject({
        "Idempotency-Key": "same-submit-key",
      });
  });
  it("401 завершает авторизованную работу", async () => {
    const expired = vi.fn();
    window.addEventListener("auth-expired", expired);
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "session_expired", message: "Expired" },
        }),
        { status: 401 },
      ),
    );
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalledOnce();
    window.removeEventListener("auth-expired", expired);
  });
  it("сохраняет 422 и пути полей для формы", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "validation_failed",
            message: "Invalid",
            fields: [{ path: "body.config.http.hostname", message: "invalid" }],
          },
        }),
        { status: 422 },
      ),
    );
    await expect(request("/profiles", { body: {} })).rejects.toMatchObject({
      status: 422,
      fields: [{ path: "body.config.http.hostname", message: "invalid" }],
    });
  });
  it("кодирует фильтры без потери специальных символов и offset=0", () => {
    const query = queryString({
      q: "curl https://lab/?a=1&b=2",
      offset: 0,
      source_ip: "",
    });
    expect(new URLSearchParams(query).get("q")).toBe(
      "curl https://lab/?a=1&b=2",
    );
    expect(new URLSearchParams(query).get("offset")).toBe("0");
    expect(query).not.toContain("source_ip");
  });
  it("не повторяет изменения автоматически при сетевом отказе", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api.stop("d")).rejects.toMatchObject({
      status: 0,
      code: "unavailable",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("loads binary evidence with operator cookies and retains the checksum header", async () => {
    const bytes = new Uint8Array([0, 255, 10, 13]);
    vi.mocked(fetch).mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { "X-Content-SHA256": "sha" },
      }),
    );
    const result = await api.artifactBytes("artifact-id");
    expect(new Uint8Array(result.bytes)).toEqual(bytes);
    expect(result.sha256).toBe("sha");
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/artifacts/artifact-id/download",
      expect.objectContaining({ credentials: "include" }),
    );
  });
  it("never treats download denial JSON as bytes and expires stale authentication", async () => {
    const expired = vi.fn();
    window.addEventListener("auth-expired", expired);
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "session_expired", message: "Expired" },
        }),
        { status: 401 },
      ),
    );
    await expect(api.artifactBytes("artifact-id")).rejects.toMatchObject({
      status: 401,
    });
    expect(expired).toHaveBeenCalledOnce();
    window.removeEventListener("auth-expired", expired);
  });
});
