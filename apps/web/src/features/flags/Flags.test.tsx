import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import { FlagsPage } from "./Flags";

const auth = vi.hoisted(() => ({ user: { id: "participant-1", username: "Uni", role: "participant" } }));
vi.mock("../auth/Auth", () => ({ useAuth: () => auth }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("lets a participant submit a found flag without showing challenge administration", async () => {
  vi.spyOn(api, "flagChallenges").mockResolvedValue([{ id: "challenge-1", title: "Резервный ключ", points: 100, active: true, enabled: true, solved: false, created_at: "2026-10-16T00:00:00Z" }]);
  vi.spyOn(api, "flagScoreboard").mockResolvedValue([]);
  const submit = vi.spyOn(api, "submitFlag").mockResolvedValue({ ok: true, challenge_id: "challenge-1", points: 100 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><FlagsPage /></QueryClientProvider>);
  expect(screen.queryByText("Создать задание")).toBeNull();
  const input = await screen.findByRole("textbox", { name: "Флаг: Резервный ключ" });
  fireEvent.change(input, { target: { value: "HF{test-marker}" } });
  await userEvent.setup().click(screen.getByRole("button", { name: "Отправить флаг" }));
  await waitFor(() => expect(submit).toHaveBeenCalledWith("challenge-1", "HF{test-marker}"));
  expect((await screen.findByRole("status")).textContent).toContain("+100 очков");
});
