// Cloudflare Pages Function: /api/scores
// Needs a D1 database bound to this Pages project with the variable name DB.
// Leaderboards are separated by mode. One best run per name per mode is kept,
// while total submitted games are counted separately for each mode.
const BAD_ROOTS=['fuck','fuk','fck','shit','cunt','bitch','bastard','wank','twat','bollock','slut','whore','nigg','faggot','retard','penis','vagina','pussy','dildo','porn','jizz','spastic','tranny','nazi','hitler','motherf','asshole','arsehole','dickhead','cocksuck','bellend','kkk'];
const BAD_WORDS=['ass','arse','cum','tit','tits','fag','fags','dick','cock','piss','prick','crap','hoe','sex','poo','poop','butt','butts','boob','boobs','dyke','wog','spic','coon','paki','chink','kike','rape','boner','knob','homo','nob','turd'];
const MODES=['single','gauntlet'];
const ANIMALS=['magpie','ibis','emu','roo','dingo','seagull','wombat'];
function cleanName(raw){return String(raw||'').replace(/[^A-Za-z0-9 .'\-]/g,'').replace(/\s+/g,' ').trim().slice(0,14);}
function isClean(name){
  const n=name.toLowerCase().replace(/[013457@$!|]/g,c=>({'0':'o','1':'i','3':'e','4':'a','5':'s','7':'t','@':'a','$':'s','!':'i','|':'i'}[c]));
  const letters=n.replace(/[^a-z]/g,''),collapsed=letters.replace(/(.)\1+/g,'$1');
  if(BAD_ROOTS.some(r=>letters.includes(r)||collapsed.includes(r)))return false;
  const toks=n.split(/[^a-z]+/).filter(Boolean);
  return !toks.concat([letters]).some(w=>BAD_WORDS.includes(w)||BAD_WORDS.includes(w.replace(/(.)\1+/g,'$1')));
}
const json=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const keyOf=n=>n.toLowerCase().replace(/[^a-z0-9]/g,'');
const validMode=m=>MODES.includes(m)?m:null;

let ready=false;
async function setup(db){
  if(ready)return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS leaderboard_v2 (
      id TEXT NOT NULL,
      mode TEXT NOT NULL,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      score INTEGER NOT NULL,
      stars INTEGER NOT NULL,
      time INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (mode,name_key))`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_lb_v2_rank ON leaderboard_v2 (mode, score DESC, time ASC)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS leaderboard_stats (
      mode TEXT PRIMARY KEY,
      games_recorded INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`INSERT OR IGNORE INTO leaderboard_stats (mode,games_recorded) VALUES ('single',0),('gauntlet',0)`)
  ]);
  // Add animal history to existing v2 tables without disturbing prior scores.
  const cols=await db.prepare(`PRAGMA table_info(leaderboard_v2)`).all();
  if(!(cols.results||[]).some(c=>c.name==='animals')){
    await db.prepare(`ALTER TABLE leaderboard_v2 ADD COLUMN animals TEXT NOT NULL DEFAULT '[]'`).run();
  }
  // Preserve the existing leaderboard as Gauntlet scores when the new table is first created.
  try{
    await db.prepare(`INSERT OR IGNORE INTO leaderboard_v2 (id,mode,name,name_key,score,stars,time,updated_at,animals)
      SELECT id,'gauntlet',name,name_key,score,stars,time,updated_at,'[]' FROM leaderboard`).run();
  }catch(e){
    // A brand-new database has no legacy leaderboard table; there is nothing to migrate.
    if(!String(e&&e.message||e).includes('no such table: leaderboard'))throw e;
  }
  // If legacy rows existed, make sure they contribute to the visible recorded-game count.
  const legacy=await db.prepare(`SELECT COUNT(*) AS n FROM leaderboard_v2 WHERE mode='gauntlet'`).first();
  await db.prepare(`UPDATE leaderboard_stats SET games_recorded=CASE WHEN games_recorded=0 THEN ?1 ELSE games_recorded END WHERE mode='gauntlet'`).bind(Number(legacy?.n||0)).run();
  ready=true;
}

export async function onRequestGet({request,env}){
  if(!env.DB)return json({error:'Leaderboard storage is not set up yet.'},500);
  const mode=validMode(new URL(request.url).searchParams.get('mode')||'single');
  if(!mode)return json({error:'Unknown leaderboard mode.'},400);
  await setup(env.DB);
  const {results}=await env.DB.prepare(`SELECT id,name,score,stars,time,animals FROM leaderboard_v2 WHERE mode=?1 ORDER BY score DESC,time ASC LIMIT 100`).bind(mode).all();
  const stat=await env.DB.prepare('SELECT games_recorded FROM leaderboard_stats WHERE mode=?1').bind(mode).first();
  for(const row of results){try{row.animals=JSON.parse(row.animals||'[]')}catch(e){row.animals=[]}}
  return json({mode,rows:results,count:Number(stat?.games_recorded||0)});
}

export async function onRequestPost({request,env}){
  if(!env.DB)return json({error:'Leaderboard storage is not set up yet.'},500);
  let b;try{b=await request.json();}catch(e){return json({error:'Bad request.'},400);}
  const mode=validMode(b.mode);
  if(!mode)return json({error:'Choose Single Play or Gauntlet.'},400);
  const name=cleanName(b.name),key=keyOf(name);
  const score=Math.round(Number(b.score)),stars=Math.round(Number(b.stars)),time=Math.round(Number(b.time));
  const animals=Array.isArray(b.animals)?b.animals.filter(x=>ANIMALS.includes(String(x))):[];
  const validAnimals=animals.length===(mode==='single'?1:7) && new Set(animals).size===animals.length && (mode==='gauntlet' ? ANIMALS.every(k=>animals.includes(k)) : true);
  if(!name||!key)return json({error:'Type a name first.'},400);
  if(!validAnimals)return json({error:'That run is missing its animal record.'},400);
  if(!isClean(name))return json({error:'Let’s keep it family friendly. Try another name.'},400);
  if(!(score>=0&&score<=60000&&stars>=(mode==='single'?1:7)&&stars<=(mode==='single'?3:21)&&time>=(mode==='single'?5:30)&&time<=(mode==='single'?180:900)))return json({error:'That score doesn’t look right.'},400);
  await setup(env.DB);
  const id=crypto.randomUUID();
  const r=await env.DB.prepare(`INSERT INTO leaderboard_v2 (id,mode,name,name_key,score,stars,time,animals)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
    ON CONFLICT(mode,name_key) DO UPDATE SET id=excluded.id,name=excluded.name,score=excluded.score,stars=excluded.stars,time=excluded.time,animals=excluded.animals,updated_at=datetime('now')
    WHERE excluded.score>leaderboard_v2.score OR (excluded.score=leaderboard_v2.score AND excluded.time<leaderboard_v2.time)`)
    .bind(id,mode,name,key,score,stars,time,JSON.stringify(animals)).run();
  await env.DB.prepare(`INSERT INTO leaderboard_stats (mode,games_recorded) VALUES (?1,1)
    ON CONFLICT(mode) DO UPDATE SET games_recorded=leaderboard_stats.games_recorded+1`).bind(mode).run();
  const row=await env.DB.prepare('SELECT id,name,score,stars,time,animals FROM leaderboard_v2 WHERE mode=?1 AND name_key=?2').bind(mode,key).first();
  const stat=await env.DB.prepare('SELECT games_recorded FROM leaderboard_stats WHERE mode=?1').bind(mode).first();
  if(row)row.animals=JSON.parse(row.animals||'[]');
  return json({ok:true,mode,id:row.id,improved:(r.meta&&r.meta.changes)>0,best:row,count:Number(stat?.games_recorded||0)});
}
