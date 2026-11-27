import express from 'express';
import {neon} from '@neondatabase/serverless';
import {randomUUID} from 'node:crypto';

const app=express();
app.disable('x-powered-by');
const origin=process.env.SITE_ORIGIN;
const sql=process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
let setup;
function initialize(){
  if (!sql) throw Error('Database unavailable');
  return setup ??= (async()=>{
    await sql`CREATE TABLE IF NOT EXISTS uu_guestbook (
      id uuid PRIMARY KEY, nickname varchar(24) NOT NULL, message varchar(280) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  })().catch(error=>{setup=undefined;throw error;});
}

app.get('/health',(_,res)=>res.sendStatus(200));
app.use('/api',(req,res,next)=>{
  if (req.get('Origin')!==origin || !origin) return res.sendStatus(403);
  res.set({'Access-Control-Allow-Origin':origin,Vary:'Origin','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Cache-Control':'no-store'});
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
},express.json({limit:'2kb'}));

app.get('/api/guestbook',async(_,res)=>{
  await initialize();
  const rows=await sql`SELECT nickname,message,created_at FROM uu_guestbook ORDER BY created_at DESC,id DESC LIMIT 30`;
  res.json(rows);
});

const limits=new Map();
function limit(req,res,next){
  const key=req.get('X-Render-Client-IP') || req.ip;
  const now=Date.now();
  for(const [ip,value] of limits) if(value.until<=now) limits.delete(ip);
  const value=limits.get(key) || {count:0,until:now+60000};
  if(value.count>=6 || (!limits.has(key)&&limits.size>=2000)) return res.sendStatus(429);
  value.count++;
  limits.set(key,value);
  next();
}
app.post('/api/guestbook',limit,async(req,res)=>{
  const nickname=typeof req.body?.nickname==='string'?req.body.nickname.trim():'';
  const message=typeof req.body?.message==='string'?req.body.message.trim():'';
  if(!nickname || nickname.length>24 || !message || message.length>280) return res.sendStatus(400);
  await initialize();
  const rows=await sql`INSERT INTO uu_guestbook (id,nickname,message) VALUES (${randomUUID()},${nickname},${message}) RETURNING nickname,message,created_at`;
  res.status(201).json(rows[0]);
});
app.use((error,req,res,next)=>{
  if(error.status===400||error.status===413) return res.sendStatus(error.status);
  console.error('Request failed',req.path,error.code||'unavailable');
  res.sendStatus(503);
});
app.listen(process.env.PORT||3000,'0.0.0.0');
