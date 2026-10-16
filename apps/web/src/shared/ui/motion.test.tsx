import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Collapse, useContentMotion, useExitValue } from "./motion";
import { Modal, Panel } from "./index";

const originalAnimate = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "animate",
);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (originalAnimate)
    Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  else delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
});

function Region({ view }: { view: string }) {
  const ref = useContentMotion<HTMLDivElement>(view);
  return (
    <div ref={ref}>
      <input aria-label="Draft" defaultValue="Unsaved work" />
    </div>
  );
}

function ExitRegion({ value }: { value: string | null }) {
  const held = useExitValue(value);
  return (
    <section inert={!value} aria-hidden={!value}>
      {held && <button>{held}</button>}
    </section>
  );
}

function DialogExample() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Review"
        description="Check draft"
      >
        <input data-initial-focus aria-label="Review draft" />
      </Modal>
    </>
  );
}

function setup(reduced = false) {
  const preference = Object.assign(new EventTarget(), { matches: reduced });
  vi.stubGlobal("matchMedia", () => preference);
  const animations: { cancel: ReturnType<typeof vi.fn> }[] = [];
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: vi.fn(() => {
      const animation = { cancel: vi.fn() };
      animations.push(animation);
      return animation as unknown as Animation;
    }),
  });
  return { preference, animations };
}

describe("workspace motion", () => {
  it("makes closing details inert and cancels stale exits when another item opens", () => {
    vi.useFakeTimers();
    setup();
    const region = render(<ExitRegion value="First detail" />);
    region.rerender(<ExitRegion value={null} />);
    expect(screen.getByText("First detail").closest("[inert]")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "First detail" })).toBeNull();
    act(() => vi.advanceTimersByTime(80));
    region.rerender(<ExitRegion value="Second detail" />);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("button", { name: "Second detail" })).toBeTruthy();
    region.rerender(<ExitRegion value={null} />);
    act(() => vi.advanceTimersByTime(160));
    expect(screen.queryByText("Second detail")).toBeNull();
  });

  it("removes closed details immediately with reduced motion", () => {
    setup(true);
    const region = render(<ExitRegion value="Detail" />);
    region.rerender(<ExitRegion value={null} />);
    expect(screen.queryByText("Detail")).toBeNull();
  });
  it("animates panel selections without replaying motion on background data refresh", () => {
    const { animations } = setup();
    const panel = render(
      <Panel motionKey="v1">
        <input aria-label="Panel draft" />
        <span>Initial data</span>
      </Panel>,
    );
    const draft = screen.getByLabelText("Panel draft") as HTMLInputElement;
    draft.value = "Keep typing";
    draft.focus();
    panel.rerender(
      <Panel motionKey="v1">
        <input aria-label="Panel draft" />
        <span>Refreshed data</span>
      </Panel>,
    );
    expect(animations).toHaveLength(1);
    expect(document.activeElement).toBe(draft);
    expect(draft.value).toBe("Keep typing");
    panel.rerender(
      <Panel motionKey="v2">
        <input aria-label="Panel draft" />
        <span>Selected version</span>
      </Panel>,
    );
    expect(animations).toHaveLength(2);
    expect(document.activeElement).toBe(draft);
  });

  it("keeps collapsed form values while removing controls from the accessible view", () => {
    const section = render(
      <Collapse open>
        <input aria-label="Advanced filter" defaultValue="saved query" />
      </Collapse>,
    );
    const field = screen.getByRole("textbox", { name: "Advanced filter" });
    section.rerender(
      <Collapse open={false}>
        <input aria-label="Advanced filter" defaultValue="saved query" />
      </Collapse>,
    );
    expect(
      screen.queryByRole("textbox", { name: "Advanced filter" }),
    ).toBeNull();
    expect(field.closest("[inert]")).toBeTruthy();
    section.rerender(
      <Collapse open>
        <input aria-label="Advanced filter" defaultValue="saved query" />
      </Collapse>,
    );
    expect(screen.getByRole("textbox", { name: "Advanced filter" })).toBe(
      field,
    );
    expect((field as HTMLInputElement).value).toBe("saved query");
  });
  it("returns keyboard focus to the opener after dismissing a modal", async () => {
    const user = userEvent.setup();
    render(<DialogExample />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    expect(document.activeElement).toBe(screen.getByLabelText("Review draft"));
    await user.click(screen.getByRole("button", { name: "Закрыть" }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
  it("preserves a focused draft and cancels interrupted animations on rapid view changes", () => {
    const { animations } = setup();
    const region = render(<Region view="first" />);
    const draft = screen.getByLabelText("Draft") as HTMLInputElement;
    draft.value = "Keep this draft";
    draft.focus();
    region.rerender(<Region view="second" />);
    region.rerender(<Region view="third" />);
    expect(screen.getByLabelText("Draft")).toBe(draft);
    expect(document.activeElement).toBe(draft);
    expect(draft.value).toBe("Keep this draft");
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expect(animations[1].cancel).toHaveBeenCalledOnce();
    region.unmount();
    expect(animations[2].cancel).toHaveBeenCalledOnce();
  });

  it("respects reduced motion from the first render", () => {
    const { animations } = setup(true);
    const region = render(<Region view="first" />);
    region.rerender(<Region view="second" />);
    expect(animations).toHaveLength(0);
    expect(screen.getByLabelText("Draft")).toBeTruthy();
  });

  it("stops active motion immediately when the system preference changes", () => {
    const { preference, animations } = setup();
    const region = render(<Region view="first" />);
    act(() => {
      preference.matches = true;
      preference.dispatchEvent(new Event("change"));
    });
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    region.rerender(<Region view="second" />);
    expect(animations).toHaveLength(1);
  });
});
