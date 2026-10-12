import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, statfs, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { config, serviceUrls, GiB, MiB } from '../src/config.mjs';
import { openStore, settings } from '../src/database.mjs';
import { createApp } from '../src/server.mjs';
import { hashPassword } from '../src/security.mjs';
import { fingerprintDigest } from '../public/fingerprint.js';

test('resume lookup remains stable on HTTP IP pages without SubtleCrypto',async()=>{
  const bytes=new TextEncoder().encode('hello');
  const digest=await fingerprintDigest(bytes,{});
  assert.match(digest,/^ip-4f9f2cab[0-9a-f]{24}$/);
  assert.equal(await fingerprintDigest(bytes,{}),digest);
  assert.notEqual(await fingerprintDigest(new TextEncoder().encode('hello changed'),{}),digest);
  assert.equal(await fingerprintDigest(bytes), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('service defaults to port 6969 and available IPv4 without a domain', () => {
  const keys=['PORT','HOST','APP_URL','COOKIE_SECURE','NODE_ENV'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try {
    for(const key of keys)delete process.env[key];
    process.env.NODE_ENV='production';
    const cfg=config();
    assert.equal(cfg.port,6969); assert.equal(cfg.host,'0.0.0.0');
    assert.equal(cfg.appUrl,'http://localhost:6969'); assert.equal(cfg.explicitAppUrl,false);
    assert.equal(cfg.secureCookie,false); assert.equal(cfg.production,true);
    assert.equal(config({appUrl:'https://operator.example'}).secureCookie,true);
    assert.throws(()=>config({appUrl:'ftp://localhost'}),/HTTP/);
    const urls=serviceUrls(); assert.ok(urls.includes('http://localhost:6969'));
    for(const address of urls){const url=new URL(address);assert.equal(url.protocol,'http:');assert.equal(url.port,'6969');assert.ok(url.hostname==='localhost'||isIP(url.hostname)===4);}
  } finally { for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key]; }
});

test('direct localhost/IP login keeps origin and CSRF protection',async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'jtg-cloud-direct-'));
  let app;
  try {
    app=await createApp({dataDir:temporary,port:0,host:'0.0.0.0',production:true,secureCookie:false,explicitAppUrl:false,trustProxy:false});
    const hash=await hashPassword('A direct service passphrase!'),id=randomUUID();
    app.db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)').run(id,'directowner','direct@example.invalid','Direct Owner',hash,'owner',50*GiB,1,Date.now());
    await new Promise(resolve=>app.server.listen(0,'0.0.0.0',resolve));
    const port=app.server.address().port,ip=`http://127.0.0.1:${port}`,local=`http://localhost:${port}`;
    const login=async base=>{
      const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({identifier:'directowner',password:'A direct service passphrase!'})});
      assert.equal(response.status,200,await response.clone().text());
      assert.match(response.headers.get('set-cookie'),/HttpOnly/);assert.match(response.headers.get('set-cookie'),/SameSite=Lax/);
      assert.doesNotMatch(response.headers.get('set-cookie'),/; Secure/);
      return {cookie:response.headers.get('set-cookie').split(';')[0],...(await response.json())};
    };
    await login(local);const actor=await login(ip);
    const create=async(origin,csrf)=>{
      const response=await fetch(ip+'/api/folders',{method:'POST',headers:{Origin:origin,Cookie:actor.cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({name:'Direct access'})});
      await response.text();return response.status;
    };
    assert.equal(await create(local,actor.csrf),403);
    assert.equal(await create(ip,'invalid'),403);
    assert.equal(await create(ip,actor.csrf),201);
    for(const host of [`attacker.invalid:${port}`,`127.0.0.1:${port+1}`]) {
      const status=await new Promise((resolve,reject)=>{
        const req=http.request(ip+'/api/me',{headers:{Host:host,Cookie:actor.cookie}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();
      });
      assert.equal(status,400);
    }
    const response=await fetch(ip+'/api/me',{headers:{Cookie:actor.cookie}});
    const me=await response.json();assert.equal(me.maxUpload,0);assert.equal(me.uploadChunkSize,20*MiB);
    const begin=async(name,size)=>{
      const response=await fetch(ip+'/api/uploads',{method:'POST',headers:{Origin:ip,Cookie:actor.cookie,'X-CSRF-Token':actor.csrf,'Content-Type':'application/json'},body:JSON.stringify({name,size})});
      return {status:response.status,...await response.json()};
    };
    const space=await statfs(temporary);
    // Metadata reservations allocate no file-sized buffer or physical disk space.
    const sizes=[600*MiB,10*GiB+137].filter(size=>size+64*MiB<space.bavail*space.bsize);
    assert.ok(sizes.length>0,'This check needs at least 664 MiB of free disk space.');
    for(const size of sizes){
      const result=await begin(`unlimited-${size}.bin`,size);assert.equal(result.status,201,JSON.stringify(result));assert.equal(result.upload.size,size);
      const cancel=await fetch(ip+`/api/uploads/${result.upload.id}`,{method:'DELETE',headers:{Origin:ip,Cookie:actor.cookie,'X-CSRF-Token':actor.csrf}});assert.equal(cancel.status,200);await cancel.text();
    }
    const limited=await fetch(ip+'/api/admin/settings',{method:'PATCH',headers:{Origin:ip,Cookie:actor.cookie,'X-CSRF-Token':actor.csrf,'Content-Type':'application/json'},body:JSON.stringify({maxUpload:MiB})});assert.equal(limited.status,200);await limited.text();
    assert.equal((await begin('optional-cap.bin',2*MiB)).status,413);
  } finally {if(app)await app.close();await rm(temporary,{recursive:true,force:true});}
});

test('existing file-size caps migrate to unlimited once while data and quotas remain',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'jtg-cloud-limits-'));
  let store;
  try {
    store=openStore(directory);const key=await readFile(path.join(directory,'encryption.key'));
    const id=randomUUID();
    store.db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)').run(id,'keptowner','kept@example.invalid','Kept Owner','fixture','owner',50*GiB,1,Date.now());
    store.db.prepare("INSERT INTO entries(id,user_id,name,kind,created_at,updated_at) VALUES (?,?,?,'folder',?,?)").run(randomUUID(),id,'Kept folder',Date.now(),Date.now());
    store.db.prepare("UPDATE settings SET value=? WHERE key='maxUpload'").run(JSON.stringify(512*MiB));store.db.exec('PRAGMA user_version=1');store.db.close();store=null;
    store=openStore(directory);assert.equal(settings(store.db).maxUpload,0);assert.equal(settings(store.db).uploadChunkSize,20*MiB);
    assert.equal(store.db.prepare('SELECT quota FROM users WHERE id=?').get(id).quota,50*GiB);assert.equal(store.db.prepare('SELECT name FROM entries').get().name,'Kept folder');
    assert.deepEqual(await readFile(path.join(directory,'encryption.key')),key);
    store.db.prepare("UPDATE settings SET value=? WHERE key='maxUpload'").run(JSON.stringify(7*GiB));store.db.close();store=null;
    store=openStore(directory);assert.equal(settings(store.db).maxUpload,7*GiB);
  } finally {store?.db.close();await rm(directory,{recursive:true,force:true});}
});
