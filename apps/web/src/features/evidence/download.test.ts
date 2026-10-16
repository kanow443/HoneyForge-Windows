import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { api, ApiError } from "../../shared/api/client";
import { verifiedArtifactBytes } from "./download";
import { artifact } from "./evidence.fixtures";
afterEach(() => vi.unstubAllGlobals());
describe("binary evidence integrity", () => {
  it("accepts actual bytes only when size, response header and SHA-256 match", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const bytes = new TextEncoder().encode("abc").buffer;
    vi.spyOn(api, "artifactBytes").mockResolvedValue({
      bytes,
      sha256: artifact.sha256,
    });
    expect(await verifiedArtifactBytes(artifact)).toBe(bytes);
  });
  it("refuses altered bytes even when the header claims the expected hash", async () => {
    vi.stubGlobal("crypto", webcrypto);
    vi.spyOn(api, "artifactBytes").mockResolvedValue({
      bytes: new TextEncoder().encode("abd").buffer,
      sha256: artifact.sha256,
    });
    await expect(verifiedArtifactBytes(artifact)).rejects.toThrow(
      "SHA-256 полученного файла не совпадает",
    );
  });
  it("rejects partial downloads and absent or inconsistent server checksum headers", async () => {
    const request = vi.spyOn(api, "artifactBytes");
    request.mockResolvedValue({
      bytes: new TextEncoder().encode("ab").buffer,
      sha256: artifact.sha256,
    });
    await expect(verifiedArtifactBytes(artifact)).rejects.toThrow(
      "Размер полученного файла не совпадает",
    );
    request.mockResolvedValue({
      bytes: new TextEncoder().encode("abc").buffer,
      sha256: null,
    });
    await expect(verifiedArtifactBytes(artifact)).rejects.toThrow(
      "Контрольная сумма ответа не совпадает",
    );
  });
  it("never requests bytes for receiving or expired artifacts, and preserves permission failures", async () => {
    const request = vi.spyOn(api, "artifactBytes");
    for (const state of ["receiving", "expired"] as const)
      await expect(
        verifiedArtifactBytes({ ...artifact, state }),
      ).rejects.toThrow("пока недоступно");
    expect(request).not.toHaveBeenCalled();
    request.mockRejectedValue(new ApiError(403, "forbidden", "No permission"));
    await expect(verifiedArtifactBytes(artifact)).rejects.toMatchObject({
      status: 403,
    });
  });
});
