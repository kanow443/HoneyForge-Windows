import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { expect } from "@playwright/test";
import {
  launch,
  login,
  logout,
  api,
  baseURL,
  evidence,
  writeProof,
  measureViewport,
  screenshot,
} from "./common.mjs";
const browser = await launch(),
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
const csrf = await login(context),
  page = await context.newPage();
const checks = [],
  viewports = [],
  exports = [],
  keys = [];
const run = crypto.randomUUID().slice(0, 8);
let profile,
  user,
  error = null;
async function checked(name, work) {
  await work();
  checks.push({ name, passed: true, at: new Date().toISOString() });
  console.log(JSON.stringify({ check: name, passed: true }));
}
function success(response, status = 200) {
  expect(response.status).toBe(status);
  return response.data;
}
async function markers(p) {
  await p.goto(baseURL + "/profiles/" + profile.id);
  await p.getByText("Маркеры-приманки · v1", { exact: true }).click();
  await p
    .getByRole("button", { name: "Создать маркер", exact: true })
    .waitFor({ timeout: 30000 });
}
const sessionId = "897e62d1-3f76-4bc2-b536-2912c48c1574";
try {
  const profiles = success(await api(context, "/profiles"));
  const source = profiles.find(
    (value) =>
      value.adapter === "http" &&
      value.versions.some((version) => version.config.schema_version === 2),
  );
  expect(source).toBeTruthy();
  profile = success(
    await api(
      context,
      "/profiles",
      {
        name: "UI bonus " + run,
        description: "Disposable undeployed browser acceptance",
        config: source.versions.find(
          (version) => version.config.schema_version === 2,
        ).config,
      },
      csrf,
    ),
    201,
  );
  await checked(
    "actual UI URL marker issue/revoke and explicit redeploy review",
    async () => {
      await markers(page);
      await page
        .getByRole("button", { name: "Создать маркер", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("Название маркера", { exact: true })
        .fill("URL " + run);
      await expect(
        dialog.getByRole("button", { name: "Создать маркер", exact: true }),
      ).toBeDisabled();
      await dialog
        .getByLabel("Применю маркер отдельным развёртыванием этой версии", {
          exact: true,
        })
        .check();
      await dialog
        .getByRole("button", { name: "Создать маркер", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      await page.getByText("URL " + run, { exact: true }).waitFor();
      await page
        .getByText("Ожидает развёртывания", { exact: false })
        .first()
        .waitFor();
      const list = success(
        await api(context, "/honeytokens?profile_id=" + profile.id),
      );
      const token = list.find((value) => value.name === "URL " + run);
      expect(token.bindings).toHaveLength(0);
      keys.push(token.id);
      viewports.push(await measureViewport(page, "bonus markers1280"));
    await page.locator(".marker-row").first().scrollIntoViewIfNeeded();
      await screenshot(page, "55-markers-desktop.png");
      await page
        .getByRole("button", { name: "Отозвать маркер", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toContainText("может оставаться");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Отозвать маркер", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page
        .getByText("Уникальный URL · Отозван", { exact: true })
        .waitFor();
    },
  );
  await checked(
    "actual CSV/STIX UI downloads with independent parsing and observed-data semantics",
    async () => {
      await page.goto(baseURL + "/sessions/" + sessionId + "/report");
      await page
        .getByRole("button", { name: "IOC CSV / STIX", exact: true })
        .click();
      for (const format of ["stix", "csv"]) {
        await page
          .getByRole("dialog")
          .getByLabel("Формат экспорта", { exact: true })
          .selectOption(format);
        const downloadPromise = page.waitForEvent("download");
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Скачать наблюдения", exact: true })
          .click();
        const download = await downloadPromise,
          filename = path.join(
            evidence,
            "bonus-observed-ioc." + (format === "csv" ? "csv" : "json"),
          );
        await download.saveAs(filename);
        const content = await fs.readFile(filename, "utf8");
        if (format === "stix") {
          const parsed = JSON.parse(content);
          expect(parsed.type).toBe("bundle");
          expect(
            parsed.objects.some((value) => value.type === "observed-data"),
          ).toBe(true);
          expect(
            parsed.objects.some((value) => value.type === "indicator"),
          ).toBe(false);
          expect(
            parsed.objects
              .filter((value) => value.type === "observed-data")
              .every((value) => value.x_honeyforge_event_ids?.length > 0),
          ).toBe(true);
        } else
          expect(content.split(/\r?\n/)[0]).toContain(
            "event_ids,deployment_ids,generations,provenance",
          );
        expect(content).not.toContain('"password"');
        exports.push({
          format,
          filename,
          bytes: Buffer.byteLength(content),
          sha256: crypto.createHash("sha256").update(content).digest("hex"),
          parse_valid: true,
        });
        await page.getByRole("status").waitFor();
      }
      await page.setViewportSize({ width: 390, height: 844 });
      viewports.push(await measureViewport(page, "IOC modal390"));
      await screenshot(page, "56-observed-export-mobile.png");
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 1280, height: 900 });
    },
  );
  await checked(
    "actual detection review uses server policy without modifying live settings",
    async () => {
      await page.goto(baseURL + "/events");
      await page.getByText("Правило повторных входов", { exact: true }).click();
      await page
        .getByRole("button", { name: "Изменить правило", exact: true })
        .click();
      const value = success(await api(context, "/detection-policy"));
      expect(
        await page
          .getByRole("dialog")
          .getByLabel("Количество неудачных входов", { exact: true })
          .inputValue(),
      ).toBe(String(value.failed_logins));
      expect(
        await page
          .getByRole("dialog")
          .getByLabel("Фиксированное окно, секунд", { exact: true })
          .inputValue(),
      ).toBe(String(value.window_seconds));
      await page.setViewportSize({ width: 390, height: 844 });
      viewports.push(await measureViewport(page, "policy modal390"));
      await screenshot(page, "57-policy-mobile.png");
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 1280, height: 900 });
    },
  );
  await checked(
    "actual Geo/ASN unavailable states and source counts at390",
    async () => {
      await page.goto(baseURL + "/");
      await page.getByText("География источников", { exact: true }).click();
      const value = success(await api(context, "/geo-sources"));
      expect(value.time_basis).toBe("observed_at");
      for (const source of value.sources.filter(
        (source) => source.reason === "private_or_reserved_address",
      ))
        await expect(page.locator(".geo-sources")).toContainText(
          source.source_ip,
        );
      await expect(page.locator(".geo-sources")).toContainText(
        "не определяют личность",
      );
      await page.setViewportSize({ width: 390, height: 844 });
      viewports.push(await measureViewport(page, "geo390"));
    await page.locator(".geo-sources").scrollIntoViewIfNeeded();
      await screenshot(page, "58-geo-mobile.png");
      await page.setViewportSize({ width: 1280, height: 900 });
    },
  );
  const hosts = success(await api(context, "/hosts")),
    host = hosts[0];
  await checked(
    "actual admin certificate list/review only; no live certificate revoked",
    async () => {
      await page.goto(baseURL + "/hosts?host=" + host.id);
      await page.getByText("Сертификаты агента", { exact: true }).click();
      const values = success(
        await api(context, "/hosts/" + host.id + "/certificates"),
      );
      await expect(page.locator(".host-certificates")).toContainText(
        "не доказывает",
      );
      for (const certificate of values)
        await expect(page.locator(".host-certificates")).toContainText(
          certificate.fingerprint,
        );
      const button = page
        .getByRole("button", { name: "Отозвать сертификат", exact: true })
        .first();
      if (values.some((certificate) => certificate.state !== "revoked")) {
        await button.click();
        await expect(page.getByRole("dialog")).toContainText(
          "есть другой действующий сертификат",
        );
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Отмена", exact: true })
          .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      viewports.push(await measureViewport(page, "certificates390"));
    await page.locator(".host-certificates").scrollIntoViewIfNeeded();
      await screenshot(page, "59-certificates-mobile.png");
      await page.setViewportSize({ width: 1280, height: 900 });
    },
  );
  await checked(
    "real viewer analyst operator API and UI permission boundaries",
    async () => {
      const creds = {
        username: "ui-bonus-" + run,
        password: "B-" + crypto.randomBytes(18).toString("hex"),
      };
      user = success(
        await api(context, "/users", { ...creds, role: "viewer" }, csrf),
        201,
      );
      for (const role of ["viewer", "analyst", "operator"]) {
        if (role !== "viewer")
          success(
            await api(context, "/users/" + user.id + "/role", { role }, csrf),
          );
        const c = await browser.newContext({
            viewport: { width: 390, height: 844 },
          }),
          token = await login(c, creds),
          p = await c.newPage();
        try {
          expect(
            (await api(c, "/honeytokens?profile_id=" + profile.id)).status,
          ).toBe(200);
          expect(
            (await api(c, "/hosts/" + host.id + "/certificates")).status,
          ).toBe(403);
          if (role !== "operator") {
            expect(
              (
                await api(
                  c,
                  "/honeytokens",
                  {
                    profile_version_id: profile.versions[0].id,
                    name: "Denied",
                    kind: "url",
                  },
                  token,
                )
              ).status,
            ).toBe(403);
            expect(
              (await api(c, "/honeytokens/" + keys[0] + "/revoke", {}, token))
                .status,
            ).toBe(403);
            const value = success(await api(c, "/detection-policy"));
            expect(
              (
                await api(
                  c,
                  "/detection-policy",
                  {
                    revision: value.revision,
                    failed_logins: value.failed_logins,
                    window_seconds: value.window_seconds,
                    enabled: value.enabled,
                  },
                  token,
                )
              ).status,
            ).toBe(403);
          } else {
            const issued = success(
              await api(
                c,
                "/honeytokens",
                {
                  profile_version_id: profile.versions[0].id,
                  name: "Operator " + run,
                  kind: "file",
                  file_path: "/opt/decoy/role-" + run + ".txt",
                },
                token,
              ),
              201,
            );
            keys.push(issued.id);
            success(
              await api(c, "/honeytokens/" + issued.id + "/revoke", {}, token),
            );
          }
          expect(
            (
              await api(
                c,
                "/ioc-exports",
                { session_id: sessionId, format: "csv" },
                token,
              )
            ).status,
          ).toBe(role === "viewer" ? 403 : 200);
          await markers(p);
          if (role === "operator")
            await expect(
              p.getByRole("button", { name: "Создать маркер", exact: true }),
            ).toBeEnabled();
          else
            await expect(
              p.getByRole("button", { name: "Создать маркер", exact: true }),
            ).toBeDisabled();
          await p.goto(baseURL + "/events");
          await p
            .getByText("Правило повторных входов", { exact: true })
            .click();
          const button = p.getByRole("button", {
            name: "Изменить правило",
            exact: true,
          });
          if (role === "operator") await expect(button).toBeEnabled();
          else await expect(button).toBeDisabled();
          viewports.push(await measureViewport(p, role + " bonus390"));
        } finally {
          await logout(c, token);
          await c.close();
        }
      }
    },
  );
} catch (value) {
  error = String(value);
  console.log(JSON.stringify({ passed: false, error }));
} finally {
  for (const id of keys)
    await api(context, "/honeytokens/" + id + "/revoke", {}, csrf);
  let profileDeleted = false;
  if (profile) {
    const result = await api(
      context,
      "/profiles/" + profile.id + "/delete",
      {},
      csrf,
    );
    profileDeleted = result.status === 200;
    if (!profileDeleted)
      await api(context, "/profiles/" + profile.id + "/archive", {}, csrf);
  }
  if (user)
    await api(context, "/users/" + user.id + "/role", { role: "viewer" }, csrf);
  await writeProof("bonus-browser-acceptance.json", {
    at: new Date().toISOString(),
    run,
    checks,
    viewports,
    exports,
    passed: !error && checks.length === 6,
    error,
    scope:
      "own undeployed profile only; no Foundation runtime or live certificate change; policy review only",
    cleanup: {
      profile_id: profile?.id,
      profile_deleted: profileDeleted,
      own_marker_ids_revoked: keys,
      user_id: user?.id,
      user_final_role: user ? "viewer" : null,
    },
    private_values_recorded: false,
  });
  await logout(context, csrf);
  await browser.close();
}
if (error) process.exitCode = 1;
