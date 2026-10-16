import type { components } from "./generated";
export type BundleConfig = components["schemas"]["BundleProfile"];
export type ProfileConfig = components["schemas"]["VersionView"]["config"];
export type ProfileVersion = components["schemas"]["VersionView"];
export type Profile = components["schemas"]["ProfileView"];
export type Host = Omit<components["schemas"]["HostView"], "metrics"> & {
  metrics: {
    cpu_percent?: number;
    memory_percent?: number;
    queued_events?: number;
    dropped_events?: number;
    parser_errors?: number;
    network_policy?: string;
  };
};
export type Deployment = components["schemas"]["DeploymentView"];
export type DeploymentGroup = components["schemas"]["DeploymentGroupView"];
export type Event = components["schemas"]["EventView"] & {
  flags?: EventFlag[];
};
export type EventFlag = {
  id: string;
  created_at: string;
  event_id: string;
  flag: "suspicious" | "reviewed" | "false_positive" | "escalated";
  note: string;
  created_by: string;
};
export type FlagChallenge = {
  id: string;
  created_at: string;
  title: string;
  points: number;
  enabled: boolean;
  active: boolean;
  solved: boolean;
  binding_id?: string | null;
};
export type FlagScore = { username: string; points: number; solves: number };
export type EventPage = components["schemas"]["EventPage"];
export type Config =
  | components["schemas"]["HttpProfile"]
  | components["schemas"]["SshProfile"]
  | ConfigV2;
export type ConfigV2 =
  | components["schemas"]["HttpProfileV2"]
  | components["schemas"]["SshProfileV2"]
  | components["schemas"]["TcpBannerProfile"];
export type User = Omit<components["schemas"]["UserView"], "role"> & {
  role: "admin" | "operator" | "analyst" | "viewer" | "participant";
};
export type Finding = components["schemas"]["FindingView"] & {
  deployment_name?: string;
};
export type Session = components["schemas"]["SessionView"];
export type SessionDetail = components["schemas"]["SessionDetail"];
export type Overview = Omit<components["schemas"]["OverviewView"], "hosts"> & {
  hosts: Host[];
};
export type Audit = components["schemas"]["AuditView"];
export type Filters = {
  host_id?: string;
  deployment_id?: string;
  event_type?: string;
  flag?: EventFlag["flag"];
  source_ip?: string;
  q?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
};
export type Job = {
  id: string;
  kind: string;
  status: string;
  attempt: number;
  lease_until: string | null;
  stages: { name: string; at: string }[];
  error: string | null;
  created_at: string;
};
export type PlaybackEvent = Event;
export type PlaybackPage = components["schemas"]["PlaybackPage"];
export type PlaybackHistory = {
  items: PlaybackEvent[];
  total: number;
  cursor: number;
  watermark: number;
};
export type Topology = Omit<components["schemas"]["TopologyView"], "hosts"> & {
  hosts: Host[];
};
export type SourceBlock = components["schemas"]["SourceBlockView"];
export type InvestigationCase = components["schemas"]["CaseView"];
export type SessionReport = components["schemas"]["SessionReport"];
export type Artifact = components["schemas"]["ArtifactView"];
export type IntegrationToken = components["schemas"]["IntegrationTokenView"];
