import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../src/server.mjs';
import {ROOT} from '../src/config.mjs';

test('eight-character passwords work across setup, registration, changes, account creation and recovery',async()=>{
  // Use a separate server so password checks do not consume another suite's auth limit.
  const directory=await mkdtemp(path.join(os.tmpdir(),'jtg-password-'));
  const dataDir=path.join(directory,'data');let app;
  const cli=(command,input)=>spawnSync(process.execPath,['src/cli.mjs',command,'--stdin'],{cwd:ROOT,encoding:'utf8',input:JSON.stringify(input),env:{...process.env,DATA_DIR:dataDir,BACKUP_DIR:path.join(directory,'backups'),NODE_ENV:'development',APP_URL:'http://localhost:6969'}});
  try {
    const setup=cli('setup',{username:'policyowner',email:'policy@example.invalid',password:'12345678'});
    assert.equal(setup.status,0,setup.stderr);
    app=await createApp({dataDir,port:0,production:false,secureCookie:false,appUrl:'http://127.0.0.1'});
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${app.server.address().port}`;app.cfg.appUrl=base;
    const request=async(route,{actor,method='GET',data}={})=>{
      const headers={};if(actor){headers.Cookie=actor.cookie;if(method!=='GET')headers['X-CSRF-Token']=actor.csrf;}
      if(data!==undefined)headers['Content-Type']='application/json';
      const response=await fetch(base+route,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});
      return {status:response.status,value:await response.json(),headers:response.headers};
    };
    const login=async(identifier,password)=>{
      const result=await request('/api/auth/login',{method:'POST',data:{identifier,password}});
      assert.equal(result.status,200,JSON.stringify(result.value));
      return {cookie:result.headers.get('set-cookie').split(';')[0],csrf:result.value.csrf,user:result.value.user};
    };
    const owner=await login('policyowner','12345678');
    assert.equal((await request('/api/auth/register',{method:'POST',data:{username:'sevenchars',email:'seven@example.invalid',password:'1234567'}})).status,400);
    const created=await request('/api/auth/register',{method:'POST',data:{username:'eightchars',email:'eight@example.invalid',password:'12345678'}});
    assert.equal(created.status,201,JSON.stringify(created.value));
    const user=await login('eightchars','12345678');
    assert.equal((await request('/api/account',{actor:user,method:'PATCH',data:{currentPassword:'12345678',newPassword:'7654321'}})).status,400);
    assert.equal((await request('/api/account',{actor:user,method:'PATCH',data:{currentPassword:'12345678',newPassword:'Abcd1234'}})).status,200);
    assert.equal((await request('/api/me',{actor:user})).status,401);
    const changed=await login('eightchars','Abcd1234');
    const reset=cli('reset-password',{identifier:'eightchars',password:'87654321'});assert.equal(reset.status,0,reset.stderr);
    assert.equal((await request('/api/me',{actor:changed})).status,401);
    assert.equal((await login('eightchars','87654321')).user.id,user.user.id);
    const managed=await request('/api/admin/users',{actor:owner,method:'POST',data:{username:'managed8',email:'managed8@example.invalid',password:'Admin123',role:'member'}});
    assert.equal(managed.status,201,JSON.stringify(managed.value));
    assert.equal((await login('managed8','Admin123')).user.role,'member');
  } finally {await app?.close();await rm(directory,{recursive:true,force:true});}
});
