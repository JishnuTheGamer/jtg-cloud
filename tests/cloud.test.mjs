import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { createApp } from '../src/server.mjs';
import { openStore } from '../src/database.mjs';
import { GiB, ROOT } from '../src/config.mjs';

test('JTG Cloud authentication, isolation, storage, permissions and recovery', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(),'jtg-cloud-test-'));
  const dataDir=path.join(temp,'data');
  const ownerInput={username:'cloudowner',email:'owner@example.com',displayName:'Cloud Owner',password:'12345678'};
  let app;
  const cli=(command,input,extra=[])=>spawnSync(process.execPath,['src/cli.mjs',command,'--stdin',...extra],{cwd:ROOT,input:JSON.stringify(input),encoding:'utf8',env:{...process.env,DATA_DIR:dataDir,BACKUP_DIR:path.join(temp,'backups'),NODE_ENV:'development',APP_URL:'http://localhost:6969'}});
  try {
    await t.test('terminal setup creates exactly one owner and no default credentials',()=>{
      const result=cli('setup',ownerInput);assert.equal(result.status,0,result.stderr);assert.ok(!result.stdout.includes(ownerInput.password));
      const second=cli('setup',{...ownerInput,username:'secondowner',email:'second@example.com'});assert.equal(second.status,1);assert.match(second.stderr,/already exists/);
    });
    app=await createApp({dataDir,port:0,production:false,secureCookie:false,appUrl:'http://127.0.0.1'});
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${app.server.address().port}`;app.cfg.appUrl=base;
    const request=async(route,{actor,method='GET',data,headers={},bytes}={})=>{
      const h={};if(actor){h.Cookie=actor.cookie;if(method!=='GET')h['X-CSRF-Token']=actor.csrf;}Object.assign(h,headers);
      if(data!==undefined)h['Content-Type']='application/json';
      const response=await fetch(base+route,{method,headers:h,body:bytes ?? (data!==undefined?JSON.stringify(data):undefined)});
      const type=response.headers.get('content-type') || '';
      const value=type.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());
      return {status:response.status,value,headers:response.headers};
    };
    const login=async(identifier,password=ownerInput.password)=>{
      const r=await request('/api/auth/login',{method:'POST',data:{identifier,password}});assert.equal(r.status,200,JSON.stringify(r.value));return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:r.value.csrf,user:r.value.user};
    };
    const register=async(username)=>{
      const r=await request('/api/auth/register',{method:'POST',data:{username,email:`${username}@example.com`,displayName:username,password:'A secure member passphrase!'}});assert.equal(r.status,201,JSON.stringify(r.value));return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:r.value.csrf,user:r.value.user};
    };
    const owner=await login('cloudowner'),alice=await register('alice'),bob=await register('bob');
    let fileId,folderId,admin;
    await t.test('email and username login, strong passwords, cookies and private routes',async()=>{
      assert.equal((await login(ownerInput.email)).user.role,'owner');assert.equal(alice.user.quota,5*GiB);assert.equal(alice.user.role,'member');
      const cookie=(await request('/api/auth/login',{method:'POST',data:{identifier:'cloudowner',password:ownerInput.password}})).headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Lax/);
      assert.equal((await request('/api/entries')).status,401);
      assert.equal((await request('/api/auth/login',{method:'POST',data:{identifier:'cloudowner',password:'wrong password'}})).status,401);
      assert.equal((await request('/api/auth/register',{method:'POST',data:{username:'shortpass',email:'short@example.com',password:'short'}})).status,400);
    });
    await t.test('CSRF, origin restrictions and security headers',async()=>{
      const r=await request('/api/folders',{actor:alice,method:'POST',data:{name:'bad'},headers:{'X-CSRF-Token':'wrong'}});assert.equal(r.status,403);
      assert.equal((await request('/api/folders',{actor:alice,method:'POST',data:{name:'bad'},headers:{Origin:'https://evil.example'}})).status,403);
      const page=await request('/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(page.headers.get('x-content-type-options'),'nosniff');
    });
    await t.test('folders, encrypted upload, authenticated download and no path traversal',async()=>{
      const folder=await request('/api/folders',{actor:alice,method:'POST',data:{name:'Documents'}});assert.equal(folder.status,201);folderId=folder.value.entry.id;
      const content=Buffer.from('Private document: this plaintext must never be stored on disk.');
      const uploaded=await request(`/api/upload?parent=${folderId}`,{actor:alice,method:'POST',bytes:content,headers:{'X-File-Name':encodeURIComponent('private.txt')}});assert.equal(uploaded.status,201,JSON.stringify(uploaded.value));fileId=uploaded.value.entry.id;
      const encrypted=await readFile(path.join(dataDir,'blobs',fileId));assert.ok(!encrypted.includes(content));assert.equal(encrypted.length,content.length);
      const download=await request(`/api/entries/${fileId}/download`,{actor:alice});assert.equal(download.status,200);assert.deepEqual(download.value,content);assert.match(download.headers.get('content-disposition'),/attachment/);
      assert.equal((await request(`/api/upload`,{actor:alice,method:'POST',bytes:content,headers:{'X-File-Name':encodeURIComponent('../escape.txt')}})).status,400);
      assert.equal((await request('/data/encryption.key')).status,404);
      assert.equal((await request('/api/folders',{actor:alice,method:'POST',data:{name:'Documents'}})).status,409);
    });
    await t.test('other members and the owner cannot read another account’s private file routes',async()=>{
      for(const actor of [bob,owner]) {
        assert.equal((await request(`/api/entries/${fileId}/download`,{actor})).status,404);
        assert.equal((await request(`/api/entries/${fileId}`,{actor,method:'PATCH',data:{name:'stolen'}})).status,404);
        assert.equal((await request(`/api/entries?parent=${folderId}`,{actor})).status,404);
      }
    });
    await t.test('star, search, rename and folder cycles',async()=>{
      assert.equal((await request(`/api/entries/${fileId}`,{actor:alice,method:'PATCH',data:{starred:true,name:'renamed.txt'}})).status,200);
      const starred=await request('/api/entries?view=starred',{actor:alice});assert.equal(starred.value.entries[0].id,fileId);
      const search=await request('/api/entries?q=RENAMED',{actor:alice});assert.equal(search.value.entries.length,1);
      const child=await request('/api/folders',{actor:alice,method:'POST',data:{name:'Nested',parentId:folderId}});
      assert.equal((await request(`/api/entries/${folderId}`,{actor:alice,method:'PATCH',data:{parentId:child.value.entry.id}})).status,400);
    });
    await t.test('storage includes trash, downloads are blocked while trashed, restore is recursive',async()=>{
      const used=(await request('/api/me',{actor:alice})).value.user.used;
      await request(`/api/entries/${folderId}`,{actor:alice,method:'DELETE'});
      assert.equal((await request(`/api/entries/${fileId}/download`,{actor:alice})).status,404);
      assert.equal((await request('/api/me',{actor:alice})).value.user.used,used);
      const trash=await request('/api/entries?view=trash',{actor:alice});assert.equal(trash.value.entries.length,1);
      assert.equal((await request(`/api/entries/${folderId}/restore`,{actor:alice,method:'POST',data:{}})).status,200);
      assert.equal((await request(`/api/entries/${fileId}/download`,{actor:alice})).status,200);
    });
    await t.test('restoring a folder preserves items previously trashed separately',async()=>{
      const child=await request('/api/folders',{actor:alice,method:'POST',data:{name:'Previously deleted',parentId:folderId}});
      await request(`/api/entries/${child.value.entry.id}`,{actor:alice,method:'DELETE'});
      await request(`/api/entries/${folderId}`,{actor:alice,method:'DELETE'});
      await request(`/api/entries/${folderId}/restore`,{actor:alice,method:'POST',data:{}});
      const listing=await request(`/api/entries?parent=${folderId}`,{actor:alice});assert.ok(!listing.value.entries.some(e=>e.id===child.value.entry.id));
      const trash=await request('/api/entries?view=trash',{actor:alice});assert.ok(trash.value.entries.some(e=>e.id===child.value.entry.id));
    });
    await t.test('only owner appoints admins; admins cannot change roles, delete or modify owner/admin accounts',async()=>{
      const created=await request('/api/admin/users',{actor:owner,method:'POST',data:{username:'adminuser',email:'admin@example.com',password:'A strong admin passphrase!',role:'admin'}});assert.equal(created.status,201);
      admin=await login('adminuser','A strong admin passphrase!');assert.equal(admin.user.role,'admin');
      const body={username:'rogueadmin',email:'rogue@example.com',password:'A strong admin passphrase!',role:'admin'};
      assert.equal((await request('/api/admin/users',{actor:admin,method:'POST',data:body})).status,403);
      assert.equal((await request(`/api/admin/users/${alice.user.id}`,{actor:admin,method:'PATCH',data:{role:'admin'}})).status,403);
      for(const id of [owner.user.id,admin.user.id])for(const method of ['DELETE','PATCH'])assert.equal((await request(`/api/admin/users/${id}`,{actor:admin,method,data:method==='PATCH'?{active:false}:undefined})).status,403);
      assert.equal((await request(`/api/admin/users/${owner.user.id}`,{actor:owner,method:'DELETE'})).status,403);
      assert.equal((await request(`/api/admin/users/${owner.user.id}`,{actor:owner,method:'PATCH',data:{role:'member'}})).status,403);
      assert.equal((await request(`/api/admin/users/${owner.user.id}`,{actor:owner,method:'PATCH',data:{quota:60*GiB}})).status,200);
      assert.equal((await request('/api/admin/users',{actor:owner,method:'POST',data:{...body,role:'owner'}})).status,403);
      assert.equal((await request('/api/admin/settings',{actor:admin,method:'PATCH',data:{siteName:'hijack'}})).status,403);
      assert.equal((await request('/api/admin/audit',{actor:admin})).status,403);
      assert.equal((await request('/api/admin/users',{actor:alice})).status,403);
      const member=await request('/api/admin/users',{actor:admin,method:'POST',data:{username:'charlie',email:'charlie@example.com',password:'A strong member passphrase!',role:'member'}});assert.equal(member.status,201);assert.equal(member.value.user.role,'member');
    });
    await t.test('owner settings control registration, new quotas and branding; active image content is excluded',async()=>{
      let r=await request('/api/admin/settings',{actor:owner,method:'PATCH',data:{siteName:'My Private Cloud',registrationEnabled:false,defaultQuota:2*GiB}});assert.equal(r.status,200);
      assert.equal((await request('/api/auth/register',{method:'POST',data:{username:'blocked',email:'blocked@example.com',password:'A strong member passphrase!'}})).status,403);
      assert.equal((await request('/api/config')).value.siteName,'My Private Cloud');
      assert.equal((await request('/api/admin/settings',{actor:owner,method:'PATCH',data:{logo:'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='}})).status,400);
      await request('/api/admin/settings',{actor:owner,method:'PATCH',data:{registrationEnabled:true}});
      const created=await request('/api/admin/users',{actor:owner,method:'POST',data:{username:'david',email:'david@example.com',password:'A strong member passphrase!'}});assert.equal(created.value.user.quota,2*GiB);
    });
    await t.test('quotas reject excess uploads and cannot be reduced below stored bytes',async()=>{
      assert.equal((await request(`/api/admin/users/${bob.user.id}`,{actor:admin,method:'PATCH',data:{quota:3}})).status,200);
      assert.equal((await request('/api/upload',{actor:bob,method:'POST',bytes:Buffer.from('four'),headers:{'X-File-Name':'limit.txt'}})).status,413);
      assert.equal((await request(`/api/admin/users/${alice.user.id}`,{actor:owner,method:'PATCH',data:{quota:1}})).status,400);
    });
    await t.test('raster previews are signature checked; HTML and SVG are attachment downloads',async()=>{
      const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=','base64');
      const img=await request('/api/upload',{actor:alice,method:'POST',bytes:image,headers:{'X-File-Name':'pixel.png'}});assert.equal(img.status,201);assert.equal(img.value.entry.mime,'image/png');
      const preview=await request(`/api/entries/${img.value.entry.id}/download?preview=1`,{actor:alice});assert.equal(preview.headers.get('content-type'),'image/png');assert.match(preview.headers.get('content-disposition'),/^inline/);
      const svg=await request('/api/upload',{actor:alice,method:'POST',bytes:Buffer.from('<svg onload="alert(1)"></svg>'),headers:{'X-File-Name':'unsafe.svg'}});
      const dl=await request(`/api/entries/${svg.value.entry.id}/download?preview=1`,{actor:alice});assert.equal(dl.headers.get('content-type'),'application/octet-stream');assert.match(dl.headers.get('content-disposition'),/^attachment/);
    });
    await t.test('parallel uploads cannot overcommit a user quota',async()=>{
      await request(`/api/admin/users/${bob.user.id}`,{actor:owner,method:'PATCH',data:{quota:6}});
      const pending=http.request(base+'/api/upload',{method:'POST',headers:{Cookie:bob.cookie,'X-CSRF-Token':bob.csrf,'X-File-Name':'first.txt','Content-Length':6}});
      const done=new Promise((resolve,reject)=>{pending.on('response',res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});pending.on('error',reject);});
      pending.write(Buffer.from('a'));
      await new Promise(resolve=>setTimeout(resolve,60));
      const second=await request('/api/upload',{actor:bob,method:'POST',bytes:Buffer.from('second'),headers:{'X-File-Name':'second.txt'}});assert.equal(second.status,409);
      pending.end(Buffer.from('bcdef'));assert.equal(await done,201);
      assert.equal((await request('/api/me',{actor:bob})).value.user.used,6);
    });
    await t.test('suspension and role updates revoke sessions',async()=>{
      await request(`/api/admin/users/${bob.user.id}`,{actor:admin,method:'PATCH',data:{active:false}});
      assert.equal((await request('/api/me',{actor:bob})).status,401);
      assert.equal((await request('/api/auth/login',{method:'POST',data:{identifier:'bob',password:'A secure member passphrase!'}})).status,401);
      await request(`/api/admin/users/${admin.user.id}`,{actor:owner,method:'PATCH',data:{role:'member'}});
      assert.equal((await request('/api/admin/users',{actor:admin})).status,401);
    });
    await t.test('permanent delete frees quota and removes encrypted blobs',async()=>{
      await request(`/api/entries/${folderId}`,{actor:alice,method:'DELETE'});
      assert.equal((await request(`/api/entries/${folderId}/purge`,{actor:alice,method:'DELETE'})).status,200);
      assert.ok(!(await readdir(path.join(dataDir,'blobs'))).includes(fileId));
      await request('/api/trash',{actor:alice,method:'DELETE'});
    });
    await t.test('password reset revokes sessions without exposing the new secret',async()=>{
      const reset=cli('reset-password',{identifier:'alice',password:'New secure member passphrase!'});assert.equal(reset.status,0,reset.stderr);assert.ok(!reset.stdout.includes('New secure member passphrase!'));
      assert.equal((await request('/api/me',{actor:alice})).status,401);assert.equal((await login('alice','New secure member passphrase!')).user.id,alice.user.id);
    });
    await t.test('second server and live backups are refused to protect consistency',async()=>{
      await assert.rejects(createApp({dataDir,production:false,secureCookie:false}),/running/);
      const backup=cli('backup',{});assert.equal(backup.status,1);assert.match(backup.stderr,/running/);
    });
    await t.test('rate limiting stops repeated login attempts',async()=>{
      let status;for(let i=0;i<22;i++)status=(await request('/api/auth/login',{method:'POST',data:{identifier:'unknown',password:'wrong'}})).status;
      assert.equal(status,429);
    });
    await app.close();app=null;
    await t.test('restart preserves accounts, encryption key and readable files',async()=>{
      app=await createApp({dataDir,port:0,production:false,secureCookie:false,appUrl:'http://127.0.0.1'});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
      const url=`http://127.0.0.1:${app.server.address().port}`;
      const r=await fetch(url+'/api/me',{headers:{Cookie:owner.cookie}});assert.equal(r.status,200);
      assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='owner'").get().n,1);
      const e=app.db.prepare("SELECT * FROM entries WHERE user_id=? AND name='pixel.png'").get(alice.user.id);
      const who=await fetch(url+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:'alice',password:'New secure member passphrase!'})});
      const dl=await fetch(url+`/api/entries/${e.id}/download`,{headers:{Cookie:who.headers.get('set-cookie').split(';')[0]}});assert.equal(dl.status,200);assert.equal((await dl.arrayBuffer()).byteLength,e.size);
    });
    await app.close();app=null;
    await t.test('offline backup restores database, encryption key and readable encrypted blobs together',async()=>{
      const result=cli('backup',{});assert.equal(result.status,0,result.stderr);
      const [backupName]=await readdir(path.join(temp,'backups'));const restored=path.join(temp,'backups',backupName);
      assert.deepEqual(await readFile(path.join(restored,'encryption.key')),await readFile(path.join(dataDir,'encryption.key')));
      app=await createApp({dataDir:restored,port:0,production:false,secureCookie:false,appUrl:'http://127.0.0.1'});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
      const url=`http://127.0.0.1:${app.server.address().port}`,e=app.db.prepare("SELECT * FROM entries WHERE user_id=? AND name='pixel.png'").get(alice.user.id);
      const who=await fetch(url+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:'alice',password:'New secure member passphrase!'})});assert.equal(who.status,200);
      const dl=await fetch(url+`/api/entries/${e.id}/download`,{headers:{Cookie:who.headers.get('set-cookie').split(';')[0]}});assert.equal(dl.status,200);assert.equal((await dl.arrayBuffer()).byteLength,e.size);
      await app.close();app=null;
    });
    await t.test('missing key is never regenerated for an existing database',async()=>{
      await rm(path.join(dataDir,'encryption.key'));
      assert.throws(()=>openStore(dataDir),/Missing encryption.key/);
      await assert.rejects(readFile(path.join(dataDir,'encryption.key')),error=>error.code==='ENOENT');
    });
    await t.test('production supports direct HTTP service without a domain',async()=>{
      const direct=await createApp({dataDir:path.join(temp,'direct'),production:true,appUrl:'http://localhost:6969'});
      try { assert.equal(direct.cfg.secureCookie,false); } finally { await direct.close(); }
    });
  } finally {if(app)await app.close();await rm(temp,{recursive:true,force:true});}
});
