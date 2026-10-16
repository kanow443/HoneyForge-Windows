# High file markers and proxy-resource clarification

Updated 2026-10-11T00:14:56.843898+00:00. Frontend sources/build ready; actual marker API/browser run PASS. Root owns package/gateway rebuild using this latest dist, which supersedes the older frontend dist manifest. No backend/infra/docs-guide edits, no commit, no sensor mutation.

## Behavior

- Single schema-v2 High was already eligible for file tokens; actual file-only issue remains available with no service key. URL stays HTTP-only.
- Schema-v3 bundles now expose supported service selection in the published profile's markers block. HTTP/Cowrie/High selectable; Low excluded. Issuance includes selected `service_key`; the list filters both immutable profile version and selected service. Switching HTTP to High resets URL choice to file. A failed issue preserves draft/selection. Limit8 remains shared across the whole version, not per service.
- High resource controls/reviews/published profile/deployments distinguish SSH-proxy/container limits from guest RAM/vCPU/session limits, which are operator-managed on the sensor. Frontend does not offer invented guest-control fields. Existing API types already contain service_key; no contract regeneration needed.

## Verification

- Targeted5-file suite:34tests PASS. New coverage: single High file-only request, exact v3 selected-service request and filtered list, HTTP-URL reset/Low exclusion, shared eight-token ceiling and conflict draft preservation. Existing Bonus/Builder/Groups/Profiles checks pass. TypeScript and production build PASS; main entry497.94kB/gzip155.52kB, editor remains lazy.
- Real browser run `8fee4ef7`: own disposable single High and v3 bundle profiles, three real tokens (single High file, bundle HTTP URL, bundle High file). Actual API IDs/type/service_key and empty bindings verified. Eight viewport checks at390/1280 cover markers and resource controls for both profile types, all without document overflow; rendered screenshots visually inspected. No guest VM started or restarted; markers remain explicitly pending deployment.
- All three own tokens revoked and both undeployed profiles archived. Only own auth context logged out. Initial helper selector ambiguity was a harness error; its cleanup is preserved in high-markers-first-harness-error.json. Final run passes.

Evidence: high-markers-browser.json; high-markers-tests.txt; high-markers-build.txt; high-markers-ready.json; high-markers-dist-manifest.json (42files, digest `9fb5c4d49372b6b70a982d8cfb39e1b1dade7cbd9785ceee6cc366a3d9f85654`); high-markers-single/bundle/single-resources/bundle-resources screenshots each at1280/390.

Earlier group/Geo/VM results are separate evidence; do not relabel earlier browser runs as performed against this new build. Backend high-real-os proof is owned by root and not asserted by this frontend run.
