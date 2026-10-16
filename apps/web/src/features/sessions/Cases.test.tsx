import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { CasesPage } from "./Cases";
import { api } from "../../shared/api/client";
import type { InvestigationCase } from "../../shared/api/models";
const auth = vi.hoisted(() => ({ user: { role: "analyst" } }));
vi.mock("../auth/Auth", () => ({ useAuth: () => auth }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  auth.user.role = "analyst";
});
const item: InvestigationCase = {
  id: "case-1",
  created_at: "2026-10-10T10:00:00Z",
  updated_at: "2026-10-10T10:00:00Z",
  created_by: "Analyst",
  title: "Lab investigation",
  session_ids: ["s"],
  note: "Saved note",
  status: "new",
  revision: 1,
  retention_pinned: false,
};
function setup(initial = item) {
  const list = vi
    .spyOn(api, "cases")
    .mockResolvedValue(initial ? [initial] : []);
  vi.spyOn(api, "sessions").mockResolvedValue([]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CasesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { list, client };
}
describe("case evidence retention", () => {
  it("pins with the current revision while preserving unsaved notes; unpin requires review", async () => {
    const { list } = setup();
    const user = userEvent.setup();
    const note = await screen.findByLabelText("Заметка оператора");
    await user.type(note, " unsaved");
    const pinned = { ...item, revision: 2, retention_pinned: true };
    list.mockResolvedValue([pinned]);
    const pin = vi.spyOn(api, "caseRetention").mockResolvedValue(pinned);
    await user.click(
      screen.getByRole("button", { name: "Закрепить доказательства" }),
    );
    await waitFor(() =>
      expect(pin).toHaveBeenCalledWith(item.id, { revision: 1, pinned: true }),
    );
    const unpin = await screen.findByRole("button", {
      name: "Снять закрепление",
    });
    expect(
      (screen.getByLabelText("Заметка оператора") as HTMLTextAreaElement).value,
    ).toBe("Saved note unsaved");
    await user.click(unpin);
    expect(pin).toHaveBeenCalledOnce();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Истёкшие данные/)).toBeTruthy();
    list.mockResolvedValue([
      { ...pinned, revision: 3, retention_pinned: false },
    ]);
    pin.mockResolvedValue({ ...pinned, revision: 3, retention_pinned: false });
    await user.click(
      within(dialog).getByRole("button", { name: "Снять закрепление" }),
    );
    await waitFor(() =>
      expect(pin).toHaveBeenLastCalledWith(item.id, {
        revision: 2,
        pinned: false,
      }),
    );
  });
  it("does not claim pin success after server rejection and retains the note", async () => {
    vi.spyOn(api, "caseRetention").mockRejectedValue(
      new Error("Revision conflict"),
    );
    setup();
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText("Заметка оператора"),
      " draft",
    );
    await user.click(
      screen.getByRole("button", { name: "Закрепить доказательства" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Revision conflict",
    );
    expect(screen.queryByText("Доказательства закреплены")).toBeNull();
    expect(
      (screen.getByLabelText("Заметка оператора") as HTMLTextAreaElement).value,
    ).toContain("draft");
  });
  it("lets a viewer inspect retention without changing it", async () => {
    auth.user.role = "viewer";
    const pin = vi.spyOn(api, "caseRetention");
    setup();
    expect(
      (
        (await screen.findByRole("button", {
          name: "Закрепить доказательства",
        })) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(pin).not.toHaveBeenCalled();
  });
});
