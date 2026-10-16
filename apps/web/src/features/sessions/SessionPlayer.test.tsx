import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { SessionPlayer } from "./SessionPlayer";
import type { Finding } from "../../shared/api/models";
import { event } from "./playback.fixtures";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const props = {
  findings: [] as Finding[],
  selected: null,
  onFinding: vi.fn(),
  connection: "connected",
  ended: false,
  catchUp: vi.fn().mockResolvedValue(undefined),
  fetching: false,
};
describe("session player interactions", () => {
  it("keeps live playback usable when a finding arrives before its evidence, then shows the actual command", () => {
    const observed = event("hostname", 1);
    const finding = {
      id: "early-finding",
      title: "Осмотр окружения",
      severity: "low",
      explanation: "Observed command",
      evidence_ids: [observed.event_id],
      rule_id: "environment-discovery",
      rule_version: 1,
      observation: "intent",
      created_at: observed.created_at,
    } as Finding;
    const view = render(
      <SessionPlayer {...props} events={[]} findings={[finding]} />,
    );
    expect(screen.getByText("Событие ещё не загружено")).toBeTruthy();
    expect(screen.queryByText("hostname")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Развернуть плеер" }),
    ).toBeTruthy();
    view.rerender(
      <SessionPlayer {...props} events={[observed]} findings={[finding]} />,
    );
    expect(screen.queryByText("Событие ещё не загружено")).toBeNull();
    expect(screen.getAllByText("hostname")).toHaveLength(2);
  });
  it("freezes exact rows on pause, keeps receiving new data and catches up only after fetching succeeds", async () => {
    const catchUp = vi.fn().mockResolvedValue(undefined),
      original = [event("hostname", 1), event("whoami", 3)];
    const view = render(
      <SessionPlayer {...props} events={original} catchUp={catchUp} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Приостановить просмотр" }),
    );
    view.rerender(
      <SessionPlayer
        {...props}
        events={[
          event("hostname", 1),
          event("late", 2),
          event("whoami", 3),
          event("cat", 4),
        ]}
        catchUp={catchUp}
      />,
    );
    expect(screen.queryByText("late")).toBeNull();
    expect(screen.queryByText("cat")).toBeNull();
    expect(screen.getByText("Просмотр на паузе")).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "В LIVE · 2 новых" })),
    );
    expect(catchUp).toHaveBeenCalledOnce();
    expect(screen.getByText("late")).toBeTruthy();
    expect(screen.getByText("cat")).toBeTruthy();
  });
  it("retains the paused view on catch-up failure and exposes retry", async () => {
    render(
      <SessionPlayer
        {...props}
        events={[event("hostname", 1)]}
        catchUp={vi.fn().mockRejectedValue(new Error("offline"))}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Приостановить просмотр" }),
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Вернуться в LIVE" })),
    );
    expect(screen.getByText("Просмотр на паузе")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Не удалось");
  });
  it("replays at the selected speed, seeks by time and pauses without moving", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    render(
      <SessionPlayer
        {...props}
        events={[
          event("first", 1, 1000),
          event("second", 2, 6000),
          event("third", 3, 11000),
        ]}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Воспроизвести с начала" }),
    );
    fireEvent.change(screen.getByLabelText("Скорость воспроизведения"), {
      target: { value: "2" },
    });
    act(() => vi.advanceTimersByTime(2500));
    expect(screen.getByText("second")).toBeTruthy();
    expect(screen.queryByText("third")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Приостановить воспроизведение" }),
    );
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.queryByText("third")).toBeNull();
    fireEvent.change(screen.getByLabelText("Позиция воспроизведения"), {
      target: { value: "10000" },
    });
    expect(screen.getByText("third")).toBeTruthy();
  });
  it("opens evidence even when identified by upstream event_id and safely displays markup as text", () => {
    const observed = event("<img src=x onerror=alert(1)>", 1),
      finding = {
        id: "finding",
        title: "Read attempt",
        severity: "medium",
        explanation: "Observed",
        evidence_ids: [observed.event_id],
        rule_id: "r",
        rule_version: 1,
        observation: "intent",
        created_at: observed.created_at,
      } as Finding;
    const select = vi.fn();
    const { container } = render(
      <SessionPlayer
        {...props}
        events={[observed]}
        findings={[finding]}
        onFinding={select}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Открыть правило: Read attempt" }),
    );
    expect(select).toHaveBeenCalledWith("finding");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByText("<img src=x onerror=alert(1)>")).toHaveLength(2);
  });
  it("opens one readable evidence inspector and returns to the rule list", () => {
    const observed = event("hostname", 1),
      finding = {
        id: "finding",
        title: "Осмотр окружения",
        severity: "low",
        explanation: "Observed command",
        evidence_ids: [observed.id],
        rule_id: "environment-discovery",
        rule_version: 1,
        observation: "intent",
        created_at: observed.created_at,
      } as Finding;
    const select = vi.fn(),
      view = render(
        <SessionPlayer
          {...props}
          events={[observed]}
          findings={[finding]}
          onFinding={select}
          selected="finding"
        />,
      );
    expect(screen.getByText("Observed command")).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Открыть правило: Осмотр окружения",
      }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "К срабатываниям" }));
    expect(select).toHaveBeenCalledWith(null);
    view.rerender(
      <SessionPlayer
        {...props}
        events={[observed]}
        findings={[finding]}
        onFinding={select}
        selected={null}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Открыть правило: Осмотр окружения" }),
    ).toBeTruthy();
  });
  it("renders captured SSH output safely and identifies missing fragments when capture quota is exceeded", () => {
    const output = {
        ...event("output", 2),
        event_type: "ssh.output" as const,
        payload: {
          text: "\u001b[31mСервис готов ✓\nroot\n<img src=x onerror=alert(1)>\u001b[0m",
          capture: "shell-output",
        },
      },
      quota = {
        ...event("quota", 3),
        event_type: "sensor.error" as const,
        payload: { capture: "shell-output", message: "quota" },
      };
    const { container } = render(
      <SessionPlayer {...props} events={[event("whoami", 1), output, quota]} />,
    );
    expect(container.querySelector(".player-output")?.textContent).toBe(
      "Сервис готов ✓\nroot\n<img src=x onerror=alert(1)>",
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("С сохранённым выводом SSH")).toBeTruthy();
    expect(container.textContent).toContain("непол");
  });
  it("bounds rendered rows but retains history for seeking and exits expanded mode with Escape", () => {
    const { container } = render(
      <SessionPlayer
        {...props}
        events={Array.from({ length: 300 }, (_, i) => event(`command-${i}`, i))}
      />,
    );
    expect(container.querySelectorAll(".player-event")).toHaveLength(250);
    expect(screen.queryByText("command-0")).toBeNull();
    fireEvent.change(screen.getByLabelText("Позиция воспроизведения"), {
      target: { value: "0" },
    });
    expect(screen.getByText("command-0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Развернуть плеер" }));
    expect(screen.getByRole("button", { name: "Свернуть плеер" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.getByRole("button", { name: "Развернуть плеер" }),
    ).toBeTruthy();
  });
});
