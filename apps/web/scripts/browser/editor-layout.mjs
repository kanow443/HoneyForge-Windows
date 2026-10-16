import { expect } from "@playwright/test";
import {
  launch,
  login,
  logout,
  baseURL,
  measureViewport,
  screenshot,
  writeProof,
} from "./common.mjs";
const browser = await launch(),
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  }),
  csrf = await login(context),
  page = await context.newPage();
try {
  await page.goto(baseURL + "/profiles/new?adapter=cowrie");
  await page
    .getByLabel("Образ сервиса", { exact: true })
    .selectOption("bastion");
  await page.getByRole("button", { name: "Файлы", exact: true }).click();
  await expect(
    page.getByLabel("Содержимое файла", { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  const editor = await page.locator(".studio-editor").boundingBox(),
    preview = await page.locator(".studio-preview").boundingBox();
  expect(editor.width).toBeGreaterThan(preview.width);
  const desktop = await measureViewport(page, "editor 1280");
  await screenshot(page, "53-editor-wide-final.png");
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await measureViewport(page, "editor 390");
  await screenshot(page, "54-editor-mobile-final.png");
  await writeProof("editor-layout.json", {
    at: new Date().toISOString(),
    real_browser: true,
    desktop,
    mobile,
    editor_width: editor.width,
    preview_width: preview.width,
    passed: true,
  });
} finally {
  await logout(context, csrf);
  await context.close();
  await browser.close();
}
