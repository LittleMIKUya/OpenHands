const { chromium } = require('../../node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname,'../..');
const mode = process.argv[2];
const serverPid = Number(process.argv[3]);
if (!['before','after'].includes(mode) || !Number.isSafeInteger(serverPid) || serverPid <= 0) throw new Error('Expected mode and server PID');
const files=['src/components/shared/buttons/circle-plus-check-toggle.tsx','src/hooks/use-skill-enablement.ts'];
const backups=files.map(f=>fs.readFileSync(path.join(root,f)));
const evidence=path.join(root,'.pr','evidence');
fs.mkdirSync(evidence,{recursive:true});
(async()=>{
  let browser,context;
  try {
    if(mode==='before') {
      files.forEach(f=>fs.writeFileSync(path.join(root,f),cp.execFileSync('git',['show',`8bb2293410c3488828a532b52691b7aaac10797d:${f}`],{cwd:root})));
      const tests=cp.spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--maxWorkers=2','__tests__/components/buttons/circle-plus-check-toggle.test.tsx','__tests__/hooks/use-skill-enablement.test.tsx'],{cwd:root,encoding:'utf8'});
      fs.writeFileSync(path.join(__dirname,'openhands-negative.log'),tests.stdout+tests.stderr);
      if(tests.status===0) throw new Error('Regression tests unexpectedly passed on base');
      console.log('Base regression suite exit:',tests.status);
    }
    const seed=await fetch('http://127.0.0.1:18120/api/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({misc_settings_diff:{app_preferences:{enabled_skills:['add-skill'],disabled_skills:[],user_consents_to_analytics:false}}})});
    if(!seed.ok) throw new Error(`Settings seed failed: ${seed.status}`);
    browser=await chromium.launch({channel:'msedge',headless:true});
    context=await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir:evidence,size:{width:1440,height:1000}}});
    await context.addInitScript(()=>{
      localStorage.setItem('openhands-onboarded','true');
      localStorage.setItem('openhands-backends',JSON.stringify([{id:'issue-17941',name:'Issue 17941 local server',host:'http://127.0.0.1:18120',apiKey:'',kind:'local'}]));
      localStorage.setItem('openhands-active-backend',JSON.stringify({backendId:'issue-17941'}));
    });
    const page=await context.newPage();
    const video=page.video();
    let patches=0;
    page.on('request',r=>{if(r.method()==='PATCH'&&r.url().endsWith('/api/settings'))patches++;});
    await page.goto('http://127.0.0.1:31120/skills');
    const enabled=page.getByTestId('skill-toggle-add-skill');
    await enabled.waitFor();
    await page.waitForTimeout(1500);
    patches=0;
    await page.mouse.move(5,5);
    await enabled.click();
    await page.mouse.move(5,5);
    await page.waitForTimeout(1200);
    const firstClick={checked:await enabled.getAttribute('aria-checked'),patches};
    console.log(mode,'first click:',firstClick);
    if(mode==='after'&&(firstClick.checked!=='false'||firstClick.patches!==1)) throw new Error('First click did not persist exactly once');
    await page.screenshot({path:path.join(evidence,`${mode}-first-click.png`)});
    if(mode==='after') {
      await page.reload();
      await enabled.waitFor();
      await page.waitForTimeout(500);
      if(await enabled.getAttribute('aria-checked')!=='false') throw new Error('Successful save did not persist across reload');
    }
    const disabled=page.getByTestId('skill-toggle-add-javadoc');
    if(await disabled.getAttribute('aria-checked')!=='false') throw new Error('Failure target is not disabled');
    process.kill(serverPid);
    await disabled.click();
    await page.mouse.move(5,5);
    await page.waitForTimeout(2200);
    const failedSave={checked:await disabled.getAttribute('aria-checked'),facets:(await page.locator('body').innerText()).split('STATE')[1]?.slice(0,80)};
    console.log(mode,'failed save:',failedSave);
    if(failedSave.checked!==(mode==='before'?'true':'false')) throw new Error('Unexpected failure-state result');
    await page.screenshot({path:path.join(evidence,`${mode}-failed-save.png`)});
    await context.close();context=null;
    await video.saveAs(path.join(evidence,`${mode}.webm`));
    fs.writeFileSync(path.join(evidence,`${mode}.json`),JSON.stringify({mode,firstClick,failedSave,backend:'openhands-agent-server 1.50.1',model:'No model execution: settings-only UI'},null,2));
  } finally {
    if(context) await context.close();
    if(browser) await browser.close();
    if(mode==='before') files.forEach((f,i)=>fs.writeFileSync(path.join(root,f),backups[i]));
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
