import fs from 'fs';
const F = 'dir-6.html';
let src = fs.readFileSync(F, 'utf8');
const log = [];
const rep = (name, re, to) => {
  const n = (src.match(re) || []).length;
  src = src.replace(re, to);
  log.push(name + ': ' + n);
};

// 1) 英文枚举残留
rep('uncommitted', /· uncommitted/, ' · 未提交');

// 2) 删 .sec-lab CSS 块
rep('sec-lab css', /\/\* 分区标签 —— mono 小标签 \+ hairline \*\/\n\.sec-lab\{[^}]*\}\n\.sec-lab \.ln\{[^}]*\}\n/, '');

// 3) root card 里的 rollup badge（祖先行已有 1 待处理）
rep('rollup-in-root', /\(awaiting\?'<span class="rollup"[^']*'>[^']*<\/span>':'<span class="rollup clear"[^']*'>[^']*<\/span>'\)\+\n?/, '');

// 4) sec-lab 渲染行删掉
rep('sec-lab render', /  h \+= '<div class="sec-lab">[^']*';?\n/g, '');

// 5) facts+arts 从 h+= 改为侧栏注入
rep('facts-out', /  h \+= '<div class="facts">'\+r\.facts\.map\(function\(f\)\{\n    return '<div class="fcell"><p>'\+f\[0\]\+'<\/p><span class="src">'\+f\[1\]\+'<\/span><\/div>';\n  \}\)\.join\(""\)\+'<\/div>';\n\n/,
  `  var sideHtml = '<div class="facts">' + r.facts.map(function(f){
    return '<div class="fcell"><p>' + f[0] + '</p><span class="src">' + f[1] + '</span></div>';
  }).join("") + '</div>';

`);

rep('arts-out', /  h \+= '<div class="arts">'\+([\s\S]*?)'<\/div><\/div>';\n/, (m, inner) =>
  `  sideHtml += '<div class="arts">'+\n${inner}'</div></div>';
  $("#sideExtra").innerHTML = sideHtml;
`);

// 6) dset + dpop 从 composer 挪到右栏 rp-foot
rep('dset-out', /          <button class="dset" id="dset"><span id="dsetText">[^<]*<\/span><svg[^>]*><path d="m6 9 6 6 6-6"\/><\/svg><\/button>\n/, '');
rep('dpop-out', /        <div class="dpop" id="dpop"><\/div>\n/, '');
rep('rp-foot-in', /    <div class="rp-body" id="pane-inbox"><\/div>\n  <\/aside>/,
`    <div class="rp-body"><div class="rp-cells" id="pane-inbox"></div><div id="sideExtra"></div></div>
    <div class="rp-foot">
      <button class="dset" id="dset"><span id="dsetText">任务 · 标准 · qwen3-32b · 高</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg></button>
      <div class="dpop" id="dpop"></div>
    </div>
  </aside>`);

// 7) rp-body 的 mask 渐隐删掉（挡内容）
rep('mask', /  -webkit-mask-image:[^;]+;\n          mask-image:[^;]+;\n/, '');

// 8) 新 CSS：rp-foot、侧栏 arts 单列、facts 在窄栏
rep('css-add', /\/\* ============ 右栏：需要你 inbox ============ \*\//,
`/* ============ 右栏：需要你 inbox ============ */
.rp-foot{flex:none;position:relative;border-top:1px solid var(--ln);padding:8px 12px;display:flex;align-items:center}
.rp-foot .dpop{left:8px;right:8px;bottom:44px;min-width:0}
.rp-cells{display:flex;flex-direction:column;gap:10px;margin-bottom:14px}
#sideExtra .arts{grid-template-columns:1fr}
#sideExtra .facts{margin:2px 0 12px}
`);

// 9) .composer 上残留的 dpop 绝对定位上下文不用动（dpop 已搬走）

fs.writeFileSync(F, src);
const m = [...src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
m.forEach((s, i) => { try { new Function(s[1]); console.log('script' + i + ' OK'); } catch (e) { console.log('script' + i + ' FAIL ' + e.message); } });
console.log(log.join('\n'));
console.log('size', src.length);
