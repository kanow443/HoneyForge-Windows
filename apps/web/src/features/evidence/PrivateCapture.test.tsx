import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrivateCapture } from "./PrivateCapture";
import { api } from "../../shared/api/client";
import { event } from "../sessions/playback.fixtures";
const auth = vi.hoisted(() => ({ user: { role: "analyst" } }));
vi.mock("../auth/Auth", () => ({ useAuth: () => auth }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  auth.user.role = "analyst";
  sessionStorage.clear();
  localStorage.clear();
});
const sample = { ...event("event-1", 1), private_capture_available: true };
const capture = {
  event_id: sample.id,
  capture_id: "capture-1",
  content: {
    username: "synthetic",
    password: "test-only-secret",
    http_payload_base64: "dGVzdA==",
    captured_bytes: 4,
    original_bytes: 10,
    truncated: true,
  },
};
function setup() {
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <PrivateCapture event={sample} />
    </QueryClientProvider>,
  );
  return { client, ...view };
}
async function confirm() {
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Закрытые данные события" }),
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Раскрыть данные",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await user.click(
    screen.getByRole("checkbox", {
      name: "Подтверждаю раскрытие закрытых данных",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Раскрыть данные" }));
  return user;
}
describe("private capture boundaries", () => {
  it("requires explicit confirmation, keeps secrets out of caches and storage, clears on close", async () => {
    const request = vi.spyOn(api, "privateCapture").mockResolvedValue(capture);
    const { client } = setup();
    expect(request).not.toHaveBeenCalled();
    const user = await confirm();
    const password = (await screen.findByLabelText(
      "Введённый пароль",
    )) as HTMLInputElement;
    expect(password.type).toBe("password");
    expect(password.value).toBe("test-only-secret");
    expect(request).toHaveBeenCalledWith(sample.id);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(screen.getByText(/полное тело не сохранено/)).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Закрыть и очистить" }),
    );
    expect(screen.queryByLabelText("Введённый пароль")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Закрытые данные события" }),
    );
    expect(screen.queryByLabelText("Введённый пароль")).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });
  it("does not request unavailable captures or permit a viewer to reveal", () => {
    const request = vi.spyOn(api, "privateCapture");
    auth.user.role = "viewer";
    const { rerender } = setup();
    expect(
      screen.queryByRole("button", { name: "Закрытые данные события" }),
    ).toBeNull();
    expect(screen.getByText(/Закрытые данные доступны/)).toBeTruthy();
    rerender(
      <PrivateCapture
        event={{ ...sample, private_capture_available: false }}
      />,
    );
    expect(screen.queryByText(/Закрытые данные доступны/)).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
  it("discards a late response after switching events and after loss of access", async () => {
    let resolve!: (value: typeof capture) => void;
    vi.spyOn(api, "privateCapture").mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const { rerender } = setup();
    await confirm();
    rerender(<PrivateCapture event={{ ...sample, id: "event-2" }} />);
    resolve(capture);
    await waitFor(() =>
      expect(screen.queryByLabelText("Введённый пароль")).toBeNull(),
    );
    vi.mocked(api.privateCapture).mockResolvedValue({
      ...capture,
      event_id: "event-2",
    });
    await confirm();
    await screen.findByLabelText("Введённый пароль");
    auth.user.role = "viewer";
    rerender(<PrivateCapture event={{ ...sample, id: "event-2" }} />);
    expect(screen.queryByLabelText("Введённый пароль")).toBeNull();
  });
  it("rejects mismatched event data without rendering its contents", async () => {
    vi.spyOn(api, "privateCapture").mockResolvedValue({
      ...capture,
      event_id: "other-event",
    });
    setup();
    await confirm();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "другого события",
    );
    expect(screen.queryByLabelText("Введённый пароль")).toBeNull();
    expect(screen.queryByLabelText("HTTP payload, Base64")).toBeNull();
  });
  it("shows a server failure without inventing captured credentials", async () => {
    vi.spyOn(api, "privateCapture").mockRejectedValue(
      new Error("Capture is unavailable"),
    );
    setup();
    await confirm();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Capture is unavailable",
    );
    expect(screen.queryByLabelText("Введённый логин")).toBeNull();
  });
});
