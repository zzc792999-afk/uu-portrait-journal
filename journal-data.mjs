import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export function journalData(app, sql, limit) {
  let ready, backup;
  async function ensure(){
    if(!sql)throw Error('Database unavailable');
    return ready ??= sql`CREATE TABLE IF NOT EXISTS uu_journal_days (
      device uuid NOT NULL, day date NOT NULL, mood smallint, cigarettes smallint NOT NULL,
      star boolean NOT NULL, favourites jsonb NOT NULL, published_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(device,day)
    )`.catch(error=>{ready=undefined;throw error;});
  }
  async function archive(){
    if(!sql)return;
    return backup ??= (async()=>{
      await sql`CREATE TABLE IF NOT EXISTS uu_site_archive (
        path text NOT NULL, digest text NOT NULL, part integer NOT NULL, data bytea NOT NULL,
        saved_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(path,digest,part)
      )`;
      for(const path of ['public/index.html','public/october.mp4','public/september.mp4','public/august.mp4']){
        const data=await readFile(new URL(path,import.meta.url));
        const digest=createHash('sha256').update(data).digest('hex');
        for(let offset=0;offset<data.length;offset+=524288){
          const part=offset/524288, chunk=data.subarray(offset,offset+524288).toString('base64');
          await sql`INSERT INTO uu_site_archive (path,digest,part,data) VALUES (${path},${digest},${part},decode(${chunk},'base64')) ON CONFLICT DO NOTHING`;
        }
      }
      console.info('Journal archive stored');
    })().catch(error=>{backup=undefined;console.error('Archive unavailable',error.code||'unavailable');});
  }
  app.get('/api/activity',async(_,res)=>{
    await ensure();
    const rows=await sql`SELECT to_char(day,'YYYY-MM-DD') AS day,mood,cigarettes,star
      FROM uu_journal_days ORDER BY day DESC,published_at DESC LIMIT 30`;
    res.json(rows);
  });
  app.post('/api/activity',limit,async(req,res)=>{
    const {device,mood,cigarettes,star,favourites}=req.body||{};
    if(typeof device!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(device)||
      !(mood===null||Number.isInteger(mood)&&mood>=0&&mood<=2)||
      !Number.isInteger(cigarettes)||cigarettes<0||cigarettes>100||typeof star!=='boolean'||
      !Array.isArray(favourites)||favourites.length>3||favourites.some(i=>!Number.isInteger(i)||i<0||i>2))return res.sendStatus(400);
    await ensure();
    await sql`INSERT INTO uu_journal_days (device,day,mood,cigarettes,star,favourites)
      VALUES (${device},(now() AT TIME ZONE 'Asia/Shanghai')::date,${mood},${cigarettes},${star},${JSON.stringify(favourites)}::jsonb)
      ON CONFLICT(device,day) DO UPDATE SET mood=EXCLUDED.mood,cigarettes=EXCLUDED.cigarettes,
      star=EXCLUDED.star,favourites=EXCLUDED.favourites,published_at=now()`;
    res.sendStatus(204);
  });
  void archive();
}
