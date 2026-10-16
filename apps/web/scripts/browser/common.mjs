import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
export const repo = path.resolve(import.meta.dirname, "../../../..");
export const evidence = path.join(repo, "docs/evidence/frontend");
export const baseURL = process.env.HF_BROWSER_URL || "http://localhost:5173";
export async function credentials() {
  const env = {};
  for (const line of (await fs.readFile(path.join(repo, ".env"), "utf8")).split(
    /\r?\n/,
  )) {
    const index = line.indexOf("=");
    if (index < 1 || line.startsWith("#")) continue;
    env[line.slice(0, index).trim()] = line
      .slice(index + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
  }
  if (!env.HF_ADMIN_USERNAME || !env.HF_ADMIN_PASSWORD)
    throw Error("Private administrator credentials unavailable");
  return { username: env.HF_ADMIN_USERNAME, password: env.HF_ADMIN_PASSWORD };
}
export async function launch() {
  return chromium.launch({ headless: true });
}
export async function login(context, creds = undefined) {
  const response = await context.request.post(baseURL + "/api/v1/auth/login", {
    data: creds || (await credentials()),
  });
  if (response.status() !== 200)
    throw Error("Authentication failed: HTTP " + response.status());
  const auth = await response.json();
  return auth.csrf_token;
}
export async function api(context, route, body = undefined, csrf = undefined) {
  const response = await context.request.fetch(baseURL + "/api/v1" + route, {
    method: body === undefined ? "GET" : "POST",
    data: body,
    headers: csrf ? { "X-CSRF-Token": csrf } : undefined,
  });
  return { status: response.status(), data: await response.json() };
}
export async function logout(context, csrf) {
  return api(context, "/auth/logout", {}, csrf);
}
export async function writeProof(name, data) {
  await fs.mkdir(evidence, { recursive: true });
  const destination = path.join(evidence, name),
    temporary = destination + ".tmp";
  const handle = await fs.open(temporary, "w");
  try {
    await handle.writeFile(JSON.stringify(data, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, destination);
}
export async function measureViewport(page, label) {
  const result = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    documentWidth: document.documentElement.scrollWidth,
  }));
  if (result.documentWidth > result.width)
    throw Error(
      "Page overflow at " +
        label +
        ": " +
        result.documentWidth +
        " > " +
        result.width,
    );
  return { label, ...result };
}
export async function screenshot(page, name) {
  await page.screenshot({ path: path.join(evidence, name), fullPage: false });
}
