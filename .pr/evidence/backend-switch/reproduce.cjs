const { chromium } = require('./oh17970/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const http = require('node:http');
const assert = require('node:assert/strict');
const mode = process.argv[2];
if (!['before','after'].includes(mode)) throw new Error('Usage: node work/oh17970-live.cjs before|after');
const root = path.join(__dirname, mode === 'before' ? 'oh17970-before' : 'oh17970');
const out = path.join(__dirname, '..', 'outputs', 'oh17970-backend-switch', mode);
fs.mkdirSync(out, {recursive:true});
const children = [];
const logs = [];
const proxies = [];
let heldA, heldB, didHoldB = false, releasedA = false;
const wait = ms => new Promise(r=>setTimeout(r,ms));
async function until(fn, timeout=60000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await fn())return;await wait(100);}
  throw new Error('Timed out waiting for condition');
}
function launch(exe,args,env={},name='process'){
  const fd=fs.openSync(path.join(out,name+'.log'),'w'); logs.push(fd);
  const child=cp.spawn(exe,args,{cwd:root,env:{...process.env,...env},stdio:['ignore',fd,fd],windowsHide:true});
  children.push(child); return child;
}
function proxy(port,target,isA){
 const server=http.createServer((req,res)=>{
  const up=http.request({host:'127.0.0.1',port:target,path:req.url,method:req.method,headers:req.headers}, response=>{
   const chunks=[]; response.on('data',c=>chunks.push(c)); response.on('end',()=>{
    const send=()=>{if(!res.destroyed){res.writeHead(response.statusCode,response.headers);res.end(Buffer.concat(chunks));}};
    if(isA && req.method==='PATCH' && req.url==='/api/settings' && response.statusCode===200 && !heldA) {
      heldA=send; console.log('A committed; holding real PATCH response');
    } else if(!isA && req.method==='GET' && req.url==='/api/settings' && releasedA && !didHoldB){
      didHoldB=true; heldB=send; console.log('Holding B real refetch response');
    } else send();
   });
  });
  up.on('error',()=>{res.writeHead(502,{'Content-Type':'application/json','Access-Control-Allow-Origin':'http://127.0.0.1:31630'});res.end(JSON.stringify({detail:'Isolated backend stopped for verification'}));});
  req.pipe(up);
 });
 proxies.push(server);return new Promise(r=>server.listen(port,'127.0.0.1',r));
}
(async()=>{
 let browser,context;
 try{
  for(const [name,port] of [['A',18130],['B',18131]]) {
    const persistence=path.join(out,'private-state-'+name);
    launch(path.join(__dirname,'oh17970-python','Scripts','python.exe'),
      ['-m','openhands.agent_server','--host','127.0.0.1','--port',String(port)],
      {OH_PERSISTENCE_DIR:persistence,OH_TELEMETRY_CONSENT:'false',OPENHANDS_SUPPRESS_BANNER:'1'},'backend-'+name);
  }
  await until(async()=>{try{return (await fetch('http://127.0.0.1:18130/server_info')).ok && (await fetch('http://127.0.0.1:18131/server_info')).ok;}catch{return false;}});
  const names=['add-skill','add-javadoc'];
  for(const [port,enabled] of [[18130,[names[0]]],[18131,names]]) {
    const res=await fetch('http://127.0.0.1:'+port+'/api/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({misc_settings_diff:{app_preferences:{enabled_skills:enabled,disabled_skills:[],user_consents_to_analytics:false}}})});
    assert(res.ok,'Seeding real settings failed');
  }
  await proxy(18132,18130,true);await proxy(18133,18131,false);
  launch(process.execPath,['scripts/static-server.mjs','--port','31630','--dir','build','--route','/api=http://127.0.0.1:18130','--route','/server_info=http://127.0.0.1:18130'],{},'frontend');
  await until(async()=>{try{return(await fetch('http://127.0.0.1:31630')).ok;}catch{return false;}});
  browser=await chromium.launch({channel:'msedge',headless:true});
  context=await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir:out,size:{width:1440,height:1000}}});
  await context.addInitScript(()=>{
   localStorage.setItem('openhands-onboarded','true');
   localStorage.setItem('openhands-backends',JSON.stringify([
    {id:'race-A',name:'Race A',host:'http://127.0.0.1:18132',apiKey:'',kind:'local'},
    {id:'race-B',name:'Race B',host:'http://127.0.0.1:18133',apiKey:'',kind:'local'},
   ]));
   localStorage.setItem('openhands-active-backend',JSON.stringify({backendId:'race-A'}));
  });
  const page=await context.newPage();const video=page.video();page.setDefaultTimeout(20000);
  await page.route(/posthog|z\.openhands\.dev/,route=>route.abort());
  await page.goto('http://127.0.0.1:31630/skills');
  const first=page.getByTestId('skill-toggle-add-skill'), second=page.getByTestId('skill-toggle-add-javadoc');
  await first.waitFor();await until(async()=>await first.getAttribute('aria-checked')==='true');
  await first.click();await until(()=>!!heldA);
  await page.getByTestId('backend-selector').getByRole('combobox').click();
  await page.getByTestId('backend-selector').getByRole('combobox').press('ArrowDown');
  fs.writeFileSync(path.join(out,'switch-dom.txt'),await page.locator('body').innerText());
  await page.screenshot({path:path.join(out,'switch.png')});
  await page.getByTestId('backend-selector').getByText('Race B',{exact:true}).click();
  await until(async()=>await first.getAttribute('aria-checked')==='true' && await second.getAttribute('aria-checked')==='true');
  await wait(1500);
  releasedA=true;heldA();await until(()=>!!heldB);
  const stateA=await(await fetch('http://127.0.0.1:18130/api/settings')).json();
  const stateB=await(await fetch('http://127.0.0.1:18131/api/settings')).json();
  assert.deepEqual(stateA.misc_settings.app_preferences.enabled_skills,[]);
  assert.deepEqual(stateB.misc_settings.app_preferences.enabled_skills,names);
  children[1].kill();await wait(700);
  await first.click();
  // This toast is emitted by useSkillEnablement only after terminal mutation failure.
  await page.getByText(/Isolated backend stopped for verification/).first().waitFor({timeout:60000});
  await page.mouse.move(620,150);
  await wait(1000);
  const observed={mode,changed:await first.getAttribute('aria-checked'),untouched:await second.getAttribute('aria-checked'),backend:'openhands-agent-server==1.53.0',model:'none',heldActualResponses:['A PATCH success','B GET settings'],terminalFailureToast:true};
  console.log(JSON.stringify(observed));
  assert.equal(observed.changed,mode==='before'?'false':'true');
  assert.equal(observed.untouched,mode==='before'?'false':'true');
  await page.screenshot({path:path.join(out,'result.png')});
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(observed,null,2));
  await context.close();context=null;await video.saveAs(path.join(out,'recording.webm'));
 }finally{
  if(heldB)heldB();if(heldA)heldA();
  if(context)await context.close();if(browser)await browser.close();
  for(const proxy of proxies){proxy.closeAllConnections();proxy.close();}
  for(const child of children){if(child.exitCode===null)child.kill();}
  for(const fd of logs)fs.closeSync(fd);
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
