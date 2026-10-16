import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TerminationResult } from "./TerminationResult";
afterEach(cleanup);
describe("SSH termination evidence", () => {
  it("never treats missing information or pending completion as a confirmed close", () => {
    const view = render(<TerminationResult block={{}} />);
    expect(view.container.textContent).toBe("");
    view.rerender(
      <TerminationResult
        block={{
          terminate_sessions: true,
          termination_state: "pending",
          terminated_sessions: [],
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Ожидаем");
    expect(view.container.textContent).not.toContain("подтвердил завершение");
  });
  it("shows unsupported independently, without claiming an open session was closed", () => {
    render(
      <TerminationResult
        block={{
          terminate_sessions: true,
          termination_state: "unsupported",
          termination_error: "Runtime has no control socket",
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("не поддерживает");
    expect(screen.getByText("Runtime has no control socket")).toBeTruthy();
  });
  it("keeps already-confirmed transport IDs visible even when a later close attempt fails", () => {
    render(
      <TerminationResult
        block={{
          terminate_sessions: true,
          termination_state: "error",
          terminated_sessions: ["transport-a", "transport-a", "transport-b"],
          termination_error: "Close failed",
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Не удалось подтвердить",
    );
    expect(
      screen.getByText("Идентификаторы транспортных сессий (2)"),
    ).toBeTruthy();
    expect(screen.getByText("Close failed")).toBeTruthy();
  });
  it("distinguishes a completed check with no open transports from successful closure of two transports", () => {
    const view = render(
      <TerminationResult
        block={{
          terminate_sessions: true,
          termination_state: "completed",
          terminated_sessions: [],
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("не найдено");
    view.rerender(
      <TerminationResult
        block={{
          terminate_sessions: true,
          termination_state: "completed",
          terminated_sessions: ["one", "two"],
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("SSH-сессий: 2");
    expect(view.container.textContent).toContain("не восстанавливает");
  });
});
