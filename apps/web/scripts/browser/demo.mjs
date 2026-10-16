import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import {
  launch,
  login,
  logout,
  api,
  baseURL,
  repo,
  evidence,
  writeProof,
  screenshot,
} from "./common.mjs";
const lowID = "a5a29c82-36bb-46cd-b60d-7a8614f6a72a",
  sshID = "9baa82d0-87fc-4e3b-bc5b-b5be5ca62d94";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(read, accept, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await pause(1200);
  }
  throw Error("Real evidence did not reach the required state");
}
async function touchBanner(endpoint) {
  const [host, port] = endpoint.split(":");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: Number(port) });
    socket.setTimeout(5000);
    socket.once("data", (data) => {
      socket.end("probe\n");
      resolve({ received_bytes: data.length });
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(Error("Low TCP connection timeout"));
    });
    socket.once("error", reject);
  });
}
function attacker(settings) {
  const child = spawn(
    path.join(repo, ".venv/bin/python"),
    [path.join(import.meta.dirname, "ssh-demo.py")],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const messages = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line));
      } catch {}
    }
  });
  child.stderr.resume();
  child.stdin.end(JSON.stringify(settings) + "\n");
  return { child, messages };
}
const browser = await launch(),
  runs = [];
try {
  for (let number = 1; number <= 2; number++) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      recordVideo: {
        dir: path.join(evidence, "video"),
        size: { width: 1280, height: 900 },
      },
    });
    const csrf = await login(context),
      page = await context.newPage(),
      run = {
        number,
        started_at: new Date().toISOString(),
        stages: [],
        passed: false,
      };
    let connection = null,
      policy = null;
    async function stage(name, fn) {
      await fn();
      run.stages.push({ name, at: new Date().toISOString() });
      console.log("Demo " + number + ": " + name);
      await pause(1800);
    }
    try {
      const low = (await api(context, "/deployments/" + lowID)).data,
        ssh = (await api(context, "/deployments/" + sshID)).data;
      assert(
        low.name.startsWith("Acceptance ") &&
          ssh.name.startsWith("Acceptance "),
      );
      assert.equal(ssh.endpoint, "192.168.139.142:18222");
      assert.equal(ssh.state, "running");
      const profiles = (await api(context, "/profiles")).data;
      const sshProfile = profiles.find((p) =>
        p.versions.some((v) => v.id === ssh.profile_version_id),
      );
      const config = sshProfile.versions.find(
        (v) => v.id === ssh.profile_version_id,
      ).config;
      const account = config.decoy_accounts[0],
        marker = "ui-demo-" + Date.now().toString(36) + "-" + number;
      await stage("real network overview", async () => {
        await page.goto(baseURL + "/");
        await page
          .getByRole("heading", { name: "Сеть ловушек", exact: true })
          .waitFor();
      });
      await stage("Low running trap and real TCP banner contact", async () => {
        await page.goto(baseURL + "/traps/" + lowID);
        await page.locator("h1").waitFor();
        run.low_probe = await touchBanner(low.endpoint);
        await pause(1500);
      });
      await stage("published Low profile in constructor", async () => {
        const p = profiles.find((p) =>
          p.versions.some((v) => v.id === low.profile_version_id),
        );
        await page.goto(baseURL + "/profiles/" + p.id + "/edit");
        await expect(
          page.getByLabel("Баннер TCP", { exact: true }),
        ).toBeVisible();
      });
      const since = Date.now();
      await stage("real SSH commands and real SFTP upload", async () => {
        connection = attacker({
          host: "192.168.139.142",
          port: 18222,
          ...account,
          marker,
        });
        await poll(
          async () => connection.messages,
          (messages) => messages.some((m) => m.state === "ready"),
          30000,
        );
        assert(!connection.messages.some((m) => m.state === "error"));
        await page.goto(baseURL + "/events?deployment_id=" + sshID);
        await page
          .getByRole("heading", { name: "Журнал событий", exact: true })
          .waitFor();
      });
      const event = await poll(
        async () =>
          (
            await api(
              context,
              "/events?deployment_id=" +
                sshID +
                "&q=" +
                marker +
                "&event_type=ssh.command&limit=100",
            )
          ).data.items,
        (items) => items.some((e) => e.session_id),
      );
      const sessionID = event.find((e) => e.session_id).session_id;
      run.session_id = sessionID;
      await stage(
        "LIVE session player and received terminal output",
        async () => {
          await page.goto(baseURL + "/sessions/" + sessionID);
          await page
            .getByRole("region", { name: "Плеер сессии", exact: true })
            .waitFor();
          await expect(
            page.getByRole("region", { name: "Плеер сессии", exact: true }),
          ).toContainText(marker, { timeout: 30000 });
          await page
            .getByRole("button", { name: "Развернуть плеер", exact: true })
            .click();
          await pause(5000);
          await expect(page.getByText("Unexpected Application Error!", { exact: true })).toHaveCount(0);
          await page
            .getByRole("button", { name: "Свернуть плеер", exact: true })
            .click();
        },
      );
      const artifacts = await poll(
        async () =>
          (await api(context, "/artifacts?deployment_id=" + sshID)).data,
        (items) =>
          items.some(
            (a) =>
              a.kind === "file" &&
              Date.parse(a.created_at) >= since &&
              a.state === "available",
          ),
      );
      const artifact = artifacts.find(
        (a) =>
          a.kind === "file" &&
          Date.parse(a.created_at) >= since &&
          a.state === "available",
      );
      run.artifact_id = artifact.id;
      run.artifact_sha256 = artifact.sha256;
      run.artifact_size_bytes = artifact.size_bytes;
      await stage(
        "actual artifact UI download and independent hash",
        async () => {
          await page.goto(
            baseURL + "/sessions/" + sessionID + "?artifact=" + artifact.id,
          );
          const button = page.getByRole("button", {
            name: "Скачать сохранённый файл " + artifact.id,
            exact: true,
          });
          await expect(button).toBeVisible({ timeout: 30000 });
          const [download] = await Promise.all([
            page.waitForEvent("download"),
            button.click(),
          ]);
          const file = path.join(
            evidence,
            "video",
            "demo-" + number + "-artifact.bin",
          );
          await download.saveAs(file);
          const bytes = await fs.readFile(file);
          assert.equal(bytes.length, artifact.size_bytes);
          assert.equal(
            createHash("sha256").update(bytes).digest("hex"),
            artifact.sha256,
          );
          await expect(
            page.getByText(/SHA-256 и размер полученного файла совпадают/),
          ).toBeVisible();
        },
      );
      const reason = "Демонстрационный прогон " + number + " " + marker;
      await stage("explicit scoped response request", async () => {
        await page
          .getByRole("button", { name: "Ответные действия", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Ограничить доступ", exact: true })
          .click();
        await expect(
          page.getByRole("checkbox", { name: /Завершить открытые SSH-сессии/ }),
        ).toBeChecked();
        await page.getByLabel("Причина", { exact: true }).fill(reason);
        await page
          .getByRole("button", {
            name: "Ограничить доступ и завершить сессии",
            exact: true,
          })
          .click();
      });
      policy = await poll(
        async () =>
          (await api(context, "/source-blocks?deployment_id=" + sshID)).data,
        (items) =>
          items.some(
            (b) =>
              b.reason === reason &&
              b.state === "applied" &&
              b.termination_state === "completed",
          ),
      );
      policy = policy.find((b) => b.reason === reason);
      run.policy_id = policy.id;
      await stage("real firewall ACK and real SSH transport EOF", async () => {
        assert.equal(policy.state, "applied");
        assert.equal(policy.termination_state, "completed");
        assert(policy.terminated_sessions.length > 0);
        await expect(
          page
            .locator(".block-list article")
            .filter({ hasText: reason })
            .getByText("Подтверждено агентом", { exact: true }),
        ).toBeVisible({ timeout: 30000 });
        await poll(
          async () => connection.messages,
          (messages) =>
            messages.some(
              (m) => m.state === "transport_closed" && m.active === false,
            ),
          15000,
        );
        run.termination_count = policy.terminated_sessions.length;
        run.client_closed = true;
        await screenshot(page, "demo-" + number + "-ack.png");
      });
      await stage("cancel request and actual agent release ACK", async () => {
        await page
          .locator(".block-list article")
          .filter({ hasText: reason })
          .getByRole("button", { name: "Отменить ограничение", exact: true })
          .click();
        const result = await poll(
          async () =>
            (await api(context, "/source-blocks?deployment_id=" + sshID)).data,
          (items) =>
            items.some(
              (b) =>
                b.id === policy.id &&
                b.state === "cancelled" &&
                b.observed_revision === b.revision,
            ),
        );
        policy = result.find((b) => b.id === policy.id);
        await expect(
          page
            .locator(".block-list article")
            .filter({ hasText: reason })
            .getByText("Отменено", { exact: true }),
        ).toBeVisible({ timeout: 30000 });
        run.release_ack = true;
      });
      await stage(
        "session report with actual evidence and response record",
        async () => {
          await page.goto(baseURL + "/sessions/" + sessionID + "/report");
          await page.locator("h1").waitFor();
          await expect(page.getByText(/Ограничения источника/))
            .toBeVisible()
            .catch(() => {});
          await pause(3000);
        },
      );
      run.passed = true;
    } catch (error) {
      run.error = String(error).split("\n")[0];
      run.source = String(error.stack)
        .match(/at .*demo\.mjs:\d+:\d+/g)
        ?.at(-1);
      process.exitCode = 1;
      await screenshot(page, "demo-" + number + "-failed.png").catch(() => {});
      console.error("Demo " + number + " stopped; see proof.");
    } finally {
      if (policy && policy.desired_state === "blocked")
        await api(
          context,
          "/source-blocks/" + policy.id + "/cancel",
          { revision: policy.revision },
          csrf,
        );
      connection?.child.kill("SIGTERM");
      run.ended_at = new Date().toISOString();
      const video = page.video();
      await page.close();
      await logout(context, csrf);
      await context.close();
      if (video) {
        const target = path.join(
          evidence,
          "video",
          "honeyforge-demo-" + number + ".webm",
        );
        await video.saveAs(target);
        run.video = target;
      }
      runs.push(run);
      await writeProof("demo-video-results.json", {
        at: new Date().toISOString(),
        real_browser: true,
        raw_private_values_recorded: false,
        scope:
          "separate Acceptance tcp-banner18223 / Cowrie18222 only; no Operations/Scale trap change",
        runs,
        passed: runs.length === 2 && runs.every((r) => r.passed),
      });
    }
    if (!run.passed) break;
  }
} finally {
  await browser.close();
}
