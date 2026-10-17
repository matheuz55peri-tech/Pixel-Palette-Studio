/* Pixel Palette Flipbook — Blockbench plugin (local install)
 * Generates a vertical animated texture from a selected texture (first frame) or a blank canvas.
 */
(function () {
  'use strict';
  const PLUGIN_ID = 'pixel_palette_flipbook_studio';
  const CURRENT_VERSION = '2.4.0';
  const REPOSITORY = 'matheuz55peri-tech/Pixel-Palette-Studio';
  const RAW_BASE = 'https://raw.githubusercontent.com/' + REPOSITORY + '/main/';
  let updateAction = null;
  let checkedUpdates = false;
  function compareVersions(a,b) {
    const aa=String(a).split('.').map(n=>parseInt(n,10)||0),bb=String(b).split('.').map(n=>parseInt(n,10)||0);
    for(let i=0;i<Math.max(aa.length,bb.length);i++) if((aa[i]||0)!==(bb[i]||0)) return (aa[i]||0)>(bb[i]||0)?1:-1;
    return 0;
  }
  async function checkUpdates(silent=false) {
    try {
      const response=await fetch(RAW_BASE+'version.json?nocache='+Date.now(),{cache:'no-store'});
      if(!response.ok) throw new Error('HTTP '+response.status);
      const data=await response.json();
      if(!data || !/^\d+\.\d+\.\d+$/.test(data.version) || data.url!==RAW_BASE+'pixel_palette_flipbook_studio.js')throw new Error('Manifesto de atualização inválido.');
      if(compareVersions(data.version,CURRENT_VERSION)<=0){
        if(!silent)Blockbench.showMessageBox({title:'Pixel Palette Studio',message:'Você já está na versão mais recente ('+CURRENT_VERSION+').'});
        return;
      }
      const plugin=typeof Plugins!=='undefined'&&Plugins.registered?Plugins.registered[PLUGIN_ID]:null;
      Blockbench.showMessageBox({
        title:'Pixel Palette Studio · atualização '+data.version,
        message:'Versão '+data.version+' disponível.\n'+String(data.notes||'').slice(0,400)+'\n\nOrigem: '+REPOSITORY+'\n\nDeseja atualizar agora?',
        buttons:['Atualizar agora','Depois']
      }, answer=>{
        if(answer!==0)return;
        try {
          if(plugin && plugin.source==='url' && typeof plugin.reload==='function') plugin.reload();
          else if(typeof Blockbench.openLink==='function') Blockbench.openLink(data.url);
          else Blockbench.showQuickMessage('Abra o URL do plugin no GitHub para reinstalar.');
        }catch(e){Blockbench.showQuickMessage('Erro na atualização: '+e.message,4000);}
      });
    }catch(err){if(!silent)Blockbench.showMessageBox({title:'Atualizações indisponíveis',message:String(err.message||err)});}
  }
  let menuAction = null;
  let textureContextAction = null;
  let activeTexture = null;
  let dialog = null;
  let runningTimer = null;
  let pendingTimer = null;
  let cleanupFns = [];
  const $ = id => document.getElementById('ppf_' + id);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const color = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const ease = (t, kind) => kind === 'smooth' ? t * t * (3 - 2 * t) : kind === 'sine' ? (1 - Math.cos(Math.PI * t)) / 2 : t;
  function stop() {
    if (runningTimer) clearInterval(runningTimer);
    if (pendingTimer) clearTimeout(pendingTimer);
    runningTimer = pendingTimer = null;
    cleanupFns.forEach(fn => { try { fn(); } catch (_) {} });
    cleanupFns = [];
    dialog = null;
  }
  function message(text, error = false) {
    const node = $('status');
    if (node) { node.textContent = text; node.style.color = error ? '#ff8d95' : '#9dedbf'; }
    if (error && typeof Blockbench !== 'undefined' && Blockbench.showQuickMessage) Blockbench.showQuickMessage(text, 3500);
  }
  function resolveTexture() {
    if (typeof Texture === 'undefined') return null;
    const list = Array.isArray(Texture.all) ? Texture.all : [];
    const found = activeTexture && list.includes(activeTexture) ? activeTexture : null;
    if (found) return found;
    if (Texture.selected && list.includes(Texture.selected)) return Texture.selected;
    return list.find(t => t && t.selected) || list.find(t => t && t.visible !== false) || list[0] || null;
  }
  function getSource() {
    const tex = resolveTexture();
    const width = tex ? Number(tex.uv_width || tex.width || 16) : clamp(Number($('width')?.value || 16), 1, 128);
    const height = tex ? Number(tex.uv_height || (tex.frameCount > 1 ? Math.round(tex.height / tex.frameCount) : tex.height) || 16) : clamp(Number($('height')?.value || 16), 1, 128);
    const w = Math.round(width), h = Math.round(height);
    if (!w || !h || w > 512 || h > 512) throw new Error('Tamanho inválido da textura.');
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', {willReadFrequently: true});
    ctx.imageSmoothingEnabled = false;
    if (tex) {
      const img = tex.canvas && tex.canvas.width ? tex.canvas : tex.img;
      if (!img || !img.width || !img.height) throw new Error('A textura selecionada ainda não carregou.');
      // The source can already be an animated strip: always use the first frame only.
      ctx.drawImage(img, 0, 0, Math.min(w, img.width), Math.min(h, img.height), 0, 0, w, h);
    } else {
      const fill = color($('base').value);
      ctx.fillStyle = `rgb(${fill.join(',')})`;
      ctx.fillRect(0, 0, w, h);
    }
    return {w, h, pixels: ctx.getImageData(0, 0, w, h).data, name: tex ? tex.name.replace(/\.png$/i, '') : 'pixel_art'};
  }
  function readSettings() {
    return {
      a: color($('base').value), b: color($('target').value),
      frames: clamp(Math.round(Number($('frames').value) || 16), 2, 128),
      fps: clamp(Number($('fps').value) || 8, 1, 20),
      tolerance: clamp(Number($('tolerance').value) || 0, 0, 255),
      mask: $('mask').value, easing: $('ease').value,
      loop: $('loop').checked, shade: $('shade').checked,
      preset: $('preset').value, intensity: Number($('intensity').value)/100,
      band: Number($('band').value), angle: Number($('angle')?.value ?? 30)/100,
      glow: color($('glow').value), coverage: $('coverage').value,
      reverse: $('reverse').checked
    };
  }
  function mixRGB(original, target, amount) {
    const a = clamp(amount, 0, 1);
    return [0,1,2].map(i => clamp(Math.round(lerp(original[i], target[i], a)),0,255));
  }
  function makeFrames(src, s) {
    if (src.w * src.h * s.frames > 4194304) throw new Error('Textura muito grande. Reduza a resolução ou os frames.');
    const strip = document.createElement('canvas'); strip.width = src.w; strip.height = src.h * s.frames;
    const ctx = strip.getContext('2d', {willReadFrequently:true});
    const data = new Uint8ClampedArray(src.pixels);
    const isPalette = s.preset === 'palette';
    const progress = f => s.reverse ? 1 - f/(s.frames-1) : f/(s.frames-1);
    // Deterministic glitter: no random flicker on re-render.
    const hash = (x,y,f) => {let n = Math.imul(x + 1231, 374761393) ^ Math.imul(y+7, 668265263) ^ Math.imul(f+19, 1442695041); n = Math.imul(n ^ n>>>13, 1274126177);return ((n ^ n>>>16)>>>0)/4294967295;};
    for (let f = 0; f < s.frames; f++) {
      data.set(src.pixels);
      const t0 = progress(f);
      let t = s.loop ? (1-Math.cos(2*Math.PI*f/s.frames))/2 : t0;
      t = ease(t, s.easing);
      const base = [0,1,2].map(i=>lerp(s.a[i],s.b[i],t));
      const sweepPos = -s.band*1.5 + t0*(src.h + 3*s.band);
      const diagPos = -s.band*1.5 + t0*(src.h+src.w*0.8+3*s.band);
      for (let y=0;y<src.h;y++) for(let x=0;x<src.w;x++) {
        const p=(y*src.w+x)*4;
        if (!src.pixels[p+3]) continue;
        const original=[src.pixels[p],src.pixels[p+1],src.pixels[p+2]];
        const dist=Math.hypot(...original.map((v,i)=>v-s.a[i]));
        const selected = s.coverage === 'all' || s.mask === 'all' || dist <= s.tolerance;
        if (!selected) continue;
        let output = original;
        if(isPalette) {
          const difference=original.map((v,i)=>v-s.a[i]);
          output = s.shade ? base.map((v,i)=>clamp(Math.round(v+difference[i]),0,255)) : base.map(Math.round);
        } else {
          let strength = 0;
          const reach=Math.max(0.45,s.band);
          const bell = delta => Math.pow(Math.max(0,1-Math.abs(delta)/reach),1.6);
          if(s.preset==='vertical') strength=bell((src.h-1-y)-sweepPos + s.band);
          if(s.preset==='diagonal') strength=bell((src.h-1-y)+(src.w-1-x)*0.8-diagPos+s.band);
          if(s.preset==='horizontal') strength=bell(x-(-s.band+t0*(src.w+2*s.band)));
          if(s.preset==='pulse') strength=Math.pow(Math.max(0,Math.sin(Math.PI*t0)),1.4);
          if(s.preset==='sparkle') {
            const active=Math.max(0,1-Math.abs(t0-0.5)*2);
            const seed = hash(x,y,0);
            const phase=hash(x,y,1);
            const sparkle=Math.max(0,1-Math.abs(t0-phase)*s.frames/2);
            const edge = (x>0&&x<src.w-1&&y>0&&y<src.h-1) ? 1 : 0.5;
            strength=seed>0.89 ? Math.max(sparkle,active*0.14)*edge : 0;
          }

          if(s.preset==='gold') {const wave=(Math.sin(x*0.52+y*0.26-2*Math.PI*t0)*0.5+0.5);const glint=hash(x,y,0)>0.92?Math.pow(Math.max(0,Math.sin(2*Math.PI*(t0+hash(x,y,1)))),8):0;strength=clamp(0.12+0.47*wave+0.66*glint,0,1);}
          if(s.preset==='rune') {const glyph=((x*7+y*11)%13<3)||((x+2*y)%11===0);const scroll=(Math.sin((y+f*src.h/s.frames)*0.62+x*0.32)*0.5+0.5);strength=glyph?0.25+scroll*0.75:scroll*0.13;}
          if(s.preset==='spectral') {const wave=Math.sin(2*Math.PI*t0*2-x*0.34-y*0.45);strength=Math.pow(Math.max(0,wave),1.7)*0.85+0.12;}
          if(s.preset==='arcane') {const radial=Math.hypot((x+0.5-src.w/2)/Math.max(1,src.w),(y+0.5-src.h/2)/Math.max(1,src.h));const pulse=Math.pow(Math.max(0,Math.sin(2*Math.PI*t0*2-radial*8)),2);const motes=hash(x,y,0)>0.9?Math.pow(Math.max(0,Math.sin(2*Math.PI*(t0+hash(x,y,1)))),6):0;strength=clamp(pulse*0.68+motes*0.65,0,1);}
          if(s.preset==='chromatic') {const phase=(t0+x/Math.max(1,src.w)*0.32+y/Math.max(1,src.h)*0.18)%1;const tint=[Math.round(150+105*(0.5+0.5*Math.sin(2*Math.PI*phase))),Math.round(75+110*(0.5+0.5*Math.sin(2*Math.PI*(phase+0.36)))),Math.round(150+105*(0.5+0.5*Math.sin(2*Math.PI*(phase+0.67))))];output=mixRGB(original,tint,Math.min(0.92,s.intensity*0.82));for(let i=0;i<3;i++)data[p+i]=output[i];continue;}
          if(s.preset==='embers') {const hot=hash(x,y,0)>0.84;const phase=hash(x,y,1);const blink=Math.pow(Math.max(0,Math.sin(2*Math.PI*(t0+phase))),5);strength=hot?blink:0.08*Math.max(0,Math.sin(2*Math.PI*t0-y*0.35));}
          if(s.preset==='edge') {
            let borders=0;
            for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
              const xx=x+dx,yy=y+dy;
              if(xx<0||yy<0||xx>=src.w||yy>=src.h||!src.pixels[(yy*src.w+xx)*4+3]) borders++;
            }
            strength = borders ? Math.pow(Math.sin(Math.PI*t0),2) : 0;
          }
          // Respect the original sprite's opaque silhouette. Light is color only.
          output=mixRGB(original,s.glow,strength*s.intensity);
        }
        for(let i=0;i<3;i++) data[p+i]=output[i];
      }
      ctx.putImageData(new ImageData(data,src.w,src.h),0,f*src.h);
    }
    return strip;
  }
  function frameAt(strip, index, w, h, dest) {
    const ctx = dest.getContext('2d'); ctx.imageSmoothingEnabled = false;
    dest.width = w; dest.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(strip, 0, index * h, w, h, 0, 0, w, h);
  }
  function launch(preset = 'vertical', texture = null) {
    stop();
    activeTexture = texture && typeof Texture !== 'undefined' && Texture.all?.includes(texture) ? texture : resolveTexture();
    const presetNames = ['vertical','diagonal','horizontal','pulse','sparkle','edge','palette','gold','rune','spectral','arcane','chromatic','embers'];
    if (!presetNames.includes(preset)) preset = 'vertical';
    const html = `
    <style>
      #ppf_root{font-family:inherit;color:var(--color-text,#eee);max-width:900px;margin:auto}
      #ppf_root *{box-sizing:border-box}
      #ppf_root .presets{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin-bottom:14px}
      #ppf_root .preset{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-height:64px;padding:7px 4px;border:1px solid #62576e;border-radius:9px;background:#312a3c;cursor:pointer;font-size:11px;color:#ddd;transition:background .16s,border .16s}
      #ppf_root .preset b{font-size:19px;color:#f0cfff;font-weight:500}
      #ppf_root .preset.active{border-color:#da9ffc;background:#694078;box-shadow:0 0 0 1px #c781e744 inset}
      #ppf_root .preset:focus-visible{outline:2px solid white;outline-offset:2px}
      #ppf_root .top{display:flex;align-items:center;gap:13px;padding:12px 14px;background:linear-gradient(105deg,#503258,#242b42);border:1px solid #705077;border-radius:12px;margin-bottom:12px}
      #ppf_root .logo{font-size:26px;background:#ffffff24;border-radius:12px;padding:9px}
      #ppf_root h2{font-size:17px;margin:0 0 3px;color:white}
      #ppf_root .sub{font-size:11px;color:#d7cddd}
      #ppf_root .progressinfo{padding:8px;background:#21212c;border-radius:7px;margin:8px 0;font-size:11px;color:#c5b9d3}
      #ppf_root .layout{display:grid;grid-template-columns:minmax(240px,1fr) minmax(210px,0.95fr);gap:12px}
      #ppf_root .panel{border:1px solid var(--color-border,#555);border-radius:12px;background:var(--color-back,#292929);padding:14px;min-width:0}
      #ppf_root .heading{color:#cba3ff;font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:bold;margin-bottom:12px}
      #ppf_root .field{margin-bottom:12px}
      #ppf_root label{display:block;font-size:12px;margin-bottom:5px}
      #ppf_root .hint{display:block;font-size:10px;opacity:.65;margin-top:4px;line-height:1.35}
      #ppf_root input:not([type=checkbox]),#ppf_root select{width:100%;height:30px;color:var(--color-text,#eee);background:var(--color-input,#383838);border:1px solid var(--color-border,#666);border-radius:6px;padding:4px 7px}
      #ppf_root input[type=color]{padding:2px!important;min-height:36px;cursor:pointer}
      #ppf_root input[type=range]{padding:0!important}
      #ppf_root .twocol{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      #ppf_root .check{display:flex;gap:7px;align-items:center;font-size:12px;margin:9px 0}
      #ppf_root .check input{accent-color:#b583e7}
      #ppf_root .preview{background:#151720;border:1px solid #45435a;border-radius:10px;min-height:205px;display:flex;justify-content:center;align-items:center;position:relative;overflow:auto;padding:12px;background-image:linear-gradient(45deg,#262936 25%,transparent 25%),linear-gradient(-45deg,#262936 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#262936 75%),linear-gradient(-45deg,transparent 75%,#262936 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0}
      #ppf_root canvas{display:block;image-rendering:pixelated;flex:none;filter:drop-shadow(0 6px 9px #0007)}
      #ppf_root .zoomtools{display:flex;align-items:center;gap:8px;margin:10px 0 6px}#ppf_root .zoomtools button{flex:0 0 auto;padding:6px 10px}#ppf_root .zoomtools input{flex:1}#ppf_root .small{font-size:11px;opacity:.7;margin:9px 0 6px}
      #ppf_root .gradient{height:14px;border-radius:6px;border:1px solid #ffffff33;margin-top:8px}
      #ppf_root .buttons{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
      #ppf_root button{background:#504060;color:white;border:1px solid #7f6890;border-radius:8px;padding:9px 12px;font-weight:bold;cursor:pointer;flex:1}
      #ppf_root button.primary{background:linear-gradient(100deg,#a363d4,#7956b3);border-color:#bc80ee}
      #ppf_root #ppf_status{min-height:18px;margin-top:10px;font-size:11px;line-height:1.4}
      @media(max-width:690px){#ppf_root .layout{grid-template-columns:1fr}}
    </style>
    <div id="ppf_root">
      <div class="top"><div class="logo">✦</div><div><h2>Pixel Palette Studio</h2><div class="sub">Transições de cor · Flipbook · Prévia ao vivo</div></div></div>
      <div class="layout">
        <section class="panel">
          <div class="heading">01 / Biblioteca de efeitos</div>
          <div class="presets" id="ppf_presetCards">
           <button class="preset" data-preset="vertical" type="button"><b>↟</b>Reflexo vertical</button>
           <button class="preset" data-preset="diagonal" type="button"><b>⤢</b>Reflexo diagonal</button>
           <button class="preset" data-preset="horizontal" type="button"><b>➜</b>Reflexo lateral</button>
           <button class="preset" data-preset="pulse" type="button"><b>◉</b>Brilho pulsante</button>
           <button class="preset" data-preset="sparkle" type="button"><b>✧</b>Faíscas suaves</button>
           <button class="preset" data-preset="edge" type="button"><b>◇</b>Contorno reluzente</button>
           <button class="preset" data-preset="palette" type="button"><b>◒</b>Troca de paleta</button>
          </div>
          <div class="heading" style="margin-top:14px">Efeitos inspirados nas referências</div><div class="presets">
<button class="preset" data-preset="gold" type="button"><b>✧</b>Ouro encantado</button>
<button class="preset" data-preset="rune" type="button"><b>◎</b>Runas verdes</button>
<button class="preset" data-preset="spectral" type="button"><b>❖</b>Gelo espectral</button>
<button class="preset" data-preset="arcane" type="button"><b>✹</b>Pulso arcano</button>
<button class="preset" data-preset="chromatic" type="button"><b>◈</b>Onda cromática</button>
<button class="preset" data-preset="embers" type="button"><b>✺</b>Brasas mágicas</button></div><input type="hidden" id="ppf_preset" value="vertical">
          <div class="heading">02 / Aparência e movimento</div>
          <div class="twocol"><div class="field"><label for="ppf_glow">Cor do reflexo</label><input type="color" id="ppf_glow" value="#fff5e8"></div>
          <div class="field"><label for="ppf_intensity">Intensidade <span id="ppf_intensityText">85%</span></label><input type="range" id="ppf_intensity" min="0" max="100" value="85"></div></div>
          <div class="twocol"><div class="field"><label for="ppf_band">Largura da faixa: <b id="ppf_bandText">3</b> px</label><input type="range" id="ppf_band" min="1" max="20" step="0.5" value="3"></div>
          <div class="field"><label for="ppf_coverage">Região iluminada</label><select id="ppf_coverage"><option value="all">Toda parte visível</option><option value="matched">Somente cor escolhida</option></select></div></div>
          <label class="check"><input type="checkbox" id="ppf_reverse"> Inverter direção do brilho</label>
          <div class="heading">03 / Paleta e máscara</div>
          <div class="twocol">
            <div class="field"><label for="ppf_base">Cor inicial</label><input id="ppf_base" type="color" value="#d83347"></div>
            <div class="field"><label for="ppf_target">Cor final</label><input id="ppf_target" type="color" value="#ff93c8"></div>
          </div>
          <div class="field"><label for="ppf_mask">Aplicar em</label><select id="ppf_mask"><option value="match">Pixels próximos da cor inicial</option><option value="all">Todos os pixels visíveis</option></select></div>
          <div class="field"><label for="ppf_tolerance">Tolerância de cor: <b id="ppf_toltext">75</b></label><input type="range" id="ppf_tolerance" min="0" max="255" value="75"><span class="hint">Aumente para incluir sombras e variações próximas.</span></div>
          <div class="twocol">
            <div class="field"><label for="ppf_frames">Quantidade de frames</label><input id="ppf_frames" type="number" min="2" max="128" value="16"></div>
            <div class="field"><label for="ppf_fps">Prévia (FPS)</label><input id="ppf_fps" type="number" min="1" max="20" value="8"></div>
          </div>
          <div class="field"><label for="ppf_ease">Suavidade da transição</label><select id="ppf_ease"><option value="smooth">Suave · acelera e desacelera</option><option value="linear">Linear · constante</option><option value="sine">Senoidal · macia</option></select></div>
          <label class="check"><input type="checkbox" id="ppf_loop" checked> Loop suave (vai e volta sem salto)</label>
          <label class="check"><input type="checkbox" id="ppf_shade" checked> Preservar relevo e diferenças de tons</label>
          <div class="heading" style="margin-top:16px">04 / Origem da textura</div>
          <div class="twocol"><div class="field"><label for="ppf_width">Largura</label><input id="ppf_width" type="number" min="1" max="128" value="16"></div><div class="field"><label for="ppf_height">Altura</label><input id="ppf_height" type="number" min="1" max="128" value="16"></div></div>
          <span class="hint">Usa a textura escolhida em IMAGES ou a primeira textura disponível. A textura selecionada será atualizada com os frames; salve um backup antes.</span>
        </section>
        <section class="panel">
          <div class="heading">Pré-visualização animada</div>
          <div class="preview"><canvas id="ppf_canvas" width="16" height="16"></canvas></div><div class="zoomtools"><span id="ppf_zoomLabel">8x</span><input id="ppf_zoom" type="range" min="1" max="32" value="8"><button type="button" id="ppf_zoomOut">−</button><button type="button" id="ppf_zoomIn">＋</button></div>
          <div class="small" id="ppf_frameLabel">Frame 1 / 16</div>
          <input type="range" id="ppf_scrub" min="0" max="15" value="0" aria-label="Visualizar frame manualmente">
          <div class="small">Paleta de transição</div><div id="ppf_gradient" class="gradient"></div>
          <div class="small" id="ppf_dimension">16 × 16 pixels</div><div class="progressinfo" id="ppf_effectdesc">A faixa luminosa atravessa os pixels de baixo para cima.</div>
          <div class="buttons"><button id="ppf_pause" type="button">⏸ Pausar</button><button id="ppf_png" type="button">Salvar PNG</button></div>
          <div class="buttons"><button class="primary" id="ppf_create" type="button">✦ Aplicar na textura selecionada</button></div>
          <div id="ppf_status" role="status">Pronto para gerar.</div>
        </section>
      </div>
    </div>`;
    dialog = new Dialog({id: 'ppf_studio_dialog', title: 'Pixel Palette Studio · Flipbook', width: 850, lines: [html], buttons: ['Fechar'], onCancel: stop, onConfirm: stop});
    dialog.show();
    const initialPreset = $('preset');
    if (initialPreset) initialPreset.value = preset;
    const presetColors={gold:'#ffe49b',rune:'#70ff9d',spectral:'#7ceaff',arcane:'#fa78ee',chromatic:'#e7a0ff',embers:'#ffa45b'};
    if(presetColors[preset] && $('glow')) $('glow').value=presetColors[preset];
    document.querySelectorAll('#ppf_root .preset').forEach(el => el.classList.toggle('active', el.dataset.preset === preset));
    const descriptionsInitial = {gold:'Cintilação dourada em ondas.',rune:'Runas verdes iluminadas.',spectral:'Faixas ciano em movimento.',arcane:'Pulso magenta e faíscas.',chromatic:'Ondas rosa, violeta e azul.',embers:'Brasas mágicas.',vertical:'A faixa clara percorre os pixels de baixo para cima.',diagonal:'Reflexo inclinado sobre a superfície.',horizontal:'A faixa atravessa da esquerda para a direita.',pulse:'O brilho aumenta e diminui.',sparkle:'Pontos brilhantes aparecem e desaparecem.',edge:'O contorno externo reluz.',palette:'Transição gradual entre duas cores.'};
    if ($('effectdesc')) $('effectdesc').textContent = descriptionsInitial[preset];
    let strip = null, src = null, settings = null, frame = 0, paused = false;
    function applyZoom(){const c=$('canvas');if(!c)return;const z=clamp(Number($('zoom')?.value||8),1,32);c.style.width=((src?.w||16)*z)+'px';c.style.height=((src?.h||16)*z)+'px';$('zoomLabel').textContent=z+'x';}
    function showFrame() {
      if (!strip || !src || !settings || !$('canvas')) return;
      frameAt(strip, frame, src.w, src.h, $('canvas'));applyZoom();
      $('frameLabel').textContent = `Frame ${frame+1} / ${settings.frames}`;
      $('scrub').value = frame;
    }
    function generate() {
      try {
        src = getSource(); settings = readSettings();
        strip = makeFrames(src, settings);
        frame = 0;
        $('scrub').max = settings.frames - 1;
        $('toltext').textContent = settings.tolerance;
        $('intensityText').textContent=Math.round(settings.intensity*100)+'%';
        $('bandText').textContent=settings.band;
        $('dimension').textContent = `${src.w} × ${src.h} pixels/frame · PNG ${src.w} × ${src.h*settings.frames}`;
        $('gradient').style.background = settings.loop ? `linear-gradient(90deg,${$('base').value},${$('target').value},${$('base').value})` : `linear-gradient(90deg,${$('base').value},${$('target').value})`;
        showFrame();
        if (runningTimer) clearInterval(runningTimer);
        runningTimer = setInterval(() => { if (!paused && $('canvas')) {frame=(frame+1)%settings.frames;showFrame();} }, 1000/settings.fps);
        message('Prévia atualizada. A textura original está preservada.');
      } catch (e) { strip = null; message(e.message || String(e), true); }
    }
    function queueGenerate() { if (pendingTimer) clearTimeout(pendingTimer); pendingTimer = setTimeout(generate, 120); }
    for (const id of ['base','target','frames','fps','tolerance','mask','ease','loop','shade','width','height','glow','intensity','band','coverage','reverse']) {
      const el = $(id); if (el) el.addEventListener('input', queueGenerate);
    }
    const descriptions={gold:'Metal dourado cintilante.',rune:'Runas verdes pulsantes.',spectral:'Brilho espectral ciano.',arcane:'Descargas arcanas magenta.',chromatic:'Onda cromática.',embers:'Brasas em movimento.',vertical:'A faixa clara percorre a textura de baixo para cima.',diagonal:'Reflexo inclinado para criar o brilho de metal polido.',horizontal:'A luz percorre a textura da esquerda para a direita.',pulse:'A iluminação aumenta e diminui progressivamente.',sparkle:'Pontos brilhantes discretos aparecem e desaparecem.',edge:'O contorno externo reluz sem preencher o interior.',palette:'Transição gradual da cor inicial para a cor final.'};
    document.querySelectorAll('#ppf_root .preset').forEach(btn=>btn.addEventListener('click',()=>{
      $('preset').value=btn.dataset.preset;
      document.querySelectorAll('#ppf_root .preset').forEach(el=>el.classList.toggle('active',el===btn));
      $('effectdesc').textContent=descriptions[btn.dataset.preset];
      if(presetColors[btn.dataset.preset])$('glow').value=presetColors[btn.dataset.preset];
      queueGenerate();
    }));
    $('pause').addEventListener('click', () => {paused=!paused;$('pause').textContent=paused?'▶ Reproduzir':'⏸ Pausar';});
    $('scrub').addEventListener('input', () => { paused=true; $('pause').textContent='▶ Reproduzir'; frame=Number($('scrub').value);showFrame(); });
    $('zoom').addEventListener('input',applyZoom);
    $('zoomIn').addEventListener('click',()=>{$('zoom').value=Math.min(32,Number($('zoom').value)+1);applyZoom();});
    $('zoomOut').addEventListener('click',()=>{$('zoom').value=Math.max(1,Number($('zoom').value)-1);applyZoom();});
    $('png').addEventListener('click', () => {
      if (!strip) return message('Não foi possível gerar o PNG.', true);
      const filename = (src.name || 'pixel_art').replace(/[^\w-]/g, '_') + '_flipbook.png';
      try {
        const a=document.createElement('a');a.href=strip.toDataURL('image/png');a.download=filename;
        document.body.appendChild(a);a.click();a.remove();
        message(`Arquivo ${filename} solicitado para download.`);
      } catch(e) {message('Erro no download: '+e.message,true);}
    });
    $('create').addEventListener('click', () => {
      if (!strip) return message('Não há frames gerados.',true);
      try{
        const tex=resolveTexture();
        if(!tex)throw Error('Selecione uma textura em IMAGES primeiro.');
        tex.fromDataURL(strip.toDataURL('image/png'));
        tex.uv_width=src.w;tex.uv_height=src.h;
        tex.frame_time=Math.max(1,Math.round(20/settings.fps));
        tex.frame_order_type='loop';tex.frame_interpolate=false;
        if('width' in tex)tex.width=src.w;
        if('height' in tex)tex.height=src.h*settings.frames;
        if(typeof tex.select==='function')tex.select();
        if(typeof tex.updateMaterial==='function')tex.updateMaterial();
        activeTexture=tex;
        message('Atualizada a própria textura: '+tex.name+' ('+settings.frames+' frames). Salve o projeto.');
      }catch(e){message('Erro ao aplicar na textura: '+e.message,true);}
    });
    generate();
  }
  Plugin.register(PLUGIN_ID, {
    title: 'Pixel Palette Studio — Flipbook FX 2.3.1',
    author: 'OpenAI',
    icon: 'auto_awesome',
    description: 'Presets de reflexos metálicos, brilho vertical, faíscas, paleta e prévia em flipbook.',
    version: CURRENT_VERSION,
    min_version: '4.9.0',
    variant: 'both',
    onload() {
      const texMenu = typeof Texture !== 'undefined' && Texture.prototype && Texture.prototype.menu;
      if (texMenu && typeof texMenu.addAction === 'function') {
        textureContextAction = {
          id: 'ppf_texture_context', name:'Pixel Palette Studio · Animar textura', icon:'auto_awesome',
          children: [
            {name:'Abrir estúdio completo', icon:'palette', click(texture) {launch('vertical', texture);}}, '_',
            {name:'Reflexo de baixo para cima', icon:'vertical_align_top', click(texture) {launch('vertical', texture);}},
            {name:'Reflexo diagonal', icon:'trending_up', click(texture) {launch('diagonal', texture);}},
            {name:'Reflexo lateral', icon:'east', click(texture) {launch('horizontal', texture);}},
            {name:'Brilho pulsante', icon:'flare', click(texture) {launch('pulse', texture);}},
            {name:'Faíscas suaves', icon:'auto_awesome', click(texture) {launch('sparkle', texture);}},
            {name:'Contorno reluzente', icon:'border_outer', click(texture) {launch('edge', texture);}},
            {name:'Transição de cores', icon:'gradient', click(texture) {launch('palette', texture);}},
            '_',
            {name:'Ouro encantado', icon:'auto_awesome', click(texture) {launch('gold',texture);}},
            {name:'Runas verdes', icon:'brightness_high', click(texture) {launch('rune',texture);}},
            {name:'Gelo espectral', icon:'ac_unit', click(texture) {launch('spectral',texture);}},
            {name:'Pulso arcano', icon:'flare', click(texture) {launch('arcane',texture);}},
            {name:'Onda cromática', icon:'gradient', click(texture) {launch('chromatic',texture);}},
            {name:'Brasas mágicas', icon:'whatshot', click(texture) {launch('embers',texture);}}
          ]
        };
        try {texMenu.addAction(textureContextAction);} catch(err){console.warn('[Pixel Palette Studio] Menu contextual indisponível:',err);}
      }
      updateAction = new Action('ppf_check_updates',{name:'Pixel Palette Studio · Verificar atualizações',icon:'system_update_alt',click:()=>checkUpdates(false)});
      try {MenuBar.addAction(updateAction,'tools');}catch(e){console.warn(e);}
      if(!checkedUpdates){checkedUpdates=true;setTimeout(()=>checkUpdates(true),3000);}
      menuAction = new Action('ppf_open_studio', {name:'Pixel Palette Studio',description:'Gerar flipbook de cores e ver animação ao vivo',icon:'auto_awesome',click:() => launch('vertical')});
      MenuBar.addAction(menuAction, 'tools');
    },
    onunload() {
      stop();
      if (dialog) {try{dialog.hide();}catch(_){}}
      if (textureContextAction && typeof Texture !== 'undefined' && Texture.prototype && Texture.prototype.menu) {
        try {Texture.prototype.menu.removeAction('ppf_texture_context');} catch (_) {}
      }
      textureContextAction = null;
      activeTexture = null;
      if (menuAction) menuAction.delete();
      if (updateAction) updateAction.delete();
    }
  });
})();