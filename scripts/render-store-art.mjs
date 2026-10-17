// Deterministic promotional artwork built from the extension's existing branding.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = resolve('store-assets');
const source = join(output, 'source');
await mkdir(source, { recursive: true });
const base = `*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#f0f6fc;-webkit-font-smoothing:antialiased}h1,p{margin:0} .eyebrow{font-size:13px;letter-spacing:2.4px;font-weight:650;color:#9ba7b7}.accent{height:3px;width:48px;background:linear-gradient(90deg,#47d6c2,#77b8ff,#c89bff,#ff9bcb,#ffc46e);border-radius:4px}.muted{color:#a5b0bf}img{display:block}`;
const designs = [
  {
    name:'promo-small-440x280',width:440,height:280,
    css:`main{position:relative;height:100%;padding:29px 28px;background:radial-gradient(ellipse at 96% 35%,#1d2537 0%,transparent 63%)}.accent{margin-bottom:20px}.eyebrow{font-size:10px;letter-spacing:2px;margin-bottom:9px}h1{font-size:31px;line-height:1.12;letter-spacing:-1px;font-weight:650}img{position:absolute;width:162px;height:162px;right:17px;top:47px}p{position:absolute;bottom:31px;font-size:15px;letter-spacing:-.15px}`,
    body:`<main><div class="accent"></div><div class="eyebrow">UNIVERSAL</div><h1>GitHub<br>Highlighting</h1><img src="../../assets/icon-master.png" alt="Rainbow GPU chip with Octocat"><p class="muted">New languages. Full color.</p></main>`
  },
  {
    name:'promo-marquee-1400x560',width:1400,height:560,
    css:`main{height:100%;position:relative;padding:61px 76px;background:radial-gradient(ellipse at 83% 45%,#202a40 0%,#131922 29%,transparent 62%)}.brand{display:flex;gap:17px;align-items:center;font-size:18px;font-weight:550;color:#c8d2df;letter-spacing:-.2px}.brand .accent{width:34px}h1{font-size:78px;line-height:1.03;letter-spacing:-3.6px;margin-top:47px;font-weight:650}h1 span{background:linear-gradient(100deg,#a5d8ff 0%,#d4b1ff 55%,#ffbedc 100%);background-clip:text;color:transparent}p{font-size:22px;margin-top:25px;letter-spacing:-.3px}img{position:absolute;width:370px;height:370px;right:111px;top:94px}.details{position:absolute;bottom:54px;font-size:14px;letter-spacing:.25px;color:#8d9aab}.details span{padding:0 13px;color:#4d5d72}`,
    body:`<main><div class="brand"><div class="accent"></div>Universal GitHub Highlighting</div><h1>New languages.<br><span>Full color.</span></h1><p class="muted">Syntax highlighting for code GitHub leaves plain.</p><img src="../../assets/icon-master.png" alt="Rainbow GPU chip with Octocat"><div class="details">On-device GPU<span>·</span>No setup<span>·</span>Light &amp; dark</div></main>`
  },
  {
    name:'05-popup-controls',width:1280,height:800,screenshot:true,
    css:`main{height:100%;padding:85px 78px;background:radial-gradient(ellipse at 81% 47%,#202a40 0%,#131922 32%,transparent 65%)}.brand{display:flex;align-items:center;gap:15px;font-size:17px;color:#c8d2df}.brand img{width:38px;height:38px}.eyebrow{margin-top:104px;margin-bottom:23px;font-size:12px}h1{font-size:62px;line-height:1.08;letter-spacing:-2.6px;font-weight:650}p{font-size:20px;line-height:1.6;margin-top:25px;max-width:480px}.popup{position:absolute;left:812px;top:185px;width:360px;height:430px;border-radius:12px;box-shadow:0 25px 75px #0008;outline:1px solid #8a9bb328}.note{margin-top:36px;color:#7e8c9e;font-size:14px}`,
    body:`<main><div class="brand"><img src="../../public/icons/icon-128.png" alt="">Universal GitHub Highlighting</div><div class="eyebrow">JUST THE CONTROLS YOU NEED</div><h1>A little control.<br>A lot of color.</h1><p class="muted">Turn highlighting on or off.<br>Force a file. Fine-tune the color fade.</p><div class="note">Runs locally. Your code stays on your device.</div><img class="popup" src="popup-capture.png" alt="Actual extension popup showing json.hd highlighted"></main>`
  }
];
const browser = await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
try {
  for(const design of designs){
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${design.name}</title><style>${base}${design.css}</style></head><body>${design.body}</body></html>`;
    const file = join(source,`${design.name}.html`);
    await writeFile(file,html+'\n');
    const page = await browser.newPage({viewport:{width:design.width,height:design.height},deviceScaleFactor:1});
    await page.goto(pathToFileURL(file).href);
    await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));});
    const directory = design.screenshot ? join(output,'screenshots') : output;
    await page.screenshot({path:join(directory,`${design.name}.png`)});
    await page.close();
    console.log(`Rendered ${design.name}.png`);
  }
}finally{await browser.close();}
