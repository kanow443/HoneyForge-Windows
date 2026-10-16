import type { PlaybackEvent } from "../../shared/api/models";
export const event = (
  id: string,
  seq: number,
  at = seq * 1000,
): PlaybackEvent => ({
  private_capture_available: false,
  id,
  event_id: `source-${id}`,
  host_id: "h",
  deployment_id: "d",
  deployment_name: "trap",
  profile_version_id: "v",
  session_id: "s",
  generation: "g",
  event_type: "ssh.command",
  source_ip: "203.0.113.1",
  source_seq: seq,
  observed_at: new Date(at).toISOString(),
  created_at: new Date(at + 100).toISOString(),
  payload: { command: id },
  provenance: "cowrie",
  ingest_position: seq,
});
