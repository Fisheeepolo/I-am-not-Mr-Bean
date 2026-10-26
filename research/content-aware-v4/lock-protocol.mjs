import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const textHash=async p=>sha((await fs.readFile(path.join(root,p),'utf8')).replace(/\r\n?/g,'\n'));
export async function computeLock(){
 const files={};for(const p of ['PROTOCOL.md','fixtures.json','prepare-fixtures.py','metrics.py','test_metrics.py'])files[p]=await textHash(p);
 for(const name of (await fs.readdir(path.join(root,'baseline'))).sort())files['baseline/'+name]=await textHash('baseline/'+name);
 const fixtures=JSON.parse(await fs.readFile(path.join(root,'fixtures.json'),'utf8'));
 for(const f of fixtures)for(const p of [f.source,f.png,f.region,f.regionPng].filter(Boolean))files[p]=sha(await fs.readFile(path.join(root,p)));
 const white=JSON.parse(await fs.readFile(path.join(root,'../white-preservation/fixtures.json'),'utf8'));
 files['../white-preservation/fixtures.json']=await textHash('../white-preservation/fixtures.json');
 for(const f of white)for(const p of [f.source,f.mask])files['../white-preservation/'+p]=sha(await fs.readFile(path.join(root,'../white-preservation',p)));
 return files;
}
export async function verifyLock(){
 const lock=JSON.parse(await fs.readFile(path.join(root,'protocol-lock.json'),'utf8'));const actual=await computeLock();
 for(const [p,h] of Object.entries(lock.files))if(actual[p]!==h)throw new Error('Pre-registered file changed: '+p);
 return lock;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await fs.access(path.join(root,'protocol-lock.json'));await verifyLock();console.log('Protocol and fixtures still match lock.');}
 catch(e){if(e.code!=='ENOENT')throw e;const lock={protocol:'content-aware-v4.4',fixedAt:new Date().toISOString(),sourceHashNormalization:'UTF8 CRLF/CR to LF; binary data byte-exact',files:await computeLock()};await fs.writeFile(path.join(root,'protocol-lock.json'),JSON.stringify(lock,null,2)+'\n');console.log('Locked protocol, metrics, baseline, 15 main and 16 white-safety fixtures.');}
}
