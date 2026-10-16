import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { expect } from "@playwright/test";
import {
  launch,
  login,
  logout,
  api,
  baseURL,
  writeProof,
  measureViewport,
  screenshot,
} from "./common.mjs";
const browser = await launch(),
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
const csrf = await login(context),
  page = await context.newPage();
const runID = Date.now().toString(36),
  checks = [],
  viewports = [],
  createdProfiles = [],
  keys = [];
let tempCase = null,
  tempUser = null,
  currentStep = "";
async function check(name, fn) {
  currentStep = name;
  await fn();
  checks.push({ name, passed: true, at: new Date().toISOString() });
  console.log("PASS " + name);
}
async function open(route) {
  await page.goto(baseURL + route, { waitUntil: "domcontentloaded" });
}
async function mobile(route, name) {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(route);
  await page.locator("h1").waitFor();
  await page
    .locator(".loading")
    .waitFor({ state: "hidden" })
    .catch(() => {});
  viewports.push(await measureViewport(page, name));
  await screenshot(page, name + ".png");
  await page.setViewportSize({ width: 1280, height: 900 });
}
try {
  await check(
    "real Low profile publication, metadata, archive and restore",
    async () => {
      await open("/profiles/new");
      await page
        .getByLabel("Протокол", { exact: true })
        .selectOption("tcp-banner");
      await expect(
        page.getByLabel("Баннер TCP", { exact: true }),
      ).toBeVisible();
      await page
        .getByLabel("Название профиля", { exact: true })
        .fill("UI acceptance " + runID);
      await page
        .getByLabel("Баннер TCP", { exact: true })
        .fill("LabService acceptance");
      await page
        .getByLabel("Ответ на TCP-запрос", { exact: true })
        .fill("Protocol mismatch.");
      await expect(
        page.getByRole("button", { name: "Файлы", exact: true }),
      ).toBeDisabled();
      viewports.push(await measureViewport(page, "Low desktop"));
      await screenshot(page, "44-low-desktop.png");
      await page
        .getByRole("button", { name: "Проверить и опубликовать", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page
        .getByRole("button", { name: "Опубликовать версию", exact: true })
        .click();
      await page.waitForURL(/\/profiles\/[a-f0-9-]+\?published=1/);
      const id = new URL(page.url()).pathname.split("/").at(-1);
      createdProfiles.push(id);
      const profile = await api(context, "/profiles/" + id);
      assert.equal(profile.status, 200);
      assert.equal(profile.data.versions[0].config.schema_version, 2);
      assert.equal(profile.data.interaction_level, "low");
      await page
        .getByRole("button", { name: "Изменить сведения", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("Название профиля", { exact: true })
        .fill("UI renamed " + runID);
      await dialog
        .getByRole("button", { name: "Изменить сведения", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "UI renamed " + runID, exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "В архив", exact: true }).click();
      await page
        .getByRole("button", { name: "Архивировать профиль", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Восстановить", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Создать новую версию", exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("button", { name: "Восстановить", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Восстановить профиль", exact: true })
        .click();
      await expect(
        page.getByRole("link", { name: "Создать новую версию", exact: true }),
      ).toBeVisible();
      await mobile("/profiles/" + id, "45-profile-mobile");
    },
  );
  await check(
    "SSH file editor, preview linkage, undo and expanded workspace",
    async () => {
      await open("/profiles/new?adapter=cowrie");
      await page.getByLabel("Протокол", { exact: true }).selectOption("cowrie");
      await page
        .getByLabel("Образ сервиса", { exact: true })
        .selectOption("bastion");
      await page.getByRole("button", { name: "Файлы", exact: true }).click();
      const editor = page.getByLabel("Содержимое файла", { exact: true });
      await expect(editor).toBeVisible({ timeout: 30000 });
      await editor.fill("UI editor acceptance " + runID);
      await page.getByRole("button", { name: /^cat / }).click();
      await expect(page.locator(".studio-terminal-output")).toContainText(
        "UI editor acceptance " + runID,
      );
      await page
        .getByRole("button", { name: "Развернуть редактор", exact: true })
        .click();
      await expect(page.locator(".studio-workspace")).toHaveClass(
        /focus-editor/,
      );
      await page
        .getByRole("button", { name: "Свернуть редактор", exact: true })
        .click();
      await expect(editor).toContainText("UI editor acceptance " + runID);
      await screenshot(page, "46-editor-desktop.png");
      await page.setViewportSize({ width: 390, height: 844 });
      viewports.push(await measureViewport(page, "SSH editor mobile"));
      await screenshot(page, "47-editor-mobile.png");
      await page.setViewportSize({ width: 1280, height: 900 });
    },
  );
  const events = [];
  for (const [deployment, id] of [
    [
      "2d963710-3dfd-4146-85a6-a2eda461a276",
      "acc07cc0-571d-42c0-a934-9573117e0dc7",
    ],
    [
      "2b5c1cc6-3652-41bb-8b05-bce3b64b9a03",
      "2a683405-8f89-449b-8980-c06383b9abcc",
    ],
  ]) {
    const result = await api(
      context,
      "/events?deployment_id=" + deployment + "&limit=200",
    );
    assert.equal(result.status, 200);
    const event = result.data.items.find((e) => e.id === id);
    assert(event);
    events.push(event);
  }
  for (const event of events)
    await check(
      "private capture confirmation and cleanup " + event.event_type,
      async () => {
        await open(
          "/events?deployment_id=" + event.deployment_id + "&event=" + event.id,
        );
        await page
          .getByRole("button", { name: "Закрытые данные события", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Раскрыть данные", exact: true }),
        ).toBeDisabled();
        await screenshot(
          page,
          event.event_type.startsWith("http")
            ? "48-private-confirmation-http.png"
            : "49-private-confirmation-ssh.png",
        );
        await page
          .getByRole("checkbox", {
            name: "Подтверждаю раскрытие закрытых данных",
            exact: true,
          })
          .check();
        await page
          .getByRole("button", { name: "Раскрыть данные", exact: true })
          .click();
        await expect(
          page.getByLabel("Введённый пароль", { exact: true }),
        ).toHaveAttribute("type", "password");
        assert.equal(
          await page.evaluate(() => {
            const secret = document.querySelector(
              'input[type="password"]',
            )?.value;
            return (
              Boolean(secret) &&
              ![
                ...Object.values(localStorage),
                ...Object.values(sessionStorage),
              ].some((value) => value.includes(secret))
            );
          }),
          true,
        );
        await page
          .getByRole("button", { name: "Закрыть и очистить", exact: true })
          .click();
        await expect(
          page.getByLabel("Введённый пароль", { exact: true }),
        ).toHaveCount(0);
      },
    );
  await check(
    "actual case pin revision and unpin review preserve unsaved notes",
    async () => {
      const result = await api(
        context,
        "/cases",
        {
          title: "UI acceptance " + runID,
          session_ids: events.map((e) => e.session_id),
          note: "Temporary browser acceptance",
        },
        csrf,
      );
      assert.equal(result.status, 201);
      tempCase = result.data;
      await open("/cases?case=" + tempCase.id);
      const note = page.getByLabel("Заметка оператора", { exact: true });
      await note.fill("Unsaved browser note");
      await page
        .getByRole("button", { name: "Закрепить доказательства", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Снять закрепление", exact: true }),
      ).toBeVisible();
      await expect(note).toHaveValue("Unsaved browser note");
      await page
        .getByRole("button", { name: "Снять закрепление", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Снять закрепление", exact: true })
        .click();
      await expect(
        page.getByRole("button", {
          name: "Закрепить доказательства",
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByLabel("Состояние дела", { exact: true })
        .selectOption("closed");
      await page
        .getByRole("button", { name: "Сохранить изменения", exact: true })
        .click();
      await expect(
        page.getByText("Изменения сохранены", { exact: true }),
      ).toBeVisible();
      await mobile("/cases?case=" + tempCase.id, "50-case-mobile");
    },
  );
  await check("storage actual capacity at 1280 and 390", async () => {
    await open("/storage");
    await expect(
      page.getByText("События", { exact: true }).last(),
    ).toBeVisible();
    await page.getByText("7 дней", { exact: true }).waitFor();
    viewports.push(await measureViewport(page, "storage desktop"));
    await mobile("/storage", "51-storage-mobile");
  });
  await check(
    "one-time read-only integration key and real revocation",
    async () => {
      await open("/integrations");
      await page
        .getByRole("button", { name: "Создать ключ", exact: true })
        .click();
      await expect(
        page.getByLabel("Срок действия, дней", { exact: false }),
      ).toHaveValue("30");
      await expect(page.getByRole("checkbox")).not.toBeChecked();
      const name = "UI read-only " + runID;
      await page.getByLabel("Название", { exact: true }).fill(name);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Создать ключ", exact: true })
        .click();
      await expect(
        page.getByLabel("Ключ доступа", { exact: true }),
      ).toHaveAttribute("type", "password");
      const tokens = await api(context, "/integration-tokens");
      const token = tokens.data.find((t) => t.name === name);
      assert(token && !token.allow_response);
      keys.push(token.id);
      await page
        .getByRole("button", { name: "Закрыть и очистить", exact: true })
        .click();
      await expect(
        page.getByLabel("Ключ доступа", { exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("button", { name: "Отозвать ключ " + name, exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Отозвать ключ", exact: true })
        .click();
      await expect(
        page.getByRole("button", {
          name: "Отозвать ключ " + name,
          exact: true,
        }),
      ).toBeDisabled();
      await mobile("/integrations", "52-integrations-mobile");
    },
  );
  await check("real viewer analyst operator permissions", async () => {
    const creds = {
      username: "ui.accept." + runID,
      password: randomBytes(24).toString("base64url"),
    };
    const created = await api(
      context,
      "/users",
      { ...creds, role: "viewer" },
      csrf,
    );
    assert.equal(created.status, 201);
    tempUser = created.data;
    for (const role of ["viewer", "analyst", "operator"]) {
      if (role !== "viewer") {
        const changed = await api(
          context,
          "/users/" + tempUser.id + "/role",
          { role },
          csrf,
        );
        assert.equal(changed.status, 200);
      }
      const c = await browser.newContext({
          viewport: { width: 1280, height: 900 },
        }),
        token = await login(c, creds),
        p = await c.newPage();
      try {
        await p.goto(baseURL + "/integrations");
        await expect(
          p.getByRole("heading", { name: "Действие недоступно", exact: true }),
        ).toBeVisible();
        await p.goto(baseURL + "/profiles/new");
        if (role === "operator")
          await expect(
            p.getByRole("heading", {
              name: "Конструктор ловушек",
              exact: true,
            }),
          ).toBeVisible();
        else
          await expect(
            p.getByRole("heading", {
              name: "Действие недоступно",
              exact: true,
            }),
          ).toBeVisible();
        await p.goto(baseURL + "/cases?case=" + tempCase.id);
        const pin = p.getByRole("button", {
          name: "Закрепить доказательства",
          exact: true,
        });
        if (role === "viewer") await expect(pin).toBeDisabled();
        else await expect(pin).toBeEnabled();
        await p.goto(
          baseURL +
            "/events?deployment_id=" +
            events[0].deployment_id +
            "&event=" +
            events[0].id,
        );
        if (role === "viewer") {
          await expect(
            p.getByRole("button", {
              name: "Закрытые данные события",
              exact: true,
            }),
          ).toHaveCount(0);
          const deny = await api(
            c,
            "/events/" + events[0].id + "/private-capture",
            {},
            token,
          );
          assert.equal(deny.status, 403);
        } else
          await expect(
            p.getByRole("button", {
              name: "Закрытые данные события",
              exact: true,
            }),
          ).toBeVisible();
        await p.setViewportSize({ width: 390, height: 844 });
        viewports.push(await measureViewport(p, role + " events mobile"));
      } finally {
        await logout(c, token);
        await c.close();
      }
    }
  });
} catch (error) {
  checks.push({
    name: currentStep,
    passed: false,
    error: String(error).split("\n")[0],
    source: String(error.stack)
      .match(/at .*acceptance\.mjs:\d+:\d+/g)
      ?.at(-1),
    locator: String(error.message)
      .split("\n")
      .find((line) => line.trim().startsWith("Locator:")),
  });
  console.error("Browser acceptance stopped; see proof file.");
  process.exitCode = 1;
} finally {
  for (const id of keys)
    await api(context, "/integration-tokens/" + id + "/revoke", {}, csrf);
  for (const id of createdProfiles)
    await api(context, "/profiles/" + id + "/delete", {}, csrf);
  if (tempCase) {
    const all = await api(context, "/cases");
    const item = all.data.find((c) => c.id === tempCase.id);
    if (item) {
      let current = item;
      if (item.retention_pinned)
        current = (
          await api(
            context,
            "/cases/" + item.id + "/retention",
            { revision: item.revision, pinned: false },
            csrf,
          )
        ).data;
      await api(
        context,
        "/cases/" + item.id,
        { revision: current.revision, status: "closed", note: current.note },
        csrf,
      );
    }
  }
  if (tempUser)
    await api(
      context,
      "/users/" + tempUser.id + "/role",
      { role: "viewer" },
      csrf,
    );
  await writeProof("browser-acceptance.json", {
    run_id: runID,
    at: new Date().toISOString(),
    real_browser: true,
    checks,
    viewports,
    private_values_recorded: false,
    cleanup: {
      profile_ids: createdProfiles,
      key_ids: keys,
      case_id: tempCase?.id,
      user_id: tempUser?.id,
      user_final_role: tempUser ? "viewer" : null,
      temporary_user_password:
        "random in-memory only, discarded; all own logins logged out",
    },
    passed: checks.every((c) => c.passed),
  });
  await logout(context, csrf);
  await context.close();
  await browser.close();
}
