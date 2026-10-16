import { describe, expect, it } from "vitest";
import { eventLabel, eventNote, eventSummary } from "./presentation";
import { event } from "../sessions/playback.fixtures";
describe("reported client and file observations", () => {
  it("shows the claimed client version and negotiation fingerprint with explicit identity limits", () => {
    expect(
      eventSummary({
        ...event("version", 1),
        event_type: "ssh.client.version",
        payload: {
          version: "SSH-2.0-OpenSSH_9.0",
          observation: "client-claimed",
          identity: "unknown",
        },
      }),
    ).toBe("SSH-2.0-OpenSSH_9.0");
    expect(
      eventSummary({
        ...event("kex", 2),
        event_type: "ssh.client.kex",
        payload: {
          hassh: "fingerprint",
          algorithms: "curve25519-sha256",
          identity: "unknown",
        },
      }),
    ).toBe("fingerprint");
    expect(eventNote("ssh.client.version")).toContain("не подтверждает ОС");
    expect(eventNote("ssh.client.kex")).toContain("нельзя подтвердить ОС");
  });
  it("does not label sensor-reported file events as stored artifacts, and preserves destination-only uploads", () => {
    for (const kind of [
      "ssh.file.download",
      "ssh.file.upload",
      "ssh.file.download.failed",
    ] as const) {
      expect(eventNote(kind)).toMatch(
        /не подтверждает|не подтверждается|не свидетельство/,
      );
      expect(eventLabel(kind)).not.toContain("сохранён");
    }
    expect(
      eventSummary({
        ...event("upload", 3),
        event_type: "ssh.file.upload",
        payload: {
          url: "",
          destination: "/tmp/пример.txt",
          artifact_verified: false,
        },
      }),
    ).toBe("/tmp/пример.txt");
  });
  it("does not let an empty adapter command hide a recorded message, and safely keeps markup as plain text", () => {
    expect(
      eventSummary({
        ...event("connect", 1),
        event_type: "ssh.connect",
        payload: {
          command: "",
          destination: "172.23.0.2",
          message: "Connection observed",
        },
      }),
    ).toBe("Connection observed");
    expect(
      eventSummary({
        ...event("empty", 4),
        payload: { command: "", message: "Attempt reported" },
      }),
    ).toBe("Attempt reported");
    expect(
      eventSummary({
        ...event("file", 5),
        event_type: "ssh.file.download",
        payload: { url: "<img src=x onerror=alert(1)>" },
      }),
    ).toBe("<img src=x onerror=alert(1)>");
  });
});
