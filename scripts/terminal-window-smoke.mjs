// Windows development smoke: actual Tauri webviews + isolated loopback Telnet.
// Start Vite on 127.0.0.1:3017 and build with scripts/terminal-smoke.tauri.json.
// APPDATA alone does not isolate Tauri's Windows Known Folder paths.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(import.meta.dirname, "..");
const binary = process.env.NETRIX_TERMINAL_SMOKE_BINARY || path.join(root, "backend-rs", "target", "terminal-window-shell", "debug", "netrix.exe");
assert.ok((await readFile(binary)).includes(Buffer.from("com.netrix.terminal-smoke")), "Refusing to launch an ordinary app profile. Build with TAURI_CONFIG from scripts/terminal-smoke.tauri.json first.");
const monitorLayout=JSON.parse((await promisify(execFile)("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",path.join(root,"scripts","terminal-monitor-layout.ps1")],{windowsHide:true})).stdout.trim());
const targetMonitor=monitorLayout.find(m=>m.primary)??monitorLayout[0];
const sourceMonitor=monitorLayout.find(m=>m!==targetMonitor);
const realMouse=process.env.NETRIX_TERMINAL_SMOKE_REAL_MOUSE==="1";
const isolated = await mkdtemp(path.join(os.tmpdir(), "netrix-terminal-windows-"));
const artifacts = path.join(root, "backend-rs", "target", "terminal-window-smoke");
await mkdir(artifacts, { recursive: true });
const reservation = net.createServer();
reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
const debugPort = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
let connections = 0;
let input = "";
const remoteSockets = new Set();
const remote = net.createServer((socket) => {
  connections++; remoteSockets.add(socket);
  socket.on("close", () => remoteSockets.delete(socket));
  socket.on("error", () => {});
  socket.on("data", (bytes) => { input += bytes.toString(); socket.write(bytes); });
  socket.write("\x1b[2J\x1b[H\x1b[36mNETRIX / SESSION CONTINUITY\x1b[0m\r\n");
  for (let i = 0; i < 60; i++) socket.write(`\x1b[32mrow-${String(i).padStart(3, "0")}\x1b[0m  live terminal checkpoint\r\n`);
  socket.write("\r\n\x1b[36mrouter-test\x1b[0m $ ");
});
remote.listen(0, "127.0.0.1"); await once(remote, "listening");
const remotePort = remote.address().port;
const app = spawn(binary, [], {
  cwd: root, windowsHide: true, stdio: "ignore",
  env: { ...process.env, APPDATA: path.join(isolated, "roaming"), LOCALAPPDATA: path.join(isolated, "local"),
    WEBVIEW2_USER_DATA_FOLDER: path.join(isolated, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1`,
  },
});
const clients = new Set();
async function targets() {
  return fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
}
async function until(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (caught) { error = caught; }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}${error ? ` (${error.message})` : ""}`);
}
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, "open");
  const pending = new Map(); let nextId = 0;
  socket.addEventListener("close", () => { for (const callback of pending.values()) callback.reject(new Error("Webview closed")); pending.clear(); });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const callback = pending.get(message.id); pending.delete(message.id);
    if (message.error) callback?.reject(new Error(message.error.message)); else callback?.resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    if(socket.readyState!==WebSocket.OPEN){reject(new Error("Webview closed"));return;}
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 8_000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (body) => {
    const result = await command("Runtime.evaluate", { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const click = async (selector) => {
    await evaluate(`const element=document.querySelector(${JSON.stringify(selector)}); if(!element || element.disabled) throw Error('Missing or disabled control'); element.click();`);
  };
  const screenshot = async (name) => {
    const result = await command("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(artifacts, `${name}.png`), Buffer.from(result.data, "base64"));
  };
  const client = { target, evaluate, command, click, screenshot, close: () => socket.close() };
  clients.add(client); return client;
}
// Vite may cache-bust app modules after HMR. Reuse the URL actually imported
// by the running app, otherwise a debug import could create a second store.
const store = "const importActual=(p)=>{const urls=[...new Set(performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname===p).map(e=>e.name))];if(urls.length>1)throw Error('Multiple Vite module generations: restart Vite after source edits before running the smoke');return import(urls[0]??p);}; const {useAppStore}=await importActual('/src/state/store.ts'); const state=useAppStore.getState();";
const terminalState = `${store} const id=state.activeTabId; const term=state.terminalInstances[id]; return {id,sid:state.sessionIds[id],status:state.tabStatuses[id],tabs:state.terminalTabs.length,transfers:Object.keys(state.terminalTransfers).length,buffer:term?.buffer.active.type,rows:term ? Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i)?.translateToString(true)).join('\\n') : ''};`;
async function checkPointerObserver(client) {
  assert.equal(await client.evaluate(`
    const invoke=window.__TAURI_INTERNALS__.invoke;
    const cancelled=crypto.randomUUID();
    await invoke('cancel_terminal_drag',{gestureId:cancelled});
    if(await invoke('wait_terminal_drag_release',{gestureId:cancelled})!==null)throw Error('Cancelled native observer revived');
    const {cursorPosition}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');
    const before=await cursorPosition();
    const gestureId=crypto.randomUUID();
    const timeout=setTimeout(()=>{void invoke('cancel_terminal_drag',{gestureId});},100);
    try {
      const result=await invoke('wait_terminal_drag_release',{gestureId});
      const after=await cursorPosition();
      if(result?.released&&before.x===after.x&&before.y===after.y&&(result.point.x!==after.x||result.point.y!==after.y))throw Error('Native/UI cursor coordinates disagree across DPI contexts');
      return result===null||(typeof result.released==='boolean'&&Number.isInteger(result.point.x)&&Number.isInteger(result.point.y));
    } finally {clearTimeout(timeout);}
  `), true, "native release/cancel IPC must work in each terminal capability");
}
async function placeAcrossMonitors(main,source) {
  if(!sourceMonitor)return;
  const label=await source.evaluate("const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');return getCurrentWindow().label;");
  await main.evaluate(`const {getCurrentWindow,getAllWindows,PhysicalPosition}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');const main=getCurrentWindow();if(await main.isMaximized())await main.toggleMaximize();await main.setPosition(new PhysicalPosition(${targetMonitor.x+32},${targetMonitor.y+32}));await main.toggleMaximize();const source=(await getAllWindows()).find(w=>w.label===${JSON.stringify(label)});if(!source)throw Error('Missing source window');await source.setPosition(new PhysicalPosition(${sourceMonitor.x+32},${sourceMonitor.y+32}));`);
  await source.evaluate("await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));");
  await main.evaluate("await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));");
  await checkPointerObserver(source);
  const scales=[await source.evaluate("return devicePixelRatio;"),await main.evaluate("return devicePixelRatio;")];
  console.log(`Cross-monitor title drag: source scale ${scales[0]}, destination scale ${scales[1]}`);
}
async function waitForRealMouseDrop(stage,main,source,expectedTabs) {
  await placeAcrossMonitors(main,source);
  await main.evaluate("const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().setFocus();");
  await source.evaluate("const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().setFocus();");
  const target=await main.evaluate("const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');const origin=await getCurrentWindow().innerPosition(),neighbor=document.querySelector('[data-terminal-tab-id=\"smoke-after\"]'),r=(neighbor??document.querySelector('[data-terminal-tabs-dropzone]')).getBoundingClientRect();return {label:getCurrentWindow().label,x:Math.round(origin.x+(r.x+(neighbor?10:80))*devicePixelRatio),y:Math.round(origin.y+(r.y+r.height/2)*devicePixelRatio)};");
  const from=await source.evaluate("const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');const origin=await getCurrentWindow().innerPosition();return {label:getCurrentWindow().label,x:origin.x,y:origin.y,width:innerWidth,height:innerHeight,scale:devicePixelRatio};");
  await writeFile(path.join(artifacts,"real-mouse-ready.json"),JSON.stringify({stage,pid:app.pid,debugPort,createdAt:new Date().toISOString(),source:from,target,expectedTabs}));
  console.log(`Waiting for real mouse title drag: ${stage}`);
  await until(()=>main.evaluate(`${store}return state.terminalTabs.length===${expectedTabs}&&!Object.keys(state.terminalTransfers).length;`),`real mouse ${stage} return`,240_000);
}
let main;
try {
  const target = await until(async () => (await targets()).find((item) => item.type === "page" && item.url.startsWith("http://127.0.0.1:3017")), "main webview");
  main = await connect(target);
  await until(() => main.evaluate(`${store} return document.querySelector('[data-workspace-ready="true"]') && document.body.textContent.includes('Hosts');`), "main shell");
  await until(() => main.evaluate(`${store} return state.vaultStatusLoaded && !state.hostsLoading && Boolean(document.querySelector('[data-workspace-ready="true"]'));`), "bootstrap");
  assert.equal(await main.evaluate(`${store} return state.hosts.filter(h=>h.name!=='Window continuity test'||h.hostname!=='127.0.0.1'||h.username!=='test').length;`), 0, "Refusing to change an unexpected profile.");
  await main.evaluate(`${store} const {getApiBase,fetchJsonOrThrow}=await importActual('/src/api.ts'); for(const tab of state.terminalTabs) state.removeTerminalTab(tab.id); for(const host of state.hosts)await fetchJsonOrThrow((await getApiBase())+'/hosts/'+host.id,{method:'DELETE'});`);
  await main.evaluate(`localStorage.setItem('netrix.help.intro.completed.v2','true'); document.querySelector('button[aria-label="Close guide"]')?.click(); ${store}
    const {getApiBase,fetchJsonOrThrow}=await importActual('/src/api.ts');
    const host=await fetchJsonOrThrow((await getApiBase())+'/hosts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Window continuity test',hostname:'127.0.0.1',port:${remotePort},connection_type:'telnet',username:'test'})});
    window.__smokeHostId=host.id;window.__smokeHost=host; state.addTerminalTab(host); state.setActiveView('terminal'); state.hideConfirm();`);
  const initial = await until(async () => { const state = await main.evaluate(terminalState); return state.status === "connected" && state.rows.includes("row-059") && state; }, "connected source");
  const sid = initial.sid;
  await checkPointerObserver(main);
  await until(() => main.evaluate("return !document.body.textContent.includes('Securing Session');"), "source connection animation");
  await main.screenshot("01-main");
  // Exercise the real tab drag sensor, preserving the source until release.
  const tabWidth = await main.evaluate(`const tab=document.querySelector('[aria-selected="true"]');const r=tab.getBoundingClientRect();window.__smokeTabPointer={x:r.x+70,y:r.y+20};tab.dispatchEvent(new PointerEvent('pointerdown',{button:0,buttons:1,pointerId:51,pointerType:'mouse',isPrimary:true,bubbles:true,clientX:r.x+70,clientY:r.y+20}));return r.width;`);
  await main.evaluate("const p=window.__smokeTabPointer;document.dispatchEvent(new PointerEvent('pointermove',{pointerId:51,pointerType:'mouse',isPrimary:true,bubbles:true,clientX:p.x,clientY:p.y+12}));");
  await main.evaluate("const p=window.__smokeTabPointer;document.dispatchEvent(new PointerEvent('pointermove',{pointerId:51,pointerType:'mouse',isPrimary:true,bubbles:true,clientX:p.x,clientY:p.y+110}));");
  const previewTarget = await until(async () => (await targets()).find((item) => item.url.includes('tabPreview=true')), "tear-out drag preview");
  const tearPreview = await connect(previewTarget);
  await until(() => tearPreview.evaluate("return document.body.textContent.includes('Open as a window');"), "drag card ready");
  await tearPreview.screenshot("09-detach-drag-preview");
  assert.equal(await main.evaluate("return document.querySelector('[aria-selected=\"true\"]').getBoundingClientRect().width;"), tabWidth, "dragging out must preserve the tab's space");
  await main.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));");
  await until(async () => !(await targets()).some((item) => item.id === previewTarget.id), "Escape removes drag preview");
  tearPreview.close();
  assert.equal((await main.evaluate(terminalState)).sid, sid);
  await main.evaluate(`${store} const {transferTerminalWindow}=await importActual('/src/terminal/windowHandoff.ts'); window.__smokeMove='pending'; void transferTerminalWindow({tabId:state.activeTabId,host:state.terminalTabs.find(t=>t.id===state.activeTabId).host,target:'no-window-for-cancel-test',open:async()=>{},release:()=>{throw Error('Cancelled move must not release source');}}).catch(error=>{window.__smokeMove=error.message;});`);
  await until(() => main.evaluate("return document.body.textContent.includes('Cancel move');"), "cancellable transfer overlay");
  await delay(180);
  await main.screenshot("05-transfer-overlay");
  await main.evaluate("const cancel=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Cancel move'));cancel.focus();cancel.click();");
  await until(() => main.evaluate("return window.__smokeMove.includes('cancelled');"), "cancel preserves source");
  assert.equal((await main.evaluate(terminalState)).sid, sid);
  await until(() => main.evaluate("return document.activeElement?.classList.contains('xterm-helper-textarea');"), "cancel restores keyboard focus");
  await main.command("Input.insertText", { text: "after-cancel" });
  await until(() => input.includes("after-cancel"), "usable keyboard after cancel");
  for (let cycle = 0; cycle < 3; cycle++) {
    await main.click('[aria-selected="true"] button[title="Move to a separate window"], [data-terminal-tabbar] button[title="Move to a separate window"]');
    const detachedTarget = await until(async () => {
      const errors = await main.evaluate(`${store} return state.toasts.filter(t=>t.type==='error').map(t=>t.message);`);
      if (errors.length) throw new Error(errors.join("; "));
      return (await targets()).find((item) => item.url.includes("detached=true"));
    }, "detached webview");
    const detached = await connect(detachedTarget);
    const moved = await until(async () => { const state = await detached.evaluate(terminalState); return state.status === "connected" && state.transfers === 0 && state.rows.includes("row-000") && state; }, "detached checkpoint");
    assert.equal(moved.sid, sid); assert.equal(connections, 1);
    if (cycle === 0) {
      await detached.evaluate(`${store}window.__layoutSession={id:state.activeTabId,term:state.terminalInstances[state.activeTabId],socket:state.terminalSockets[state.activeTabId]};`);
      for (const [label, layout, empty] of [["Side by side", "columns", 1], ["Stacked", "rows", 1], ["2 × 2", "grid", 3], ["Single", "single", 0]]) {
        await detached.click(`[role="radio"][aria-label="${label}"]`);
        assert.equal(await detached.evaluate(`${store}const before=window.__layoutSession;return state.terminalLayout===${JSON.stringify(layout)}&&document.querySelectorAll('[data-terminal-empty-pane]').length===${empty}&&state.activeTabId===before.id&&state.terminalInstances[before.id]===before.term&&state.terminalSockets[before.id]===before.socket&&state.sessionIds[before.id]===${sid};`), true, "standalone detached layout must preserve the live session");
      }
      assert.equal(connections, 1, "detached layout changes must not reconnect");
    }
    if(cycle===0)await checkPointerObserver(detached);
    assert.equal((await main.evaluate(terminalState)).tabs, 0);
    if (cycle === 1) {
      // Idle, non-existent saved hosts give us two real tab positions without
      // creating another transport or touching any external server.
      await main.evaluate(`${store}const host={...window.__smokeHost,id:999999};state.markInitialConnectSuppressed('smoke-before');useAppStore.setState({terminalTabs:[{id:'smoke-before',host:{...host,name:'Monitoring'},isConnected:false},{id:'smoke-after',host:{...host,name:'Diagnostics'},isConnected:false}],activeTabId:'smoke-before',activeView:'terminal'});`);
      await until(() => main.evaluate("return Boolean(document.querySelector('[data-terminal-tab-id=\"smoke-after\"]'));"), "insertion neighbors");
    }
    if(cycle===1&&realMouse) {
      await waitForRealMouseDrop("single",main,detached,3);
    } else if (cycle < 2) {
      if(cycle===1)await placeAcrossMonitors(main,detached);
      const point = await main.evaluate(`const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');const origin=await getCurrentWindow().innerPosition();const rect=(document.querySelector('[data-terminal-tab-id="smoke-after"]')??document.querySelector('[data-terminal-tabs-dropzone]')??document.querySelector('[data-terminal-dock-surface]')).getBoundingClientRect();return {x:origin.x+(rect.x+10)*devicePixelRatio,y:origin.y+(rect.y+20)*devicePixelRatio};`);
      // Simulate only the native move loop/cursor. React, Tauri dock events,
      // live xterm, geometry, handoff and window closure remain real.
      await detached.evaluate(`${store}
        window.__smokeTerm=state.terminalInstances[state.activeTabId];
        window.__smokeGeometry={cols:window.__smokeTerm.cols,rows:window.__smokeTerm.rows,width:window.innerWidth,height:window.innerHeight};
        window.__smokeCursor=${JSON.stringify(point)};
        const {Window,PhysicalPosition,cursorPosition}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');
        window.__smokeRestoreDrag=()=>{
          Window.prototype.startDragging=window.__smokeOriginalDrag;
          delete PhysicalPosition.prototype.x;delete PhysicalPosition.prototype.y;
        };
        window.__smokeOriginalDrag=Window.prototype.startDragging;
        Window.prototype.startDragging=()=>new Promise(resolve=>{window.__smokeRelease=resolve;});
        // Override only the API position value in this synthetic webview.
        // Tauri's immutable IPC entry point remains untouched.
        for(const axis of ['x','y'])Object.defineProperty(PhysicalPosition.prototype,axis,{configurable:true,get:()=>window.__smokeCursor[axis],set:()=>{}});
        const simulated=await cursorPosition();
        if(simulated.x!==window.__smokeCursor.x||simulated.y!==window.__smokeCursor.y)throw Error('Native cursor simulation failed');
        document.querySelector('[data-terminal-window-drag-region]').dispatchEvent(new PointerEvent('pointerdown',{button:0,clientX:150,clientY:12,pointerId:71,bubbles:true}));
        window.dispatchEvent(new PointerEvent('pointermove',{clientX:162,clientY:12,pointerId:71,bubbles:true}));`);
      await until(() => detached.evaluate("return document.querySelector('.terminal-dock-stage').dataset.dockArmed==='true';"), "compact dock preview");
      await delay(1_400);
      assert.equal(await main.evaluate("return document.querySelector('.terminal-dock-target')?.dataset.dockArmed==='true';"), true, "stationary pointer must retain the destination");
      const preview = await detached.evaluate(`${store} const term=state.terminalInstances[state.activeTabId];const frame=document.querySelector('.terminal-dock-live');return {same:term===window.__smokeTerm,cols:term.cols,rows:term.rows,width:innerWidth,height:innerHeight,before:window.__smokeGeometry,scale:frame.getBoundingClientRect().width/frame.clientWidth};`);
      assert.equal(preview.same, true);
      for (const key of ["cols", "rows", "width", "height"]) assert.equal(preview[key], preview.before[key], `Preview changed ${key}`);
      assert.ok(Math.abs(preview.scale - Math.min(.5, 420 / preview.width, 280 / preview.height)) < 0.01);
      assert.equal(await detached.evaluate("return getComputedStyle(document.body).backgroundColor;"), "rgba(0, 0, 0, 0)");
      await detached.screenshot("07-compact-dock-preview");
      await main.screenshot("08-active-dock-destination");
      if (cycle === 0) {
        await detached.evaluate("window.__smokeCursor={x:-100000,y:-100000};");
        await until(() => detached.evaluate("return document.querySelector('.terminal-dock-stage').dataset.dockArmed==='false';"), "leaving dock restores terminal");
      }
      await detached.evaluate("window.dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:71,bubbles:true}));window.__smokeRelease();");
      if (cycle === 0) {
        await until(() => main.evaluate("return !document.querySelector('.terminal-dock-target');"), "drop outside clears shelf");
        await detached.evaluate("window.__smokeRestoreDrag();");
        assert.equal((await detached.evaluate(terminalState)).sid, sid);
      }
    }
    if (cycle === 0) {
      await detached.screenshot("02-detached");
      // Native close must offer Return / Disconnect, rather than orphaning a session.
      await detached.evaluate("const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js'); await getCurrentWindow().close();");
      await until(() => detached.evaluate("return document.body.textContent.includes('Disconnect') && document.body.textContent.includes('Cancel');"), "detached native-close dialog");
      await detached.screenshot("03-close-dialog");
      await detached.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await detached.command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await until(() => detached.evaluate("return !document.querySelector('[role=dialog]');"), "close-dialog Escape");
      // Exercise the main window's native-close path with all terminals detached.
      await main.evaluate("const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js'); await getCurrentWindow().close();");
      await until(() => main.evaluate(`${store} return state.confirmDialog?.message.includes('detached terminal');`), "main native-close confirmation");
      await main.evaluate(`${store} state.hideConfirm();`);
    }
    if (cycle === 0) await detached.click('button[aria-label="Return terminal to main window"]');
    if (cycle === 2) {
      await main.evaluate("const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().minimize();");
      await detached.evaluate("const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().close();");
      await until(() => detached.evaluate("return Boolean(document.querySelector('[role=dialog]'));"), "return dialog");
      await detached.evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.includes('Return to main window')).click();");
    }
    const returned = await until(async () => { const state = await main.evaluate(terminalState); return state.status === "connected" && state.tabs === (cycle === 1 ? 3 : 1) && state.transfers === 0 && state; }, "returned terminal");
    assert.equal(returned.sid, sid); assert.equal(connections, 1);
    if (cycle === 1) {
      assert.deepEqual(await main.evaluate(`${store}return state.terminalTabs.map(t=>t.id===state.activeTabId?'returned':t.id);`), ['smoke-before','returned','smoke-after']);
      await main.screenshot("10-session-tabs");
      await main.evaluate(`${store}state.removeTerminalTab('smoke-before');state.removeTerminalTab('smoke-after');`);
    }
    await until(async () => !(await targets()).some((item) => item.id === detachedTarget.id), "detached window closed");
    detached.close();
  }
  await main.evaluate(`${store} const {getTerminalSessionController}=await importActual('/src/terminal/TerminalSessionController.ts'); getTerminalSessionController(state.activeTabId).send('after-return');`);
  await until(() => input.includes("after-return"), "usable input after return");
  await main.screenshot("04-returned");
  const dockArmed = await main.evaluate(`const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js'); const {emit,listen}=await import('/node_modules/.vite/deps/@tauri-apps_api_event.js'); const origin=await getCurrentWindow().innerPosition(); const rect=document.querySelector('[data-terminal-tabbar]').getBoundingClientRect(); return new Promise(async(resolve)=>{const stop=await listen('terminal-dock-result',e=>{if(e.payload.id==='smoke-dock'){stop();resolve(e.payload.armed);}});await emit('terminal-dock-probe',{id:'smoke-dock',source:'detached-test',point:{x:origin.x+(rect.x+100)*devicePixelRatio,y:origin.y+(rect.y+20)*devicePixelRatio}});});`);
  assert.equal(dockArmed, true);
  await main.screenshot("06-dock-target");
  await main.evaluate(`const {emit}=await import('/node_modules/.vite/deps/@tauri-apps_api_event.js'); await emit('terminal-dock-end',{}); ${store}
    const live=state.terminalTabs.find(t=>t.id===state.activeTabId);
    if(!live)throw Error('Missing active fixture: '+JSON.stringify({active:state.activeTabId,tabs:state.terminalTabs.map(t=>t.id),transfers:Object.keys(state.terminalTransfers),modules:performance.getEntriesByType('resource').filter(e=>e.name.includes('/src/state/store.ts')).map(e=>e.name)}));
    const fixtures=Array.from({length:6},(_,i)=>({id:'smoke-overflow-'+i,host:{...live.host,id:999999,name:'Branch gateway '+(i+1),connection_type:i%2?'ssh':'serial'},isConnected:false}));
    for(const tab of fixtures)state.markInitialConnectSuppressed(tab.id);
    useAppStore.setState({terminalTabs:[...fixtures,live]});`);
  await until(() => main.evaluate(`const viewport=document.querySelector('[data-terminal-tabs-dropzone]').getBoundingClientRect();const tab=document.querySelector('[role=tab][aria-selected=true]').getBoundingClientRect();return tab.left>=viewport.left-1&&tab.right<=viewport.right+1&&Boolean(document.querySelector('[aria-label="Scroll sessions left"]'));`), "selected tab visible in overflowing strip");
  await main.screenshot("11-session-tabs-overflow");
  const scrollBefore = await main.evaluate("return document.querySelector('[data-terminal-tabs-dropzone]').scrollLeft;");
  await main.click('[aria-label="Scroll sessions left"]');
  await until(() => main.evaluate(`return document.querySelector('[data-terminal-tabs-dropzone]').scrollLeft < ${scrollBefore};`), "session strip scrolls left");
  assert.equal((await main.evaluate(terminalState)).sid, sid);
  await main.click('[aria-label="Scroll sessions right"]');
  await main.evaluate(`${store}useAppStore.setState({settings:{...state.settings,window:{...state.settings.window,tabPosition:'bottom'}}});`);
  await until(() => main.evaluate("const rect=document.querySelector('[data-terminal-tabbar]').getBoundingClientRect();return rect.top>innerHeight/2;"), "bottom session tabs");
  await main.evaluate("document.querySelector('[role=tab][aria-selected=true]').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));");
  await until(() => main.evaluate("return document.querySelector('[role=tooltip]')?.style.bottom;"), "bottom tab tooltip");
  await main.screenshot("12-session-tabs-bottom");
  await main.evaluate(`${store}for(const tab of state.terminalTabs)if(tab.id.startsWith('smoke-overflow-'))state.removeTerminalTab(tab.id);`);
  // A detached grid must be able to fill an exact vacant cell locally and accept
  // both a main-window tab and a separate floating terminal without reconnecting.
  await main.evaluate(`${store} useAppStore.setState({settings:{...state.settings,window:{...state.settings.window,tabPosition:'top'}}});state.setTerminalGroup({id:'smoke-grid',layout:'grid',tabIds:[state.activeTabId]});`);
  await until(() => main.evaluate("return Boolean(document.querySelector('[data-terminal-group-id]'));"), "group tab ready");
  await main.click('[data-terminal-tabbar] button[title="Move to a separate window"]');
  const gridTarget = await until(async () => (await targets()).find((item) => item.url.includes("workspace=true")), "detached grid window");
  const grid = await connect(gridTarget);
  await until(() => grid.evaluate(`${store} return Object.keys(state.terminalTransfers).length===0 && Boolean(document.querySelector('[aria-label="Choose a connection for pane 4"]'));`), "detached empty-pane chooser");
  await grid.click('[aria-label="Choose a connection for pane 4"]');
  await until(() => grid.evaluate("return [...document.querySelectorAll('[role=dialog] button')].some(button=>button.textContent.includes('127.0.0.1:'));"), "saved profiles in detached picker");
  await grid.evaluate("[...document.querySelectorAll('[role=dialog] button')].find(button=>button.textContent.includes('127.0.0.1:')).click();");
  const pickerSession = await until(() => grid.evaluate(`${store} const group=state.terminalGroups[0],id=group?.paneSlots?.[3];return id && state.tabStatuses[id]==='connected' && state.sessionIds[id];`), "saved connection in pane four");
  assert.equal(await grid.evaluate(`${store} return state.terminalGroups[0].paneSlots[2];`), null, "choosing pane four must leave pane three vacant");
  await grid.screenshot("13-detached-pane-chooser-result");
  const physicalPane = async (index) => grid.evaluate(`const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');const win=getCurrentWindow();await win.setFocus();const origin=await win.innerPosition();const r=document.querySelector('[data-terminal-pane-index="${index}"]').getBoundingClientRect();return {x:origin.x+(r.x+r.width/2)*devicePixelRatio,y:origin.y+(r.y+r.height/2)*devicePixelRatio};`);
  const simulateCursor = async (client, point) => client.evaluate(`window.__paneCursor=${JSON.stringify(point)};const {PhysicalPosition}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');for(const axis of ['x','y'])Object.defineProperty(PhysicalPosition.prototype,axis,{configurable:true,get:()=>window.__paneCursor[axis],set:()=>{}});`);
  await main.evaluate(`${store} state.addTerminalTab(window.__smokeHost);state.setActiveView('terminal');`);
  const mainTabSession = await until(async () => { const value=await main.evaluate(terminalState);return value.status==='connected'&&value.sid; }, "independent main tab");
  await simulateCursor(main, await physicalPane(1));
  await main.evaluate(`const tab=document.querySelector('[role=tab]'),r=tab.getBoundingClientRect();window.__panePointer={x:r.x+60,y:r.y+20};tab.dispatchEvent(new PointerEvent('pointerdown',{button:0,buttons:1,pointerId:91,pointerType:'mouse',isPrimary:true,bubbles:true,clientX:r.x+60,clientY:r.y+20}));`);
  await main.evaluate("const p=window.__panePointer;document.dispatchEvent(new PointerEvent('pointermove',{pointerId:91,pointerType:'mouse',isPrimary:true,bubbles:true,clientX:p.x,clientY:p.y+12}));");
  await main.evaluate("const p=window.__panePointer;document.dispatchEvent(new PointerEvent('pointermove',{pointerId:91,pointerType:'mouse',isPrimary:true,bubbles:true,clientX:p.x,clientY:p.y+220}));");
  await until(() => grid.evaluate("return document.body.textContent.includes('Release to insert in pane 2');"), "tab drop destination in detached grid");
  await main.evaluate("const p=window.__panePointer;document.dispatchEvent(new PointerEvent('pointerup',{pointerId:91,pointerType:'mouse',isPrimary:true,bubbles:true,clientX:p.x,clientY:p.y+220}));");
  await until(() => grid.evaluate(`${store} const id=state.terminalGroups[0].paneSlots[1];return id && state.sessionIds[id]===${mainTabSession} && Object.keys(state.terminalTransfers).length===0;`), "main tab inserted without reconnecting");
  await main.evaluate("const {PhysicalPosition}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');delete PhysicalPosition.prototype.x;delete PhysicalPosition.prototype.y;");
  assert.equal((await main.evaluate(terminalState)).tabs, 0);
  await grid.screenshot("14-tab-in-detached-pane");
  await main.evaluate(`${store} state.addTerminalTab(window.__smokeHost);state.setActiveView('terminal');`);
  const floatingSession = await until(async () => { const value=await main.evaluate(terminalState);return value.status==='connected'&&value.sid; }, "new independent terminal");
  await main.click('[data-terminal-tabbar] button[title="Move to a separate window"]');
  const floatingTarget = await until(async () => (await targets()).find((item) => item.url.includes("detached=true") && item.id !== gridTarget.id), "independent floating terminal");
  const floating = await connect(floatingTarget);
  await until(() => floating.evaluate(`${store} return state.tabStatuses[state.activeTabId]==='connected' && Object.keys(state.terminalTransfers).length===0;`), "floating terminal ready");
  await simulateCursor(floating, await physicalPane(2));
  await floating.evaluate("const {Window}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');Window.prototype.startDragging=()=>new Promise(resolve=>{window.__paneRelease=resolve;});document.querySelector('[data-terminal-window-drag-region]').dispatchEvent(new PointerEvent('pointerdown',{button:0,clientX:150,clientY:12,pointerId:92,bubbles:true}));window.dispatchEvent(new PointerEvent('pointermove',{clientX:162,clientY:12,pointerId:92,bubbles:true}));");
  await until(() => grid.evaluate("return document.body.textContent.includes('Release to insert in pane 3');"), "floating terminal targets pane three");
  await floating.evaluate("window.__paneRelease();window.dispatchEvent(new PointerEvent('pointerup',{pointerId:92,bubbles:true}));");
  await until(() => grid.evaluate(`${store} const id=state.terminalGroups[0].paneSlots[2];return id && state.sessionIds[id]===${floatingSession} && Object.keys(state.terminalTransfers).length===0;`), "floating session inserted into grid");
  await until(async () => !(await targets()).some((item) => item.id===floatingTarget.id), "inserted floating window closed");
  floating.close();
  let expectedPaneSessions = [sid,mainTabSession,floatingSession,pickerSession];
  assert.deepEqual(await grid.evaluate(`${store} return state.terminalGroups[0].paneSlots.map(id=>state.sessionIds[id]);`), expectedPaneSessions);
  assert.equal(connections, 4, "pane moves must reuse all existing Telnet transports");
  await grid.screenshot("15-detached-grid-filled");
  if(realMouse) {
    await waitForRealMouseDrop("grid",main,grid,4);
  } else {
  await placeAcrossMonitors(main,grid);
  // Return a complete four-session group through the title drag gesture, with
  // DOM release preceding the delayed native move acknowledgement.
  await main.evaluate("const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().setFocus();");
  await grid.evaluate("const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().setFocus();");
  const groupDropPoint=await main.evaluate("const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');const origin=await getCurrentWindow().innerPosition(),r=document.querySelector('[data-terminal-tabs-dropzone]').getBoundingClientRect();return {x:Math.round(origin.x+(r.x+30)*devicePixelRatio),y:Math.round(origin.y+(r.y+r.height/2)*devicePixelRatio)};");
  await simulateCursor(grid,groupDropPoint);
  await grid.evaluate("const {Window}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');Window.prototype.startDragging=()=>new Promise(resolve=>{window.__groupRelease=resolve;});document.querySelector('[data-terminal-window-drag-region]').dispatchEvent(new PointerEvent('pointerdown',{button:0,clientX:150,clientY:12,pointerId:172,bubbles:true}));window.dispatchEvent(new PointerEvent('pointermove',{clientX:162,clientY:12,pointerId:172,bubbles:true}));");
  await until(()=>grid.evaluate("return document.querySelector('.terminal-dock-stage').dataset.dockArmed==='true';"),"multi-session return drop armed");
  await grid.evaluate("window.dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:172,bubbles:true}));window.__groupRelease();");
  }
  await until(() => main.evaluate(`${store} return state.terminalTabs.length===4 && Object.keys(state.terminalTransfers).length===0 && state.terminalGroups[0]?.layout==='grid';`), "filled grid returned to main");
  assert.deepEqual(await main.evaluate(`${store} return state.terminalGroups[0].paneSlots.map(id=>state.sessionIds[id]);`), expectedPaneSessions);
  assert.equal(connections, 4);
  await main.screenshot("16-filled-grid-returned");
  grid.close();
  await until(async () => !(await targets()).some((item) => item.id===gridTarget.id), "returned group source closed");
  // Extract individual live panes from a detached group. The remaining panes
  // retain their xterm/controller/socket identity and their original cells.
  await main.click('[data-terminal-tabbar] [aria-selected="true"] button[title="Move to a separate window"]');
  const extractionTarget = await until(async () => (await targets()).find((item) => item.url.includes('workspace=true')&&item.id!==gridTarget.id), "group for individual extraction");
  const extraction = await connect(extractionTarget);
  await until(() => extraction.evaluate(`${store}return state.terminalTabs.length===4 && !Object.keys(state.terminalTransfers).length;`), "extraction group ready");
  const paneIds = await extraction.evaluate(`${store}window.__extractNeighbors=state.terminalGroups[0].tabIds.map(id=>({id,term:state.terminalInstances[id],socket:state.terminalSockets[id]}));return state.terminalGroups[0].paneSlots;`);
  const dragPane = async (client,id,point,pointerId) => {
    await simulateCursor(client,point);
    await client.evaluate(`const id=${JSON.stringify(id)},handle=[...document.querySelectorAll('[data-terminal-pane-drag-handle]')].find(element=>element.dataset.terminalPaneDragHandle===id),r=handle.getBoundingClientRect();window.__extractPointer={x:r.x+10,y:r.y+10};handle.dispatchEvent(new PointerEvent('pointerdown',{button:0,buttons:1,pointerId:${pointerId},pointerType:'mouse',isPrimary:true,bubbles:true,clientX:r.x+10,clientY:r.y+10}));window.dispatchEvent(new PointerEvent('pointermove',{pointerId:${pointerId},pointerType:'mouse',isPrimary:true,bubbles:true,clientX:r.x+35,clientY:r.y+30}));`);
    await until(()=>client.evaluate("return Boolean(document.querySelector('[data-terminal-pane-drag-preview]'));"),"individual pane drag preview");
    await client.evaluate(`window.dispatchEvent(new PointerEvent('pointerup',{pointerId:${pointerId},pointerType:'mouse',isPrimary:true,bubbles:true,clientX:window.__extractPointer.x+25,clientY:window.__extractPointer.y+20}));`);
  };
  await main.evaluate("const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().setFocus();");
  await extraction.evaluate("const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().setFocus();");
  const mainStripPoint = await main.evaluate(`const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');const origin=await getCurrentWindow().innerPosition(),r=document.querySelector('[data-terminal-tabs-dropzone]').getBoundingClientRect();for(let offset=20;offset<r.width-10;offset+=80){const point={x:Math.round(origin.x+(r.x+offset)*devicePixelRatio),y:Math.round(origin.y+(r.y+r.height/2)*devicePixelRatio)};if(await window.__TAURI_INTERNALS__.invoke('terminal_dock_target',{...point,excludeSource:false})==='main')return point;}throw Error('No uncovered main tab-strip point');`);
  await dragPane(extraction,paneIds[1],mainStripPoint,111);
  await until(()=>main.evaluate(`${store}return state.terminalTabs.some(tab=>state.sessionIds[tab.id]===${mainTabSession})&&!Object.keys(state.terminalTransfers).length;`),"one pane extracted to main");
  await until(()=>extraction.evaluate(`${store}return state.terminalGroups[0].paneSlots[1]===null&&!Object.keys(state.terminalTransfers).length;`),"only the extracted source cell is empty");
  assert.equal(await extraction.evaluate(`${store}return window.__extractNeighbors.filter(item=>item.id!==${JSON.stringify(paneIds[1])}).every(item=>state.terminalInstances[item.id]===item.term && state.terminalSockets[item.id]===item.socket);`),true,"extracting a pane must not remount or reconnect neighbors");
  await main.screenshot("19-pane-extracted-to-main");
  await extraction.evaluate("const {PhysicalPosition}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');delete PhysicalPosition.prototype.x;delete PhysicalPosition.prototype.y;");
  await dragPane(extraction,paneIds[2],{x:-100000,y:-100000},112);
  const extractedTarget = await until(async()=>(await targets()).find(item=>item.url.includes('detached=true')&&item.id!==extractionTarget.id),"individual pane floating window");
  const extracted = await connect(extractedTarget);
  await until(()=>extracted.evaluate(`${store}return state.tabStatuses[state.activeTabId]==='connected'&&state.sessionIds[state.activeTabId]===${floatingSession}&&!Object.keys(state.terminalTransfers).length;`),"individual pane retains its session in a new window");
  await until(()=>extraction.evaluate(`${store}return state.terminalTabs.length===2&&!Object.keys(state.terminalTransfers).length;`),"source group retains the other two members");
  expectedPaneSessions=[sid,null,null,pickerSession];
  assert.deepEqual(await extraction.evaluate(`${store}return state.terminalGroups[0].paneSlots.map(id=>id?state.sessionIds[id]:null);`),expectedPaneSessions);
  assert.equal(await extraction.evaluate(`${store}return window.__extractNeighbors.filter(item=>[${JSON.stringify(paneIds[0])},${JSON.stringify(paneIds[3])}].includes(item.id)).every(item=>state.terminalInstances[item.id]===item.term&&state.terminalSockets[item.id]===item.socket);`),true);
  assert.equal(connections,4);
  await extracted.screenshot("20-individually-extracted-window");
  await extraction.screenshot("21-group-after-individual-extraction");
  await extracted.click('[aria-label="Return terminal to main window"]');
  await until(()=>main.evaluate(`${store}return state.terminalTabs.length===2&&!Object.keys(state.terminalTransfers).length;`),"individual floating session returned independently");
  extracted.close();
  await extraction.click('[aria-label="Return terminal to main window"]');
  await until(()=>main.evaluate(`${store}return state.terminalTabs.length===4&&state.terminalGroups.length===1&&!Object.keys(state.terminalTransfers).length;`),"remaining group returned with vacancies intact");
  assert.deepEqual(await main.evaluate(`${store}return state.terminalGroups[0].paneSlots.map(id=>id?state.sessionIds[id]:null);`),expectedPaneSessions);
  assert.equal(connections,4);
  await main.screenshot("22-individuals-and-remaining-group");
  extraction.close();
  await until(async () => !(await targets()).some(item => item.id === extractionTarget.id || item.id === extractedTarget.id), "extracted windows closed");
  // Two source windows can request Return before the first replay completes.
  // The main window must serialize preparation so neither incoming renderer is
  // hidden by the next return. Existing groups and sessions stay independent.
  const simultaneous = [];
  const simultaneousSids = [];
  for (let index=0;index<2;index++) {
    await main.evaluate(`${store} state.addTerminalTab(window.__smokeHost);state.setActiveView('terminal');`);
    simultaneousSids.push(await until(async () => { const value=await main.evaluate(terminalState);return value.status==='connected' && value.sid; }, "concurrent return source connection"));
    await main.click('[data-terminal-tabbar] [aria-selected="true"] button[title="Move to a separate window"]');
    const sourceTarget = await until(async () => (await targets()).find((item) => item.url.includes('detached=true')&&!simultaneous.some((client)=>client.target.id===item.id)), "concurrent return floating window");
    const source = await connect(sourceTarget);
    await until(() => source.evaluate(`${store} return state.tabStatuses[state.activeTabId]==='connected' && !Object.keys(state.terminalTransfers).length;`), "concurrent source ready");
    simultaneous.push(source);
  }
  await main.evaluate(`${store}const {TerminalSessionController}=await importActual('/src/terminal/TerminalSessionController.ts');window.__smokeOriginalReady=TerminalSessionController.prototype.waitForHandoffReady;window.__smokeReadyCalls=0;TerminalSessionController.prototype.waitForHandoffReady=async function(signal){window.__smokeReadyCalls++;if(window.__smokeReadyCalls===1){window.__smokeHeldSession=this.getSnapshot().sessionId;await new Promise((resolve,reject)=>{const abort=()=>reject(Error('Delayed replay cancelled'));signal.addEventListener('abort',abort,{once:true});window.__smokeFinishReplay=()=>{signal.removeEventListener('abort',abort);resolve();};});}return window.__smokeOriginalReady.call(this,signal);};`);
  await Promise.all(simultaneous.map((source)=>source.click('[aria-label="Return terminal to main window"]')));
  await until(()=>main.evaluate("return window.__smokeReadyCalls===1;"),"first delayed return reaches replay barrier");
  await until(async()=> (await Promise.all(simultaneous.map((source)=>source.evaluate(`${store}return state.terminalTransfers[state.activeTabId]?.direction==='outgoing';`)))).every(Boolean),"both returns pending");
  await delay(400);
  assert.equal(await main.evaluate("return window.__smokeReadyCalls;"),1,"the second return must wait outside preparation");
  assert.equal(await main.evaluate(`${store}return state.sessionIds[state.activeTabId]===window.__smokeHeldSession;`),true,"queued returns must not replace the first renderer");
  await main.evaluate("window.__smokeFinishReplay();");
  await until(() => main.evaluate(`${store} return state.terminalTabs.length===6 && !Object.keys(state.terminalTransfers).length;`), "simultaneous returns complete");
  const finalSids = await main.evaluate(`${store} return state.terminalTabs.map(tab=>state.sessionIds[tab.id]);`);
  for (const session of simultaneousSids) assert.ok(finalSids.includes(session));
  assert.deepEqual(await main.evaluate(`${store} return state.terminalGroups[0].paneSlots.map(id=>state.sessionIds[id]);`), expectedPaneSessions, "returning singles must not join an existing group");
  assert.equal(connections, 6, "concurrent returns must not reconnect transports");
  await main.evaluate(`${store}const {TerminalSessionController}=await importActual('/src/terminal/TerminalSessionController.ts');TerminalSessionController.prototype.waitForHandoffReady=window.__smokeOriginalReady;`);
  await main.screenshot("17-queued-returns");
  simultaneous.forEach((source)=>source.close());
  await main.evaluate(`${store}state.setActiveTabId(state.terminalTabs.find(tab=>state.sessionIds[tab.id]===${simultaneousSids[1]}).id);`);
  await main.click('[role="radio"][aria-label="2 × 2"]');
  assert.deepEqual(await main.evaluate(`${store}const group=state.terminalGroups.find(item=>item.tabIds.includes(state.activeTabId));return group.paneSlots.map(id=>id?state.sessionIds[id]:null);`),[simultaneousSids[1],null,null,null],"choosing grid must include only the selected session");
  assert.equal(await main.evaluate("return document.querySelectorAll('[data-terminal-empty-pane]').length;"),3);
  await main.screenshot("18-selected-session-grid");
  await main.click('[role="radio"][aria-label="Stacked"]');
  await main.click('[role="radio"][aria-label="Side by side"]');
  assert.equal(await main.evaluate(`${store}return state.terminalGroups.find(item=>item.tabIds.includes(state.activeTabId)).tabIds.length;`),1,"changing layout must not collect other active sessions");
  assert.equal(connections,6);
  // Single dissolves only the selected split. Its ordinary tab must regain the
  // protocol identity even when the group contained only one session.
  const singleFocus = await main.evaluate(`${store}return state.sessionIds[state.activeTabId];`);
  await main.click('[role="radio"][aria-label="Single"]');
  assert.equal(await main.evaluate(`${store}return state.terminalGroups.some(g=>g.tabIds.includes(state.activeTabId));`),false);
  assert.equal(await main.evaluate(`${store}return state.sessionIds[state.activeTabId];`),singleFocus);
  await main.screenshot("23-single-restores-ordinary-tab");
  const splitId=await main.evaluate(`${store}const id=state.terminalTabs.find(t=>state.sessionIds[t.id]===${sid}).id;state.setActiveTabId(id);state.setTerminalLayout('grid');const group=useAppStore.getState().terminalGroups.find(g=>g.tabIds.includes(id));state.insertTerminalPane(group.id,1,state.terminalTabs.find(t=>state.sessionIds[t.id]===${mainTabSession}).id);state.insertTerminalPane(group.id,2,state.terminalTabs.find(t=>state.sessionIds[t.id]===${floatingSession}).id);state.setActiveTabId(id);return group.id;`);
  await main.click(`[data-terminal-group-id="${splitId}"] button[title="Move to a separate window"]`);
  const singlesTarget=await until(async()=>(await targets()).find(item=>item.url.includes('workspace=true')),"workspace for Single separation");
  const singles=await connect(singlesTarget);
  await until(()=>singles.evaluate(`${store}return state.terminalTabs.length===4&&!Object.keys(state.terminalTransfers).length;`),"four-session split ready");
  await singles.evaluate(`${store}window.__singleTransports=state.terminalTabs.map(t=>({id:t.id,sid:state.sessionIds[t.id],socket:state.terminalSockets[t.id]}));`);
  await singles.click('[role="radio"][aria-label="Single"]');
  assert.equal(await singles.evaluate(`${store}return state.terminalGroups.length===0&&document.querySelectorAll('[role=tab]').length===4&&window.__singleTransports.every(t=>state.sessionIds[t.id]===t.sid&&state.terminalSockets[t.id]===t.socket)&&state.sessionIds[state.activeTabId]===${sid};`),true,"Single preserves every transport and the selected session");
  await singles.screenshot("24-floating-single-tabs");
  const singlesIds=await singles.evaluate(`${store}return state.terminalTabs.map(t=>t.id);`);
  await singles.click(`[data-terminal-tab-id="${singlesIds[1]}"]`);
  assert.equal(await singles.evaluate(`${store}return state.activeTabId;`),singlesIds[1]);
  await main.evaluate("const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().setFocus();");
  await singles.evaluate("const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await getCurrentWindow().setFocus();");
  const singleDrop=await main.evaluate(`const {getCurrentWindow}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');const origin=await getCurrentWindow().innerPosition(),r=document.querySelector('[data-terminal-tabs-dropzone]').getBoundingClientRect();for(let offset=20;offset<r.width-10;offset+=80){const p={x:Math.round(origin.x+(r.x+offset)*devicePixelRatio),y:Math.round(origin.y+(r.y+r.height/2)*devicePixelRatio)};if(await window.__TAURI_INTERNALS__.invoke('terminal_dock_target',{...p,excludeSource:false})==='main')return p;}throw Error('No uncovered tab strip');`);
  await simulateCursor(singles,singleDrop);
  await singles.evaluate(`${store}window.__singleTrace=[];let previous='';useAppStore.subscribe(s=>{const item={active:s.activeTabId,transfers:Object.keys(s.terminalTransfers),toasts:s.toasts.map(t=>t.message)},next=JSON.stringify(item);if(next!==previous){window.__singleTrace.push(item);previous=next;}});`);
  await singles.evaluate(`const tab=document.querySelector('[data-terminal-tab-id="${singlesIds[2]}"]'),r=tab.getBoundingClientRect();window.__singlePointer={x:r.x+60,y:r.y+20};tab.dispatchEvent(new PointerEvent('pointerdown',{button:0,buttons:1,pointerId:171,pointerType:'mouse',isPrimary:true,bubbles:true,clientX:r.x+60,clientY:r.y+20}));`);
  await singles.evaluate("const p=window.__singlePointer;document.dispatchEvent(new PointerEvent('pointermove',{pointerId:171,pointerType:'mouse',isPrimary:true,bubbles:true,clientX:p.x,clientY:p.y+12}));");
  await singles.evaluate("const p=window.__singlePointer;document.dispatchEvent(new PointerEvent('pointermove',{pointerId:171,pointerType:'mouse',isPrimary:true,bubbles:true,clientX:p.x,clientY:p.y+110}));");
  await until(()=>main.evaluate("return document.body.textContent.includes('Release to dock here');"),"ordinary floating tab advertises main destination");
  await singles.evaluate("const p=window.__singlePointer;document.dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:171,pointerType:'mouse',isPrimary:true,bubbles:true,clientX:p.x,clientY:p.y+110}));");
  await until(()=>singles.evaluate(`${store}return state.terminalTabs.length===3&&!Object.keys(state.terminalTransfers).length;`),"ordinary floating tab returns individually");
  await singles.evaluate("const {PhysicalPosition}=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');delete PhysicalPosition.prototype.x;delete PhysicalPosition.prototype.y;");
  await main.screenshot("25-single-tab-dragged-to-main");
  // Re-splitting one of the remaining singles must leave its two siblings
  // independent, and its group tab can use the restricted native opener.
  await singles.click('[role="radio"][aria-label="Side by side"]');
  const nativeGroup=await singles.evaluate(`${store}return state.terminalGroups[0].id;`);
  assert.equal(await singles.evaluate(`${store}return state.terminalGroups[0].tabIds.length===1&&document.querySelectorAll('[role=tab]').length===3;`),true);
  await singles.click(`[data-terminal-group-id="${nativeGroup}"] button[title="Move to a separate window"]`);
  const nestedTarget=await until(async()=>(await targets()).find(item=>item.url.includes('workspace=true')&&item.id!==singlesTarget.id),"native group-tab extraction");
  const nested=await connect(nestedTarget);
  await until(()=>nested.evaluate(`${store}return state.terminalTabs.length===1&&!Object.keys(state.terminalTransfers).length;`),"nested group ready");
  await nested.click('[role="radio"][aria-label="Single"]');
  assert.equal(await nested.evaluate(`${store}return state.terminalGroups.length===0&&document.querySelectorAll('[role=tab]').length===1;`),true);
  await nested.click('[aria-label="Return terminal to main window"]');
  await until(async()=>!(await targets()).some(item=>item.id===nestedTarget.id),"nested single returned");nested.close();
  const finalFocus=await singles.evaluate(`${store}return state.sessionIds[state.activeTabId];`);
  await singles.click('[aria-label="Return terminal to main window"]');
  await until(()=>main.evaluate(`${store}return state.terminalTabs.length===6&&!Object.keys(state.terminalTransfers).length&&state.terminalGroups.length===0&&state.sessionIds[state.activeTabId]===${finalFocus};`),"all Single tabs return independently with focus preserved");
  await until(async()=>!(await targets()).some(item=>item.id===singlesTarget.id),"empty Single workspace closed");singles.close();
  assert.equal(connections,6,"Single and repeated split/return must never reconnect transports");
  await main.screenshot("26-all-single-tabs-returned");
  console.log("Terminal window smoke passed: detach/return, individual pane extraction, exact grid insertion, queued returns, Single separation in main/floating workspaces, native group-tab extraction, unchanged session IDs and transport count.");
  console.log(`Screenshots: ${artifacts}`);
} catch (error) {
  console.error("Terminal smoke failed:",error);
  for (const client of clients) {
    if (!client.target.url.includes("detached=true")) continue;
    console.error("Detached diagnostics:", await client.evaluate(`${store} const id=state.activeTabId;const term=state.terminalInstances[id]; return JSON.stringify({id,sid:state.sessionIds[id],status:state.tabStatuses[id],transfer:Object.keys(state.terminalTransfers),buffer:term?.buffer.active.type,first:term?.buffer.active.getLine(0)?.translateToString(true),last:document.body.textContent.slice(-250),trace:window.__singleTrace});`).catch(() => "closed"));
    await client.screenshot("failure-detached").catch(() => {});
  }
  if (main) {
    console.error(await main.evaluate(`${store} return JSON.stringify({toasts:state.toasts.map(t=>t.message),tabs:state.terminalTabs.length,transfers:Object.keys(state.terminalTransfers),body:document.body.textContent.slice(-900)});`).catch(() => "No diagnostics"));
    await main.screenshot("failure").catch(() => {});
  }
  throw error;
} finally {
  if (main) await main.evaluate(`${store} if(window.__smokeHostId){for(const tab of state.terminalTabs)state.removeTerminalTab(tab.id);const {getApiBase,fetchJsonOrThrow}=await importActual('/src/api.ts');await fetchJsonOrThrow((await getApiBase())+'/hosts/'+window.__smokeHostId,{method:'DELETE'});localStorage.removeItem('netrix_layout');}`).catch(() => {});
  if (main) await Promise.race([main.evaluate("await window.__TAURI_INTERNALS__.invoke('quit_app');").catch(() => {}), delay(1_000)]);
  clients.forEach((client) => client.close());
  app.kill(); remoteSockets.forEach((socket) => socket.destroy());
  await new Promise((resolve) => remote.close(resolve));
  // The WebView process can release its profile shortly after the main process.
  await rm(isolated, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
