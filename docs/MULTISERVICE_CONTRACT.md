# Multi-service contract (schema v3)

A profile may use `adapter: "bundle", schema_version: 3`, `hostname`, `persona`, and `services` (2–8 entries). Each entry has a unique `key` matching `[a-z][a-z0-9-]{0,23}`, a unique `port` (1024–65535), and `config` containing an existing **schema v2** http/cowrie/tcp-banner profile. Root hostname/persona override the corresponding service settings in runtime. v1/v2 remain supported and immutable.

Example: `{"schema_version":3,"adapter":"bundle","hostname":"files-stage-02","persona":"Asset Operations","services":[{"key":"web","port":18080,"config":{"schema_version":2,"adapter":"http"}},{"key":"ssh","port":2222,"config":{"schema_version":2,"adapter":"cowrie"}}]}`.

- POST `/api/v1/deployment-groups` (admin/operator, CSRF and Idempotency-Key): `{name, host_id, profile_version_id, ports?: {serviceKey: port}}`.
- GET `/api/v1/deployment-groups` and `/{id}`: authenticated read.
- POST `/{id}/stop` and `/{id}/redeploy` (body `{profile_version_id?: uuid}`): admin/operator.
- Group view: `{id,created_at,name,host_id,profile_version_id,state,services: DeploymentView[]}`. States: running/stopped/error/unknown/mixed/requested; running only after every service confirms running.
- Existing DeploymentView gains nullable `group_id` and `service_key`; individual services remain visible in deployments, sessions, topology and evidence.
- Request creation/reservations/jobs are one transaction: conflict on any port/capability reserves nothing. Runtime application is asynchronous per service; partial failures are visible. Group stop/redeploy enqueue all jobs in one transaction.
- Group redeploy requires the same service keys/adapters; ports stay as deployed. Changed topology needs a new group. Individual redeploy of a group child is rejected; individual stop remains available as emergency control.
- `/api/v1/deployments` remains the single-service contract; passing a bundle version gives a domain error pointing to groups.

Frontend work: extend types and normal profile builder with add/remove/reorder service cards; service-specific v2 form; one coherent hostname/persona; show aggregate memory and port conflicts; publish/re-edit v3; deploy bundle via groups endpoint with all service ports; show group states and stop/redeploy controls; retain single-service workflows. Geo pages must link to https://db-ip.com when showing DB-IP results. High availability must come from host capabilities; no fabricated availability or fake metrics.
