const express = require("express");
const path = require("path");
const { jsonrepair } = require("jsonrepair");

const app = express();
const PORT = process.env.PORT || 10000;
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";

app.use(express.json({ limit: "3mb" }));
app.use(express.static(path.join(__dirname, "public"), {
  etag:true,
  maxAge:"10m",
  setHeaders(res,filePath){
    const base=path.basename(filePath);
    if(base==="index.html"||base==="service-worker.js"||base==="manifest.webmanifest"){
      res.setHeader("Cache-Control","no-cache, no-store, must-revalidate");
      res.setHeader("Pragma","no-cache");
      res.setHeader("Expires","0");
    }
  }
}));

const CHECKLIST = [
  "fixture_verification",
  "current_squads_authenticity",
  "confirmed_lineups",
  "injuries_suspensions",
  "recent_transfers",
  "rest_rotation_motivation",
  "last5_last10_form",
  "goals_xg_chance_quality",
  "shots_sot_possession",
  "corners_width_crossing_setpieces",
  "cards_referee",
  "opponent_strength_adjustment",
  "tactical_matchup_game_states",
  "h2h_venue_weather",
  "video_evidence"
];

const cache = new Map();
let apiFootballQueue = Promise.resolve();
let lastApiFootballCall = 0;

// Free API-Football accounts are rate-limited. Serialize calls and keep spacing
// conservative so a research request does not hammer the provider.
async function apiFootballThrottle(){
  const minGapMs = Number(process.env.API_FOOTBALL_MIN_GAP_MS || 6200);
  const now = Date.now();
  const wait = Math.max(0, minGapMs - (now - lastApiFootballCall));
  if(wait) await new Promise(r => setTimeout(r, wait));
  lastApiFootballCall = Date.now();
}
function queuedApiFootball(fn){
  apiFootballQueue = apiFootballQueue.then(async () => {
    await apiFootballThrottle();
    return fn();
  }, async () => {
    await apiFootballThrottle();
    return fn();
  });
  return apiFootballQueue;
}



const researchProgress = new Map();
const researchResults = new Map();

function setResearchProgress(id,{percent,stage,stageNumber,totalStages=10,message,status="running",detail=""}={}){
  if(!id)return;
  const prev=researchProgress.get(id)||{
    id,startedAt:isoNow(),percent:0,stage:"Queued",stageNumber:0,totalStages,logs:[]
  };
  const now=isoNow();
  const next={
    ...prev,
    percent:Number.isFinite(Number(percent))?Math.max(prev.percent||0,Math.min(100,Number(percent))):prev.percent,
    stage:stage||prev.stage,
    stageNumber:Number.isFinite(Number(stageNumber))?Number(stageNumber):prev.stageNumber,
    totalStages:Number(totalStages||prev.totalStages||10),
    message:message||prev.message||"",
    detail:detail||"",
    status,
    updatedAt:now
  };
  if(message && (!prev.logs?.length || prev.logs[prev.logs.length-1]?.message!==message)){
    next.logs=[...(prev.logs||[]),{at:now,stage:next.stage,message,detail:detail||""}].slice(-20);
  }
  researchProgress.set(id,next);
}
function failResearchProgress(id,err){
  if(!id)return;
  const prev=researchProgress.get(id)||{};
  setResearchProgress(id,{
    percent:prev.percent||0,
    stage:"Stopped",
    stageNumber:prev.stageNumber||0,
    totalStages:prev.totalStages||10,
    message:`Research stopped: ${String(err?.message||err||"Unknown error")}`,
    status:"error"
  });
}
function finishResearchProgress(id){
  if(!id)return;
  setResearchProgress(id,{
    percent:100,stage:"Complete",stageNumber:10,totalStages:10,
    message:"Research round complete. Results are ready for presentation.",
    status:"complete"
  });
}
// Keep in-memory progress lightweight on the free Render instance.
setInterval(()=>{
  const cutoff=Date.now()-45*60*1000;
  for(const [id,p] of researchProgress){
    const t=Date.parse(p.updatedAt||p.startedAt||0);
    if(Number.isFinite(t)&&t<cutoff){
      researchProgress.delete(id);
      researchResults.delete(id);
    }
  }
},10*60*1000).unref?.();

const providerUsage = {
  apiFootball:{calls:0,success:0,fail:0,lastError:"",lastQuota:null},
  tavily:{calls:0,success:0,fail:0,lastError:""},
  footballDataOrg:{calls:0,success:0,fail:0,lastError:""},
  theSportsDB:{calls:0,success:0,fail:0,lastError:""},
  scoreBat:{calls:0,success:0,fail:0,lastError:""},
  gemini:{calls:0,success:0,fail:0,lastError:""},
  groq:{calls:0,success:0,fail:0,lastError:""},
  cloudflare:{calls:0,success:0,fail:0,lastError:""},
  openrouter:{calls:0,success:0,fail:0,lastError:""}
};
function usageStart(name){ if(providerUsage[name]) providerUsage[name].calls++; }
function usageOk(name,extra={}){ if(providerUsage[name]){ providerUsage[name].success++; Object.assign(providerUsage[name],extra); } }
function usageFail(name,err){ if(providerUsage[name]){ providerUsage[name].fail++; providerUsage[name].lastError=String(err?.message||err||"").slice(0,240); } }
function providerConfigured(){
  return {
    apiFootball:Boolean(process.env.API_FOOTBALL_KEY),
    tavily:Boolean(process.env.TAVILY_API_KEY),
    gemini:Boolean(process.env.GEMINI_API_KEY),
    groq:Boolean(process.env.GROQ_API_KEY),
    cloudflare:Boolean(process.env.CLOUDFLARE_ACCOUNT_ID&&process.env.CLOUDFLARE_AUTH_TOKEN),
    openrouter:Boolean(process.env.OPENROUTER_API_KEY),
    footballDataOrg:Boolean(process.env.FOOTBALL_DATA_ORG_KEY),
    theSportsDB:true,
    scoreBat:Boolean(process.env.SCOREBAT_TOKEN)
  };
}

function requireEnv(name){
  const value = process.env[name];
  if(!value) {
    const err = new Error(`${name} is not configured on the server.`);
    err.status = 503;
    throw err;
  }
  return value;
}
function cleanFixture(f){
  return String(f || "").replace(/\s+/g, " ").trim().slice(0, 200);
}
function parseFixtureTeams(raw){
  const s = cleanFixture(raw);
  const separators = [
    /\s+vs\.?\s+/i,
    /\s+v\s+/i,
    /\s+\|\s+/,
    /\s+—\s+/,
    /\s+–\s+/,
    /\s+-\s+/
  ];
  for(const rx of separators){
    const parts = s.split(rx).map(x=>x.trim()).filter(Boolean);
    if(parts.length === 2) return {home:parts[0], away:parts[1]};
  }
  return null;
}
function normalizeTeamName(s){
  return String(s||"")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/&/g," and ")
    .replace(/[^a-z0-9]+/g," ")
    .replace(/\b(fc|cf|afc|ac|sc|ssd|fk|fk|calcio|football club)\b/g," ")
    .replace(/\s+/g," ").trim();
}
function teamSimilarity(a,b){
  const x=normalizeTeamName(a), y=normalizeTeamName(b);
  if(!x||!y) return 0;
  if(x===y) return 1;
  if(x.includes(y)||y.includes(x)) return 0.88;
  const A=new Set(x.split(" ")), B=new Set(y.split(" "));
  let inter=0; for(const t of A) if(B.has(t)) inter++;
  const union=new Set([...A,...B]).size || 1;
  const j=inter/union;
  const prefix=(x[0]===y[0])?0.04:0;
  return Math.min(0.95,j+prefix);
}
function isoNow(){ return new Date().toISOString(); }
function getCached(key, maxAgeMs){
  const v=cache.get(key);
  if(v && Date.now()-v.at < maxAgeMs) return v.value;
  return null;
}
function setCached(key,value){ cache.set(key,{at:Date.now(),value}); return value; }

async function apiFootball(endpoint, params={}, {cacheMs=0, force=false}={}){
  const key = requireEnv("API_FOOTBALL_KEY");
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k,v])=>{ if(v!==undefined && v!==null && v!=="") qs.set(k,String(v)); });
  const cacheKey = `api-football:${endpoint}?${qs}`;
  if(!force && cacheMs){
    const hit=getCached(cacheKey,cacheMs);
    if(hit) return hit;
  }
  const value = await queuedApiFootball(async()=>{
    const response = await fetch(`${API_FOOTBALL_BASE}${endpoint}?${qs}`, {
      headers: {"x-apisports-key": key}
    });
    const raw = await response.text();
    if(!response.ok) throw new Error(`API-Football failed (${response.status}): ${raw.slice(0,260)}`);
    let data;
    try{ data=JSON.parse(raw); }catch{ throw new Error("API-Football returned invalid JSON."); }
    const apiErrors=data.errors && (Array.isArray(data.errors)?data.errors.length:Object.keys(data.errors).length);
    if(apiErrors) throw new Error(`API-Football error: ${JSON.stringify(data.errors).slice(0,320)}`);
    return {
      data,
      quota:{
        dailyRemaining: response.headers.get("x-ratelimit-requests-remaining"),
        dailyLimit: response.headers.get("x-ratelimit-requests-limit"),
        minuteRemaining: response.headers.get("x-ratelimit-remaining"),
        minuteLimit: response.headers.get("x-ratelimit-limit")
      },
      fetchedAt: isoNow()
    };
  });
  return cacheMs ? setCached(cacheKey,value) : value;
}

function teamSearchVariants(requested){
  const raw=String(requested||"").trim();
  const norm=normalizeTeamName(raw);
  const variants=[raw];
  if(norm && norm.toLowerCase()!==raw.toLowerCase()) variants.push(norm);

  const tokens=norm.split(" ").filter(Boolean);
  if(tokens.length>1 && tokens[0].length>=4) variants.push(tokens[0]);

  const aliases={
    "wolverhampton wanderers":["Wolverhampton","Wolves"],
    "manchester united":["Manchester United","Man United"],
    "manchester city":["Manchester City","Man City"],
    "tottenham hotspur":["Tottenham","Spurs"],
    "newcastle united":["Newcastle"],
    "nottingham forest":["Nottingham Forest","Nottm Forest"],
    "brighton and hove albion":["Brighton"],
    "west ham united":["West Ham"],
    "lokomotiv moscow":["Lokomotiv Moskva","Lokomotiv Moscow"],
    "krylia sovetov samara":["Krylya Sovetov","Krylia Sovetov"]
  };
  for(const a of (aliases[norm]||[])) variants.push(a);

  return [...new Set(variants.map(x=>x.trim()).filter(Boolean))].slice(0,4);
}
async function resolveTeam(requested,{force=false}={}){
  const variants=teamSearchVariants(requested);
  const all=[], seen=new Set();
  let lastQuota=null,checkedAt=isoNow();

  for(let i=0;i<variants.length;i++){
    const q=variants[i];
    const result=await apiFootball("/teams",{search:q},{cacheMs:24*3600e3,force});
    lastQuota=result.quota;checkedAt=result.fetchedAt;
    for(const x of (result.data.response||[])){
      const id=x.team?.id;
      if(!id||seen.has(id))continue;
      seen.add(id);
      all.push({
        id,name:x.team?.name||"",country:x.team?.country||"",logo:x.team?.logo||"",
        score:teamSimilarity(requested,x.team?.name||""),
        foundBy:q
      });
    }
    all.sort((a,b)=>b.score-a.score);
    if(all[0]?.score>=0.65) break;
  }
  const best=all.sort((a,b)=>b.score-a.score)[0]||null;
  return {
    requested,best,alternatives:all.slice(1,4),
    confidence:best?best.score:0,
    searchVariantsTried:variants.slice(0,Math.max(1,variants.findIndex(v=>v===best?.foundBy)+1)),
    quota:lastQuota,checkedAt
  };
}
async function currentSquad(teamId,{force=false}={}){
  const result=await apiFootball("/players/squads",{team:teamId},{cacheMs:6*3600e3,force});
  const teamBlock=result.data.response?.[0]||{};
  return {
    team:teamBlock.team||null,
    players:(teamBlock.players||[]).map(p=>({
      id:p.id,name:p.name,age:p.age,number:p.number,position:p.position
    })),
    quota:result.quota,
    checkedAt:result.fetchedAt
  };
}
async function findUpcomingFixture(homeId,awayId,{force=false}={}){
  const result=await apiFootball("/fixtures",{team:homeId,next:20,timezone:"Africa/Lusaka"},{cacheMs:10*60e3,force});
  const matches=(result.data.response||[]);
  const exact=matches.find(x=>{
    const h=x.teams?.home?.id, a=x.teams?.away?.id;
    return (h===homeId&&a===awayId)||(h===awayId&&a===homeId);
  });
  return {match:exact||null, quota:result.quota, checkedAt:result.fetchedAt};
}
async function fixtureDetails(fixtureId,{force=false}={}){
  const result=await apiFootball("/fixtures",{id:fixtureId,timezone:"Africa/Lusaka"},{cacheMs:2*60e3,force});
  return {match:result.data.response?.[0]||null, quota:result.quota, checkedAt:result.fetchedAt};
}
async function fixtureInjuries(fixtureId,{force=false}={}){
  const result=await apiFootball("/injuries",{fixture:fixtureId,timezone:"Africa/Lusaka"},{cacheMs:2*60e3,force});
  const rows=(result.data.response||[]).map(x=>({
    player:x.player?.name||"",
    playerId:x.player?.id||null,
    team:x.team?.name||"",
    teamId:x.team?.id||null,
    type:x.player?.type||x.type||"",
    reason:x.player?.reason||x.reason||""
  }));
  return {rows,quota:result.quota,checkedAt:result.fetchedAt};
}
async function recentTransfers(teamId,{force=false}={}){
  const result=await apiFootball("/transfers",{team:teamId},{cacheMs:6*3600e3,force});
  const cut=Date.now()-1000*60*60*24*180;
  const rows=[];
  for(const entry of (result.data.response||[])){
    const player=entry.player||{};
    for(const t of (entry.transfers||[])){
      const ts=Date.parse(t.date||"");
      if(!Number.isFinite(ts)||ts<cut) continue;
      rows.push({
        player:player.name||"",
        date:t.date||"",
        type:t.type||"",
        from:t.teams?.out?.name||"",
        to:t.teams?.in?.name||""
      });
    }
  }
  rows.sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  return {rows:rows.slice(0,20),quota:result.quota,checkedAt:result.fetchedAt};
}
function compactLineups(match){
  return (match?.lineups||[]).map(l=>({
    team:l.team?.name||"",
    formation:l.formation||"",
    coach:l.coach?.name||"",
    startXI:(l.startXI||[]).map(x=>x.player?.name).filter(Boolean),
    substitutes:(l.substitutes||[]).map(x=>x.player?.name).filter(Boolean)
  }));
}
function compactFixture(match){
  if(!match) return null;
  return {
    id:match.fixture?.id,
    date:match.fixture?.date,
    timestamp:match.fixture?.timestamp,
    status:match.fixture?.status?.long||match.fixture?.status?.short||"",
    venue:match.fixture?.venue?.name||"",
    city:match.fixture?.venue?.city||"",
    league:match.league?.name||"",
    country:match.league?.country||"",
    season:match.league?.season||null,
    round:match.league?.round||"",
    home:{id:match.teams?.home?.id,name:match.teams?.home?.name||""},
    away:{id:match.teams?.away?.id,name:match.teams?.away?.name||""},
    lineups:compactLineups(match)
  };
}
function lastQuota(...items){
  const flat=items.flat().filter(Boolean);
  for(let i=flat.length-1;i>=0;i--) if(flat[i].quota) return flat[i].quota;
  return null;
}
async function buildAuthenticityGate(fixtureText,round){
  const parsed=parseFixtureTeams(fixtureText);
  if(!parsed){
    return {
      status:"FAILED",
      checkedAt:isoNow(),
      warnings:["Could not split fixture into two team names. Use 'Team A vs Team B'."],
      requested:{home:"",away:""},
      resolved:null, fixture:null, squads:null, injuries:[], transfers:[], confirmedLineups:false
    };
  }
  const force=round>1;
  const home=await resolveTeam(parsed.home,{force:false});
  const away=await resolveTeam(parsed.away,{force:false});
  const warnings=[];
  if(!home.best||home.confidence<0.42) warnings.push(`Home team resolution is uncertain: "${parsed.home}".`);
  if(!away.best||away.confidence<0.42) warnings.push(`Away team resolution is uncertain: "${parsed.away}".`);
  if(!home.best||!away.best){
    return {
      status:"FAILED",checkedAt:isoNow(),warnings,requested:parsed,
      resolved:{home,away},fixture:null,squads:null,injuries:[],transfers:[],confirmedLineups:false,
      quota:lastQuota(home,away)
    };
  }

  const homeSquad=await currentSquad(home.best.id,{force});
  const awaySquad=await currentSquad(away.best.id,{force});
  const candidate=await findUpcomingFixture(home.best.id,away.best.id,{force});
  let details=null, injuries={rows:[]}, transfers=[];
  if(candidate.match){
    details=await fixtureDetails(candidate.match.fixture.id,{force:true});
    injuries=await fixtureInjuries(candidate.match.fixture.id,{force:true});
  }else{
    warnings.push("API-Football did not find this matchup among the home team's next 20 fixtures.");
  }
  // A fresh Relearn round adds transfer activity so stale squad/player claims get another check.
  if(round>1){
    const [ht,at]=await Promise.all([
      recentTransfers(home.best.id,{force:true}),
      recentTransfers(away.best.id,{force:true})
    ]);
    transfers=[...(ht.rows||[]),...(at.rows||[])].sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,30);
  }

  const fixture=compactFixture(details?.match||candidate.match);
  const lineups=fixture?.lineups||[];
  const confirmedLineups=lineups.some(x=>(x.startXI||[]).length>=10);
  if(fixture){
    const ids=[fixture.home?.id,fixture.away?.id];
    if(!ids.includes(home.best.id)||!ids.includes(away.best.id)){
      warnings.push("Resolved fixture teams do not exactly match both resolved team IDs.");
    }
  }
  if(!confirmedLineups) warnings.push("Confirmed starting XIs are not available yet; do not present a predicted XI as confirmed.");

  let status="VERIFIED";
  if(warnings.length || home.confidence<0.65 || away.confidence<0.65 || !fixture) status="CAUTION";
  if(home.confidence<0.42 || away.confidence<0.42) status="FAILED";

  return {
    status,
    checkedAt:isoNow(),
    requested:parsed,
    resolved:{
      home:{id:home.best.id,name:home.best.name,country:home.best.country,confidence:home.confidence},
      away:{id:away.best.id,name:away.best.name,country:away.best.country,confidence:away.confidence}
    },
    fixture,
    squads:{
      home:{team:home.best.name,count:homeSquad.players.length,players:homeSquad.players},
      away:{team:away.best.name,count:awaySquad.players.length,players:awaySquad.players}
    },
    injuries:injuries.rows||[],
    transfers,
    confirmedLineups,
    warnings,
    quota:lastQuota(details,injuries,candidate,homeSquad,awaySquad,home,away)
  };
}


function fixtureTemporalGuard(gate){
  const f=gate?.fixture;
  if(!f?.date){
    return {
      mode:"UNKNOWN",bettingAllowed:false,fixtureDate:"",
      reason:"Fixture kickoff time could not be verified. Pre-match betting conclusions are blocked until the fixture is verified."
    };
  }
  const kickoff=Date.parse(f.date);
  const status=String(f.status||"").toLowerCase();
  const now=Date.now();
  const futureStatuses=["not started","ns","time to be defined","tbd","scheduled","timed"];
  const finished=/finished|match finished|\bft\b|after extra time|penalties/i.test(status);
  const live=/first half|second half|halftime|extra time|penalt|live|in play/i.test(status);

  if(finished || live || (Number.isFinite(kickoff) && kickoff <= now-5*60*1000)){
    return {
      mode:finished?"POST_MATCH_AUDIT":"LIVE_OR_STARTED",
      bettingAllowed:false,fixtureDate:f.date,
      reason:finished
        ?"This fixture has already finished. Post-match evidence must not be used as if it were a pre-match prediction."
        :"This fixture has started or its verified kickoff has passed. New betting recommendations/value analysis are blocked."
    };
  }
  if(Number.isFinite(kickoff) && kickoff>now){
    return {mode:"PREMATCH",bettingAllowed:true,fixtureDate:f.date,reason:"Verified fixture is still in the future."};
  }
  if(futureStatuses.some(s=>status.includes(s))){
    return {mode:"PREMATCH",bettingAllowed:true,fixtureDate:f.date,reason:"Fixture status indicates it has not started."};
  }
  return {mode:"UNKNOWN",bettingAllowed:false,fixtureDate:f.date,reason:"Fixture timing/status is ambiguous; betting conclusions are blocked."};
}

function structuredDigest(gate){
  if(!gate) return "Unavailable";
  const playerList = side => (gate.squads?.[side]?.players||[]).map(p=>`${p.name} (${p.position||"?"})`).join(", ");
  const lineupText=(gate.fixture?.lineups||[]).map(l=>`${l.team}: ${l.startXI.join(", ")} | Bench: ${l.substitutes.join(", ")}`).join("\n");
  const injuryText=(gate.injuries||[]).map(x=>`${x.team}: ${x.player} — ${x.type}${x.reason?` (${x.reason})`:""}`).join("\n");
  const transferText=(gate.transfers||[]).map(x=>`${x.date}: ${x.player} ${x.from} -> ${x.to} [${x.type}]`).join("\n");
  return `
AUTHENTICITY STATUS: ${gate.status}
CHECKED AT: ${gate.checkedAt}
REQUESTED: ${gate.requested?.home||"?"} vs ${gate.requested?.away||"?"}
RESOLVED HOME: ${gate.resolved?.home?.name||"unresolved"} (confidence ${gate.resolved?.home?.confidence??0})
RESOLVED AWAY: ${gate.resolved?.away?.name||"unresolved"} (confidence ${gate.resolved?.away?.confidence??0})
FIXTURE: ${JSON.stringify(gate.fixture)}
CURRENT HOME SQUAD: ${playerList("home")}
CURRENT AWAY SQUAD: ${playerList("away")}
CURRENT INJURIES/SUSPENSIONS:
${injuryText||"None returned / unavailable"}
CONFIRMED LINEUPS:
${lineupText||"Not available"}
RECENT TRANSFERS (extra check on Relearn rounds):
${transferText||"Not queried in this round or none returned"}
WARNINGS: ${(gate.warnings||[]).join(" | ")||"None"}
`;
}



function zambiaDate(offsetDays=0){
  const d=new Date(Date.now()+offsetDays*86400000);
  // Africa/Lusaka is UTC+2 and has no DST.
  const local=new Date(d.getTime()+2*3600000);
  return local.toISOString().slice(0,10);
}

function coverageObjectForSeason(leagueResponse, season){
  const item=(leagueResponse?.data?.response||[])[0];
  const seasons=item?.seasons||[];
  const s=seasons.find(x=>Number(x.year)===Number(season)) || seasons.find(x=>x.current) || seasons.at(-1);
  return s?.coverage||null;
}
function bool(v){return v===true}
function coverageScore(coverage){
  if(!coverage)return {score:0,parts:[],note:"No league-season coverage object returned."};
  const fx=coverage.fixtures||{};
  const weights=[
    ["events",bool(fx.events),10],
    ["lineups",bool(fx.lineups),16],
    ["fixture statistics",bool(fx.statistics_fixtures),16],
    ["player statistics",bool(fx.statistics_players),10],
    ["players",bool(coverage.players),8],
    ["injuries",bool(coverage.injuries),14],
    ["predictions",bool(coverage.predictions),8],
    ["standings",bool(coverage.standings),5],
    ["top scorers/assists/cards",bool(coverage.top_scorers)||bool(coverage.top_assists)||bool(coverage.top_cards),5]
  ];
  let score=0,total=weights.reduce((a,x)=>a+x[2],0),parts=[];
  for(const [name,ok,w] of weights){if(ok)score+=w;parts.push({name,available:ok,weight:w});}
  return {score:Math.round(score/total*100),parts,note:"Odds coverage is deliberately excluded from discovery scoring."};
}

async function footballDataOrg(pathname,params={}){
  const key=requireEnv("FOOTBALL_DATA_ORG_KEY");
  usageStart("footballDataOrg");
  const qs=new URLSearchParams();
  Object.entries(params).forEach(([k,v])=>{ if(v!==undefined&&v!==null&&v!=="") qs.set(k,String(v)); });
  try{
    const r=await fetch(`https://api.football-data.org/v4${pathname}${qs.size?`?${qs}`:""}`,{headers:{"X-Auth-Token":key}});
    const text=await r.text();
    if(!r.ok) throw new Error(`football-data.org failed (${r.status}): ${text.slice(0,220)}`);
    usageOk("footballDataOrg");
    return parseHttpJson(text,"football-data.org");
  }catch(err){ usageFail("footballDataOrg",err); throw err; }
}
async function footballDataFindFixture(home,away,dateHint=""){
  if(!process.env.FOOTBALL_DATA_ORG_KEY) return {available:false,reason:"FOOTBALL_DATA_ORG_KEY not configured"};
  try{
    const data=await footballDataOrg("/matches",{dateFrom:dateHint||zambiaDate(-1),dateTo:dateHint||zambiaDate(14)});
    const matches=(data.matches||[]).map(m=>({
      id:m.id,date:m.utcDate,status:m.status,competition:m.competition?.name||"",
      home:m.homeTeam?.name||"",away:m.awayTeam?.name||""
    }));
    const ranked=matches.map(m=>({...m,score:Math.max(
      teamSimilarity(home,m.home)*0.5+teamSimilarity(away,m.away)*0.5,
      teamSimilarity(home,m.away)*0.5+teamSimilarity(away,m.home)*0.5
    )})).sort((a,b)=>b.score-a.score);
    const best=ranked[0]||null;
    return {available:Boolean(best&&best.score>=0.62),best,checkedAt:isoNow(),count:matches.length};
  }catch(err){ return {available:false,reason:err.message,checkedAt:isoNow()}; }
}
async function footballDataFixturesForDates(days=2){
  if(!process.env.FOOTBALL_DATA_ORG_KEY) return [];
  const data=await footballDataOrg("/matches",{dateFrom:zambiaDate(0),dateTo:zambiaDate(Math.max(0,days-1))});
  return (data.matches||[]).filter(m=>["SCHEDULED","TIMED"].includes(m.status)).map(m=>({
    fixture:`${m.homeTeam?.name||""} vs ${m.awayTeam?.name||""}`,
    date:m.utcDate,league:m.competition?.name||"",country:m.area?.name||"",
    source:"football-data.org",sourceId:m.id
  }));
}
async function sportsDb(endpoint,params={}){
  const apiKey=process.env.THESPORTSDB_API_KEY||"123";
  usageStart("theSportsDB");
  const qs=new URLSearchParams();
  Object.entries(params).forEach(([k,v])=>{ if(v!==undefined&&v!==null&&v!=="") qs.set(k,String(v)); });
  try{
    const r=await fetch(`https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(apiKey)}/${endpoint}?${qs}`);
    const text=await r.text();
    if(!r.ok) throw new Error(`TheSportsDB failed (${r.status}): ${text.slice(0,220)}`);
    usageOk("theSportsDB");
    return parseHttpJson(text,"TheSportsDB");
  }catch(err){ usageFail("theSportsDB",err); throw err; }
}
async function sportsDbFindFixture(home,away,dateHint=""){
  const term=`${home}_vs_${away}`.replace(/\s+/g,"_");
  try{
    const data=await sportsDb("searchevents.php",{e:term,d:dateHint||undefined});
    const events=data.event||data.events||[];
    const ranked=events.map(e=>{
      const h=e.strHomeTeam||"",a=e.strAwayTeam||"";
      return {
        id:e.idEvent,date:e.dateEvent,time:e.strTime||"",league:e.strLeague||"",home:h,away:a,
        score:Math.max(
          teamSimilarity(home,h)*0.5+teamSimilarity(away,a)*0.5,
          teamSimilarity(home,a)*0.5+teamSimilarity(away,h)*0.5
        )
      };
    }).sort((a,b)=>b.score-a.score);
    const best=ranked[0]||null;
    return {available:Boolean(best&&best.score>=0.62),best,checkedAt:isoNow(),note:"Free TheSportsDB endpoints return limited result counts."};
  }catch(err){ return {available:false,reason:err.message,checkedAt:isoNow()}; }
}
async function sportsDbFixturesForDate(date){
  try{
    const data=await sportsDb("eventsday.php",{d:date,s:"Soccer"});
    return (data.events||[]).map(e=>({
      fixture:`${e.strHomeTeam||""} vs ${e.strAwayTeam||""}`,
      date:`${e.dateEvent||date}T${e.strTime||"00:00:00"}`,
      league:e.strLeague||"",country:e.strCountry||"",source:"TheSportsDB",sourceId:e.idEvent
    }));
  }catch{return [];}
}
function extractIframeSrc(embed){
  const m=String(embed||"").match(/src=["']([^"']+)["']/i);
  return m?m[1]:"";
}
async function scoreBatHighlights(home,away){
  if(!process.env.SCOREBAT_TOKEN) return {available:false,reason:"SCOREBAT_TOKEN not configured",matches:[]};
  usageStart("scoreBat");
  try{
    const r=await fetch(`https://www.scorebat.com/video-api/v3/free-feed/?token=${encodeURIComponent(process.env.SCOREBAT_TOKEN)}`);
    const text=await r.text();
    if(!r.ok) throw new Error(`ScoreBat failed (${r.status}): ${text.slice(0,220)}`);
    const data=parseHttpJson(text,"ScoreBat");
    const matches=(data.response||[]).map(m=>{
      const score=Math.max(
        teamSimilarity(home,m.homeTeam?.name||"")*0.5+teamSimilarity(away,m.awayTeam?.name||"")*0.5,
        teamSimilarity(home,m.awayTeam?.name||"")*0.5+teamSimilarity(away,m.homeTeam?.name||"")*0.5
      );
      return {
        score,title:m.title||"",date:m.date||"",competition:m.competition||"",
        home:m.homeTeam?.name||"",away:m.awayTeam?.name||"",matchviewUrl:m.matchviewUrl||"",
        videos:(m.videos||[]).map(v=>({title:v.title||"",embedUrl:extractIframeSrc(v.embed),id:v.id||""}))
      };
    }).filter(x=>x.score>=0.45).sort((a,b)=>b.score-a.score).slice(0,4);
    usageOk("scoreBat");
    return {available:matches.length>0,matches,checkedAt:isoNow(),note:"ScoreBat free feed is supplementary only."};
  }catch(err){ usageFail("scoreBat",err); return {available:false,reason:err.message,matches:[],checkedAt:isoNow()}; }
}
async function collectFallbackEvidence(fixture,gate){
  const parsed=parseFixtureTeams(fixture)||gate?.requested||{};
  const home=gate?.resolved?.home?.name||parsed.home||"";
  const away=gate?.resolved?.away?.name||parsed.away||"";
  const date=(gate?.fixture?.date||"").slice(0,10);
  const [footballDataOrgEvidence,theSportsDB,scoreBat]=await Promise.all([
    footballDataFindFixture(home,away,date),
    sportsDbFindFixture(home,away,date),
    scoreBatHighlights(home,away)
  ]);
  return {
    checkedAt:isoNow(),
    footballDataOrg:footballDataOrgEvidence,
    theSportsDB,scoreBat,
    providerNote:"Cross-check/fallback providers never override stronger verified current data."
  };
}
async function buildFallbackGate(fixtureText){
  const parsed=parseFixtureTeams(fixtureText);
  if(!parsed) return {status:"FAILED",checkedAt:isoNow(),warnings:["Could not split fixture into two teams."],requested:{home:"",away:""},resolved:null,fixture:null,squads:null,injuries:[],transfers:[],confirmedLineups:false,provider:"fallback"};
  const [fd,ts]=await Promise.all([footballDataFindFixture(parsed.home,parsed.away),sportsDbFindFixture(parsed.home,parsed.away)]);
  const best=fd.available?{provider:"football-data.org",date:fd.best.date,league:fd.best.competition,home:fd.best.home,away:fd.best.away,score:fd.best.score}
    :ts.available?{provider:"TheSportsDB",date:ts.best.date,league:ts.best.league,home:ts.best.home,away:ts.best.away,score:ts.best.score}:null;
  return {
    status:best?"CAUTION":"FAILED",checkedAt:isoNow(),provider:best?.provider||"fallback",
    requested:parsed,
    resolved:best?{
      home:{id:null,name:best.home,country:"",confidence:best.score},
      away:{id:null,name:best.away,country:"",confidence:best.score}
    }:{
      home:{id:null,name:parsed.home,country:"",confidence:0.35},
      away:{id:null,name:parsed.away,country:"",confidence:0.35}
    },
    fixture:best?{
      id:null,date:best.date,status:"",venue:"",city:"",league:best.league,country:"",season:null,round:"",
      home:{id:null,name:best.home},away:{id:null,name:best.away},lineups:[]
    }:null,
    squads:null,injuries:[],transfers:[],confirmedLineups:false,
    warnings:[
      "API-Football was unavailable or quota-limited; free fallback providers were used.",
      "Fallback mode cannot fully verify current squads, injuries or confirmed starting XIs."
    ].concat(best?[]:["No fallback provider strongly verified the exact fixture."]),
    quota:null
  };
}
async function buildBestAvailableGate(fixtureText,round){
  if(process.env.API_FOOTBALL_KEY){
    try{return await buildAuthenticityGate(fixtureText,round);}
    catch(err){
      const fb=await buildFallbackGate(fixtureText);
      fb.warnings.unshift(`API-Football unavailable: ${err.message}`);
      return fb;
    }
  }
  return buildFallbackGate(fixtureText);
}

function discoveryPriority(leagueName,country){
  const s=`${leagueName||""} ${country||""}`.toLowerCase();
  const names=[
    "champions league","europa league","conference league","premier league","la liga",
    "serie a","bundesliga","ligue 1","eredivisie","primeira liga","major league soccer",
    "mls","championship","brasileiro","liga profesional","j1 league","a-league"
  ];
  const hit=names.findIndex(x=>s.includes(x));
  return hit>=0 ? (20-hit) : 0;
}
async function fixturesForDate(date){
  const r=await apiFootball("/fixtures",{date,timezone:"Africa/Lusaka"},{cacheMs:5*60e3,force:true});
  const rows=(r.data.response||[]).filter(x=>{
    const short=x.fixture?.status?.short||"";
    return ["NS","TBD"].includes(short);
  });
  return {rows,quota:r.quota,checkedAt:r.fetchedAt};
}
async function leagueCoverage(leagueId,season){
  const r=await apiFootball("/leagues",{id:leagueId,season},{cacheMs:12*3600e3});
  const coverage=coverageObjectForSeason(r,season);
  return {coverage,score:coverageScore(coverage),quota:r.quota,checkedAt:r.fetchedAt};
}
async function discoverDataRichFixtures({days=2,maxResults=5}={}){
  const horizon=Math.max(1,Math.min(3,Number(days||2)));
  const dateResults=[];
  for(let i=0;i<horizon;i++) dateResults.push(await fixturesForDate(zambiaDate(i)));
  const all=dateResults.flatMap(x=>x.rows);
  const grouped=new Map();
  for(const m of all){
    const id=m.league?.id,season=m.league?.season;
    if(!id||!season)continue;
    const key=`${id}:${season}`;
    if(!grouped.has(key))grouped.set(key,{leagueId:id,season,name:m.league?.name||"",country:m.league?.country||"",fixtures:[]});
    grouped.get(key).fixtures.push(m);
  }

  // Quota-aware first pass: prefer competitions likely to have rich public/structured data,
  // but the final score comes from actual coverage flags, never odds.
  const groups=[...grouped.values()]
    .sort((a,b)=>(discoveryPriority(b.name,b.country)+Math.min(8,b.fixtures.length))-(discoveryPriority(a.name,a.country)+Math.min(8,a.fixtures.length)))
    .slice(0,12);

  const covered=[];
  for(const g of groups){
    const cov=await leagueCoverage(g.leagueId,g.season);
    covered.push({...g,coverage:cov});
  }
  const rich=covered.filter(g=>g.coverage.score.score>=68);

  const candidates=[];
  // Use only a manageable number of fixtures for web-availability probes.
  const pool=rich.flatMap(g=>g.fixtures.map(m=>({m,g})))
    .sort((a,b)=>b.g.coverage.score.score-a.g.coverage.score.score)
    .slice(0,12);

  for(const {m,g} of pool){
    const home=m.teams?.home?.name||"",away=m.teams?.away?.name||"";
    const q=`${home} vs ${away} ${String(m.fixture?.date||"").slice(0,10)} team news statistics injuries preview`;
    let results=[];
    try{results=await tavilySearch(q)}catch{}
    const sourceCount=results.length;
    const officialish=results.filter(r=>/(official|club|league|uefa|fifa|premierleague|laliga|bundesliga|seriea)/i.test(`${r.title} ${r.url}`)).length;
    const webScore=Math.min(20,sourceCount*3 + Math.min(5,officialish*2));
    const structured=g.coverage.score.score;
    const total=Math.min(100,Math.round(structured*0.8+webScore));
    if(sourceCount<3)continue;
    candidates.push({
      fixtureId:m.fixture?.id,
      fixture:`${home} vs ${away}`,
      date:m.fixture?.date,
      league:g.name,
      country:g.country,
      season:g.season,
      structuredCoverageScore:structured,
      publicSourceCount:sourceCount,
      officialishSourceCount:officialish,
      dataAvailabilityScore:total,
      coverageParts:g.coverage.score.parts,
      discoveryQuery:q,
      discoverySources:results.map(r=>({title:r.title,url:r.url,published_date:r.published_date||""})),
      note:"Selected for data availability. Bookmaker odds were not used in discovery scoring."
    });
  }
  candidates.sort((a,b)=>b.dataAvailabilityScore-a.dataAvailabilityScore);
  return {
    checkedAt:isoNow(),
    dates:[...new Set(all.map(x=>String(x.fixture?.date||"").slice(0,10)).filter(Boolean))],
    scannedFixtures:all.length,
    scannedLeagueSeasons:groups.length,
    candidates:candidates.slice(0,Math.max(1,Math.min(8,Number(maxResults||5)))),
    methodology:"Structured league-season coverage + fresh public-source availability. Odds are excluded from discovery ranking."
  };
}


async function discoverFallbackFixtures({days=2,maxResults=5}={}){
  const all=[];
  if(process.env.FOOTBALL_DATA_ORG_KEY){
    try{all.push(...await footballDataFixturesForDates(days));}catch{}
  }
  for(let i=0;i<Math.min(days,3);i++) all.push(...await sportsDbFixturesForDate(zambiaDate(i)));

  const seen=new Set();
  const unique=all.filter(x=>{
    const key=normalizeTeamName(x.fixture)+"|"+String(x.date).slice(0,10);
    if(seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0,18);

  const candidates=[];
  for(const x of unique){
    let results=[];
    try{results=await tavilySearch(`${x.fixture} ${String(x.date).slice(0,10)} team news statistics injuries preview`);}catch{}
    if(results.length<3) continue;
    candidates.push({
      fixture:x.fixture,date:x.date,league:x.league,country:x.country||"",
      structuredCoverageScore:x.source==="football-data.org"?45:25,
      publicSourceCount:results.length,
      officialishSourceCount:results.filter(r=>/(official|club|league|uefa|fifa)/i.test(`${r.title} ${r.url}`)).length,
      dataAvailabilityScore:Math.min(78,35+results.length*5),
      coverageParts:[],discoveryQuery:`fallback discovery via ${x.source}`,
      discoverySources:results.map(r=>({title:r.title,url:r.url,published_date:r.published_date||""})),
      note:`Fallback discovery from ${x.source}. Odds were not used.`,provider:x.source
    });
  }
  candidates.sort((a,b)=>b.dataAvailabilityScore-a.dataAvailabilityScore);
  return {checkedAt:isoNow(),dates:[...new Set(candidates.map(x=>String(x.date).slice(0,10)))],scannedFixtures:unique.length,scannedLeagueSeasons:0,candidates:candidates.slice(0,maxResults),methodology:"Fallback fixtures + fresh public-source availability. Odds excluded.",provider:"fallback"};
}
async function discoverBestAvailableFixtures(opts){
  if(process.env.API_FOOTBALL_KEY){
    try{return await discoverDataRichFixtures(opts);}catch{}
  }
  return discoverFallbackFixtures(opts);
}

async function preMatchOdds(fixtureId){
  if(!process.env.API_FOOTBALL_KEY)return {available:false,rows:[],checkedAt:isoNow(),reason:"API-Football unavailable; value pricing skipped."};
  if(!fixtureId)return {available:false,rows:[],checkedAt:isoNow(),reason:"No API-Football fixture ID; value pricing skipped."};
  const r=await apiFootball("/odds",{fixture:fixtureId,page:1},{cacheMs:10*60e3,force:true});
  const rows=[];
  const snapshots=r.data.response||[];
  for(const snap of snapshots){
    const update=snap.update||"";
    for(const book of (snap.bookmakers||[])){
      for(const bet of (book.bets||[])){
        for(const v of (bet.values||[])){
          const odd=Number(v.odd);
          if(!Number.isFinite(odd)||odd<=1)continue;
          rows.push({
            bookmakerId:book.id,
            bookmaker:book.name||"",
            betId:bet.id,
            bet:bet.name||"",
            selection:v.value||"",
            decimalOdds:odd,
            update
          });
        }
      }
    }
  }
  return {
    available:rows.length>0,
    rows,
    checkedAt:r.fetchedAt,
    quota:r.quota,
    reason:rows.length?"":"No pre-match odds were returned for this fixture."
  };
}
function normOddsText(s){
  return String(s||"").toLowerCase()
    .replace(/[^a-z0-9.+-]+/g," ")
    .replace(/\s+/g," ").trim();
}
function termsMatch(text,terms=[]){
  const hay=normOddsText(text);
  const good=(terms||[]).map(normOddsText).filter(Boolean);
  return !good.length || good.some(t=>hay.includes(t));
}
function matchOddsForCandidate(candidate,oddsRows){
  const lookup=candidate?.oddsLookup||{};
  const betTerms=lookup.betTerms||[];
  const selectionTerms=lookup.selectionTerms||[];
  let matches=oddsRows.filter(r=>termsMatch(r.bet,betTerms)&&termsMatch(r.selection,selectionTerms));
  // Fallback using words from exact market when lookup misses.
  if(!matches.length){
    const tokens=normOddsText(candidate?.market||"").split(" ").filter(x=>x.length>=4).slice(0,4);
    matches=oddsRows.filter(r=>tokens.some(t=>normOddsText(`${r.bet} ${r.selection}`).includes(t)));
  }
  matches.sort((a,b)=>b.decimalOdds-a.decimalOdds);
  return matches;
}
function valueAudit(shortlist,odds){
  const rows=odds?.rows||[];
  const audits=[];
  for(const c of (shortlist||[])){
    const fair=Number(c.fairProbabilityPct);
    const matches=matchOddsForCandidate(c,rows);
    const best=matches[0]||null;
    if(!best||!Number.isFinite(fair)||fair<=0||fair>=100){
      audits.push({market:c.market,status:"UNPRICED_OR_UNMAPPED",fairProbabilityPct:Number.isFinite(fair)?fair:null,match:null});
      continue;
    }
    const breakEven=100/best.decimalOdds;
    const edge=fair-breakEven;
    let status="NO_VALUE_SIGNAL";
    if(edge>=5)status="POTENTIAL_VALUE";
    else if(edge>=2)status="VALUE_WATCH";
    audits.push({
      market:c.market,
      marketFamily:c.marketFamily||"",
      fairProbabilityPct:Math.round(fair*10)/10,
      probabilityConfidence:c.probabilityConfidence||"",
      bestBookmaker:best.bookmaker,
      bestDecimalOdds:best.decimalOdds,
      breakEvenProbabilityPct:Math.round(breakEven*10)/10,
      edgePercentagePoints:Math.round(edge*10)/10,
      status,
      matchedBet:best.bet,
      matchedSelection:best.selection,
      bookmakerPrices:matches.slice(0,8)
    });
  }
  const potential=audits.filter(x=>x.status==="POTENTIAL_VALUE").sort((a,b)=>b.edgePercentagePoints-a.edgePercentagePoints);
  return {
    checkedAt:odds?.checkedAt||isoNow(),
    oddsAvailable:Boolean(odds?.available),
    bookmakerCount:new Set(rows.map(x=>x.bookmaker)).size,
    betTypeCount:new Set(rows.map(x=>x.bet)).size,
    selectionCount:rows.length,
    audits,
    potentialValues:potential,
    headline:potential.length
      ? `Whilst researching, I found ${potential.length} potential value ${potential.length===1?"bet":"bets"}. The market price may be underestimating the evidence-based chance.`
      : "No clear potential-value signal survived the sporting shortlist and price comparison."
  };
}

function makeVideoQueries(fixture, gate, round){
  const home=gate?.resolved?.home?.name||gate?.requested?.home||"";
  const away=gate?.resolved?.away?.name||gate?.requested?.away||"";
  const freshness=round>1?"latest recent":"recent";
  return [
    `${home} ${freshness} match highlights official site:youtube.com`,
    `${away} ${freshness} match highlights official site:youtube.com`,
    `${home} tactical highlights recent match site:youtube.com`,
    `${away} tactical highlights recent match site:youtube.com`
  ].filter(q=>q.trim().length>20);
}

function isYoutubeUrl(url){
  try{
    const u=new URL(url);
    return ["youtube.com","www.youtube.com","m.youtube.com","youtu.be"].includes(u.hostname);
  }catch{return false}
}
function youtubeVideoKey(url){
  try{
    const u=new URL(url);
    if(u.hostname==="youtu.be") return u.pathname.replace("/","");
    if(u.pathname==="/watch") return u.searchParams.get("v")||url;
    const m=u.pathname.match(/\/shorts\/([^/?]+)/); if(m)return m[1];
    return url;
  }catch{return url}
}
function chooseVideoCandidates(videoScout, gate){
  const home=normalizeTeamName(gate?.resolved?.home?.name||gate?.requested?.home||"");
  const away=normalizeTeamName(gate?.resolved?.away?.name||gate?.requested?.away||"");
  const all=[];
  for(const group of videoScout){
    for(const r of (group.results||[])){
      if(!isYoutubeUrl(r.url)) continue;
      const hay=normalizeTeamName(`${r.title||""} ${r.content||""}`);
      let side="general";
      if(home && hay.includes(home)) side="home";
      if(away && hay.includes(away)) side=side==="home"?"both":"away";
      all.push({...r,side});
    }
  }
  // Deduplicate by video id/url and prioritize "official" or league/club-looking results.
  const seen=new Set();
  const unique=all.filter(x=>{
    const k=youtubeVideoKey(x.url);
    if(seen.has(k))return false; seen.add(k); return true;
  }).sort((a,b)=>{
    const sa=/official|league|highlights/i.test(`${a.title} ${a.content}`)?1:0;
    const sb=/official|league|highlights/i.test(`${b.title} ${b.content}`)?1:0;
    return sb-sa;
  });

  const picked=[];
  const takeSide=(side,n)=>{
    for(const v of unique){
      if(picked.length>=4)break;
      if((v.side===side||v.side==="both") && !picked.includes(v)){
        picked.push(v); if(--n<=0)break;
      }
    }
  };
  takeSide("home",2); takeSide("away",2);
  for(const v of unique) if(picked.length<4 && !picked.includes(v)) picked.push(v);
  return picked.slice(0,4);
}

async function reviewYoutubeHighlights(videos, gate){
  if(!videos.length){
    return {status:"UNAVAILABLE", reviewedAt:isoNow(), videos:[], summary:"No public YouTube highlight links were found by the scouting searches.", observations:[]};
  }
  const key=requireEnv("GEMINI_API_KEY");
  const model=process.env.GEMINI_MODEL||"gemini-3.8-flash";
  const { GoogleGenAI } = await import("@google/genai");
  const ai=new GoogleGenAI({apiKey:key});

  const prompt=`You are reviewing PUBLIC FOOTBALL HIGHLIGHT VIDEOS from the teams’ RECENT PRIOR MATCHES as supporting evidence for a pre-match scouting report. Do not use highlights from the target fixture after it has started or finished.

Teams: ${gate?.resolved?.home?.name||gate?.requested?.home||"Home"} vs ${gate?.resolved?.away?.name||gate?.requested?.away||"Away"}

Review every supplied video visually and, where audio/commentary helps, use it cautiously.

For EACH video:
- identify which team(s) and match appear in the footage;
- note if the video looks like highlights rather than a full match;
- assess attacking routes: wings, central combinations, transitions, set pieces;
- assess shot/chance quality visible in the selected clips;
- note defensive shape/errors, counter vulnerability, goalkeeper actions;
- note crossing and corner/set-piece patterns if actually visible;
- note pressing, pace, physicality, and behavior while leading/trailing if observable;
- explicitly state what CANNOT be concluded because highlights are selective.

Do NOT invent statistics from video. Do NOT infer that unshown events did not happen.
Do NOT use the video to identify a current player-club relationship if structured squad data contradicts it.

Return ONLY JSON:
{
 "summary":"overall video evidence",
 "observations":[
   {
     "url":"exact supplied URL",
     "teamOrMatch":"...",
     "evidence":["..."],
     "limitations":["..."],
     "usefulness":"HIGH|MEDIUM|LOW"
   }
 ],
 "crossVideoPatterns":["..."],
 "warning":"Highlights are selective evidence and not a full-match sample."
}`;

  const input=[{type:"text",text:prompt},...videos.map(v=>({type:"video",uri:v.url}))];
  try{
    const interaction=await ai.interactions.create({model,input});
    const out=String(interaction.output_text||interaction.outputText||"").trim();
    const parsed=parseJsonObject(out,"Video model");
    return {
      status:"COMPLETE",
      reviewedAt:isoNow(),
      videos:videos.map(v=>({title:v.title,url:v.url,side:v.side||"general"})),
      ...parsed
    };
  }catch(err){
    return {
      status:"PARTIAL",
      reviewedAt:isoNow(),
      videos:videos.map(v=>({title:v.title,url:v.url,side:v.side||"general"})),
      summary:`Video links were found, but automated visual review could not complete: ${err.message}`,
      observations:[],
      crossVideoPatterns:[],
      warning:"Do not treat linked highlights as reviewed footage unless status is COMPLETE."
    };
  }
}

function flattenScoutLinks(webScout=[],videoScout=[]){
  const rows=[];
  const seen=new Set();
  for(const group of [...webScout,...videoScout]){
    for(const r of (group.results||[])){
      if(!r.url)continue;
      const key=r.url;
      if(seen.has(key))continue;
      seen.add(key);
      rows.push({
        query:group.query,
        category:group.category,
        title:r.title||r.url,
        url:r.url,
        published_date:r.published_date||"",
        score:r.score??null
      });
    }
  }
  return rows;
}

function makeQueries(fixture, round, gate){
  const home=gate?.resolved?.home?.name||gate?.requested?.home||"";
  const away=gate?.resolved?.away?.name||gate?.requested?.away||"";
  const match=`${home} vs ${away}`.trim()||fixture;
  const date=(gate?.fixture?.date||"").slice(0,10);
  const dated=date?`${date} `:"";
  if(round<=1){
    return [
      `${dated}${match} official team news injuries suspensions confirmed lineup latest`,
      `${dated}${match} recent form last 5 last 10 goals xG shots shots on target possession statistics`,
      `${dated}${match} corners for against crosses width set pieces cards fouls referee`,
      `${dated}${match} tactical preview opponent strength head to head venue weather recent highlights`
    ];
  }
  return [
    `${dated}${match} confirmed lineup injury update suspension transfer team news latest`,
    `${dated}${match} tactical weaknesses pressing transitions counter attacks set pieces game state`,
    `${dated}${match} recent opponent strength shots on target corners xG defensive record`,
    `${dated}${match} exact goal corner card thresholds contradictory evidence preview`
  ];
}

async function tavilySearch(query){
  const key=requireEnv("TAVILY_API_KEY");
  const response=await fetch("https://api.tavily.com/search",{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${key}`},
    body:JSON.stringify({query,search_depth:"basic",max_results:5,include_answer:false,include_raw_content:false})
  });
  const text=await response.text();
  if(!response.ok) throw new Error(`Tavily search failed (${response.status}): ${text.slice(0,240)}`);
  const data=parseHttpJson(text,"Tavily Search");
  return (data.results||[]).map(r=>({
    title:r.title||"",url:r.url||"",content:r.content||"",
    score:typeof r.score==="number"?r.score:null,
    published_date:r.published_date||""
  }));
}
function dedupeSources(groups){
  const seen=new Set(),out=[];
  for(const group of groups) for(const s of group){
    if(!s.url||seen.has(s.url))continue;seen.add(s.url);out.push(s);
  }
  return out.slice(0,18);
}
function sourceDigest(sources){
  return sources.map((s,i)=>{
    const snippet=String(s.content||"").replace(/\s+/g," ").slice(0,1200);
    return `[S${i+1}] ${s.title}\nURL: ${s.url}\nDATE: ${s.published_date||"unknown"}\nEXTRACT: ${snippet}`;
  }).join("\n\n");
}



function parseHttpJson(text,label="Remote service"){
  const raw=String(text??"").trim();
  if(!raw)throw new Error(`${label} returned an empty response.`);
  if(/^<!doctype html/i.test(raw)||/^<html/i.test(raw)){
    throw new Error(`${label} returned an HTML error page instead of JSON. This is usually a temporary provider/proxy error.`);
  }
  try{return JSON.parse(raw)}
  catch(err){
    throw new Error(`${label} returned invalid JSON: ${err.message}`);
  }
}

function parseJsonObject(text,label="AI"){
  const raw=String(text||"")
    .trim()
    .replace(/^```(?:json)?\s*/i,"")
    .replace(/\s*```$/,"");

  const candidates=[raw];
  const objectMatch=raw.match(/\{[\s\S]*\}/);
  if(objectMatch && objectMatch[0]!==raw)candidates.push(objectMatch[0]);

  const errors=[];
  for(const candidate of candidates){
    try{return JSON.parse(candidate)}catch(err){errors.push(`direct: ${err.message}`);}
    try{
      const repaired=jsonrepair(candidate);
      return JSON.parse(repaired);
    }catch(err){
      errors.push(`repair: ${err.message}`);
    }
  }

  throw new Error(
    `${label} returned malformed JSON that could not be repaired automatically. ` +
    `${errors.slice(-2).join(" | ")}`
  );
}
function clampPct(v){
  const n=Number(v);
  return Number.isFinite(n)?Math.max(0,Math.min(100,n)):null;
}
function canonicalKey(s){
  return String(s||"").toUpperCase().replace(/[^A-Z0-9.+-]+/g,"_").replace(/^_+|_+$/g,"").replace(/_+/g,"_").slice(0,100);
}
function councilEvidencePack({fixture,gate,sources,videoReview,fallbackEvidence}){
  return `FIXTURE:\n${fixture}\n\nSTRUCTURED CURRENT-FOOTBALL DATA:\n${structuredDigest(gate)}\n\nFALLBACK / CROSS-CHECK PROVIDERS:\n${JSON.stringify(fallbackEvidence||{},null,2)}\n\nFRESH WEB EVIDENCE:\n${sourceDigest(sources)}\n\nVIDEO REVIEW:\n${JSON.stringify(videoReview||{status:"UNAVAILABLE"},null,2)}`;
}
function councilPrompt(payload){
  const specialist=payload.specialistRole?`\nSPECIALIST ROLE: ${payload.specialistRole}. Give this lens extra attention, but still evaluate the whole match and do not force a pick.\n`:"";
  return `You are one independent member of a multi-model FOOTBALL RESEARCH COUNCIL.${specialist}

Every council model receives the SAME locked evidence pack.
BOOKMAKER ODDS, favourites, prediction-site consensus and the user's original market are hidden.

${councilEvidencePack(payload)}

RULES:
1. Verify present-day team and player identities from structured data.
2. Reject stale player-club claims.
3. Analyze squad quality, lineup state, injuries, rotation/rest, opponent-adjusted form, goals/chances,
   shots/SOT, possession/territory, corners/width/crossing/set pieces, cards/referee where available,
   tactics/game states, H2H/venue/weather and video evidence.
4. Screen realistic market families independently.
5. Attack your strongest candidate with counter-evidence.
6. Never call a pick safe, guaranteed or a banker.
7. If evidence is not strong enough for an exact market, return UNRESOLVED.
8. fairProbabilityPct is a cautious estimate, not a fact.

Return ONLY JSON:
{
  "primaryMarket":"Exact market and line OR UNRESOLVED",
  "canonicalMarketKey":"Examples: BTTS_YES, TOTAL_GOALS_OVER_2.5, HOME_DOUBLE_CHANCE_1X, HOME_TEAM_GOALS_OVER_0.5, TOTAL_CORNERS_OVER_8.5, UNRESOLVED",
  "marketFamily":"...",
  "fairProbabilityPct":62,
  "confidence":"HIGH|MEDIUM|LOW",
  "classification":"STRONG|MEDIUM|GENUINE DANGER|UNRESOLVED / HIGH RISK",
  "strongestReasons":["..."],
  "counterEvidence":["..."],
  "topAlternatives":[{"market":"...","canonicalMarketKey":"...","fairProbabilityPct":58}],
  "dataWeaknesses":["..."],
  "antiBiasCheck":"..."
}`;
}
function normalizeCouncilResult(provider,modelName,obj){
  const unresolved=/UNRESOLVED/i.test(String(obj?.primaryMarket||""));
  return {
    provider,modelName,available:true,
    primaryMarket:unresolved?"UNRESOLVED":String(obj?.primaryMarket||"UNRESOLVED"),
    canonicalMarketKey:unresolved?"UNRESOLVED":canonicalKey(obj?.canonicalMarketKey||obj?.primaryMarket||"UNRESOLVED"),
    marketFamily:String(obj?.marketFamily||""),
    fairProbabilityPct:clampPct(obj?.fairProbabilityPct),
    confidence:String(obj?.confidence||"LOW"),
    classification:String(obj?.classification||"UNRESOLVED / HIGH RISK"),
    strongestReasons:Array.isArray(obj?.strongestReasons)?obj.strongestReasons:[],
    counterEvidence:Array.isArray(obj?.counterEvidence)?obj.counterEvidence:[],
    topAlternatives:Array.isArray(obj?.topAlternatives)?obj.topAlternatives:[],
    dataWeaknesses:Array.isArray(obj?.dataWeaknesses)?obj.dataWeaknesses:[],
    antiBiasCheck:String(obj?.antiBiasCheck||"")
  };
}
async function geminiCouncilMember(payload){
  const result=await geminiTextWithRetry({
    prompt:councilPrompt(payload),
    maxOutputTokens:3500,
    responseMimeType:"application/json",
    preferredModel:process.env.GEMINI_COUNCIL_MODEL||process.env.GEMINI_MODEL||"gemini-3.8-flash"
  });
  const out=parseJsonObject(result.output,"Gemini");
  const normalized=normalizeCouncilResult("Google",`Gemini (${result.model})`,out);
  normalized.retryAttempt=result.attempt;
  return normalized;
}
async function groqCouncilMember(payload,model,display){
  const key=requireEnv("GROQ_API_KEY");
  const response=await fetch("https://api.groq.com/openai/v1/chat/completions",{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${key}`},
    body:JSON.stringify({model,temperature:0.2,max_completion_tokens:3500,messages:[{role:"user",content:councilPrompt(payload)}]})
  });
  const txt=await response.text();
  if(!response.ok)throw new Error(`${display} council failed (${response.status}): ${txt.slice(0,260)}`);
  const d=JSON.parse(txt);
  return normalizeCouncilResult("Groq",display,parseJsonObject(d.choices?.[0]?.message?.content||"",display));
}
async function cloudflareCouncilMember(payload){
  const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_AUTH_TOKEN;
  if(!account||!token)throw new Error("Cloudflare AI is not configured.");
  const model=payload?._cfModel||process.env.CLOUDFLARE_LLAMA_MODEL||"@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${model}`,{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`},
    body:JSON.stringify({messages:[{role:"user",content:councilPrompt(payload)}],temperature:0.2,max_tokens:3500})
  });
  const txt=await response.text();
  if(!response.ok)throw new Error(`Meta Llama council failed (${response.status}): ${txt.slice(0,260)}`);
  const d=JSON.parse(txt);
  const out=d.result?.response ?? d.result?.text ?? d.result?.output_text ?? d.result ?? "";
  const display=payload?._cfName||"Meta Llama";
  const normalized=normalizeCouncilResult("Cloudflare",display,parseJsonObject(typeof out==="string"?out:JSON.stringify(out),display));
  normalized.modelId=model;normalized.brainType="unique-model";
  return normalized;
}
async function openRouterCouncilMember(payload){
  const key=requireEnv("OPENROUTER_API_KEY");
  const model=process.env.OPENROUTER_COUNCIL_MODEL||"openrouter/free";
  const response=await fetch("https://openrouter.ai/api/v1/chat/completions",{
    method:"POST",
    headers:{
      "Content-Type":"application/json","Authorization":`Bearer ${key}`,
      "HTTP-Referer":process.env.APP_PUBLIC_URL||"https://localhost/",
      "X-Title":"Football Fact-First Research"
    },
    body:JSON.stringify({model,temperature:0.2,max_tokens:3500,messages:[{role:"user",content:councilPrompt(payload)}]})
  });
  const txt=await response.text();
  if(!response.ok)throw new Error(`OpenRouter council failed (${response.status}): ${txt.slice(0,260)}`);
  const d=JSON.parse(txt);
  return normalizeCouncilResult("OpenRouter","Free Router",parseJsonObject(d.choices?.[0]?.message?.content||"","OpenRouter"));
}
function median(nums){
  const a=nums.filter(Number.isFinite).sort((x,y)=>x-y);
  if(!a.length)return null;
  const m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
}
function aggregateCouncil(results){
  const available=results.filter(x=>x.available);
  const resolved=available.filter(x=>x.canonicalMarketKey&&x.canonicalMarketKey!=="UNRESOLVED");
  const groups=new Map();
  for(const r of resolved){
    const k=r.canonicalMarketKey;
    if(!groups.has(k))groups.set(k,[]);
    groups.get(k).push(r);
  }
  const ranked=[...groups.entries()].map(([key,members])=>({
    canonicalMarketKey:key,market:members[0]?.primaryMarket||key,count:members.length,
    models:members.map(x=>x.modelName),
    medianFairProbabilityPct:median(members.map(x=>Number(x.fairProbabilityPct)).filter(Number.isFinite))
  })).sort((a,b)=>b.count-a.count||(b.medianFairProbabilityPct||0)-(a.medianFairProbabilityPct||0));

  const top=ranked[0]||null,total=available.length||1,share=top?top.count/total:0;
  let convergence="NONE";
  if(available.length<2) convergence="INSUFFICIENT";
  else if(top?.count>=3&&share>=0.6) convergence="HIGH";
  else if(top?.count>=2&&share>=0.4) convergence="MEDIUM";
  else if(top?.count>=2) convergence="LOW";

  const consensusAllowed=available.length>=2 && top?.count>=2;
  return {
    availableModels:available.length,
    unresolvedModels:available.filter(x=>x.canonicalMarketKey==="UNRESOLVED").length,
    convergence,
    consensusMarket:consensusAllowed?(top?.market||"NO CONSENSUS"):"NO COUNCIL CONSENSUS",
    consensusCanonicalKey:consensusAllowed?(top?.canonicalMarketKey||""):"",
    leadingSingleModelMarket:available.length===1?(top?.market||"UNRESOLVED"):"",
    modelsAgreeing:consensusAllowed?(top?.models||[]):[],
    medianFairProbabilityPct:consensusAllowed?(top?.medianFairProbabilityPct??null):null,
    groups:ranked,
    note:available.length<2
      ?`Only ${available.length} council model answered. That is an individual opinion, not council convergence.`
      :top?`${top.count} of ${available.length} available council models independently selected the same canonical market.`:
      "No resolved market convergence was found."
  };
}

const SPECIALIST_ROLES=[
  "Current-squad and lineup auditor","Opponent-strength and form analyst","Goals and chance-quality analyst",
  "Shots and shots-on-target analyst","Corners, width and crossing analyst","Tactical interaction and game-state analyst",
  "Defensive structure and transition-risk analyst","Set-piece analyst","Cards, fouls and referee analyst",
  "Rest, travel, rotation and motivation analyst","Home/away split analyst","Underdog resistance analyst",
  "First-half market analyst","Second-half market analyst","Combination-market analyst",
  "Adversarial kill-the-pick analyst","Data-quality and stale-information auditor","Video-evidence tactical analyst",
  "Exact-line threshold analyst","Conservative probability calibration analyst"
];

async function openRouterFreeModels(){
  if(!process.env.OPENROUTER_API_KEY)return [];
  try{
    const r=await fetch("https://openrouter.ai/api/v1/models?max_price=0&output_modalities=text",{headers:{"Authorization":`Bearer ${process.env.OPENROUTER_API_KEY}`}});
    if(!r.ok)return [];
    const text=await r.text();
    const d=parseHttpJson(text,"OpenRouter Models");
    return (d.data||[]).filter(m=>{
      const p=m.pricing||{};
      return Number(p.prompt||0)===0&&Number(p.completion||0)===0;
    }).map(m=>({id:m.id,name:m.name||m.id,context:m.context_length||0}))
      .filter(m=>m.id!=="openrouter/free").slice(0,30);
  }catch{return [];}
}
async function openRouterSpecificCouncilMember(payload,modelId,display,specialistRole=""){
  const key=requireEnv("OPENROUTER_API_KEY");
  usageStart("openrouter");
  try{
    const r=await fetch("https://openrouter.ai/api/v1/chat/completions",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${key}`,"HTTP-Referer":process.env.APP_PUBLIC_URL||"https://localhost/","X-Title":"Football Fact-First Research"},
      body:JSON.stringify({model:modelId,temperature:0.2,max_tokens:1800,messages:[{role:"user",content:councilPrompt({...payload,specialistRole})}]})
    });
    const text=await r.text();
    if(!r.ok)throw new Error(`${display} failed (${r.status}): ${text.slice(0,220)}`);
    const d=parseHttpJson(text,"OpenRouter Chat");
    const out=normalizeCouncilResult("OpenRouter",display,parseJsonObject(d.choices?.[0]?.message?.content||"",display));
    out.modelId=modelId;out.specialistRole=specialistRole||"General independent analyst";out.brainType="unique-model";
    usageOk("openrouter");return out;
  }catch(err){usageFail("openrouter",err);throw err;}
}
async function geminiSpecialistMember(payload,role,index){
  const result=await geminiTextWithRetry({
    prompt:councilPrompt({...payload,specialistRole:role}),
    maxOutputTokens:2200,responseMimeType:"application/json",
    preferredModel:process.env.GEMINI_COUNCIL_MODEL||process.env.GEMINI_MODEL||"gemini-3.8-flash"
  });
  const out=normalizeCouncilResult("Google",`Gemini Specialist ${index+1}`,parseJsonObject(result.output,"Gemini specialist"));
  out.specialistRole=role;out.brainType="specialist-agent";out.modelId="gemini-specialist";
  return out;
}
async function runInBatches(jobs,batchSize=5){
  const results=[];
  for(let i=0;i<jobs.length;i+=batchSize){
    const chunk=jobs.slice(i,i+batchSize);
    const settled=await Promise.allSettled(chunk.map(j=>j.run()));
    settled.forEach((x,k)=>{
      const j=chunk[k];
      results.push(x.status==="fulfilled"?x.value:{provider:j.provider,modelName:j.name,available:false,specialistRole:j.role||"",brainType:j.brainType||"",error:String(x.reason?.message||x.reason||"Brain failed")});
    });
    if(i+batchSize<jobs.length)await sleep(900);
  }
  return results;
}
function councilSummaryCounts(members=[]){
  const available=members.filter(x=>x.available);
  return {
    agentSeats:members.length,availableAgents:available.length,
    uniqueModels:new Set(available.map(x=>`${x.provider}:${x.modelId||x.modelName}`)).size,
    specialistAgents:available.filter(x=>x.brainType==="specialist-agent").length
  };
}

async function runAiCouncil(payload,{targetSize=8,existingMembers=[]}={}){
  const target=Math.max(1,Math.min(50,Number(targetSize||8)));
  const jobs=[];
  const used=new Set((existingMembers||[]).map(x=>`${x.provider}:${x.modelId||x.modelName}:${x.specialistRole||""}`));
  const add=(job)=>{
    const key=`${job.provider}:${job.modelId||job.name}:${job.role||""}`;
    if(!used.has(key)){used.add(key);jobs.push(job);}
  };

  add({provider:"Google",name:"Gemini",modelId:"gemini-core",brainType:"unique-model",run:()=>geminiCouncilMember(payload)});

  if(process.env.GROQ_API_KEY){
    add({provider:"Groq",name:"OpenAI GPT-OSS 120B",modelId:"openai/gpt-oss-120b",brainType:"unique-model",run:()=>groqCouncilMember(payload,"openai/gpt-oss-120b","OpenAI GPT-OSS 120B")});
    add({provider:"Groq",name:"OpenAI GPT-OSS 20B",modelId:"openai/gpt-oss-20b",brainType:"unique-model",run:()=>groqCouncilMember(payload,"openai/gpt-oss-20b","OpenAI GPT-OSS 20B")});
    add({provider:"Groq",name:"Qwen 3.8 27B",modelId:"qwen/qwen3.8-27b",brainType:"unique-model",run:()=>groqCouncilMember(payload,"qwen/qwen3.8-27b","Qwen 3.8 27B")});
  }

  if(process.env.CLOUDFLARE_ACCOUNT_ID&&process.env.CLOUDFLARE_AUTH_TOKEN){
    const models=[
      ["@cf/meta/llama-3.3-70b-instruct-fp8-fast","Meta Llama 3.3 70B"],
      ["@cf/google/gemma-4-26b-a4b-it","Gemma 4 26B"],
      ["@cf/nvidia/nemotron-3-120b-a12b","NVIDIA Nemotron 3 120B"],
      ["@cf/zai-org/glm-4.7-flash","GLM 4.7 Flash"]
    ];
    for(const [modelId,name] of models){
      add({provider:"Cloudflare",name,modelId,brainType:"unique-model",run:()=>cloudflareCouncilMember({...payload,_cfModel:modelId,_cfName:name})});
    }
  }

  if(process.env.OPENROUTER_API_KEY&&jobs.length<target){
    const freeModels=await openRouterFreeModels();
    for(const fm of freeModels){
      if(jobs.length>=target)break;
      add({provider:"OpenRouter",name:fm.name,modelId:fm.id,brainType:"unique-model",run:()=>openRouterSpecificCouncilMember(payload,fm.id,fm.name)});
    }
  }

  let roleIndex=0;
  while(jobs.length<target&&roleIndex<SPECIALIST_ROLES.length){
    const role=SPECIALIST_ROLES[roleIndex++];
    add({provider:"Google",name:`Gemini Specialist ${roleIndex}`,modelId:"gemini-specialist",role,brainType:"specialist-agent",run:()=>geminiSpecialistMember(payload,role,roleIndex-1)});
  }

  const needed=Math.max(0,target-(existingMembers||[]).length);
  const fresh=await runInBatches(jobs.slice(0,needed),5);
  const members=[...(existingMembers||[]),...fresh];
  return {
    checkedAt:isoNow(),requestedAgentSeats:target,members,
    counts:councilSummaryCounts(members),aggregation:aggregateCouncil(members),
    warning:target>=20?"Large councils consume many free-provider requests. The app stops gracefully when a provider reaches its free limit.":""
  };
}
async function apiFootballPrediction(fixtureId){
  if(!process.env.API_FOOTBALL_KEY)return {available:false,checkedAt:isoNow(),reason:"API-Football unavailable; prediction benchmark skipped."};
  if(!fixtureId)return {available:false,checkedAt:isoNow(),reason:"No API-Football fixture ID."};
  try{
    const r=await apiFootball("/predictions",{fixture:fixtureId},{cacheMs:15*60e3,force:true});
    const item=r.data.response?.[0]||null;
    if(!item)return {available:false,checkedAt:r.fetchedAt,reason:"No API-Football prediction returned."};
    return {available:true,checkedAt:r.fetchedAt,prediction:{
      winner:item.predictions?.winner?.name||"",comment:item.predictions?.winner?.comment||"",
      underOver:item.predictions?.under_over||"",advice:item.predictions?.advice||"",
      percent:item.predictions?.percent||{},goals:item.predictions?.goals||{}
    }};
  }catch(err){return {available:false,checkedAt:isoNow(),reason:err.message};}
}

async function tavilyExtractUrl(url, query=""){
  const key=requireEnv("TAVILY_API_KEY");
  const body={
    urls:[url],
    extract_depth:"advanced",
    format:"markdown",
    include_images:false,
    timeout:30
  };
  if(query){
    body.query=query;
    body.chunks_per_source=5;
  }
  const response=await fetch("https://api.tavily.com/extract",{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${key}`},
    body:JSON.stringify(body)
  });
  const text=await response.text();
  if(!response.ok)throw new Error(`Tavily extract failed (${response.status}): ${text.slice(0,260)}`);
  const data=parseHttpJson(text,"Tavily Extract");
  const item=(data.results||[])[0]||null;
  if(!item)return {ok:false,url,content:"",failed:data.failed_results||[]};
  return {ok:true,url:item.url||url,content:String(item.raw_content||""),failed:data.failed_results||[]};
}

function meaningfulTeamTokens(name){
  const stop=new Set(["fc","cf","afc","ac","sc","fk","club","football","futbol","soccer","the","de","del","cd","ud","ssd"]);
  return normalizeTeamName(name).split(" ").filter(x=>x.length>1&&!stop.has(x));
}
function teamTextScore(team,text){
  const norm=normalizeTeamName(text);
  const phrase=normalizeTeamName(team);
  if(!phrase||!norm)return 0;
  if(norm.includes(phrase))return 1;
  const tokens=meaningfulTeamTokens(team);
  if(!tokens.length)return 0;
  const hit=tokens.filter(t=>norm.includes(t)).length;
  return hit/tokens.length;
}
function benchmarkCandidateScore(result,home,away,date){
  const hay=`${result.title||""} ${result.content||""} ${result.url||""}`;
  const hs=teamTextScore(home,hay),as=teamTextScore(away,hay);
  if(hs<0.5||as<0.5)return 0;
  let score=hs+as;
  const d=String(date||"");
  if(d && hay.includes(d))score+=1;
  const year=d.slice(0,4);
  if(year && hay.includes(year))score+=0.25;
  if(/prediction|tip|forecast|correct score|btts|over|under/i.test(hay))score+=0.25;
  return score;
}
function selectBenchmarkCandidates(results,home,away,date){
  return (results||[])
    .map(r=>({...r,_matchScore:benchmarkCandidateScore(r,home,away,date)}))
    .filter(r=>r._matchScore>0)
    .sort((a,b)=>b._matchScore-a._matchScore)
    .slice(0,3);
}
function benchmarkParsePrompt({siteName,home,away,expectedDate,url,title,content}){
  return `You are extracting an EXTERNAL FOOTBALL PREDICTION from one source page.

SOURCE: ${siteName}
TARGET FIXTURE: ${home} vs ${away}
EXPECTED DATE: ${expectedDate||"unknown"}
SOURCE URL: ${url}
SOURCE TITLE: ${title||""}

PAGE CONTENT:
${String(content||"").slice(0,18000)}

STRICT RULES:
1. Use ONLY the source-page content above. Do not use your own football knowledge.
2. The prediction must belong to ${home} vs ${away}; do not accidentally use another match on the same page.
3. If the exact target fixture is not present, set fixtureMatched=false and predictionAvailable=false.
4. If a prediction is not explicitly published by the source, set predictionAvailable=false.
5. Do not turn statistics or odds alone into a prediction.
6. Extract all clearly published prediction markets you can identify: 1X2, correct score, goals, BTTS,
   double chance, corners/cards or other markets if explicitly present.
7. If the source gives probabilities, preserve the published percentages.
8. If the source gives an explanation, trends, form argument or statistical reasoning, PARAPHRASE it
   concisely in rationaleSummary. Do not invent an explanation.
9. If the source provides no explanation, explanationAvailable=false and rationaleSummary=[].
10. Judge freshness from the page. If a page date clearly conflicts with the expected/current fixture,
    mark freshnessStatus=STALE and predictionAvailable=false.
11. canonicalMarketKey should represent the source's PRIMARY prediction in a stable form, e.g.
    HOME_WIN, AWAY_WIN, DRAW, BTTS_YES, BTTS_NO, TOTAL_GOALS_OVER_2.5, TOTAL_GOALS_UNDER_2.5,
    HOME_DOUBLE_CHANCE_1X, AWAY_DOUBLE_CHANCE_X2, or another clear stable key.

Return ONLY JSON:
{
  "fixtureMatched":true,
  "matchedFixture":"...",
  "fixtureDate":"...",
  "freshnessStatus":"CURRENT|STALE|UNKNOWN",
  "predictionAvailable":true,
  "primaryPrediction":{
    "market":"1X2",
    "selection":"Away Win",
    "canonicalMarketKey":"AWAY_WIN",
    "probabilityPct":41,
    "correctScore":"0-1",
    "publishedOdds":""
  },
  "otherPredictions":[
    {"market":"Correct Score","selection":"0-1","probabilityPct":null}
  ],
  "explanationAvailable":true,
  "rationaleSummary":["...","..."],
  "sourceEvidenceSummary":"Short paraphrase of what the source actually publishes for this fixture.",
  "warnings":[]
}`;
}
async function parseBenchmarkPrediction(payload){
  try{
    const result=await geminiTextWithRetry({
      prompt:benchmarkParsePrompt(payload),
      maxOutputTokens:3000,
      responseMimeType:"application/json",
      preferredModel:process.env.GEMINI_MODEL||"gemini-3.8-flash"
    });
    const parsed=parseJsonObject(result.output,`${payload.siteName} benchmark parser`);
    parsed.parserModel=result.model;
    return parsed;
  }catch(err){
    return {
      fixtureMatched:false,
      freshnessStatus:"UNKNOWN",
      predictionAvailable:false,
      primaryPrediction:null,
      otherPredictions:[],
      explanationAvailable:false,
      rationaleSummary:[],
      sourceEvidenceSummary:"",
      warnings:[`Prediction parser failed: ${err.message}`]
    };
  }
}
async function exactWebsitePrediction({name,domain,home,away,date}){
  const year=(date||zambiaDate(0)).slice(0,4);
  const queries=[
    `site:${domain} "${home}" "${away}" ${date||""} prediction`,
    `site:${domain} "${home}" "${away}" ${year} tip forecast`
  ];
  let searchResults=[];
  for(const q of queries){
    try{
      const r=await tavilySearch(q);
      searchResults.push(...r.map(x=>({...x,_query:q})));
    }catch{}
  }
  // Deduplicate and enforce both-team fixture identity before extracting pages.
  const seen=new Set();
  searchResults=searchResults.filter(r=>{
    if(!r.url||seen.has(r.url))return false;
    seen.add(r.url);return true;
  });
  const candidates=selectBenchmarkCandidates(searchResults,home,away,date);
  if(!candidates.length){
    return {
      name,domain,status:"NO_EXACT_FIXTURE_SOURCE",found:false,
      predictionAvailable:false,
      explanationAvailable:false,
      prediction:null,rationaleSummary:[],
      sourceUrl:"",sourceTitle:"",
      diagnostics:{queries,searchResultCount:searchResults.length}
    };
  }

  const focus=`${home} vs ${away} ${date||""} prediction correct score 1X2 BTTS over under probability explanation`;
  for(const c of candidates){
    let extracted;
    try{extracted=await tavilyExtractUrl(c.url,focus)}catch(err){extracted={ok:false,content:"",error:err.message,url:c.url};}
    const pageContent=extracted.ok&&extracted.content ? extracted.content : `${c.title}\n${c.content}`;
    const parsed=await parseBenchmarkPrediction({
      siteName:name,home,away,expectedDate:date,url:c.url,title:c.title,content:pageContent
    });
    if(parsed.fixtureMatched && parsed.predictionAvailable && parsed.freshnessStatus!=="STALE"){
      return {
        name,domain,status:"PREDICTION_EXTRACTED",found:true,
        predictionAvailable:true,
        explanationAvailable:Boolean(parsed.explanationAvailable),
        prediction:parsed.primaryPrediction||null,
        otherPredictions:Array.isArray(parsed.otherPredictions)?parsed.otherPredictions:[],
        rationaleSummary:Array.isArray(parsed.rationaleSummary)?parsed.rationaleSummary:[],
        sourceEvidenceSummary:String(parsed.sourceEvidenceSummary||""),
        fixtureDate:String(parsed.fixtureDate||""),
        freshnessStatus:String(parsed.freshnessStatus||"UNKNOWN"),
        sourceUrl:c.url,
        sourceTitle:c.title,
        sourcePublishedDate:c.published_date||"",
        warnings:Array.isArray(parsed.warnings)?parsed.warnings:[],
        parserModel:parsed.parserModel||"",
        diagnostics:{queries,searchResultCount:searchResults.length,candidateCount:candidates.length,extracted:Boolean(extracted.ok)}
      };
    }
  }
  return {
    name,domain,status:"NO_CURRENT_EXPLICIT_PREDICTION",found:true,
    predictionAvailable:false,explanationAvailable:false,
    prediction:null,otherPredictions:[],rationaleSummary:[],
    sourceEvidenceSummary:"An exact or near-exact fixture page was found, but no current explicit prediction could be safely extracted.",
    sourceUrl:candidates[0]?.url||"",sourceTitle:candidates[0]?.title||"",
    freshnessStatus:"UNKNOWN",
    warnings:["Unrelated or stale prediction links were suppressed instead of being shown as valid benchmarks."],
    diagnostics:{queries,searchResultCount:searchResults.length,candidateCount:candidates.length}
  };
}
function externalBenchmarkConsensus(websites=[]){
  const valid=(websites||[]).filter(x=>x.predictionAvailable&&x.prediction?.canonicalMarketKey);
  const groups=new Map();
  for(const x of valid){
    const k=canonicalKey(x.prediction.canonicalMarketKey);
    if(!groups.has(k))groups.set(k,[]);
    groups.get(k).push(x.name);
  }
  const ranked=[...groups.entries()].map(([key,sites])=>({key,count:sites.length,sites}))
    .sort((a,b)=>b.count-a.count);
  const top=ranked[0]||null;
  return {
    availablePredictions:valid.length,
    consensusCanonicalKey:top?.key||"",
    consensusCount:top?.count||0,
    sitesAgreeing:top?.sites||[],
    status:top&&top.count>=3?"HIGH":top&&top.count>=2?"MEDIUM":top?"LOW":"NONE"
  };
}

async function externalPredictionBenchmarks(fixture,gate){
  const prediction=await apiFootballPrediction(gate?.fixture?.id);
  const home=gate?.resolved?.home?.name||gate?.requested?.home||"";
  const away=gate?.resolved?.away?.name||gate?.requested?.away||"";
  const date=(gate?.fixture?.date||"").slice(0,10) || zambiaDate(0);

  const targets=[
    {name:"Forebet",domain:"forebet.com"},
    {name:"PredictZ",domain:"predictz.com"},
    {name:"WinDrawWin",domain:"windrawwin.com"},
    {name:"FootyStats",domain:"footystats.org"}
  ];

  const websites=[];
  for(const target of targets){
    websites.push(await exactWebsitePrediction({...target,home,away,date}));
  }
  return {
    checkedAt:isoNow(),
    targetFixture:`${home} vs ${away}`,
    targetDate:date,
    apiFootball:prediction,
    websites,
    consensus:externalBenchmarkConsensus(websites),
    rule:"External prediction benchmarks are collected after independent sporting analysis. Only exact/current fixture predictions are displayed; unrelated or stale links are suppressed."
  };
}

function analysisPrompt({fixture,round,originalMarket,previousRounds,sources,gate,videoReview,fallbackEvidence,temporalGuard}){
  const prior=previousRounds?.length?JSON.stringify(previousRounds.slice(-3),null,2):"None";
  const original=originalMarket||"Not supplied";
  return `
You are an evidence-first football match research analyst. Freshness and identity accuracy are mandatory.

FIXTURE: ${fixture}
RESEARCH ROUND: ${round}
ORIGINAL USER/TICKET MARKET (do not anchor on it): ${original}

STRUCTURED AUTHENTICITY / FALLBACK DATA:
${structuredDigest(gate)}

CROSS-CHECK / FALLBACK PROVIDERS:
${JSON.stringify(fallbackEvidence||{},null,2)}

HARD AUTHENTICITY RULES:
1. Treat API-Football's current squad/fixture data as the primary identity check for club membership and fixture identity.
2. NEVER describe a player as currently belonging to a club merely because an old article says so.
3. If a web source names a player for a club but that player is absent from the current squad, mark the claim stale/unverified unless a newer official source clearly explains the situation.
4. Confirmed XI means only the structured confirmed lineup. Predicted/probable XI must never be called confirmed.
5. Prefer newer dated sources. If sources conflict, report the conflict; do not silently choose the older claim.
6. If fixture identity or both team identities are not verified strongly enough, finalMarket MUST be "UNRESOLVED".
7. Do not invent players, transfers, injuries, suspensions, statistics, referee assignments, odds, or lineups.
8. Before the sporting market, explicitly audit stale-player/team claims and reject them.
9. If structured coverage is missing, say unavailable instead of filling the gap from memory.

TEMPORAL INTEGRITY RULE:
- This application is for PRE-MATCH research.
- Never use reports, scores, goalscorers, red cards, post-match interviews, or any source published after kickoff as evidence for a pre-match recommendation.
- If temporalGuard.mode is POST_MATCH_AUDIT, LIVE_OR_STARTED, or UNKNOWN, do not create a new betting recommendation or value claim.
- If a source appears to describe the target match result rather than preview it, mark it as post-match leakage and exclude it from prediction reasoning.

TEMPORAL GUARD:
${JSON.stringify(temporalGuard||{},null,2)}

MANDATORY THREE-STAGE WORKFLOW:

STAGE 1 — DATA GATHERING
Collect and organize the evidence before drawing conclusions:
- current club identity and current squad;
- fixture identity/date/competition;
- injuries/suspensions/transfers;
- confirmed vs predicted lineups;
- rest, rotation, motivation, travel;
- last 5 / last 10 / larger sample;
- opponent strength;
- goals, xG/chance quality where available;
- shots, shots on target, possession/territory;
- corners, width, crossing, set pieces;
- cards/referee;
- tactical and game-state evidence;
- H2H, venue, weather;
- video/highlight evidence;
- all source links and freshness.

STAGE 2 — DATA ANALYSIS
Analyze the gathered evidence quantitatively and qualitatively.
Do not merely repeat data. Identify patterns, consistency, contradictions, data gaps,
opponent-strength distortion, recency effects and how strongly each dataset supports
or weakens each market family.

Return explicit analytical scores from 0 to 100:
- evidenceQualityScore: overall completeness/reliability/freshness;
- structuredDataScore: quality of structured/API data;
- webEvidenceScore: quality/freshness/diversity of public web sources;
- videoEvidenceScore: usefulness of reviewed video evidence;
- contradictionRiskScore: higher means more serious contradictions/uncertainty;
- dataFreshnessScore: how current the evidence is.

For every shortlisted market, return:
- sportingSupportScore 0-100;
- contradictionRiskScore 0-100;
- dataSupportScore 0-100;
- fairProbabilityPct;
- probabilityConfidence.

STAGE 3 — PRESENTATION
Present the conclusion clearly enough that the UI can visualize it with:
- a bar chart comparing exact shortlisted markets;
- a pie/donut chart showing data coverage (complete / partial / unavailable);
- a quality-score chart for evidence quality, structured data, web evidence,
  video evidence, freshness and contradiction risk;
- concise narrative explaining what the charts mean.
Charts are a presentation of the analysis, not a replacement for the underlying facts.

ANALYSIS ORDER:
1. Verify fixture and current clubs.
2. Audit present-day squads, confirmed lineup status, injuries/suspensions and transfers when available.
3. Build a football-only match profile.
4. Adjust recent form for opponent strength.
5. SCREEN EVERY REALISTIC MARKET FAMILY WITHOUT USING ODDS. You must explicitly consider:
   - 1X2
   - Double Chance
   - Draw No Bet
   - Asian Handicap
   - European Handicap
   - Total Goals
   - Team Goals
   - Both Teams To Score
   - First-Half Goals
   - Second-Half Goals
   - Win/Double-Chance + Goals combinations
   - Total Corners
   - Team Corners
   - First-Half Corners
   - Corner Handicap / Corner 1X2
   - Cards / Team Cards
   - Shots / Shots On Target when supported
   - Any other bookmaker market that is genuinely supported by the evidence
   Record every family in marketScreen with CONSIDERED, ELIMINATED, or DATA_UNAVAILABLE and why.
6. Shortlist 2-8 exact markets/lines strictly from sporting evidence, still without seeing prices.
   For every surviving candidate estimate a cautious fairProbabilityPct and a confidence label.
   The probability must reflect evidence uncertainty and cannot be invented when data is weak.
7. Adversarially attack each candidate; exact-opposite/failure-set test where applicable.
8. Choose a final sporting market only if evidence converges. Otherwise UNRESOLVED.
9. Compare with original market only after independent conclusion.
10. PRICE/VALUE COMPARISON HAPPENS SERVER-SIDE AFTER THIS ANALYSIS. Do not let assumed prices influence the sporting shortlist.
11. Never call a pick safe, guaranteed, or a banker.

ROUND ${round}: treat this as a fresh independent cycle. Previous rounds are only for end-stage convergence comparison.

PREVIOUS ROUNDS:
${prior}

VIDEO REVIEW OF RECENT HIGHLIGHTS:
${JSON.stringify(videoReview||{status:"UNAVAILABLE"},null,2)}

VIDEO-EVIDENCE RULES:
- Use video review only as supporting evidence.
- Highlights are selective and must never be treated as a complete sample of a team's whole match.
- If videoReview.status is not COMPLETE, do not claim the videos were visually reviewed.
- Give higher weight to recurring patterns seen across multiple recent videos, but still cross-check them against structured/statistical evidence.
- Do not invent shot counts, xG, corner counts, possession, or lineup facts from highlight footage.

FRESH WEB SOURCES:
${sourceDigest(sources)}

Return ONLY valid JSON:
{
  "fixture":"...",
  "fixtureVerified":true,
  "verificationNote":"...",
  "freshness":{
    "structuredCheckedAt":"...",
    "fixtureDate":"...",
    "confirmedLineupsAvailable":false,
    "freshnessNote":"..."
  },
  "authenticityAssessment":{
    "status":"VERIFIED|CAUTION|FAILED",
    "homeCurrentClubVerified":true,
    "awayCurrentClubVerified":true,
    "note":"..."
  },
  "staleClaimsRejected":[
    {"claim":"...","reason":"...","sourceRef":"S1 or structured check"}
  ],
  "verifiedCurrentPlayersReferenced":["..."],
  "videoReviewSummary":"...",
  "dataAnalysis":{
    "evidenceQualityScore":82,
    "structuredDataScore":88,
    "webEvidenceScore":76,
    "videoEvidenceScore":64,
    "contradictionRiskScore":28,
    "dataFreshnessScore":91,
    "keyPatterns":["..."],
    "keyContradictions":["..."],
    "analysisNarrative":"...",
    "marketScores":[
      {
        "market":"Exact market and line",
        "sportingSupportScore":78,
        "contradictionRiskScore":24,
        "dataSupportScore":83,
        "fairProbabilityPct":62,
        "probabilityConfidence":"HIGH|MEDIUM|LOW"
      }
    ]
  },
  "dataCoverage":[{"item":"fixture_verification","status":"complete|partial|unavailable","note":"..."}],
  "matchProfile":{
    "squadAndLineups":"...",
    "formAndOpponentStrength":"...",
    "attackAndDefence":"...",
    "shotsPossessionTerritory":"...",
    "cornersWidthSetPieces":"...",
    "disciplineReferee":"...",
    "tacticsAndGameState":"...",
    "contextRestMotivation":"...",
    "h2hVenueWeatherVideo":"..."
  },
  "marketScreen":[
    {"family":"1X2","status":"CONSIDERED|ELIMINATED|DATA_UNAVAILABLE","reason":"..."}
  ],
  "shortlist":[
    {
      "market":"Exact market and line",
      "marketFamily":"...",
      "fairProbabilityPct":62,
      "probabilityConfidence":"HIGH|MEDIUM|LOW",
      "sportingSupportScore":78,
      "contradictionRiskScore":24,
      "dataSupportScore":83,
      "oddsLookup":{"betTerms":["Match Winner"],"selectionTerms":["Home"]},
      "support":["..."],
      "counterEvidence":["..."],
      "survivesKillTest":true
    }
  ],
  "finalMarket":"Exact market and line OR UNRESOLVED",
  "runnerUp":"Exact market and line OR NONE",
  "classification":"STRONG|MEDIUM|GENUINE DANGER|UNRESOLVED / HIGH RISK",
  "whyFinal":"...",
  "remainingDanger":"...",
  "originalMarketComparison":"...",
  "missingData":["..."],
  "antiBiasCheck":"...",
  "roundConvergence":"...",
  "sourceRefs":["S1"]
}

For dataCoverage include each exactly once:
${CHECKLIST.join(", ")}

Ground factual claims only in the structured data or supplied web sources.
`;
}


function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function geminiTextWithRetry({prompt,maxOutputTokens=9000,responseMimeType="application/json",preferredModel}){
  const key=requireEnv("GEMINI_API_KEY");
  const configured=preferredModel||process.env.GEMINI_MODEL||"gemini-3.8-flash";
  const fallbackModels=[configured,"gemini-3.7-flash","gemini-3.6-flash","gemini-3.5-flash-lite"]
    .filter((m,i,a)=>m&&a.indexOf(m)===i);
  const errors=[];
  for(const model of fallbackModels){
    for(let attempt=1;attempt<=3;attempt++){
      const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{
        method:"POST",
        headers:{"Content-Type":"application/json","x-goog-api-key":key},
        body:JSON.stringify({
          contents:[{parts:[{text:prompt}]}],
          generationConfig:{temperature:0.15,maxOutputTokens,responseMimeType}
        })
      });
      const text=await response.text();
      if(response.ok){
        const data=parseHttpJson(text,`Gemini ${model}`);
        const output=(data.candidates?.[0]?.content?.parts||[]).map(p=>p.text||"").join("").trim();
        return {model,output,attempt};
      }
      const retryable=[429,500,502,503,504].includes(response.status);
      errors.push(`${model} attempt ${attempt}: HTTP ${response.status} ${text.slice(0,300)}`);
      if(!retryable)break;
      if(attempt<3){
        const delay=[2500,6500,13000][attempt-1]+Math.floor(Math.random()*1200);
        await sleep(delay);
      }
    }
  }
  throw new Error(`Gemini unavailable after automatic retries/fallbacks. ${errors.slice(-4).join(" | ")}`);
}

async function geminiAnalyze(payload){
  let firstError=null;
  for(let jsonAttempt=1;jsonAttempt<=2;jsonAttempt++){
    const suffix=jsonAttempt===1?"":`

IMPORTANT RETRY: Your previous answer was syntactically invalid JSON.
Return one complete JSON object only. Check every comma, quote, bracket and array before responding.
Do not add markdown or commentary outside the JSON.`;
    const result=await geminiTextWithRetry({
      prompt:analysisPrompt(payload)+suffix,
      maxOutputTokens:9000,
      responseMimeType:"application/json",
      preferredModel:process.env.GEMINI_MODEL||"gemini-3.8-flash"
    });
    try{
      const parsed=parseJsonObject(result.output,`Gemini ${result.model} analysis`);
      parsed._geminiModelUsed=result.model;
      parsed._geminiAttempt=result.attempt;
      parsed._jsonRecoveryAttempt=jsonAttempt;
      return parsed;
    }catch(err){
      firstError=firstError||err;
      if(jsonAttempt===2){
        throw new Error(`Primary analysis JSON failed after automatic repair and one clean-JSON retry. ${err.message}`);
      }
      await sleep(1200);
    }
  }
  throw firstError||new Error("Primary analysis failed.");
}

app.get("/api/health",(req,res)=>{
  res.json({
    ok:true,version:"3.7.0",
    tavilyConfigured:Boolean(process.env.TAVILY_API_KEY),
    geminiConfigured:Boolean(process.env.GEMINI_API_KEY),
    apiFootballConfigured:Boolean(process.env.API_FOOTBALL_KEY),
    groqConfigured:Boolean(process.env.GROQ_API_KEY),
    cloudflareConfigured:Boolean(process.env.CLOUDFLARE_ACCOUNT_ID&&process.env.CLOUDFLARE_AUTH_TOKEN),
    openRouterConfigured:Boolean(process.env.OPENROUTER_API_KEY),
    footballDataOrgConfigured:Boolean(process.env.FOOTBALL_DATA_ORG_KEY),
    theSportsDBConfigured:true,
    scoreBatConfigured:Boolean(process.env.SCOREBAT_TOKEN),
    model:process.env.GEMINI_MODEL||"gemini-3.8-flash"
  });
});



app.get("/api/research-progress/:id",(req,res)=>{
  res.setHeader("Cache-Control","no-store");
  const p=researchProgress.get(String(req.params.id||""));
  if(!p)return res.status(404).json({ok:false,error:"Progress job not found or already expired."});
  res.json({ok:true,...p});
});

app.get("/api/provider-status",async(req,res)=>{
  const configured=providerConfigured();
  let openRouterFreeModelsCount=0;
  if(configured.openrouter){try{openRouterFreeModelsCount=(await openRouterFreeModels()).length;}catch{}}
  res.json({ok:true,configured,usage:providerUsage,openRouterFreeModelsCount});
});

app.get("/api/provider-test",async(req,res)=>{
  try{
    const result=await apiFootball("/status",{}, {force:true});
    res.json({ok:true,quota:result.quota,status:result.data.response||result.data});
  }catch(err){
    res.status(err.status||500).json({ok:false,error:err.message});
  }
});


app.post("/api/discover",async(req,res)=>{
  try{
    requireEnv("TAVILY_API_KEY");
    const days=Math.max(1,Math.min(3,Number(req.body?.days||2)));
    const maxResults=Math.max(1,Math.min(8,Number(req.body?.maxResults||5)));
    const result=await discoverBestAvailableFixtures({days,maxResults});
    res.json({ok:true,...result});
  }catch(err){
    console.error(err);
    res.status(err.status||500).json({error:err.message||"Discovery failed."});
  }
});


app.post("/api/council-expand",async(req,res)=>{
  try{
    requireEnv("GEMINI_API_KEY");
    const fixture=cleanFixture(req.body?.fixture);
    const existingMembers=Array.isArray(req.body?.existingMembers)?req.body.existingMembers:[];
    const targetSize=Math.max(existingMembers.length+1,Math.min(50,Number(req.body?.targetSize||existingMembers.length+5)));
    const aiCouncil=await runAiCouncil({
      fixture,
      gate:req.body?.authenticityGate||{},
      sources:Array.isArray(req.body?.sources)?req.body.sources:[],
      videoReview:req.body?.videoReview||{},
      fallbackEvidence:req.body?.fallbackEvidence||{}
    },{targetSize,existingMembers});
    res.json({ok:true,aiCouncil});
  }catch(err){
    console.error(err);
    res.status(err.status||500).json({error:err.message||"Council expansion failed."});
  }
});


async function executeResearchJob(body,progressId){
  setResearchProgress(progressId,{percent:2,stage:"Starting research round",stageNumber:1,totalStages:10,message:"Request received. Preparing the fixture for a fresh independent research round."});
  const fixture=cleanFixture(body?.fixture);
  if(!fixture||fixture.length<5)throw new Error("Please provide a valid fixture, preferably 'Team A vs Team B'.");
  const round=Math.max(1,Math.min(20,Number(body?.round||1)));
  const originalMarket=String(body?.originalMarket||"").trim().slice(0,180);
  const previousRounds=Array.isArray(body?.previousRounds)?body.previousRounds:[];
  requireEnv("TAVILY_API_KEY");
  requireEnv("GEMINI_API_KEY");
  const councilSize=Math.max(1,Math.min(20,Number(body?.councilSize||8)));

  setResearchProgress(progressId,{percent:7,stage:"Fixture verification",stageNumber:2,totalStages:10,message:`Round ${round}: verifying team identities, competition, kickoff time and current fixture status.`});
  const gate=await buildBestAvailableGate(fixture,round);
  const temporalGuard=fixtureTemporalGuard(gate);

  setResearchProgress(progressId,{percent:15,stage:"Fallback cross-checks",stageNumber:3,totalStages:10,message:"Cross-checking the fixture with secondary structured providers and supplementary video sources."});
  const fallbackEvidence=await collectFallbackEvidence(fixture,gate);

  const queries=makeQueries(fixture,round,gate);
  const groups=[];
  const webScout=[];
  setResearchProgress(progressId,{percent:22,stage:"Fresh web scouting",stageNumber:4,totalStages:10,message:`Searching fresh public evidence across ${queries.length} research queries.`});
  for(let qi=0;qi<queries.length;qi++){
    const q=queries[qi];
    setResearchProgress(progressId,{
      percent:22+Math.round(((qi+1)/Math.max(1,queries.length))*18),
      stage:"Fresh web scouting",stageNumber:4,totalStages:10,
      message:`Web search ${qi+1}/${queries.length}: ${q.slice(0,120)}`
    });
    const results=await tavilySearch(q);
    groups.push(results);
    webScout.push({category:"web",query:q,results});
  }
  const sources=dedupeSources(groups);
  if(!sources.length)throw new Error("No usable web sources were returned for this fixture.");

  const videoQueries=makeVideoQueries(fixture,gate,round);
  const videoScout=[];
  setResearchProgress(progressId,{percent:43,stage:"Video scouting",stageNumber:5,totalStages:10,message:`Looking for recent prior-match highlights and tactical video evidence (${videoQueries.length} searches).`});
  for(let vi=0;vi<videoQueries.length;vi++){
    const q=videoQueries[vi];
    setResearchProgress(progressId,{
      percent:43+Math.round(((vi+1)/Math.max(1,videoQueries.length))*7),
      stage:"Video scouting",stageNumber:5,totalStages:10,
      message:`Video search ${vi+1}/${videoQueries.length}: ${q.slice(0,120)}`
    });
    const results=await tavilySearch(q);
    videoScout.push({category:"video-search",query:q,results});
  }
  const videoCandidates=chooseVideoCandidates(videoScout,gate);
  setResearchProgress(progressId,{percent:52,stage:"Video review",stageNumber:5,totalStages:10,message:`Reviewing ${videoCandidates.length} selected public video source(s) where supported.`});
  const videoReview=await reviewYoutubeHighlights(videoCandidates,gate);

  const allScoutedLinks=flattenScoutLinks(webScout,videoScout);
  setResearchProgress(progressId,{percent:59,stage:"Data analysis",stageNumber:6,totalStages:10,message:`Analyzing ${sources.length} deduplicated sources, structured evidence, contradictions and every realistic market family.`});
  const analysis=await geminiAnalyze({fixture,round,originalMarket,previousRounds,sources,gate,videoReview,fallbackEvidence,temporalGuard});

  if(gate.status==="FAILED"){
    analysis.finalMarket="UNRESOLVED";
    analysis.classification="UNRESOLVED / HIGH RISK";
    analysis.remainingDanger=`Authenticity gate failed: ${(gate.warnings||[]).join(" ")}`;
  }
  if(!temporalGuard.bettingAllowed){
    analysis.finalMarket=temporalGuard.mode==="POST_MATCH_AUDIT"?"POST-MATCH AUDIT ONLY":"NO PRE-MATCH BET — TIMING NOT VERIFIED";
    analysis.classification="UNRESOLVED / HIGH RISK";
    analysis.originalMarketComparison="";
    analysis.remainingDanger=temporalGuard.reason;
    analysis.shortlist=[];
  }

  setResearchProgress(progressId,{percent:70,stage:"AI Council",stageNumber:7,totalStages:10,message:temporalGuard.bettingAllowed?`Running the independent AI Council with up to ${councilSize} agent seat(s). Odds remain hidden.`:"Pre-match timing guard blocked the betting council; preserving the audit instead."});
  const aiCouncil=temporalGuard.bettingAllowed
    ? await runAiCouncil({fixture,gate,sources,videoReview,fallbackEvidence},{targetSize:councilSize})
    : {checkedAt:isoNow(),members:[],counts:{agentSeats:0,availableAgents:0,uniqueModels:0,specialistAgents:0},
       aggregation:{availableModels:0,unresolvedModels:0,convergence:"BLOCKED",consensusMarket:"BLOCKED BY TEMPORAL GUARD",
       consensusCanonicalKey:"",modelsAgreeing:[],medianFairProbabilityPct:null,groups:[],note:temporalGuard.reason}};

  setResearchProgress(progressId,{percent:81,stage:"External benchmarks",stageNumber:8,totalStages:10,message:temporalGuard.bettingAllowed?"Extracting actual current predictions and published reasoning from external benchmark sources.":"External predictions blocked by the pre-match integrity guard."});
  const externalBenchmarks=temporalGuard.bettingAllowed
    ? await externalPredictionBenchmarks(fixture,gate)
    : {checkedAt:isoNow(),websites:[],apiFootball:{available:false},consensus:{status:"BLOCKED",availablePredictions:0},
       rule:`Blocked: ${temporalGuard.reason}`};

  setResearchProgress(progressId,{percent:90,stage:"Odds & value audit",stageNumber:9,totalStages:10,message:temporalGuard.bettingAllowed?"Sporting analysis is complete. Only now checking available prices and potential value.":"Odds/value stage blocked because this is not a verified pre-match fixture."});
  const oddsSnapshot=temporalGuard.bettingAllowed
    ? await preMatchOdds(gate?.fixture?.id)
    : {available:false,rows:[],checkedAt:isoNow(),reason:`Blocked: ${temporalGuard.reason}`};

  const valueCandidates=temporalGuard.bettingAllowed?[...(analysis.shortlist||[])]:[];
  const agg=aiCouncil.aggregation||{};
  if(agg.consensusCanonicalKey&&agg.consensusMarket&&agg.consensusMarket!=="NO CONSENSUS"){
    const exists=valueCandidates.some(x=>canonicalKey(x.canonicalMarketKey||x.market)===agg.consensusCanonicalKey);
    if(!exists)valueCandidates.push({
      market:agg.consensusMarket,marketFamily:"AI Council Consensus",
      fairProbabilityPct:agg.medianFairProbabilityPct,
      probabilityConfidence:agg.convergence==="HIGH"?"HIGH":agg.convergence==="MEDIUM"?"MEDIUM":"LOW",
      canonicalMarketKey:agg.consensusCanonicalKey,oddsLookup:{betTerms:[],selectionTerms:[]}
    });
  }
  const value=valueAudit(valueCandidates,oddsSnapshot);

  const primaryKey=canonicalKey((analysis.shortlist||[]).find(x=>x.market===analysis.finalMarket)?.canonicalMarketKey||analysis.finalMarket);
  const councilKey=agg.consensusCanonicalKey||"";
  const same=Boolean(councilKey)&&primaryKey===councilKey;
  const finalConvergence={
    status:!councilKey||["NONE","INSUFFICIENT","BLOCKED"].includes(agg.convergence)?"NO COUNCIL CONSENSUS":same?"PRIMARY + COUNCIL CONVERGED":"PRIMARY / COUNCIL DISAGREE",
    primaryMarket:analysis.finalMarket||"UNRESOLVED",
    councilMarket:agg.consensusMarket||"NO CONSENSUS",
    councilConvergence:agg.convergence||"NONE",
    note:same?"The primary fact-first analysis and independent council point to the same canonical market.":"Disagreement or insufficient council coverage is preserved instead of forcing agreement."
  };

  setResearchProgress(progressId,{percent:97,stage:"Presentation",stageNumber:10,totalStages:10,message:"Building charts, source audit, market screen, council summary and final round presentation."});

  return {
    ok:true,fixture,round,
    searchesUsed:queries.length+videoQueries.length,
    queries,videoQueries,sources,
    authenticityGate:gate,videoReview,fallbackEvidence,
    sourceAudit:{webScout,videoScout,allScoutedLinks},
    temporalGuard,
    aiCouncil,externalBenchmarks,finalConvergence,
    oddsSnapshot:{
      available:oddsSnapshot.available,checkedAt:oddsSnapshot.checkedAt,
      bookmakerCount:value.bookmakerCount,betTypeCount:value.betTypeCount,
      selectionCount:value.selectionCount,reason:oddsSnapshot.reason||""
    },
    valueAudit:value,analysis
  };
}

app.post("/api/research-start",(req,res)=>{
  const progressId=String(req.body?.progressId||"").trim().slice(0,120);
  if(!progressId)return res.status(400).json({error:"Missing progressId."});
  if(researchProgress.get(progressId)?.status==="running"){
    return res.status(409).json({error:"That research job is already running.",progressId});
  }

  setResearchProgress(progressId,{
    percent:1,stage:"Queued",stageNumber:1,totalStages:10,
    message:"Research job accepted by the server. Starting now.",status:"running"
  });
  researchResults.delete(progressId);

  const body=JSON.parse(JSON.stringify(req.body||{}));
  res.status(202).json({ok:true,progressId,status:"accepted"});

  setImmediate(async()=>{
    try{
      const result=await executeResearchJob(body,progressId);
      researchResults.set(progressId,{status:"complete",result,updatedAt:isoNow()});
      finishResearchProgress(progressId);
    }catch(err){
      console.error(err);
      researchResults.set(progressId,{status:"error",error:err.message||"Research failed.",updatedAt:isoNow()});
      failResearchProgress(progressId,err);
    }
  });
});

app.get("/api/research-result/:id",(req,res)=>{
  res.setHeader("Cache-Control","no-store");
  const id=String(req.params.id||"");
  const job=researchResults.get(id);
  const progress=researchProgress.get(id);
  if(job?.status==="complete")return res.json({ok:true,status:"complete",result:job.result});
  if(job?.status==="error")return res.status(500).json({ok:false,status:"error",error:job.error||"Research failed."});
  if(progress)return res.status(202).json({ok:true,status:progress.status||"running",progress});
  return res.status(404).json({ok:false,status:"missing",error:"Research job not found or expired."});
});

// Backward-compatible endpoint: starts an async job instead of holding one long HTTP request open.
app.post("/api/research",(req,res)=>{
  const progressId=String(req.body?.progressId||"").trim().slice(0,120) || `legacy-${Date.now()}`;
  if(researchProgress.get(progressId)?.status==="running"){
    return res.status(409).json({error:"That research job is already running.",progressId});
  }
  setResearchProgress(progressId,{percent:1,stage:"Queued",stageNumber:1,totalStages:10,message:"Research job accepted. Use the result endpoint to retrieve it.",status:"running"});
  researchResults.delete(progressId);
  const body={...(req.body||{}),progressId};
  setImmediate(async()=>{
    try{
      const result=await executeResearchJob(body,progressId);
      researchResults.set(progressId,{status:"complete",result,updatedAt:isoNow()});
      finishResearchProgress(progressId);
    }catch(err){
      researchResults.set(progressId,{status:"error",error:err.message||"Research failed.",updatedAt:isoNow()});
      failResearchProgress(progressId,err);
    }
  });
  res.status(202).json({ok:true,progressId,status:"accepted",message:"Research is running asynchronously."});
});


app.use((req,res)=>{
  res.setHeader("Cache-Control","no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname,"public","index.html"));
});
app.listen(PORT,()=>console.log(`Football Fact-First Research v3.7 running on port ${PORT}`));
