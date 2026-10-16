import { describe, expect, it } from "vitest";
import { canonicalReport, verifyReport } from "./checksum";
import { webcrypto, createHash } from "node:crypto";
describe("report integrity", () => {
  it("preserves API float tokens, sorts Unicode keys and excludes only the root checksum", () => {
    expect(
      canonicalReport(
        '{"sha256":"omit","nested":{"sha256":"keep","cpu":1.0},"a":"Привет","😀":true,"\uffff":null}',
      ),
    ).toBe(
      '{"a":"Привет","nested":{"cpu":1.0,"sha256":"keep"},"\uffff":null,"😀":true}',
    );
  });
  it("verifies actual response bytes and rejects changed evidence", async () => {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      configurable: true,
    });
    const canonical =
      '{"events":[{"command":"hostname"}],"limits":{"cpu":1.0}}';
    const hash = createHash("sha256").update(canonical).digest("hex");
    const raw =
      '{ "limits": {"cpu":1.0}, "sha256":"' +
      hash +
      '", "events":[{"command":"hostname"}] }';
    expect((await verifyReport(raw, hash)).valid).toBe(true);
    expect(
      (await verifyReport(raw.replace("hostname", "whoami"), hash)).valid,
    ).toBe(false);
  });
  it("rejects incomplete or trailing JSON", () => {
    expect(() => canonicalReport('{"events":[')).toThrow();
    expect(() => canonicalReport("{} garbage")).toThrow();
  });
});
