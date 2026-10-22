import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {gzipSync} from 'node:zlib'
import test from 'node:test'
import {PublicHttpPool} from './web-http.ts'

async function fixture(run:(pool:PublicHttpPool,url:string,connections:()=>number)=>Promise<void>) {
  let connections=0
  const server=createServer((req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{location:'/gzip'});res.end();return}
    if(req.url==='/slow'){res.writeHead(200);res.write('start');return}
    if(req.url==='/large'){res.end('x'.repeat(100));return}
    res.writeHead(200,{'content-type':'text/plain; charset=utf-8','content-encoding':'gzip'});res.end(gzipSync('完整 source evidence'))
  });server.on('connection',()=>connections++)
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const pool=new PublicHttpPool(),url=`http://127.0.0.1:${(server.address() as any).port}`
  try{await run(pool,url,()=>connections)}finally{pool.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
}

test('public HTTP pool reuses a connection and preserves decompressed evidence and redirects',()=>fixture(async(pool,url,connections)=>{
  const options={timeoutMs:1000,maxBytes:1000}
  const first=await pool.fetch(url+'/gzip',options),second=await pool.fetch(url+'/redirect',options)
  assert.equal(first.body.toString(),'完整 source evidence')
  assert.equal(second.body.toString(),first.body.toString())
  assert.equal(second.finalUrl,url+'/gzip')
  assert.equal(second.status,200)
  assert.equal(connections(),1)
}))

test('public HTTP pool bounds decompressed bytes and cancels streaming bodies',()=>fixture(async(pool,url)=>{
  await assert.rejects(pool.fetch(url+'/large',{timeoutMs:1000,maxBytes:10}),/byte limit/)
  const controller=new AbortController()
  const request=pool.fetch(url+'/slow',{timeoutMs:1000,maxBytes:1000,signal:controller.signal})
  setTimeout(()=>controller.abort(),20)
  await assert.rejects(request)
  await assert.rejects(pool.fetch(url+'/slow',{timeoutMs:20,maxBytes:1000}))
}))
