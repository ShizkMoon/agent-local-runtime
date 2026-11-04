import fs from 'fs';
const F = 'dir-6.html';
let s = fs.readFileSync(F, 'utf8');
const rep = (name, from, to) => {
  if (!s.includes(from)) { console.log('MISS ' + name); return; }
  s = s.replace(from, to); console.log('ok   ' + name);
};

/* 1) rp-body：需要你 + 产物 + 子代理 三区 */
rep('rp-body',
`    <div class="rp-body"><div class="rp-cells" id="pane-inbox"></div></div>`,
`    <div class="rp-body">
      <div class="rp-cells" id="pane-inbox"></div>
      <div class="rp-sub"><div class="rp-subh">产物</div><div id="artDock"></div></div>
      <div class="rp-sub"><div class="rp-subh">子代理</div><div id="subDock"></div></div>
    </div>`);

/* 2) 中栏移除 .arts（产物搬右栏） */
rep('arts-out',
`  h += '<div class="arts">'+
    '<div class="art"><div class="ah"><span class="fn">agent-ui-survey.md</span><span class="ft">MD</span></div>'+
    '<div class="bd serif"><span class="hh"># Agent 界面调研</span><br>- Claude Desktop · token 于 localStorage<br>- Cursor · state.vscdb / cursorAuth<br>- Windsurf · cascade 代理注入</div>'+
    '<div class="st">12 KB · 摘要 v3 源稿</div></div>'+
    '<div class="art"><div class="ah"><span class="fn">notes/survey.md</span><span class="ft">DIFF</span></div>'+
    '<div class="bd mono"><span class="p">+ ## token 抓取路径</span><br><span class="p">+ cdk_ 前缀 → session?</span><br><span class="m">- ~~token 固定为 UUID~~</span></div>'+
    '<div class="st"><span class="p">+128</span> <span class="m">−46</span>  · 未提交</div></div>'+
    '<div class="art"><div class="ah"><span class="fn">capture-claude.html</span><span class="ft">PAGE</span></div>'+
    '<div class="pm"><div class="bar"><i></i><i></i><i></i></div><div class="empty">空窗口 · 未捕获内容</div></div>'+
    '<div class="st">窗口快照 · 10:03</div></div></div>';
`, '');

/* 3) 新区块 CSS */
rep('css',
`.rp-cells{display:flex;flex-direction:column;gap:10px}`,
`.rp-cells{display:flex;flex-direction:column;gap:10px}
.rp-sub{margin-top:18px}
.rp-subh{font-family:var(--f-mono);font-size:11px;color:var(--t3);letter-spacing:.06em;padding:0 2px 7px;border-bottom:1px solid var(--ln);margin-bottom:8px}
.artl{display:flex;align-items:center;gap:9px;width:100%;padding:7px 8px;border:1px solid var(--ln);border-radius:var(--r-sub);background:var(--s2);cursor:pointer;transition:border-color var(--t-ui) var(--e),background var(--t-ui) var(--e);margin-bottom:6px}
.artl:hover{border-color:var(--ln-hi);background:var(--s3)}
.artl .ft{font-family:var(--f-mono);font-size:9.5px;letter-spacing:.08em;color:var(--t3);border:1px solid var(--ln);border-radius:4px;padding:2px 5px;flex:none}
.artl .fn{flex:1;min-width:0;font-size:13px;color:var(--t1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.artl .sz{flex:none;font-family:var(--f-mono);font-size:10.5px;color:var(--t3)}
.subrow{display:flex;align-items:center;gap:8px;width:100%;padding:7px 4px;border-bottom:1px solid var(--ln);background:none;border-left:none;border-right:none;border-top:none;cursor:pointer;text-align:left;transition:background var(--t-ui) var(--e)}
.subrow:hover{background:var(--hov)}
.subrow .nm{flex:1;min-width:0;font-size:13px;color:var(--t1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.subrow .stm{flex:none;font-family:var(--f-mono);font-size:10.5px;color:var(--t3)}
.sub-empty{padding:10px 4px;font-size:12.5px;color:var(--t3)}`);

/* 4) mock 产物数据 + 渲染三区 */
rep('data',
`var SETTLED = [`,
`var ARTS = [
  {ft:"MD",   fn:"agent-ui-survey.md",   sz:"12 KB", body:"# Agent 界面调研\\n\\n- Claude Desktop · token 于 localStorage\\n- Cursor · state.vscdb / cursorAuth\\n- Windsurf · cascade 代理注入\\n\\n## token 抓取路径\\ncdk_ 前缀 → session?"},
  {ft:"DIFF", fn:"notes/survey.md",      sz:"+128 −46", body:"+ ## token 抓取路径\\n+ cdk_ 前缀 → session?\\n- ~~token 固定为 UUID~~"},
  {ft:"PAGE", fn:"capture-claude.html",  sz:"快照", body:"(网页产物 · 点击「打开」查看渲染页）"},
  {ft:"PDF",  fn:"interface-survey.pdf", sz:"340 KB", body:"(PDF 产物 · 点击「打开」调用系统阅读器）"}
];

var SETTLED = [`);

rep('render',
`  $("#sideExtra").innerHTML = sideHtml;`,
`  renderSubs(null);`);

/* sideHtml 已无产物，改回 facts-only 注入中栏 —— sideHtml 变量残留清理 */
rep('sideHtml-clean',
`  var sideHtml = '<div class="facts">'+r.facts.map(function(f){
    return '<div class="fcell"><p>'+f[0]+'</p><span class="src">'+f[1]+'</span></div>';
  }).join("")+'</div>';

  h += '<div class="facts">'+r.facts.map(function(f){
    return '<div class="fcell"><p>'+f[0]+'</p><span class="src">'+f[1]+'</span></div>';
  }).join("")+'</div>';
`,
`  h += '<div class="facts">'+r.facts.map(function(f){
    return '<div class="fcell"><p>'+f[0]+'</p><span class="src">'+f[1]+'</span></div>';
  }).join("")+'</div>';
`);

/* 5) openSheet 泛化为 openSheetFor(n)；产物/子代理渲染器 */
rep('sheet-fn',
`function openSheet(el){
  var nm = el.dataset.nm;
  var n = findNode(RUNS[currentRun].tree, nm) || {};
  var st = n.st || el.dataset.st;`,
`function openSheet(el){ openSheetFor(findNode(RUNS[currentRun].tree, el.dataset.nm) || {nm:el.dataset.nm, st:el.dataset.st}); }
function openSheetFor(n){
  var nm = n.nm || "";
  var st = n.st || "working";`);

rep('sheet-kv',
`  var kv = '<div class="sh-row"><span>状态</span><b>'+(ST_LABEL[st]||st)+'</b></div>'+
           (n.el?'<div class="sh-row"><span>耗时</span><b class="num">'+n.el+'</b></div>':"")+
           (n.d?'<div class="sh-row"><span>当前</span><b>'+n.d+'</b></div>':"")+
           (n.wb?'<div class="sh-row"><span>等待</span><b>'+(WB_LABEL[n.wb]||n.wb)+'</b></div>':"");
  var log = n.log ? '<pre class="sh-log">'+n.log.join("\\n")+'</pre>' : "";
  var act = st==="input"
    ? '<button class="opt solid" id="shGo">在需要你中处理</button>'
    : (log? "" : '<div class="sh-note">子任务 · 独立进程运行</div>');`,
`  var kv = n.body
    ? '<pre class="sh-log">'+n.body+'</pre>'
    : '<div class="sh-row"><span>状态</span><b>'+(ST_LABEL[st]||st)+'</b></div>'+
      (n.el?'<div class="sh-row"><span>耗时</span><b class="num">'+n.el+'</b></div>':"")+
      (n.d?'<div class="sh-row"><span>当前</span><b>'+n.d+'</b></div>':"")+
      (n.wb?'<div class="sh-row"><span>等待</span><b>'+(WB_LABEL[n.wb]||n.wb)+'</b></div>':"")+
      (n.log?'<pre class="sh-log">'+n.log.join("\\n")+'</pre>':"");
  var act = n.body
    ? '<button class="opt solid" id="shOpen">打开</button>'
    : st==="input"
      ? '<button class="opt solid" id="shGo">在需要你中处理</button>'
      : (n.log? "" : '<div class="sh-note">子任务 · 独立进程运行</div>');`);

rep('sheet-bind',
`  var go=$("#shGo"); if(go) go.addEventListener("click",function(){ closeSheet(); document.querySelector('[data-nav="inbox"]').click(); });`,
`  var go=$("#shGo"); if(go) go.addEventListener("click",function(){ closeSheet(); document.querySelector('[data-nav="inbox"]').click(); });
  var so=$("#shOpen"); if(so) so.addEventListener("click",function(){ so.textContent="已交给系统打开"; });`);

/* 6) 三区渲染器 + 节点点击联动 */
rep('renderers',
`/* ================= inbox ================= */`,
`/* ================= 右栏三区：产物 / 子代理 ================= */
function renderArts(){
  $("#artDock").innerHTML = ARTS.map(function(a,i){
    return '<button class="artl" data-a="'+i+'"><span class="ft">'+a.ft+'</span><span class="fn">'+a.fn+'</span><span class="sz">'+a.sz+'</span></button>';
  }).join("");
  Array.prototype.forEach.call(document.querySelectorAll("#artDock .artl"),function(el){
    el.addEventListener("click",function(){ var a=ARTS[+el.dataset.a]; openSheetFor({nm:a.fn,body:a.body}); });
  });
}
function renderSubs(nd){
  var kids = nd && nd.fold ? nd.fold : null;
  if(!kids){ $("#subDock").innerHTML = nd ? '<div class="sub-empty">无下级子代理</div>' : '<div class="sub-empty">点选一个子任务查看其下级</div>'; return; }
  $("#subDock").innerHTML = kids.map(function(k){
    return '<button class="subrow"><span class="dot '+k.st+'"></span><span class="nm">'+k.nm+'</span><span class="stm">'+(ST_LABEL[k.st]||k.st)+' · '+(k.el||"—")+'</span></button>';
  }).join("");
  Array.prototype.forEach.call(document.querySelectorAll("#subDock .subrow"),function(el,i){
    el.addEventListener("click",function(){ openSheetFor(kids[i]); });
  });
}

/* ================= inbox ================= */`);

rep('treeclick',
`      el.classList.add("sel");
      openSheet(el);`,
`      el.classList.add("sel");
      var nd = findNode(RUNS[currentRun].tree, el.dataset.nm);
      renderSubs(nd);
      openSheet(el);`);

rep('boot',
`renderRun();
renderDset();`,
`renderRun();
renderArts();
renderSubs(null);
renderDset();`);

fs.writeFileSync(F, s);
const m = [...s.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
m.forEach((x, i) => { try { new Function(x[1]); console.log('script' + i + ' OK'); } catch (e) { console.log('script' + i + ' FAIL ' + e.message); } });
console.log('size', s.length);
