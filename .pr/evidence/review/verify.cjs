const { chromium } = require('../../../node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const mode = process.argv[2];
const backendPid = Number(process.argv[3]);
if (!['before', 'after'].includes(mode) || !Number.isSafeInteger(backendPid) || backendPid <= 0) throw new Error('Expected mode and isolated backend PID');
const files = ['src/hooks/use-skill-enablement.ts', 'src/hooks/mutation/use-save-settings.ts'];
const backups = files.map(f => fs.readFileSync(path.join(root, f)));
const evidence = path.join(root, '.pr/evidence/review');
fs.mkdirSync(evidence, { recursive: true });
let heldResponse;
let patches = 0;
// Forward to the actual backend. Only hold the first GET response after a PATCH.
// No settings or successful write responses are fabricated.
const proxy = http.createServer((req, res) => {
  if (req.url === '/api/settings') console.log('Proxy request:', req.method, req.url);
  const upstream = http.request({ hostname: '127.0.0.1', port: 18120, path: req.url, method: req.method, headers: req.headers, agent: false }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => {
      if (req.url === '/api/settings') console.log('Real response:', req.method, response.statusCode);
      const send = () => { res.writeHead(response.statusCode, response.headers); res.end(Buffer.concat(chunks)); };
      if (req.method === 'PATCH' && req.url === '/api/settings' && response.statusCode < 300) patches++;
      if (req.method === 'GET' && req.url === '/api/settings' && patches === 1 && !heldResponse) {
        res.writeHead(response.statusCode, { ...response.headers, connection: 'close' });
        res.flushHeaders();
        heldResponse = () => res.end(Buffer.concat(chunks));
      } else send();
    });
  });
  upstream.on('error', error => {
    console.log('Upstream unavailable:', req.method, req.url, error.code);
    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://127.0.0.1:31120', 'Access-Control-Allow-Credentials': 'true' });
    res.end(JSON.stringify({ detail: `Real backend unavailable: ${error.code}` }));
  });
  upstream.setTimeout(2000, () => upstream.destroy(Object.assign(new Error('Backend transport timed out'), { code: 'ETIMEDOUT' })));
  req.pipe(upstream);
});
(async () => {
  let browser, context;
  try {
    if (mode === 'before') files.forEach(f => fs.writeFileSync(path.join(root, f), cp.execFileSync('git', ['show', `f512f7c4bfb67023520754c7b8250fbad7daf6f5:${f}`], { cwd: root })));
    const seed = await fetch('http://127.0.0.1:18120/api/settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ misc_settings_diff: { app_preferences: { enabled_skills: ['add-skill', 'add-javadoc'], disabled_skills: [], user_consents_to_analytics: false } } }),
    });
    assert(seed.ok, 'Real settings seed failed');
    await new Promise(resolve => proxy.listen(18121, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: { dir: evidence, size: { width: 1440, height: 1000 } } });
    await context.addInitScript(() => {
      localStorage.setItem('openhands-onboarded', 'true');
      localStorage.setItem('openhands-backends', JSON.stringify([{ id: 'review-17941', name: 'Real server with delayed settings response', host: 'http://127.0.0.1:18121', apiKey: '', kind: 'local' }]));
      localStorage.setItem('openhands-active-backend', JSON.stringify({ backendId: 'review-17941' }));
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('request', req => { if (req.url().endsWith('/api/settings')) console.log('Browser request:', req.method()); });
    page.on('requestfailed', req => { if (req.url().endsWith('/api/settings')) console.log('Browser failed:', req.method(), req.failure()); });
    const video = page.video();
    await page.goto('http://127.0.0.1:31120/skills');
    const first = page.getByTestId('skill-toggle-add-skill');
    const second = page.getByTestId('skill-toggle-add-javadoc');
    await first.waitFor();
    await page.waitForTimeout(1200);
    assert.equal(await first.getAttribute('aria-checked'), 'true');
    assert.equal(await second.getAttribute('aria-checked'), 'true');
    await first.click();
    await page.mouse.move(5, 5);
    for (let i = 0; i < 100 && !heldResponse; i++) await page.waitForTimeout(100);
    assert(heldResponse, 'Post-success GET was not held');
    const persisted = await (await fetch('http://127.0.0.1:18120/api/settings')).json();
    const lists = persisted.misc_settings.app_preferences;
    assert(!lists.enabled_skills.includes('add-skill'));
    assert(lists.enabled_skills.includes('add-javadoc'));
    fs.writeFileSync(path.join(evidence, `${mode}-server-settings.json`), JSON.stringify({ enabled_skills: lists.enabled_skills, disabled_skills: lists.disabled_skills }, null, 2));
    console.log('Real PATCH succeeded; post-success GET held; A:', await first.getAttribute('aria-checked'));
    process.kill(backendPid);
    await second.click();
    await page.waitForTimeout(3000);
    console.log('Mutation diagnostics:', await page.evaluate(() => window.__OH_QUERY_CLIENT__?.getMutationCache().getAll().map(m => ({ status: m.state.status, error: m.state.error?.message, enabled: m.state.variables?.enabled_skills, disabled: m.state.variables?.disabled_skills }))));
    console.log('States after error:', await first.getAttribute('aria-checked'), await second.getAttribute('aria-checked'));
    await page.screenshot({ path: path.join(evidence, `${mode}-diagnostic.png`) });
    await page.mouse.move(5, 5);
    await page.waitForFunction(() => document.querySelector('[data-testid="skill-toggle-add-javadoc"]')?.getAttribute('aria-checked') === 'true', null, { timeout: 45000 });
    await page.waitForTimeout(500);
    const result = { mode, first: await first.getAttribute('aria-checked'), second: await second.getAttribute('aria-checked'), successfulPatches: patches, postSuccessGetHeld: true, backend: 'openhands-agent-server==1.50.1', model: 'None: settings-only interaction' };
    console.log(result);
    assert.equal(result.first, mode === 'before' ? 'true' : 'false');
    assert.equal(result.second, 'true');
    assert.equal(patches, 1);
    await page.screenshot({ path: path.join(evidence, `${mode}.png`) });
    fs.writeFileSync(path.join(evidence, `${mode}.json`), JSON.stringify(result, null, 2));
    await context.close(); context = null;
    await video.saveAs(path.join(evidence, `${mode}.webm`));
  } finally {
    if (heldResponse) heldResponse();
    if (context) await context.close();
    if (browser) await browser.close();
    proxy.closeAllConnections(); proxy.close();
    if (mode === 'before') files.forEach((f, i) => fs.writeFileSync(path.join(root, f), backups[i]));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
