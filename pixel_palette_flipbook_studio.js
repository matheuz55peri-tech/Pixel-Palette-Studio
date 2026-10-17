/* Pixel Palette Flipbook — Blockbench plugin (local install)
 * Generates a vertical animated texture from a selected texture (first frame) or a blank canvas.
 */
(function () {
  'use strict';
  const PLUGIN_ID = 'pixel_palette_flipbook_studio';
  const CURRENT_VERSION = '2.9.2';
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
          if(plugin && plugin.source==='url' && typeof plugin.reload==='function') {
            plugin.reload();
            Blockbench.showQuickMessage('Recarregamento solicitado. Reinicie o Blockbench e confira a versao.',5000);
          } else {
            const url=data.url+'?version='+encodeURIComponent(data.version);
            if(typeof navigator!=='undefined' && navigator.clipboard?.writeText) navigator.clipboard.writeText(url).catch(()=>{});
            Blockbench.showMessageBox({title:'Instalacao manual necessaria',message:'Esta instalacao nao permite recarregamento automatico. Copie a URL atualizada em Plugins > Carregar por URL: '+url+' Reinicie e confira a versao no titulo.',buttons:['Abrir link','OK']},answer=>{if(answer===0&&typeof Blockbench.openLink==='function')Blockbench.openLink(url);});
          }
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
    if (!tex) throw new Error('Selecione uma textura na lista TEXTURES antes de abrir o estúdio.');
    const img = tex.canvas && tex.canvas.width && tex.canvas.height ? tex.canvas : tex.img;
    if (!img || !img.width || !img.height) throw new Error('A textura selecionada ainda não carregou.');
    const iw = Math.round(img.width), ih = Math.round(img.height);
    // Prefer actual image dimensions. Blockbench's UV height can be the complete
    // strip height, especially with animated textures imported into BBModel.
    const fw = iw;
    const declaredFrames = Number(tex.frameCount || tex.frame_count || 0);
    const uvh = Math.round(Number(tex.getUVHeight?.() || tex.uv_height || 0));
    let fh = 0;
    if (declaredFrames > 1 && ih % declaredFrames === 0) fh = ih / declaredFrames;
    if (!fh && uvh > 0 && uvh < ih && ih % uvh === 0) fh = uvh;
    if (!fh && ih > iw && ih % iw === 0) fh = iw;
    if (!fh) fh = ih;
    const count = Math.max(1, Math.floor(ih / fh));
    if (fw < 1 || fh < 1 || fw > 512 || fh > 512) throw new Error('Dimensões inválidas de frame: ' + fw + ' × ' + fh);
    const all = document.createElement('canvas');
    all.width = fw; all.height = fh * count;
    const allctx = all.getContext('2d', {willReadFrequently:true});
    allctx.imageSmoothingEnabled = false;
    allctx.drawImage(img, 0, 0, fw, fh * count, 0, 0, fw, fh * count);
    const pixelsByFrame = [];
    for (let n = 0; n < count; n++) pixelsByFrame.push(allctx.getImageData(0, n * fh, fw, fh).data);
    return {w:fw, h:fh, pixels:pixelsByFrame[0], pixelsByFrame, inputFrames:count, texture:tex,
      name:tex.name.replace(/\.png$/i,'')};
  }
  function readSettings() {
    return {
      a: color($('base').value), b: color($('target').value),
      frames: clamp(Math.round(Number($('frames').value) || 16), 2, 128),
      fps: clamp(Number($('fps').value) || 8, 0.1, 20),
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
      // Keep every original animation frame: loop through the source frames instead
      // of repeating only frame one over the entire output strip.
      const originalFrame = src.pixelsByFrame[Math.floor(f * src.inputFrames / s.frames) % src.inputFrames];
      data.set(originalFrame);
      const t0 = progress(f);
      let t = s.loop ? (1-Math.cos(2*Math.PI*f/s.frames))/2 : t0;
      t = ease(t, s.easing);
      const base = [0,1,2].map(i=>lerp(s.a[i],s.b[i],t));
      const sweepPos = -s.band*1.5 + t0*(src.h + 3*s.band);
      const diagPos = -s.band*1.5 + t0*(src.h+src.w*0.8+3*s.band);
      for (let y=0;y<src.h;y++) for(let x=0;x<src.w;x++) {
        const p=(y*src.w+x)*4;
        if (!originalFrame[p+3]) continue;
        const original=[originalFrame[p],originalFrame[p+1],originalFrame[p+2]];
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

          // Procedural loops are independent of existing source frame count.
          // Only recolors nontransparent source pixels.
          if(s.preset==='petals') {
            const u=x/Math.max(1,src.w),v=y/Math.max(1,src.h);
            let ptl=0;
            for(let k=0;k<8;k++){
              const yy=(hash(k,8,0)+t0*(0.5+hash(k,4,0)*0.4))%1;
              const xx=(hash(k,3,0)+t0*0.10+Math.sin(6.283*(yy+t0+hash(k,2,0)))*0.06+1)%1;
              const dx=Math.min(Math.abs(u-xx),1-Math.abs(u-xx));
              const dy=Math.min(Math.abs(v-yy),1-Math.abs(v-yy));
              ptl=Math.max(ptl,Math.max(0,1-Math.hypot(dx,dy)/(0.026+hash(k,7,0)*0.033)));
            }
            strength=ptl;
          }
          if(s.preset==='fireflies'){
            const u=x/Math.max(1,src.w),v=y/Math.max(1,src.h);
            let gl=0;
            for(let k=0;k<9;k++){
              const px=(hash(k,9,0)+Math.sin(6.283*(t0+hash(k,1,0)))*0.08+1)%1;
              const py=(hash(k,10,0)+Math.cos(6.283*(t0+hash(k,2,0)))*0.10+1)%1;
              const blink=0.5+0.5*Math.sin(6.283*(t0+hash(k,4,0)));
              const d=Math.hypot(u-px,v-py);
              gl=Math.max(gl,Math.exp(-d*d/0.005)*blink);
            }
            strength=gl;
          }
          if(s.preset==='sunrays'){
            const q=x*0.8+y*0.35;
            const pos=-s.band*3+t0*(src.w*0.8+src.h*0.35+s.band*6);
            strength=Math.max(0,1-Math.abs(q-pos)/Math.max(2,s.band*3))*0.88;
          }
          if(s.preset==='breeze'){
            strength=Math.pow(Math.max(0,Math.sin((y/src.h*3-x/src.w*1.5-t0*2)*6.283)),2)*0.52;
          }
          if(s.preset==='lantern'){
            const dx=(x-src.w*0.52)/Math.max(1,src.w),dy=(y-src.h*0.3)/Math.max(1,src.h);
            const radial=Math.max(0,1-Math.hypot(dx,dy)*1.8);
            strength=radial*(0.68+0.20*Math.sin(6.283*t0)+0.09*Math.sin(6.283*t0*3));
          }
          if(s.preset==='dew'){
            const seed=hash(x,y,0);
            strength=seed>0.90?Math.pow(Math.max(0,Math.sin(6.283*(t0+hash(x,y,1)))),8):0;
          }

          if(s.preset.startsWith('water_')) {
            const u=x/Math.max(1,src.w),v=y/Math.max(1,src.h),tau=Math.PI*2;
            if(s.preset==='water_ripple') strength=Math.pow(Math.max(0,Math.sin(tau*(v*2+u*0.45-t0))),2)*0.8;
            if(s.preset==='water_flow') strength=Math.pow(Math.max(0,Math.sin(tau*(u*3.2+v*0.5-t0))),2.5)*0.85;
            if(s.preset==='water_fall') strength=clamp(Math.pow(Math.max(0,Math.sin(tau*(u*3.8+v*1.7-t0))),2)*0.8+Math.max(0,1-v*7)*0.2+Math.max(0,(v-0.85)*4)*0.3,0,1);
            if(s.preset==='water_foam') strength=Math.pow(Math.max(0,Math.sin(tau*(u*2-t0)+Math.sin(v*11))),3)*Math.exp(-Math.pow((v-0.78)*4,2));
            if(s.preset==='water_caustic') strength=Math.pow(Math.max(0,(Math.sin(tau*(u*3+t0))+Math.sin(tau*(v*3.4-t0))+Math.sin(tau*((u+v)*2.3+t0)))/3),2)*0.94;
            if(s.preset==='water_rain'){strength=0;for(let k=0;k<6;k++){const cx=hash(k,11,0),cy=hash(k,12,0),radius=((t0+hash(k,13,0))%1)*0.31,d=Math.hypot(u-cx,v-cy);strength=Math.max(strength,Math.exp(-Math.pow((d-radius)*22,2)));}}
            if(s.preset==='water_bubbles'){strength=0;for(let k=0;k<8;k++){const yy=1-((hash(k,5,0)+t0*0.67)%1),xx=(hash(k,6,0)+Math.sin(tau*(t0+hash(k,7,0)))*0.035+1)%1,d=Math.hypot(u-xx,v-yy);strength=Math.max(strength,Math.exp(-d*d/0.002));}}
            if(s.preset==='water_tide') strength=clamp(Math.pow(Math.max(0,Math.sin(tau*(v*1.5-t0))),2)*0.7+Math.pow(Math.max(0,Math.sin(tau*(u*1.1+v*0.65-t0))),2)*0.22,0,1);
          }
          if(s.preset==='pix_fire') { const q=x/src.w*0.5+y/src.h*0.9-t0*2;strength=Math.max(0,Math.sin(Math.PI*2*q)+Math.sin(x*0.65-y*0.33+t0*Math.PI*6)*0.4)*0.55; }
          if(s.preset==='pix_lightning') {const dx=Math.abs(x-src.w*(0.5+0.18*Math.sin(y*0.8+t0*Math.PI*2+Math.sin(y*1.5))));strength=clamp(Math.max(0,1-dx/Math.max(1,s.band*0.75))*0.95,0,1);}
          if(s.preset==='pix_snow') {strength=(hash(x,y,0)>0.91?Math.pow(Math.max(0,Math.sin(Math.PI*2*(t0+hash(x,y,1)))),6):0)+Math.max(0,Math.sin(y*0.4+t0*Math.PI*2))*0.12;}
          if(s.preset==='pix_twinkle') {strength=hash(x,y,0)>0.87?Math.pow(Math.max(0,Math.sin(Math.PI*2*(t0+hash(x,y,1)))),10):0;}
          if(s.preset==='pix_shockwave') {const cx=src.w*0.5,cy=src.h*0.5,d=Math.hypot(x-cx,y-cy);strength=Math.max(0,1-Math.abs(d-((t0+0.05)%1)*Math.hypot(cx,cy))/Math.max(1,s.band));}
          if(s.preset==='fire_ember') strength=Math.pow(Math.max(0,Math.sin((y/src.h*2-x/src.w*.65-t0)*Math.PI*2)),3)*.72+(hash(x,y,1)>.91?Math.pow(Math.max(0,Math.sin((t0+hash(x,y,2))*Math.PI*2)),5)*.65:0);
          if(s.preset==='fire_blue') strength=Math.pow(Math.max(0,Math.sin((y/src.h*1.7+Math.sin(x*.37)*.22-t0)*Math.PI*2)),2)*.88;
          if(s.preset==='fire_magic') strength=Math.pow(Math.max(0,Math.sin((y/src.h*2+x/src.w*.6-t0)*Math.PI*2)),3)*.7+(hash(x,y,3)>.92?.35:0);
          if(s.preset==='fire_wave') strength=Math.pow(Math.max(0,Math.sin((y/src.h*2.6+Math.sin(x*.35-t0*Math.PI*2)*.2-t0)*Math.PI*2)),2)*.93;
          if(s.preset==='edge') {
            let borders=0;
            for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
              const xx=x+dx,yy=y+dy;
              if(xx<0||yy<0||xx>=src.w||yy>=src.h||!originalFrame[(yy*src.w+xx)*4+3]) borders++;
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
    const presetNames = ['vertical','diagonal','horizontal','pulse','sparkle','edge','palette','gold','rune','spectral','arcane','chromatic','embers','petals','fireflies','sunrays','breeze','lantern','dew','water_ripple','water_flow','water_fall','water_foam','water_caustic','water_rain','water_bubbles','water_tide','pix_fire','pix_lightning','pix_snow','pix_twinkle','pix_shockwave','fire_ember','fire_blue','fire_magic','fire_wave'];
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
      <div class="tabs" style="display:flex;gap:8px;margin-bottom:12px"><button type="button" id="ppf_switchEditor" style="flex:1;padding:10px;background:#68427c;color:white;border:1px solid #b885d1;border-radius:8px">Editor sobre textura</button><button type="button" id="ppf_switchCreator" style="flex:1;padding:10px;background:#30273f;color:white;border:1px solid #745184;border-radius:8px">Gerador transparente ✦</button></div><div class="layout">
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
<button class="preset" data-preset="embers" type="button"><b>✺</b>Brasas mágicas</button></div><div class="heading" style="margin-top:18px">03 / Animações automáticas</div><div class="progressinfo">Movimentos gerados automaticamente em frames. Personalize cor, intensidade, máscara, velocidade e número de frames.</div><div class="presets" id="ppf_autoPresets">
<button class="preset" data-preset="petals" type="button"><b>❀</b>Pétalas ao vento</button>
<button class="preset" data-preset="fireflies" type="button"><b>✦</b>Vagalumes</button>
<button class="preset" data-preset="sunrays" type="button"><b>☀</b>Raios de sol</button>
<button class="preset" data-preset="breeze" type="button"><b>≋</b>Brisa suave</button>
<button class="preset" data-preset="lantern" type="button"><b>♨</b>Luz de lanterna</button>
<button class="preset" data-preset="dew" type="button"><b>✧</b>Orvalho brilhante</button></div>
<div class="heading" style="margin-top:16px">04 / Pacote de Água</div><div class="progressinfo">Ondas, correntezas, espuma e reflexos. Mantém os pixels transparentes e os frames originais.</div><div class="presets">
<button class="preset" data-preset="water_ripple" type="button"><b>≈</b>Ondulações</button><button class="preset" data-preset="water_flow" type="button"><b>↝</b>Correnteza</button><button class="preset" data-preset="water_fall" type="button"><b>⇊</b>Cachoeira</button><button class="preset" data-preset="water_foam" type="button"><b>✽</b>Espuma</button><button class="preset" data-preset="water_caustic" type="button"><b>⌇</b>Cáusticas</button><button class="preset" data-preset="water_rain" type="button"><b>◌</b>Chuva na água</button><button class="preset" data-preset="water_bubbles" type="button"><b>˚</b>Bolhas</button><button class="preset" data-preset="water_tide" type="button"><b>∿</b>Maré</button></div><div class="heading" style="margin-top:16px">05 / Pixilart · Novas referências</div><div class="progressinfo">Efeitos de pixel art aplicados somente nas áreas já pintadas.</div><div class="presets">
<button class="preset" type="button" data-preset="pix_fire"><b>♨</b>Chama oscilante</button><button class="preset" type="button" data-preset="pix_lightning"><b>ϟ</b>Energia elétrica</button><button class="preset" type="button" data-preset="pix_snow"><b>❄</b>Neve brilhante</button><button class="preset" type="button" data-preset="pix_twinkle"><b>✧</b>Cintilação estelar</button><button class="preset" type="button" data-preset="pix_shockwave"><b>◎</b>Pulso circular</button></div><div class="heading" style="margin-top:16px">06 / Chamas e brasas</div><div class="presets">
<button type="button" class="preset" data-preset="fire_ember"><b>♨</b>Brasa viva</button>
<button type="button" class="preset" data-preset="fire_blue"><b>❖</b>Fogo azul</button>
<button type="button" class="preset" data-preset="fire_magic"><b>✦</b>Fogo mágico</button>
<button type="button" class="preset" data-preset="fire_wave"><b>〰</b>Labareda</button></div><input type="hidden" id="ppf_preset" value="vertical">
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
            <div class="field"><label for="ppf_fps">Velocidade (FPS)</label><input id="ppf_fps" type="number" min="0.1" max="20" step="0.1" value="4"><span class="hint">0,1 FPS = 1 frame a cada 10 s. Minecraft: 20 ticks = 1 s.</span></div>
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
    // Generator is an independent dialog; the existing editor and handlers stay untouched.
    dialog = new Dialog({id: 'ppf_studio_dialog', title: 'Pixel Palette Studio · Flipbook v'+CURRENT_VERSION, width: 850, lines: [html], buttons: ['Fechar'], onCancel: stop, onConfirm: stop});
    dialog.show();
    document.getElementById('ppf_switchCreator')?.addEventListener('click',()=>{ dialog?.hide(); openTransparentGenerator(); });
    const initialPreset = $('preset');
    if (initialPreset) initialPreset.value = preset;
    const presetColors={fire_ember:'#ff813e',fire_blue:'#69cfff',fire_magic:'#c780ff',fire_wave:'#ffba56',pix_fire:'#ffac61',pix_lightning:'#bbd4ff',pix_snow:'#e2f6ff',pix_twinkle:'#f7e7ff',pix_shockwave:'#ffde9d',water_ripple:'#8fe7ff',water_flow:'#64d5ff',water_fall:'#d3f6ff',water_foam:'#ffffff',water_caustic:'#a4f6ff',water_rain:'#9fdcff',water_bubbles:'#d9fbff',water_tide:'#71cfff',petals:'#ffa5ca',fireflies:'#ecffa2',sunrays:'#fff1b0',breeze:'#9de8ff',lantern:'#ffca79',dew:'#e7faff',gold:'#ffe49b',rune:'#70ff9d',spectral:'#7ceaff',arcane:'#fa78ee',chromatic:'#e7a0ff',embers:'#ffa45b'};
    if(presetColors[preset] && $('glow')) $('glow').value=presetColors[preset];
    document.querySelectorAll('#ppf_root .preset').forEach(el => el.classList.toggle('active', el.dataset.preset === preset));
    const descriptionsInitial = {fire_ember:'Brasas acendem e esfriam nos pixels existentes.',fire_blue:'Chama azul movimenta a luz da textura.',fire_magic:'Fogo mágico com pulsos violeta.',fire_wave:'Labaredas oscilam pela textura.',pix_fire:'Luz de chama pulsante.',pix_lightning:'Descargas elétricas em movimento.',pix_snow:'Brilhos frios alternados.',pix_twinkle:'Cintilação de estrelas.',pix_shockwave:'Pulso de luz circular.',water_ripple:'Ondulações iluminadas.',water_flow:'Correnteza deslizando pela textura.',water_fall:'Cachoeira com fluxo vertical.',water_foam:'Espuma nas cristas.',water_caustic:'Reflexos subaquáticos.',water_rain:'Anéis de chuva.',water_bubbles:'Bolhas ascendentes.',water_tide:'Maré em ondas amplas.',petals:'Pétalas coloridas atravessam a textura.',fireflies:'Pontos luminosos flutuantes.',sunrays:'Faixas de sol atravessam a textura.',breeze:'Ondas translúcidas sugerem vento.',lantern:'Luz quente oscilante.',dew:'Reflexos de gotas cintilantes.',gold:'Cintilação dourada em ondas.',rune:'Runas verdes iluminadas.',spectral:'Faixas ciano em movimento.',arcane:'Pulso magenta e faíscas.',chromatic:'Ondas rosa, violeta e azul.',embers:'Brasas mágicas.',vertical:'A faixa clara percorre os pixels de baixo para cima.',diagonal:'Reflexo inclinado sobre a superfície.',horizontal:'A faixa atravessa da esquerda para a direita.',pulse:'O brilho aumenta e diminui.',sparkle:'Pontos brilhantes aparecem e desaparecem.',edge:'O contorno externo reluz.',palette:'Transição gradual entre duas cores.'};
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
        if(src.texture){settings.frames=src.inputFrames;const fc=$('frames');if(fc){fc.value=String(settings.frames);fc.disabled=true;fc.title='Frames fixos para preservar a textura';}}
        strip = makeFrames(src, settings);
        frame = 0;
        $('scrub').max = settings.frames - 1;
        $('toltext').textContent = settings.tolerance;
        $('intensityText').textContent=Math.round(settings.intensity*100)+'%';
        $('bandText').textContent=settings.band;
        $('dimension').textContent = `${src.w} × ${src.h} por frame · ${src.inputFrames} frame(s) originais · ${settings.frames} exportados`;
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
    const descriptions={fire_ember:'Brasa viva.',fire_blue:'Fogo azul.',fire_magic:'Fogo mágico.',fire_wave:'Labaredas quentes.',pix_fire:'Fogo cintilante.',pix_lightning:'Energia elétrica.',pix_snow:'Brilho de neve.',pix_twinkle:'Luzes estelares.',pix_shockwave:'Onda circular.',water_ripple:'Ondulações aquáticas.',water_flow:'Correnteza horizontal.',water_fall:'Queda de água.',water_foam:'Espuma costeira.',water_caustic:'Cáusticas luminosas.',water_rain:'Anéis de chuva.',water_bubbles:'Bolhas ascendentes.',water_tide:'Movimento da maré.',petals:'Pétalas atravessam a superfície.',fireflies:'Luzes flutuantes.',sunrays:'Raios de sol em movimento.',breeze:'Brisa suave.',lantern:'Luz quente oscilante.',dew:'Orvalho brilhante.',gold:'Metal dourado cintilante.',rune:'Runas verdes pulsantes.',spectral:'Brilho espectral ciano.',arcane:'Descargas arcanas magenta.',chromatic:'Onda cromática.',embers:'Brasas em movimento.',vertical:'A faixa clara percorre a textura de baixo para cima.',diagonal:'Reflexo inclinado para criar o brilho de metal polido.',horizontal:'A luz percorre a textura da esquerda para a direita.',pulse:'A iluminação aumenta e diminui progressivamente.',sparkle:'Pontos brilhantes discretos aparecem e desaparecem.',edge:'O contorno externo reluz sem preencher o interior.',palette:'Transição gradual da cor inicial para a cor final.'};
    document.querySelectorAll('#ppf_root .preset').forEach(btn=>btn.addEventListener('click',()=>{
      $('preset').value=btn.dataset.preset;
      document.querySelectorAll('#ppf_root .preset').forEach(el=>el.classList.toggle('active',el===btn));
      $('effectdesc').textContent=descriptions[btn.dataset.preset];
      const flameColors={fire_ember:'#ff813e',fire_blue:'#69cfff',fire_magic:'#c780ff',fire_wave:'#ffba56'};if(flameColors[btn.dataset.preset])$('glow').value=flameColors[btn.dataset.preset];
      const pixColors={pix_fire:'#ffac61',pix_lightning:'#bbd4ff',pix_snow:'#e2f6ff',pix_twinkle:'#f7e7ff',pix_shockwave:'#ffde9d'};if(pixColors[btn.dataset.preset])$('glow').value=pixColors[btn.dataset.preset];
      const waterColors={water_ripple:'#8fe7ff',water_flow:'#64d5ff',water_fall:'#d3f6ff',water_foam:'#ffffff',water_caustic:'#a4f6ff',water_rain:'#9fdcff',water_bubbles:'#d9fbff',water_tide:'#71cfff',};if(waterColors[btn.dataset.preset])$('glow').value=waterColors[btn.dataset.preset];
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
      if (!strip || !src || !src.texture) return message('Selecione uma textura antes de aplicar.',true);
      try {
        const tex=src.texture;
        if (!Texture.all.includes(tex)) throw Error('A textura original não está disponível.');
        const img=tex.canvas?.width ? tex.canvas : tex.img;
        if (!img || img.width!==strip.width || img.height!==strip.height) throw Error('Tamanho diferente da textura. Reabra o estúdio.');
        if (settings.frames!==src.inputFrames) throw Error('A quantidade de frames não pode mudar.');
        if (typeof tex.edit!=='function') throw Error('A edição de textura não está disponível nesta versão do Blockbench.');
        const intended=strip.getContext('2d',{willReadFrequently:true}).getImageData(0,0,strip.width,strip.height).data;
        const source=src.pixelsByFrame;
        let changed=0;
        // Use the active layer rather than flattening layers. Preserve each painted pixel's alpha.
        const editingLayer=tex.layers_enabled ? tex.getActiveCanvas?.() : tex;
        if (!editingLayer?.canvas?.width) throw Error('Não consegui identificar a camada ativa.');
        const baseCanvas=editingLayer.canvas;
        const off=tex.layers_enabled && Array.isArray(editingLayer.offset) ? editingLayer.offset : [0,0];
        const ox=Math.round(Number(off[0])||0),oy=Math.round(Number(off[1])||0);
        const lc=baseCanvas.getContext('2d',{willReadFrequently:true});
        const sourceLayer=lc.getImageData(0,0,baseCanvas.width,baseCanvas.height).data;
        const fw=strip.width,fh=strip.height,lw=baseCanvas.width,lh=baseCanvas.height;
        // Calculate the minimal RGB changes for painted pixels on the selected layer only.
        const result=new Uint8ClampedArray(sourceLayer);
        for(let y=0;y<lh;y++)for(let x=0;x<lw;x++){
          const gx=x+ox,gy=y+oy;
          if(gx<0||gy<0||gx>=fw||gy>=fh)continue;
          const lp=(y*lw+x)*4,gp=(gy*fw+gx)*4;
          if(!sourceLayer[lp+3])continue;
          const frameIndex=Math.floor(gy/src.h);
          const framePixel=(gy%src.h)*src.w+gx;
          const orig=source[frameIndex];
          if(!orig)continue;
          const op=framePixel*4;
          if(!orig[op+3])continue;
          let modified=false;
          for(let k=0;k<3;k++){
            const delta=intended[gp+k]-orig[op+k];
            const next=clamp(sourceLayer[lp+k]+delta,0,255);
            if(next!==sourceLayer[lp+k])modified=true;
            result[lp+k]=next;
          }
          if(modified)changed++;
        }
        if(!changed)throw Error('Nenhum pixel pintado da camada ativa foi alterado. Selecione a camada com o desenho e use Aplicar em: Toda parte visível.');
        tex.edit(canvas=>{
          if(!canvas || canvas.width!==lw || canvas.height!==lh)throw Error('A camada de edição mudou. Reabra o estúdio.');
          const ctx=canvas.getContext('2d');
          ctx.putImageData(new ImageData(result,lw,lh),0,0);
        },{method:'canvas',edit_name:'Pixel Palette Studio: efeitos na camada ativa'});
        // Minecraft uses 20 ticks/second. Frame count/UV stay unchanged, only playback timing changes.
        const ticks = Math.max(1,Math.round(20/settings.fps));
        tex.frame_time=ticks;
        if(typeof tex.select==='function')tex.select();
        activeTexture=tex;
        message('Aplicado na camada ativa: '+changed+' pixel(s). Velocidade: '+ticks+' ticks/frame (~'+(20/ticks).toFixed(2)+' FPS).');
      }catch(e){message('Falha ao aplicar: '+(e.message||e),true);}
    });
    generate();
  }

  function openTransparentGenerator(){
    stop();
    const html=`
    <style>
    #ppfg{color:var(--color-text,#eee);font-family:inherit}
    #ppfg *{box-sizing:border-box}
    #ppfg .tabs{display:flex;gap:8px;margin-bottom:12px}
    #ppfg .tabs button,#ppfg button{background:#3b2b4b;border:1px solid #7f638c;color:white;border-radius:9px;padding:8px;cursor:pointer}
    #ppfg .tabs .active{background:#704783;border-color:#dda6ed}
    #ppfg .wrap{display:grid;grid-template-columns:minmax(280px,1fr) minmax(260px,1fr);gap:12px}
    #ppfg .card{background:var(--color-back,#29252e);border:1px solid #65576f;border-radius:12px;padding:14px;min-width:0}
    #ppfg .presets{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
    #ppfg .presets button{min-height:50px;font-size:11px}
    #ppfg .presets .active{background:#774d91;border-color:#e2a8fa}
    #ppfg .fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    #ppfg label{display:block;font-size:11px;margin:8px 0 4px}
    #ppfg input{width:100%;padding:5px;border:1px solid #605268;border-radius:6px;background:#34303a;color:#fff}
    #ppfg .viewer{height:270px;overflow:auto;background-color:#1d1c27;background-image:linear-gradient(45deg,#30313c 25%,transparent 25%),linear-gradient(-45deg,#30313c 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#30313c 75%),linear-gradient(-45deg,transparent 75%,#30313c 75%);background-size:16px 16px;display:flex;align-items:center;justify-content:center;border-radius:10px}
    #ppfg canvas{image-rendering:pixelated;flex:none}
    #ppfg .note{font-size:11px;opacity:.75;margin:9px 0}
    #ppfg .primary{width:100%;background:#8953b5;margin-top:8px}
    </style>
    <div id="ppfg">
    <div class="tabs"><button id="ppfg_back">Editor sobre textura</button><button class="active">Gerador transparente ✦</button></div>
    <div class="wrap"><section class="card">
    <h3>✦ Animações do zero</h3><p class="note">Desenha os próprios pixels. Fundo 100% invisível; não utiliza a pintura anterior.</p>
    <div class="presets">
    <button data-effect="petals" class="active">❀ Pétalas</button><button data-effect="leaves">❃ Folhas</button>
    <button data-effect="ripples">≈ Ondas</button><button data-effect="flow">↝ Correnteza</button>
    <button data-effect="waterfall">⇊ Cachoeira</button><button data-effect="foam">✽ Espuma</button>
    <button data-effect="rain">◌ Chuva</button><button data-effect="bubbles">˚ Bolhas</button>
    <button data-effect="fire">♨ Chamas</button><button data-effect="snow">❄ Neve</button><button data-effect="sparks">✧ Faíscas</button><button data-effect="lightning">ϟ Raios</button><button data-effect="burst">◎ Pulso mágico</button><button data-effect="flame_torch">♨ Tocha cartoon</button><button data-effect="flame_tall">🔥 Labareda alta</button><button data-effect="flame_blue">❖ Chama azul</button><button data-effect="flame_magic">✦ Fogo mágico</button><button data-effect="flame_camp">♨ Fogueira</button></div>
    <div class="fields"><div><label>Cor principal</label><input id="ppfg_color1" type="color" value="#ff6ea8"></div><div><label>Cor secundária</label><input id="ppfg_color2" type="color" value="#ffd6e7"></div>
    <div><label>Largura por frame</label><input id="ppfg_w" type="number" min="1" max="128" value="32"></div><div><label>Altura por frame</label><input id="ppfg_h" type="number" min="1" max="128" value="32"></div>
    <div><label>Frames</label><input id="ppfg_frames" type="number" min="2" max="128" value="16"></div><div><label>Velocidade (FPS)</label><input id="ppfg_fps" type="number" min="0.1" max="20" step="0.1" value="4"></div>
    <div><label>Quantidade de elementos</label><input id="ppfg_count" type="number" min="1" max="40" value="10"></div><div><label>Tamanho dos elementos</label><input id="ppfg_size" type="number" min="1" max="6" value="2"></div></div>
    <p class="note">Ao aplicar, a textura normal selecionada é convertida em flipbook. A pintura original será substituída pela animação transparente.</p>
    </section><section class="card"><h3>Prévia animada</h3><div class="viewer"><canvas id="ppfg_preview" width="32" height="32"></canvas></div>
    <div class="fields"><div><label>Zoom</label><input id="ppfg_zoom" type="range" min="1" max="16" value="7"></div><div><label>Frame</label><input id="ppfg_seek" type="range" min="0" max="15" value="0"></div></div>
    <div class="tabs" style="margin-top:10px"><button id="ppfg_pause">⏸ Pausar</button><button id="ppfg_png">Salvar PNG</button></div>
    <button id="ppfg_apply" class="primary">✦ Converter textura em flipbook</button><p class="note" id="ppfg_status"></p>
    </section></div></div>`;
    const dlg=new Dialog({id:'ppfg_generator_dialog',title:'Pixel Palette Studio · Gerador transparente v'+CURRENT_VERSION,width:850,lines:[html],buttons:['Fechar'],onCancel:()=>clearInterval(timer),onConfirm:()=>clearInterval(timer)});
    dlg.show();
    const el=id=>document.getElementById('ppfg_'+id);
    let kind='petals',frame=0,paused=false,output=null,w=32,h=32,n=16,fps=4;
    let timer=null;
    const rand=(a,b)=>{let k=Math.imul(a+31,73856093)^Math.imul(b+97,19349663);k=Math.imul(k^(k>>>13),1274126177);return ((k^(k>>>16))>>>0)/4294967295};
    function settings(){w=clamp(Math.round(+el('w').value||32),1,128);h=clamp(Math.round(+el('h').value||32),1,128);n=clamp(Math.round(+el('frames').value||16),2,128);fps=clamp(+el('fps').value||4,0.1,20);return {count:clamp(Math.round(+el('count').value||10),1,40),size:clamp(+el('size').value||2,1,6)}}
    function render(){
      const cfg=settings();if(w*h*n>4194304)throw Error('Reduza as dimensões ou os frames.');
      const out=document.createElement('canvas');out.width=w;out.height=h*n;const ctx=out.getContext('2d');const tau=Math.PI*2;
      const a=el('color1').value,b=el('color2').value;
      const dot=(x,y,col,size=1)=>{ctx.fillStyle=col;ctx.fillRect(Math.round(x),Math.round(y),Math.max(1,Math.round(size)),Math.max(1,Math.round(size)))};
      for(let f=0;f<n;f++){
        const t=f/n,oy=f*h;
        for(let i=0;i<cfg.count;i++){
          const seed=rand(i,1),phase=(t+seed)%1;
          const x=rand(i,2)*w+Math.sin(tau*(t+rand(i,3)))*cfg.size*1.5;
          if(kind==='petals'||kind==='leaves'){
            const y=phase*(h+5)-2;
            dot(x,y+oy,i%3? a:b,cfg.size);dot(x-1,y+oy+cfg.size,a,1);
          }else if(kind==='bubbles'){
            const y=(1-phase)*h;
            dot(x,y+oy,i%2?a:b,1);dot(x+cfg.size,y+oy,b,1);dot(x,y+oy+cfg.size,b,1);
          }else if(kind==='rain'){
            const y=phase*h;
            dot(x,y+oy,b,1);dot(x+1,y+oy+1,a,1);
          }else if(kind==='ripples'){
            const cx=rand(i,4)*w,cy=rand(i,5)*h,r=1+phase*Math.min(w,h)*.25;
            for(let z=0;z<Math.max(12,r*12);z++){const ang=tau*z/Math.max(12,r*12);dot(cx+Math.cos(ang)*r,cy+Math.sin(ang)*r+oy,i%2?a:b,1)}
          }else if(kind==='flow'||kind==='foam'){
            const y=phase*h;
            for(let xx=0;xx<w;xx+=2) dot(xx,y+Math.sin(xx/w*tau*2+t*tau)*cfg.size+oy,kind==='foam'?b:a,1);
          }else if(kind==='fire'){const yy=h-1-phase*h;dot(x+Math.sin(tau*(t+rand(i,7)))*cfg.size,yy+oy,i%3?a:b,Math.max(1,cfg.size));
          }else if(kind==='snow'){const yy=phase*h;dot(x+Math.sin(tau*(t+rand(i,11)))*cfg.size,yy+oy,i%3?a:b,1);
          }else if(kind==='sparks'){const cx=w*.5,cy=h*.5,ang=rand(i,20)*tau,rad=phase*Math.min(w,h)*.47;dot(cx+Math.cos(ang)*rad,cy+Math.sin(ang)*rad+oy,i%2?a:b,1);
          }else if(kind==='lightning'){const xx=w*(.5+.27*Math.sin(i*3.1+t*tau));for(let yy=0;yy<h;yy+=Math.max(1,Math.round(cfg.size))){dot(xx+Math.sin(yy*.6+t*tau)*cfg.size,yy+oy,i%3?a:b,1);}
          }else if(kind==='burst'){const cx=w/2,cy=h/2,rr=phase*Math.min(w,h)*.46,ang=rand(i,6)*tau;dot(cx+Math.cos(ang)*rr,cy+Math.sin(ang)*rr+oy,i%3?a:b,1);
          }else if(kind==='waterfall'){
            const xx=rand(i,6)*w;
            for(let yy=0;yy<h;yy+=2)dot(xx+Math.sin(tau*t+yy*.08)*cfg.size,((yy+Math.floor(t*h))%h)+oy,i%3? a:b,1);
          }
        }

      // Pixel-art fire uses 3 separately drawn ramps, tapering flame tongues,
      // rhythmic silhouette motion and sparks. No opaque background.
      if(kind.startsWith('flame_')){
        const palette=kind==='flame_blue'?['#15396c','#167bbb','#6dd8f5','#e9ffff']:
          kind==='flame_magic'?['#4f175f','#9e42bf','#ed9fff','#fff2ff']:
          ['#a82426','#ed582c','#ffad3f','#fff3aa'];
        const tall=kind==='flame_tall',camp=kind==='flame_camp';
        const center=w*.5,base=h-2;
        const flameH=Math.max(5,Math.floor(h*(tall?.83:camp?.52:.68)));
        const fireW=Math.max(3,Math.min(w*.46,h*.29)*(camp?1.4:1));
        for(let yy=0;yy<flameH;yy++){
          const rise=yy/flameH;
          const sway=Math.sin(tau*(t+yy*.055))*(1+rise*fireW*.3);
          const jag=Math.sin((yy*.76+t*tau*2.4))*1.2+Math.sin((yy*.37-t*tau))*1.5;
          const half=Math.max(.25,fireW*Math.pow(1-rise,1.35)*(0.87+.14*Math.sin(tau*(t+rise*1.8))));
          const cy=base-yy;
          for(let xx=Math.floor(center+sway+jag-half);xx<=Math.ceil(center+sway+jag+half);xx++){
            const d=Math.abs(xx-(center+sway+jag))/Math.max(.2,half);
            if(d>1)continue;
            const rag=rand(Math.floor(yy+xx*.2),Math.floor(t*n))*.22;
            if(d>1-rag && rise>.23)continue;
            let col=palette[0];
            if(d<.8)col=palette[1];
            if(d<.55 && rise<.78)col=palette[2];
            if(d<.27 && rise<.44)col=palette[3];
            dot(xx,cy+oy,col,1);
          }
        }
        // Independent tongues make the silhouette read as a cartoon flame, rather than a blinking dot.
        for(let tongue=0;tongue<3;tongue++){
          const shift=(tongue-1)*fireW*.58;
          const tongueHeight=flameH*(.35+.28*rand(tongue,3));
          for(let k=0;k<tongueHeight;k++){
            const fy=base-k,fx=center+shift+Math.sin(tau*t+tongue+k*.12)*(1+k*.045);
            const rad=Math.max(0,(2.5-k/tongueHeight*2.3));
            for(let ox=-Math.round(rad);ox<=Math.round(rad);ox++)
              if(Math.abs(ox)<=rad)dot(fx+ox,fy+oy,k<tongueHeight*.35?palette[2]:palette[1],1);
          }
        }
        for(let p=0;p<Math.max(2,Math.round(cfg.count*.5));p++){
          const ph=(t+rand(p,90))%1;
          const sx=center+(rand(p,92)-.5)*fireW*2+Math.sin(tau*(t+rand(p,91)))*2;
          const sy=base-flameH*.45-ph*flameH*.7;
          dot(sx,sy+oy,p%3?palette[2]:palette[3],1);
        }
      }
      }
      output=out;frame=Math.min(frame,n-1);el('seek').max=n-1;
      show();
    }
    function show(){if(!output)return;const c=el('preview'),ctx=c.getContext('2d');c.width=w;c.height=h;ctx.imageSmoothingEnabled=false;ctx.clearRect(0,0,w,h);ctx.drawImage(output,0,frame*h,w,h,0,0,w,h);const z=+el('zoom').value||7;c.style.width=(w*z)+'px';c.style.height=(h*z)+'px';el('seek').value=frame;}
    let delay=160;
    function animate(){clearInterval(timer);delay=1000/fps;timer=setInterval(()=>{if(!paused){frame=(frame+1)%n;show()}},delay)}
    function refresh(){try{render();animate();el('status').textContent='Pronto · fundo transparente · '+w+' × '+h*n+' px';}catch(e){el('status').textContent=e.message;output=null}}
    for(const id of ['color1','color2','w','h','frames','fps','count','size'])el(id).addEventListener('input',refresh);
    document.querySelectorAll('#ppfg [data-effect]').forEach(btn=>btn.addEventListener('click',()=>{kind=btn.dataset.effect;document.querySelectorAll('#ppfg [data-effect]').forEach(x=>x.classList.toggle('active',x===btn));refresh()}));
    el('zoom').addEventListener('input',show);
    el('seek').addEventListener('input',()=>{frame=+el('seek').value;paused=true;show()});
    el('pause').addEventListener('click',()=>{paused=!paused;el('pause').textContent=paused?'▶ Reproduzir':'⏸ Pausar'});
    el('back').addEventListener('click',()=>{clearInterval(timer);dlg.hide();launch('vertical')});
    el('png').addEventListener('click',()=>{if(!output)return;const link=document.createElement('a');link.href=output.toDataURL('image/png');link.download='pixel_palette_'+kind+'.png';link.click()});
    el('apply').addEventListener('click',()=>{
      try{
        if(!output)throw Error('Gere a prévia primeiro.');
        const tex=typeof Texture!=='undefined'?Texture.selected||Texture.all?.find(t=>t.selected):null;
        if(!tex)throw Error('Selecione uma textura normal na lista IMAGES antes de aplicar.');
        if(tex.layers_enabled)throw Error('Textura com camadas: use uma textura normal sem camadas para este modo.');
        tex.fromDataURL(output.toDataURL('image/png'));tex.uv_width=w;tex.uv_height=h;
        tex.frame_time=Math.max(1,Math.round(20/fps));tex.frame_order_type='loop';tex.frame_interpolate=false;
        if(typeof tex.select==='function')tex.select();
        if(typeof tex.updateMaterial==='function')tex.updateMaterial();
        el('status').textContent='Convertida: '+tex.name+' · '+w+' × '+(h*n)+' px, '+n+' frames. Salve a textura.';
      }catch(e){el('status').textContent='Erro: '+e.message}
    });
    refresh();
  }

  Plugin.register(PLUGIN_ID, {
    title: 'Pixel Palette Studio — Flipbook FX 2.9.2',
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