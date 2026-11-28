import express from 'express';
import {journalData} from './journal-data.mjs';
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
    await sql`ALTER TABLE uu_guestbook ADD COLUMN IF NOT EXISTS reply_to uuid REFERENCES uu_guestbook(id)`;
    await sql`ALTER TABLE uu_guestbook ADD COLUMN IF NOT EXISTS stamp smallint CHECK (stamp BETWEEN 0 AND 3)`;
  })().catch(error=>{setup=undefined;throw error;});
}

app.get('/health',(_,res)=>res.sendStatus(200));
app.use('/api',(req,res,next)=>{
  if (req.get('Origin')!==origin || !origin) return res.sendStatus(403);
  res.set({'Access-Control-Allow-Origin':origin,Vary:'Origin','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Cache-Control':'no-store'});
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
},express.json({limit:'2kb'}));

app.get('/api/guestbook',async(req,res)=>{
  const {nickname,before}=req.query;
  if(nickname!==undefined){
    if(typeof nickname!=='string'||!nickname.trim()||nickname.length>24) return res.sendStatus(400);
    if(before!==undefined&&(typeof before!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(before))) return res.sendStatus(400);
    await initialize();
    const rows=await sql`SELECT id,nickname,message,created_at FROM uu_guestbook
      WHERE nickname=${nickname.trim()} AND (${before??null}::uuid IS NULL OR (created_at,id) < (
        SELECT created_at,id FROM uu_guestbook WHERE id=${before??null}::uuid AND nickname=${nickname.trim()}
      ))
      ORDER BY created_at DESC,id DESC LIMIT 31`;
    const page=rows.slice(0,30);
    return res.json({
      notes:page.map(({nickname,message,created_at})=>({nickname,message,created_at})),
      nextCursor:rows.length>page.length?page.at(-1).id:null
    });
  }
  await initialize();
  if(before!==undefined && (typeof before!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(before))) return res.sendStatus(400);
  const rows=await sql`SELECT n.id,n.nickname,n.message,n.created_at,n.stamp,n.reply_to,p.nickname AS parent_name,left(p.message,80) AS parent_message
    FROM uu_guestbook n LEFT JOIN uu_guestbook p ON p.id=n.reply_to
    WHERE ${before??null}::uuid IS NULL OR (n.created_at,n.id)<(SELECT created_at,id FROM uu_guestbook WHERE id=${before??null}::uuid)
    ORDER BY n.created_at DESC,n.id DESC LIMIT 30`;
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
app.post('/api/guestbook/:id/stamp',limit,async(req,res)=>{
  const stamp=req.body?.stamp,id=req.params.id;
  if(!Number.isInteger(stamp)||stamp<0||stamp>3||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))return res.sendStatus(400);
  await initialize();
  const rows=await sql`UPDATE uu_guestbook SET stamp=${stamp} WHERE id=${id} RETURNING stamp`;
  if(!rows.length)return res.sendStatus(404);
  res.json(rows[0]);
});
app.post('/api/guestbook',limit,async(req,res)=>{
  const nickname=typeof req.body?.nickname==='string'?req.body.nickname.trim():'';
  const message=typeof req.body?.message==='string'?req.body.message.trim():'';
  if(!nickname || nickname.length>24 || !message || message.length>280) return res.sendStatus(400);
  await initialize();
  const parent=req.body.reply_to??null;
  if(parent!==null && (typeof parent!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(parent)))return res.sendStatus(400);
  const rows=await sql`WITH added AS (
    INSERT INTO uu_guestbook(id,nickname,message,reply_to)
    SELECT ${randomUUID()},${nickname},${message},${parent}::uuid
    WHERE ${parent}::uuid IS NULL OR EXISTS(SELECT 1 FROM uu_guestbook WHERE id=${parent}::uuid)
    RETURNING *)
    SELECT n.id,n.nickname,n.message,n.created_at,n.stamp,n.reply_to,p.nickname AS parent_name,left(p.message,80) AS parent_message
    FROM added n LEFT JOIN uu_guestbook p ON p.id=n.reply_to`;
  if(!rows.length)return res.sendStatus(400);
  res.status(201).json(rows[0]);
});
journalData(app,sql,limit);
app.use((error,req,res,next)=>{
  if(error.status===400||error.status===413) return res.sendStatus(error.status);
  console.error('Request failed',req.path,error.code||'unavailable');
  res.sendStatus(503);
});
app.listen(process.env.PORT||3000,'0.0.0.0');
