import { describe, expect, it } from "vitest";
import type { Topology } from "../../shared/api/models";
import { filteredLinks } from "./Topology";
describe("topology linked filtering", () => {
  const data = {
    deployments: [
      { id: "one", host_id: "h1" },
      { id: "two", host_id: "h2" },
    ],
    links: [
      { source_ip: "a", deployment_id: "one" },
      { source_ip: "a", deployment_id: "two" },
      { source_ip: "b", deployment_id: "two" },
    ],
  } as Topology;
  it("filters the same observations by source, trap and host without IP attribution", () => {
    expect(filteredLinks(data, { type: "source", id: "a" })).toHaveLength(2);
    expect(filteredLinks(data, { type: "deployment", id: "two" })).toHaveLength(
      2,
    );
    expect(filteredLinks(data, { type: "host", id: "h1" })).toEqual([
      data.links[0],
    ]);
    expect(filteredLinks(data, null)).toHaveLength(3);
    expect(filteredLinks(data, { type: "host", id: "missing" })).toHaveLength(
      0,
    );
  });
});
