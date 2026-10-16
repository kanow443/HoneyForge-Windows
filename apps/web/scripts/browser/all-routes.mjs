import path from 'node:path';
import { expect } from '@playwright/test';
import { launch, login, logout, api, baseURL, evidence, writeProof, measureViewport, screenshot } from './common.mjs';

// Read-only sweep. Each route gets a fresh page, so builder drafts stay isolated.
const browser = await launch();
const context = await browser.newContext();
const csrf = await login(context);
const checks = [];
let fixtures = null;
let fatal = null;
async function read(route) {
  const result = await api(context, route);
  expect(result.status).toBe(200);
  return result.data;
}
try {
  const profiles = await read('/profiles');
  const hosts = await read('/hosts');
  const deployments = await read('/deployments');
  const sessions = await read('/sessions');
  const cases = await read('/cases');
  const profile = profiles.find(p => !p.archived_at && p.adapter === 'cowrie' && p.versions.some(v => v.config.schema_version === 2));
  const trap = deployments.find(d => d.id === '9baa82d0-87fc-4e3b-bc5b-b5be5ca62d94');
  const session = sessions.find(s => s.id === '897e62d1-3f76-4bc2-b536-2912c48c1574') ?? sessions.find(s => s.protocol === 'ssh' && s.event_count > 0);
  const host = hosts[0];
  expect(profile && trap && session && host).toBeTruthy();
  fixtures = { profile_id: profile.id, deployment_id: trap.id, session_id: session.id, host_id: host.id, case_id: cases[0]?.id ?? null };
  const title = name => p => p.getByRole('heading', { name, exact: true });
  const flows = [
    { name: 'overview', route: '/', loaded: title('Сеть ловушек'), required: ['/overview', '/topology', '/findings'] },
    { name: 'overview-geo', route: '/', loaded: title('Сеть ловушек'), required: ['/geo-sources'], interact: async p => { await p.getByText('География источников', { exact: true }).click(); await p.locator('.geo-sources').scrollIntoViewIfNeeded(); } },
    { name: 'profiles', route: '/profiles', loaded: title('Профили ловушек'), required: ['/profiles'] },
    { name: 'profile-markers', route: '/profiles/' + profile.id, loaded: title(profile.name), required: ['/profiles/' + profile.id, '/honeytokens'], interact: async p => { await p.locator('summary').filter({ hasText: 'Маркеры-приманки' }).click(); await p.locator('.profile-markers').scrollIntoViewIfNeeded(); } },
    ...['tcp-banner', 'http', 'cowrie'].map(adapter => ({ name: 'builder-' + adapter, route: '/profiles/new?adapter=' + adapter, loaded: title('Конструктор ловушек'), required: [], interact: async p => { await expect(p.getByLabel('Протокол', { exact: true })).toHaveValue(adapter); if (adapter === 'tcp-banner') await expect(p.getByLabel('Баннер TCP', { exact: true })).toBeVisible(); } })),
    { name: 'builder-files', route: '/profiles/new?adapter=cowrie', loaded: title('Конструктор ловушек'), required: [], interact: async p => { await p.getByRole('button', { name: 'Файлы', exact: true }).click(); await expect(p.getByLabel('Содержимое файла', { exact: true })).toBeVisible(); } },
    { name: 'existing-editor', route: '/profiles/' + profile.id + '/edit', loaded: title('Конструктор ловушек'), required: ['/profiles/' + profile.id] },
    { name: 'hosts', route: '/hosts', loaded: title('Хосты'), required: ['/hosts'] },
    { name: 'host-certificates', route: '/hosts?host=' + host.id, loaded: title('Хосты'), required: ['/hosts', '/hosts/' + host.id + '/certificates'], interact: async p => { await p.getByText('Сертификаты агента', { exact: true }).click(); await p.locator('.host-certificates').scrollIntoViewIfNeeded(); } },
    { name: 'traps', route: '/traps', loaded: title('Развёртывания'), required: ['/deployments'] },
    { name: 'trap-detail', route: '/traps/' + trap.id, loaded: title(trap.name), required: ['/deployments/' + trap.id, '/sessions'] },
    { name: 'deploy-form', route: '/traps/new', loaded: title('Развёртывание ловушки'), required: ['/profiles', '/hosts'] },
    { name: 'events', route: '/events', loaded: title('Журнал событий'), required: ['/events'] },
    { name: 'event-inspector', route: '/events?deployment_id=' + trap.id, loaded: title('Журнал событий'), required: ['/events'], interact: async p => { await p.locator('.event-list tbody tr .event-open').first().waitFor(); await p.locator('.event-list tbody tr .event-open').first().click(); await p.locator('.event-detail').waitFor(); await p.locator('.event-detail').scrollIntoViewIfNeeded(); } },
    { name: 'detection-policy', route: '/events', loaded: title('Журнал событий'), required: ['/detection-policy'], interact: async p => { await p.getByText('Правило повторных входов', { exact: true }).click(); await p.getByRole('button', { name: 'Изменить правило', exact: true }).waitFor(); await p.locator('.analysis-settings').scrollIntoViewIfNeeded(); } },
    { name: 'session-player', route: '/sessions/' + session.id, loaded: p => p.getByRole('region', { name: 'Плеер сессии', exact: true }), required: ['/sessions/' + session.id, '/sessions/' + session.id + '/playback'] },
    { name: 'expanded-player', route: '/sessions/' + session.id, loaded: p => p.getByRole('region', { name: 'Плеер сессии', exact: true }), required: ['/sessions/' + session.id + '/playback'], interact: async p => { await p.getByRole('button', { name: 'Развернуть плеер', exact: true }).click(); await p.getByRole('button', { name: 'Свернуть плеер', exact: true }).waitFor(); } },
    { name: 'report', route: '/sessions/' + session.id + '/report', loaded: title('Отчёт расследования'), required: ['/sessions/' + session.id + '/report'] },
    { name: 'cases', route: '/cases' + (cases[0] ? '?case=' + cases[0].id : ''), loaded: title('Расследования'), required: ['/cases', '/sessions'] },
    { name: 'integrations', route: '/integrations', loaded: title('Интеграции'), required: ['/integration-tokens'] },
    { name: 'users', route: '/users', loaded: title('Пользователи'), required: ['/users'] },
    { name: 'storage', route: '/storage', loaded: title('Хранилище'), required: ['/storage'] },
    { name: 'audit', route: '/audit', loaded: title('Журнал оператора'), required: ['/audit'] },
  ];
  for (const width of [1280, 390]) {
    for (const flow of flows) {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const responses = [], pageErrors = [];
      page.on('pageerror', e => pageErrors.push(e.name));
      page.on('response', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/v1/') && !u.pathname.includes('/live')) responses.push({ path: u.pathname.slice(7), status: r.status() }); });
      const proof = { name: flow.name, width, route: flow.route, started_at: new Date().toISOString(), passed: false };
      try {
        await page.goto(baseURL + flow.route);
        await flow.loaded(page).waitFor({ timeout: 30000 });
        await flow.interact?.(page);
        await expect.poll(() => page.locator('.loading:visible').count(), { timeout: 30000 }).toBe(0);
        for (const required of flow.required) await expect.poll(() => responses.some(r => r.path === required && r.status === 200), { timeout: 30000, message: required + ' did not finish' }).toBe(true);
        await page.waitForTimeout(400);
        await expect(page.locator('.error-notice:visible')).toHaveCount(0);
        expect(pageErrors).toEqual([]);
        expect(responses.filter(r => r.status >= 400)).toEqual([]);
        proof.viewport = await measureViewport(page, flow.name + '-' + width);
        proof.screenshot = path.join(evidence, 'routes', flow.name + '-' + width + '.png');
        await screenshot(page, 'routes/' + flow.name + '-' + width + '.png');
        proof.passed = true;
      } catch (e) {
        proof.error = String(e).split('\n').slice(0, 3).join(' ');
        proof.headings = await page.locator('h1,h2').allTextContents().catch(() => []);
        await screenshot(page, 'routes/failed-' + flow.name + '-' + width + '.png').catch(() => {});
      } finally {
        proof.responses = responses; proof.page_errors = pageErrors; proof.ended_at = new Date().toISOString(); checks.push(proof);
        console.log(JSON.stringify({ name: flow.name, width, passed: proof.passed, error: proof.error }));
        await page.close();
        await writeProof('all-routes-browser.json', { at: new Date().toISOString(), baseURL, fixtures, checks, completed: false, passed: false, mutations: 'none except own auth login/logout; drafts isolated in own pages' });
      }
    }
    const anonymous = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
    const p = await anonymous.newPage();
    try {
      await p.goto(baseURL + '/login');
      await expect(p.getByRole('heading', { name: 'Вход в HoneyForge', exact: true })).toBeVisible();
      expect(await p.getByLabel('Пароль', { exact: true }).inputValue()).toBe('');
      const viewport = await measureViewport(p, 'login-' + width);
      await screenshot(p, 'routes/login-' + width + '.png');
      await p.goto(baseURL + '/users');
      await p.waitForURL('**/login');
      checks.push({ name: 'anonymous-login-and-protected-redirect', width, passed: true, viewport, empty_password: true });
    } finally { await anonymous.close(); }
  }
} catch (e) { fatal = String(e).split('\n')[0]; }
finally {
  await logout(context, csrf);
  await browser.close();
  const passed = !fatal && checks.length === 52 && checks.every(c => c.passed);
  await writeProof('all-routes-browser.json', { at: new Date().toISOString(), baseURL, fixtures, checks, completed: true, passed, fatal, expected_checks: 52, mutations: 'none except own auth login/logout; drafts isolated in own pages', role_matrix: 'independent actual viewer/analyst/operator coverage in bonus-browser-acceptance.json' });
  if (!passed) process.exitCode = 1;
}
