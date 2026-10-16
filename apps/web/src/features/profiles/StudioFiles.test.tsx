import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StudioFiles } from "./StudioFiles";
import { defaultConfig } from "./config";
import type { Config } from "../../shared/api/models";
Object.defineProperty(Range.prototype, "getClientRects", { value: () => [] });
Object.defineProperty(Range.prototype, "getBoundingClientRect", {
  value: () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    width: 0,
    height: 0,
  }),
});
afterEach(cleanup);
function Workspace() {
  const [config, setConfig] = useState<Config>({
    ...defaultConfig("cowrie"),
    decoy_files: [
      { path: "/opt/decoy/first.txt", content: "first" },
      { path: "/opt/decoy/second.txt", content: "second" },
    ],
  });
  return (
    <StudioFiles
      config={config}
      patch={(patch) => setConfig((c) => ({ ...c, ...patch }) as Config)}
      errors={{}}
      endGroup={() => {}}
    />
  );
}
describe("file editor context", () => {
  it("restores the caret inside the selected document", async () => {
    render(<Workspace />);
    const user = userEvent.setup();
    let editor = screen.getByLabelText("Содержимое файла");
    await user.click(editor);
    await user.keyboard("{Control>}{End}{/Control}{ArrowLeft}{ArrowLeft}");
    await user.click(screen.getByRole("button", { name: "second.txt" }));
    await user.click(screen.getByRole("button", { name: "first.txt" }));
    editor = screen.getByLabelText("Содержимое файла");
    editor.focus();
    await user.keyboard("!");
    await waitFor(() => expect(editor.textContent).toBe("fir!st"));
  });
  it("preserves file-specific undo across switching without overwriting another file", async () => {
    render(<Workspace />);
    const user = userEvent.setup();
    let editor = screen.getByLabelText("Содержимое файла");
    await user.click(editor);
    await user.keyboard("{Control>}{End}{/Control} X");
    await waitFor(() => expect(editor.textContent).toBe("first X"));
    await user.click(screen.getByRole("button", { name: "second.txt" }));
    editor = screen.getByLabelText("Содержимое файла");
    expect(editor.textContent).toBe("second");
    await user.click(editor);
    await user.keyboard("{Control>}{End}{/Control} Y");
    await waitFor(() => expect(editor.textContent).toBe("second Y"));
    await user.click(screen.getByRole("button", { name: "first.txt" }));
    editor = screen.getByLabelText("Содержимое файла");
    expect(editor.textContent).toBe("first X");
    await user.click(editor);
    await user.keyboard("{Control>}z{/Control}");
    await waitFor(() => expect(editor.textContent).toBe("first"));
    await user.click(screen.getByRole("button", { name: "second.txt" }));
    expect(screen.getByLabelText("Содержимое файла").textContent).toBe(
      "second Y",
    );
  });
});
