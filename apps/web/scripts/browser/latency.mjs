import fs from "node:fs/promises";
import path from "node:path";
import {
  launch,
  login,
  logout,
  repo,
  baseURL,
  writeProof,
  measureViewport,
} from "./common.mjs";
const runID = process.env.HF_LATENCY_RUN_ID || "d3b528422479";
const deployment =
  process.env.HF_LATENCY_DEPLOYMENT || "d79dcb0e-47de-4040-a952-7b17b7ed8b42";
const duration = Number(process.env.HF_LATENCY_DURATION_SECONDS || 1200);
const prefix = "/acceptance-latency/" + runID + "/";
if (
  !/^[a-zA-Z0-9-]{1,64}$/.test(runID) ||
  !Number.isFinite(duration) ||
  duration <= 0
)
  throw new Error("Invalid observation run ID or duration");
let stopRequested = false;
process.on("SIGUSR2", () => {
  stopRequested = true;
});
async function writeReady(value) {
  const destination = path.join(repo, ".runtime/frontend-browser-ready.json");
  await fs.writeFile(destination + ".tmp", JSON.stringify(value) + "\n");
  await fs.rename(destination + ".tmp", destination);
}
const browser = await launch(),
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
const csrf = await login(context),
  page = await context.newPage();
const records = new Map();
let apiErrors = 0,
  parseErrors = 0;
page.on("response", async (response) => {
  if (!response.url().includes("/api/v1/events?")) return;
  if (response.status() !== 200) {
    apiErrors++;
    return;
  }
  try {
    const body = await response.json();
    for (const event of body.items || []) {
      const value = event.payload?.path;
      if (typeof value === "string" && value.startsWith(prefix))
        records.set(value, {
          event_id: event.id,
          path: value,
          observed_at: event.observed_at,
          api_received_at: Date.now(),
        });
    }
  } catch {
    parseErrors++;
  }
});
await page.addInitScript(
  ({ prefix }) => {
    window.__firstDOMArrival = {};
    const inspect = () => {
      for (const row of document.querySelectorAll(".event-list tbody tr")) {
        const rect = row.getBoundingClientRect();
        if (
          !row.getClientRects().length ||
          rect.bottom <= 0 ||
          rect.top >= innerHeight ||
          rect.right <= 0 ||
          rect.left >= innerWidth ||
          document.visibilityState !== "visible"
        )
          continue;
        const text = row.textContent || "",
          start = text.indexOf(prefix);
        if (start < 0) continue;
        const suffix = text.slice(start + prefix.length).match(/^\d+/);
        if (!suffix) continue;
        const value = prefix + suffix[0];
        if (!window.__firstDOMArrival[value])
          window.__firstDOMArrival[value] = Date.now();
      }
    };
    new MutationObserver(inspect).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    document.addEventListener("DOMContentLoaded", inspect);
  },
  { prefix },
);
const params = new URLSearchParams({
  deployment_id: deployment,
  event_type: "http.request",
  q: prefix,
});
await page.goto(baseURL + "/events?" + params, {
  waitUntil: "domcontentloaded",
});
await page
  .getByRole("heading", { name: "Журнал событий", exact: true })
  .waitFor();
await page.getByText("Обновление включено", { exact: true }).waitFor();
const viewport = await measureViewport(page, "live event journal");
const startedAt = Date.now();
await writeReady({
  ready: true,
  run_id: runID,
  at: new Date(startedAt).toISOString(),
  viewport,
  browser: "isolated Playwright Chromium",
  page: "live real event journal",
  observer_pid: process.pid,
  finish_signal: "SIGUSR2",
  durable_checkpoint: true,
});
console.log(JSON.stringify({ ready: true, run_id: runID, viewport }));
let arrivals = {};
const deadline = startedAt + duration * 1000;
try {
  while (Date.now() < deadline && !stopRequested) {
    await new Promise((resolve) => setTimeout(resolve, 30000));
    const fresh = await page.evaluate(() => window.__firstDOMArrival);
    for (const [value, at] of Object.entries(fresh))
      arrivals[value] = Math.min(arrivals[value] ?? Infinity, at);
    const count = Object.keys(arrivals).length;
    const checkpoint = [...records.values()]
      .filter((e) => Date.parse(e.observed_at) >= startedAt && arrivals[e.path])
      .map((e) => ({
        ...e,
        dom_at: arrivals[e.path],
        dom_delay_ms: arrivals[e.path] - Date.parse(e.observed_at),
      }));
    const current = checkpoint.map((e) => e.dom_delay_ms).sort((a, b) => a - b);
    const progress = {
      run_id: runID,
      at: new Date().toISOString(),
      measurement: "viewport-intersecting rendered row DOM/layout, not paint",
      dom_paths: count,
      api_paths: records.size,
      samples_after_start: current.length,
      p95_ms: current.length
        ? current[Math.ceil(current.length * 0.95) - 1]
        : null,
      min_ms: current[0] ?? null,
      max_ms: current.at(-1) ?? null,
      negative_delays: current.filter((value) => value < 0).length,
      excluded_preexisting_api_paths: [...records.values()].filter(
        (event) => Date.parse(event.observed_at) < startedAt,
      ).length,
      apiErrors,
      parseErrors,
    };
    // Save paired timestamps before publishing progress, so process interruption
    // cannot discard the real per-event evidence already measured.
    await writeProof("latency-dom-checkpoint-" + runID + ".json", {
      run_id: runID,
      at: progress.at,
      state: "checkpoint_not_final",
      measurement: progress.measurement,
      samples: checkpoint,
      progress,
      eligible_api_events: [...records.values()].filter(
        (event) => Date.parse(event.observed_at) >= startedAt,
      ),
      unseen_paths: [...records.values()]
        .filter(
          (event) =>
            Date.parse(event.observed_at) >= startedAt && !arrivals[event.path],
        )
        .map((event) => event.path),
    });
    await writeProof("latency-progress-" + runID + ".json", progress);
    await writeProof("latency-progress.json", progress);
    console.log(
      JSON.stringify({
        run_id: runID,
        dom_paths: count,
        api_paths: records.size,
        remaining_seconds: Math.max(
          0,
          Math.round((deadline - Date.now()) / 1000),
        ),
      }),
    );
  }
  const fresh = await page.evaluate(() => window.__firstDOMArrival);
  for (const [value, at] of Object.entries(fresh))
    arrivals[value] = Math.min(arrivals[value] ?? Infinity, at);
  const eligible = [...records.values()].filter(
    (e) => Date.parse(e.observed_at) >= startedAt,
  );
  const samples = eligible
    .filter((e) => arrivals[e.path])
    .map((e) => ({
      ...e,
      dom_at: arrivals[e.path],
      dom_delay_ms: arrivals[e.path] - Date.parse(e.observed_at),
    }));
  const sorted = samples
    .map((e) => e.dom_delay_ms)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const p95 = sorted.length
    ? sorted[Math.ceil(sorted.length * 0.95) - 1]
    : null;
  const unseen = eligible
    .map((e) => e.path)
    .filter((value) => !arrivals[value]);
  const unpaired = Object.keys(arrivals).filter((value) => !records.has(value));
  const proof = {
    run_id: runID,
    browser: "isolated real Chromium",
    viewport,
    started_at: new Date(startedAt).toISOString(),
    ended_at: new Date().toISOString(),
    duration_seconds: (Date.now() - startedAt) / 1000,
    measurement:
      "first rendered table-row intersection with browser viewport DOM/layout Date.now minus corresponding real API observed_at; paint may add a frame; no API/SSE substitute",
    excluded_preexisting_api_paths: records.size - eligible.length,
    samples: samples.length,
    p95_ms: p95,
    min_ms: sorted[0] ?? null,
    max_ms: sorted.at(-1) ?? null,
    negative_delays: sorted.filter((x) => x < 0).length,
    api_errors: apiErrors,
    parse_errors: parseErrors,
    api_paths_not_rendered: unseen.length,
    dom_paths_without_api_pair: unpaired.length,
    unseen_paths: unseen,
    unpaired_paths: unpaired,
    passed:
      samples.length >= 100 &&
      p95 !== null &&
      p95 <= 2000 &&
      !sorted.some((x) => x < 0) &&
      !apiErrors &&
      !parseErrors,
  };
  await writeProof("latency-dom-results.json", proof);
  await writeProof("latency-dom-samples.json", samples);
  await writeProof("latency-dom-results-" + runID + ".json", proof);
  await writeProof("latency-dom-samples-" + runID + ".json", samples);
  console.log(JSON.stringify(proof));
} finally {
  const activeReady = JSON.parse(
    await fs.readFile(
      path.join(repo, ".runtime/frontend-browser-ready.json"),
      "utf8",
    ),
  );
  if (activeReady.run_id === runID)
    await writeReady({
      ready: false,
      run_id: runID,
      at: new Date().toISOString(),
      reason: "observation finished",
    });
  try {
    await logout(context, csrf);
  } finally {
    await context.close();
    await browser.close();
  }
}
