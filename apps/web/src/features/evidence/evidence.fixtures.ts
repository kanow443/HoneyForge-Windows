import type { Artifact } from "../../shared/api/models";
export const artifact: Artifact = {
  id: "00000000-0000-4000-8000-000000000001",
  deployment_id: "trap",
  host_id: "host",
  generation: "generation",
  source_session_id: null,
  kind: "file",
  state: "available",
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  size_bytes: 3,
  received_bytes: 3,
  created_at: "2026-10-10T16:00:00Z",
  started_at: "2026-10-10T15:59:00Z",
  ended_at: "2026-10-10T16:00:00Z",
  expires_at: "2099-10-10T16:00:00Z",
  details: { malware_verdict: "not_scanned" },
};
