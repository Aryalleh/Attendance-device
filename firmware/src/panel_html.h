#pragma once
#include <Arduino.h>

// Local web panel (Persian, RTL) served by the device at http://<device-ip>/ or http://<name>.local/
// In server mode only Status + Settings are editable; cards/log live on the server.
// No external fonts: the device may run on its own Wi-Fi without internet.
const char PANEL_HTML[] PROGMEM = R"HTML(<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>دستگاه تردد</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--fg:#1d2330;--mut:#6b7280;--line:#e3e5ea;--acc:#2563eb;--ok:#16a34a;--bad:#dc2626}
@media(prefers-color-scheme:dark){:root{--bg:#111318;--card:#1a1d24;--fg:#e8eaee;--mut:#9aa1ad;--line:#2a2e37;--acc:#60a5fa;--ok:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;font:15px/1.6 Vazirmatn,Tahoma,"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:4px;padding:10px 12px;background:var(--card);border-bottom:1px solid var(--line);flex-wrap:wrap;align-items:center}
header b{margin-inline-end:auto}nav button{background:none;border:0;color:var(--mut);padding:6px 10px;border-radius:6px;font:inherit;cursor:pointer}
nav button.on{background:var(--acc);color:#fff}main{max-width:820px;margin:0 auto;padding:12px}
.box{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:12px}
h2{font-size:16px;margin:0 0 10px}table{width:100%;border-collapse:collapse}td,th{text-align:start;padding:6px 4px;border-bottom:1px solid var(--line);font-size:14px}
th{color:var(--mut);font-weight:500}.mono{font-family:ui-monospace,Consolas,monospace;direction:ltr;unicode-bidi:isolate}.mut{color:var(--mut)}
.ok{color:var(--ok)}.bad{color:var(--bad)}input,select{font:inherit;padding:7px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);width:100%}
input[dir=ltr]{text-align:left}
label{display:block;margin:8px 0 3px;color:var(--mut);font-size:13px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.row>*{flex:1;min-width:140px}
.btn{background:var(--acc);color:#fff;border:0;border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer;width:auto;flex:0 0 auto;min-width:0}
.btn.sec{background:var(--line);color:var(--fg)}.btn.red{background:var(--bad)}.btn.sm{padding:3px 9px;font-size:13px}
.kv{display:grid;grid-template-columns:130px 1fr;gap:4px 10px}.hide{display:none}#msg{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:8px 14px;border-radius:8px;display:none}
.scroll{overflow-x:auto}.chk{display:flex;gap:8px;align-items:center;color:var(--fg)}.chk input{width:auto}
</style></head><body>
<header><b id="title">دستگاه تردد</b><nav>
<button data-t="status" class="on">وضعیت</button><button data-t="cards">کارت‌ها</button><button data-t="log">گزارش</button><button data-t="settings">تنظیمات</button></nav></header>
<main>
<section id="t-status">
 <div class="box"><h2>دستگاه</h2><div class="kv" id="kv"></div></div>
 <div class="box"><h2>آخرین کارت</h2><div id="last" class="mut">هنوز کارتی خوانده نشده است.</div></div>
 <div class="box row"><button class="btn" onclick="act('/api/open')">باز کردن در</button><button class="btn sec" onclick="if(confirm('دستگاه راه‌اندازی مجدد شود؟'))act('/api/reboot')">راه‌اندازی مجدد</button></div>
</section>
<section id="t-cards" class="hide">
 <div class="box" id="srvCards"><p class="mut">حالت سرور: کارت‌ها در پنل سرور مدیریت می‌شوند. این فهرست، نسخه پشتیبان برای زمان قطعی سرور است.</p></div>
 <div class="box" id="addBox"><h2>افزودن کارت</h2>
  <div class="row"><div><label>نام</label><input id="cName" maxlength="32"></div><div><label>شناسه کارت (یا دکمه «ثبت با کارت‌زدن»)</label><input id="cUid" class="mono" dir="ltr" placeholder="04:A3:1B:2C"></div></div>
  <div class="row" style="margin-top:10px"><button class="btn" onclick="addCard()">ذخیره</button><button class="btn sec" onclick="enroll()">ثبت با کارت‌زدن</button><span id="enr" class="mut"></span></div>
 </div>
 <div class="box scroll"><h2>کارت‌ها <span id="cCount" class="mut"></span></h2><table><thead><tr><th>نام</th><th>شناسه</th><th>وضعیت</th><th></th></tr></thead><tbody id="cards"></tbody></table></div>
</section>
<section id="t-log" class="hide">
 <div class="box scroll"><div class="row" style="margin-bottom:8px"><h2>آخرین ترددها</h2><button class="btn sec sm" onclick="location='/log.csv?tz='+(-new Date().getTimezoneOffset())">خروجی اکسل (CSV)</button><button class="btn red sm" onclick="if(confirm('کل گزارش حذف شود؟'))act('/api/log/clear').then(loadLog)">پاک کردن</button></div>
 <table><thead><tr><th>زمان</th><th>نام</th><th>شناسه</th><th>نتیجه</th><th>جهت</th></tr></thead><tbody id="log"></tbody></table></div>
</section>
<section id="t-settings" class="hide">
 <div class="box"><h2>حالت کار</h2>
  <select id="s-mode"><option value="standalone">مستقل — کارت‌ها و گزارش روی همین دستگاه</option><option value="server">سرور — تصمیم و ثبت گزارش با سرور</option></select>
  <div class="row"><div><label>نام دستگاه (انگلیسی)</label><input id="s-deviceName" dir="ltr"></div><div><label>جهت تردد</label><select id="s-direction"><option value="toggle">متناوب (ورود/خروج)</option><option value="in">فقط ورود</option><option value="out">فقط خروج</option></select></div><div><label>زمان باز ماندن قفل (میلی‌ثانیه)</label><input id="s-openMs" type="number" dir="ltr" min="500" max="30000"></div></div>
 </div>
 <div class="box"><h2>وای‌فای</h2>
  <label class="chk"><input type="checkbox" id="s-apOnly"> بدون روتر — دستگاه وای‌فای خودش را می‌سازد (فقط حالت مستقل)</label>
  <div class="row"><div><label>نام وای‌فای روتر (SSID)</label><input id="s-wifiSsid" dir="ltr"></div><div><label>رمز وای‌فای روتر</label><input id="s-wifiPass" type="password" dir="ltr" placeholder="بدون تغییر"></div><div><label>رمز وای‌فای دستگاه (حداقل ۸)</label><input id="s-apPass" type="password" dir="ltr" placeholder="بدون تغییر"></div></div>
  <label>سرور زمان NTP (نیاز به اینترنت)</label><input id="s-ntpServer" dir="ltr">
 </div>
 <div class="box" id="srvBox"><h2>سرور</h2>
  <div class="row"><div><label>آدرس سرور</label><input id="s-serverUrl" dir="ltr" placeholder="http://192.168.1.10:8080 / https://….workers.dev"></div><div><label>کلید دستگاه (از صفحه «درها» در پنل سرور)</label><input id="s-deviceKey" type="password" dir="ltr" placeholder="بدون تغییر"></div></div>
  <label class="chk"><input type="checkbox" id="s-offlineFallback"> اگر سرور در دسترس نبود، از فهرست ذخیره‌شده کارت‌ها استفاده شود</label>
 </div>
 <div class="box"><h2>ورود به پنل</h2>
  <div class="row"><div><label>نام کاربری</label><input id="s-adminUser" dir="ltr"></div><div><label>رمز جدید</label><input id="s-adminPass" type="password" dir="ltr" placeholder="بدون تغییر"></div></div>
 </div>
 <button class="btn" onclick="saveSettings()">ذخیره و راه‌اندازی مجدد</button>
</section>
</main><div id="msg"></div>
<script>
const $=s=>document.querySelector(s);let S={},tab='status',C=[];
const RES={granted:'مجاز',denied:'رد شد',unknown:'کارت ناشناس',enrolled:'ثبت شد',manual:'باز کردن دستی',disabled:'مسدود',expired:'منقضی',full:'حافظه کارت‌ها پر است'};
const DIR={in:'ورود',out:'خروج'};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=x=>Number(x).toLocaleString('fa-IR');
const fmt=t=>{if(t<=1600000000)return '(زمان تنظیم نشده)';const d=new Date(t*1000);return d.toLocaleDateString('fa-IR')+' '+d.toLocaleTimeString('fa-IR')};
function toast(t){const m=$('#msg');m.textContent=t;m.style.display='block';clearTimeout(m._t);m._t=setTimeout(()=>m.style.display='none',2500)}
async function api(u,body){const r=await fetch(u,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||('خطا '+r.status));throw j}return j}
async function act(u,b){const j=await api(u,b||{});toast(j.message||'انجام شد');return j}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>show(b.dataset.t));
function show(t){tab=t;document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on',b.dataset.t==t));
 document.querySelectorAll('main>section').forEach(s=>s.classList.toggle('hide',s.id!='t-'+t));
 ({status:loadStatus,cards:loadCards,log:loadLog,settings:loadSettings})[t]()}
async function loadStatus(){S=await api('/api/status');const srv=S.mode=='server';
 $('#title').textContent=S.deviceName;
 const rows=[['حالت',srv?'سرور':'مستقل'],['شبکه',esc(S.network)],['IP','<span class=mono>'+S.ip+'</span>'],['قدرت سیگنال',S.rssi?'<span class=mono>'+S.rssi+' dBm</span>':'—'],['زمان',fmt(S.time)],
  ['تعداد کارت',n(S.cards)],['کارت‌خوان',S.readerOk?'<span class=ok>سالم</span>':'<span class=bad>شناسایی نشد</span>'],['مدت روشن بودن',n(Math.round(S.uptime/60))+' دقیقه'],['حافظه آزاد',n(S.heap)+' بایت'],['نسخه',S.fw]];
 if(srv)rows.splice(2,0,['سرور',S.serverOk?'<span class=ok>متصل</span>':'<span class=bad>در دسترس نیست</span>'+(S.queued?' (رویدادها در صف ارسال)':'')]);
 $('#kv').innerHTML=rows.map(r=>`<span class=mut>${r[0]}</span><span>${r[1]}</span>`).join('');
 if(S.lastResult){$('#last').innerHTML=(S.lastUid?`<span class=mono>${esc(S.lastUid)}</span> — `:'')+(S.lastName?`<b>${esc(S.lastName)}</b> — `:'')+`${esc(RES[S.lastResult]||S.lastResult)} <span class=mut>${fmt(S.lastTime)}</span>`+
  (!srv&&S.lastResult=='unknown'?` <button class="btn sm" onclick="addLast()">ثبت این کارت</button>`:'')}
 $('#addBox').classList.toggle('hide',srv);$('#srvCards').classList.toggle('hide',!srv)}
function addLast(){show('cards');$('#cUid').value=S.lastUid;$('#cName').focus()}
async function loadCards(){if(!S.mode)await loadStatus();const srv=S.mode=='server';C=await api('/api/cards');
 $('#cCount').textContent='('+n(C.length)+')';
 $('#cards').innerHTML=C.map((k,i)=>`<tr><td>${esc(k.name)}</td><td class=mono>${esc(k.uid)}</td><td>${k.enabled?'<span class=ok>مجاز</span>':'<span class=bad>مسدود</span>'}${k.inside?' <span class=mut>· داخل</span>':''}</td><td style="white-space:nowrap">`+
 (srv?'':`<button class="btn sec sm" onclick="editCard(${i})">ویرایش</button> <button class="btn sec sm" onclick="toggleCard(${i})">${k.enabled?'مسدود کن':'مجاز کن'}</button> <button class="btn red sm" onclick="delCard(${i})">حذف</button>`)+'</td></tr>').join('')||'<tr><td colspan=4 class=mut>هنوز کارتی ثبت نشده است.</td></tr>'}
function editCard(i){$('#cName').value=C[i].name;$('#cUid').value=C[i].uid;$('#cName').focus()}
async function addCard(){await act('/api/cards',{uid:$('#cUid').value,name:$('#cName').value,enabled:true});$('#cUid').value='';$('#cName').value='';loadCards()}
async function toggleCard(i){const k=C[i];await act('/api/cards',{uid:k.uid,name:k.name,enabled:!k.enabled});loadCards()}
async function delCard(i){const k=C[i];if(confirm('کارت «'+k.name+'» حذف شود؟')){await act('/api/cards/delete',{uid:k.uid});loadCards()}}
async function enroll(){const nm=$('#cName').value.trim();if(!nm){toast('ابتدا نام را وارد کنید');return}
 await act('/api/enroll',{name:nm});$('#enr').textContent='کارت را جلوی دستگاه بگیرید…';
 const t0=Date.now();const iv=setInterval(async()=>{const e=await api('/api/enroll');
  if(!e.armed){clearInterval(iv);$('#enr').textContent=e.uid?'ثبت شد: '+e.uid:'';$('#cName').value='';loadCards()}
  else if(Date.now()-t0>32000){clearInterval(iv);$('#enr').textContent='زمان تمام شد'}},1000)}
async function loadLog(){const l=await api('/api/log?n=100');
 $('#log').innerHTML=l.map(e=>`<tr><td style="white-space:nowrap">${fmt(e.t)}</td><td>${esc(e.name)}</td><td class=mono>${esc(e.uid)}</td><td class=${e.r=='granted'||e.r=='enrolled'||e.r=='manual'?'ok':'bad'}>${esc(RES[e.r]||e.r)}</td><td>${DIR[e.d]||'—'}</td></tr>`).join('')||'<tr><td colspan=5 class=mut>خالی است.</td></tr>'}
async function loadSettings(){const s=await api('/api/settings');
 for(const[k,v]of Object.entries(s)){const el=$('#s-'+k);if(!el)continue;if(el.type=='checkbox')el.checked=v;else if(el.type!='password')el.value=v}
 $('#s-deviceKey').placeholder=s.hasDeviceKey?'بدون تغییر':'تنظیم نشده';syncSrvBox()}
function syncSrvBox(){$('#srvBox').style.opacity=$('#s-mode').value=='server'?1:.5}
$('#s-mode').onchange=syncSrvBox;
async function saveSettings(){const o={};document.querySelectorAll('[id^=s-]').forEach(el=>{const k=el.id.slice(2);
 o[k]=el.type=='checkbox'?el.checked:el.type=='number'?+el.value:el.value});
 await act('/api/settings',o);toast('ذخیره شد — دستگاه راه‌اندازی مجدد می‌شود. حدود ۱۰ ثانیه بعد دوباره وصل شوید.')}
api('/api/time',{epoch:Math.floor(Date.now()/1000)}).catch(()=>{});
loadStatus();setInterval(()=>{if(tab=='status')loadStatus().catch(()=>{})},3000);
</script></body></html>)HTML";
