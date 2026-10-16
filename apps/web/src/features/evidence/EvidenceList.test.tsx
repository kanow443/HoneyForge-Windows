import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import { EvidenceList } from "./EvidenceList";
import { artifact } from "./evidence.fixtures";
const auth = vi.hoisted(() => ({ user: { role: "admin" } }));
vi.mock("../auth/Auth", () => ({ useAuth: () => auth }));
afterEach(() => {
  cleanup();
  auth.user.role = "admin";
});
function setup(
  scope: { sessionId: string } | { deploymentId: string },
  selected?: string,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <EvidenceList {...scope} selected={selected} />
    </QueryClientProvider>,
  );
  return client;
}
describe("truthful evidence states", () => {
  it("does not offer downloads while evidence is being purged", async () => {
    vi.spyOn(api, "artifacts").mockResolvedValue([
      { ...artifact, state: "purging" },
    ]);
    setup({ sessionId: "session" });
    expect(await screen.findByText("Удаляется")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Скачать/ })).toBeNull();
  });
  it("lets viewers inspect verified metadata but exposes no binary download action", async () => {
    auth.user.role = "viewer";
    vi.spyOn(api, "artifacts").mockResolvedValue([artifact]);
    setup({ sessionId: "session" });
    expect(await screen.findByText(/SHA-256 проверен сервером/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Скачать/ })).toBeNull();
    expect(
      screen.getByText(/Изменение дел, экспорт и скачивание доступны/),
    ).toBeTruthy();
  });
  it("keeps a failed list separate from a genuine empty list", async () => {
    vi.spyOn(api, "artifacts").mockRejectedValue(
      new Error("Sensor endpoint unavailable"),
    );
    setup({ deploymentId: "trap" });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      screen.queryByText("Сохранённых доказательств пока нет."),
    ).toBeNull();
  });
  it("does not offer a download or server verification while receiving, then refreshes to available", async () => {
    const list = vi.spyOn(api, "artifacts").mockResolvedValue([
      {
        ...artifact,
        state: "receiving",
        size_bytes: 100,
        received_bytes: 40,
      },
    ]);
    const client = setup({ sessionId: "session" });
    const bar = await screen.findByRole("progressbar");
    expect(bar.getAttribute("value")).toBe("40");
    expect(bar.getAttribute("max")).toBe("100");
    expect(screen.queryByRole("button", { name: /^Скачать/ })).toBeNull();
    expect(screen.queryByText(/проверен сервером/)).toBeNull();
    expect(list.mock.calls[0][0]).toEqual({ session_id: "session" });
    list.mockResolvedValue([artifact]);
    await client.invalidateQueries({ queryKey: ["artifacts"] });
    expect(
      await screen.findByRole("button", { name: /^Скачать/ }),
    ).toBeTruthy();
    expect(screen.getByText(/SHA-256 проверен сервером/)).toBeTruthy();
  });
  it("does not download expired content and discloses trap-wide encrypted PCAP scope", async () => {
    vi.spyOn(api, "artifacts").mockResolvedValue([
      { ...artifact, kind: "pcap", state: "expired" },
    ]);
    setup({ sessionId: "session" });
    expect(await screen.findByText("Срок хранения истёк")).toBeTruthy();
    expect(
      screen.getByText(/Запись сети всей ловушки, включая другие подключения/),
    ).toBeTruthy();
    expect(screen.getByText(/SSH-трафик остаётся зашифрованным/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Скачать/ })).toBeNull();
  });
  it("labels file safety as not scanned and reports a missing linked artifact without inventing availability", async () => {
    vi.spyOn(api, "artifacts").mockResolvedValue([artifact]);
    setup({ deploymentId: "trap" }, "missing");
    expect(
      await screen.findByText("Проверка на вредоносность не проводилась."),
    ).toBeTruthy();
    expect(
      screen.getByText("Сведения о связанном файле не получены."),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Принимается")).toBeNull());
  });
});
