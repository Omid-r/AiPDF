const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('PASS ' + name); }
function request(port, url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({hostname:'127.0.0.1', port, path:url, headers, method}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status:res.statusCode, headers:res.headers, body:Buffer.concat(chunks).toString()}));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('HTTP test timed out')));
    req.on('error', reject); req.end();
  });
}
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aipdf-server-'));
  const originalResources = process.resourcesPath;
  try {
    for (const layout of ['dev', 'packaged-layout']) {
      const root = path.join(temp, layout);
      async function write(name, content) {
        const target = path.join(root, name);
        await fs.mkdir(path.dirname(target), {recursive:true});
        await fs.writeFile(target, content);
      }
      for (const name of ['server.js','http-policy.cjs']) {
        await write('src/main/' + name, await fs.readFile(path.join(__dirname,'..','src','main',name)));
      }
      await write('src/renderer/index.html','<html>AiPDF fixture</html>');
      await write('src/renderer/js/app.js','export const ready = true;');
      await write('package.json','{"private":true}');
      await write('node_modules/pdfjs-dist/build/pdf.min.mjs','export const fixture = true;');
      await write('node_modules/pdfjs-dist/cmaps/sample.bcmap','cmap');
      const core = layout === 'dev' ? 'node_modules/tesseract.js-core' : 'node_modules/tesseract.js/node_modules/tesseract.js-core';
      await write(core + '/tesseract-core-simd-lstm.wasm.js','core');
      if (layout === 'dev') {
        delete process.resourcesPath;
        await write('vendor/tessdata/eng.traineddata','language');
      } else {
        process.resourcesPath = path.join(temp, 'external-resources');
        await fs.mkdir(path.join(process.resourcesPath,'tessdata'), {recursive:true});
        await fs.writeFile(path.join(process.resourcesPath,'tessdata','eng.traineddata'),'language');
      }
      const {start} = require(path.join(root,'src','main','server.js'));
      const {server,port,ocr} = await start();
      try {
        const cases = [
          ['renderer','/',200],['module','/js/app.js',200],
          ['PDF vendor','/v/pdf.min.mjs',200],['CMap','/v/cmaps/sample.bcmap',200],
          ['OCR core','/v/tesscore/tesseract-core-simd-lstm.wasm.js',200],
          ['OCR data','/v/tessdata/eng.traineddata',200],['health','/__ocr-health',200],
          ['malformed escape','/%E0%A4%A',400],['survives bad URL','/',200],
          ['NUL','/js%00/app.js',400],['Windows separator','/..%5cmain%5cserver.js',400],
          ['renderer traversal','/%2e%2e/main/server.js',403],
          ['vendor traversal','/v/cmaps/%2e%2e/build/pdf.min.mjs',403],
          ['unknown vendor','/v/private',404],['directory','/js/',404],['missing file','/missing',404],
          ['hostile Host','/',403,{host:'attacker.example:'+port}],
          ['hostile Origin','/',403,{origin:'https://attacker.example'}],
          ['same origin','/',200,{origin:'http://127.0.0.1:'+port}],
          ['cross-site','/',403,{'sec-fetch-site':'cross-site'}],
          ['POST','/',405,{},'POST'],
        ];
        for (const [label,url,status,headers,method] of cases) {
          await check(layout+': '+label, async()=>assert.equal((await request(port,url,headers,method)).status,status));
        }
        await check(layout+': health fields',async()=>{const r=await request(port,'/__ocr-health'); assert.equal(JSON.parse(r.body).ok,true); assert.equal(ocr.ok,true);});
        await check(layout+': JavaScript MIME',async()=>assert.match((await request(port,'/js/app.js')).headers['content-type'],/javascript/));
        await check(layout+': HEAD',async()=>{const r=await request(port,'/',{},'HEAD'); assert.equal(r.status,200); assert.equal(r.body,''); assert.ok(Number(r.headers['content-length'])>0);});
        await check(layout+': HEAD health',async()=>{const r=await request(port,'/__ocr-health',{},'HEAD'); assert.equal(r.body,''); assert.ok(Number(r.headers['content-length'])>0);});
        await check(layout+': cache',async()=>{const r=await request(port,'/'); assert.equal((await request(port,'/',{'if-modified-since':r.headers['last-modified']})).status,304);});
        await check(layout+': no unsupported range claim',async()=>assert.equal((await request(port,'/')).headers['accept-ranges'],undefined));
        await check(layout+': symlink escape',async()=>{
          await fs.symlink(path.join(root,'src','main'),path.join(root,'src','renderer','leak'),process.platform === 'win32' ? 'junction' : 'dir');
          assert.equal((await request(port,'/leak/server.js')).status,403);
        });
      } finally { await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
    }
  } finally {
    if (originalResources === undefined) delete process.resourcesPath; else process.resourcesPath=originalResources;
    await fs.rm(temp,{recursive:true,force:true});
  }
  console.log(JSON.stringify({checks,failed:0,scope:'Node HTTP integration; simulated asset layouts, not Electron ASAR or Windows installer'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
