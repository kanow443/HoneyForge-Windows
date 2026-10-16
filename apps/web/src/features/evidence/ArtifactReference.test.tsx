import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { event } from "../sessions/playback.fixtures";
import { artifact } from "./evidence.fixtures";
import { ArtifactReference } from "./ArtifactReference";
afterEach(() => cleanup());
describe("file observation and artifact linkage", () => {
  it("links a sensor artifact ID to its session without treating the event as verified bytes", () => {
    render(
      <MemoryRouter>
        <ArtifactReference
          event={{
            ...event("file", 1),
            event_type: "ssh.file.upload",
            payload: {
              artifact_id: artifact.id,
              artifact_capture: "sensor-durable",
              artifact_verified: false,
            },
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      `/sessions/s?artifact=${artifact.id}`,
    );
    expect(screen.getByText(/Доступность содержимого указана/)).toBeTruthy();
    expect(screen.queryByText(/проверен сервером/)).toBeNull();
  });
  it("preserves unavailable capture and never follows malformed artifact paths", () => {
    render(
      <MemoryRouter>
        <ArtifactReference
          event={{
            ...event("file", 1),
            event_type: "ssh.file.download",
            payload: {
              artifact_id: "../../secret",
              artifact_capture: "unavailable",
            },
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/Доступно только событие/)).toBeTruthy();
  });
});
