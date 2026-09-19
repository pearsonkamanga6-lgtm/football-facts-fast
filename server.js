const express = require("express");
const path = require("path");
const { jsonrepair } = require("jsonrepair");
const cheerio = require("cheerio");
const fs = require("fs");
const pkg = require("./package.json");

const app = express();
const PORT = process.env.PORT || 10000;
const APP_VERSION = pkg.version;
const AI_REQUEST_TIMEOUT_MS = Math.max(8000, Math.min(90000, Number(process.env.AI_REQUEST_TIMEOUT_MS || 45000)));
const COUNCIL_MIN_MODELS = Math.max(2, Math.min(5, Number(process.env.COUNCIL_MIN_INDEPENDENT_MODELS || 2)));
const COUNCIL_MAX_MODELS = Math.max(COUNCIL_MIN_MODELS, Math.min(12, Number(process.env.COUNCIL_MAX_MODELS || 8)));
const INDEX_PATH = path.join(__dirname, "public", "index.html");
const SERVICE_WORKER_PATH = path.join(__dirname, "public", "service-worker.js");
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";

app.use(express.json({ limit: "3mb" }));

// Runtime-injected version: package.json is the single version source.
app.get("/", (req,res) => {
  res.setHeader("Cache-Control","no-cache, no-store, must-revalidate");
  const html=fs.readFileSync(INDEX_PATH,"utf8").replaceAll("__APP_VERSION__",APP_VERSION);
  res.type("html").send(html);
});
app.get("/service-worker.js", (req,res) => {
  res.setHeader("Cache-Control","no-cache, no-store, must-revalidate");
  const js=fs.readFileSync(SERVICE_WORKER_PATH,"utf8").replaceAll("__APP_VERSION__",APP_VERSION);
  res.type("application/javascript").send(js);
});

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
    percent:100,stage:"Complete",stageNumber:12,totalStages:12,
    message:"Research round complete. Results are ready for presentation.",
    status:"complete"
  });
}
// Keep in-memory progress lightweight on the free Render instance.
setInterval(()=>{
  const cutoff=Date.now()-90*60*1000;
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
  googleSearch:{calls:0,success:0,fail:0,lastError:""},
  bingSearch:{calls:0,success:0,fail:0,lastError:""},
  duckduckgo:{calls:0,success:0,fail:0,lastError:""},
  pageReader:{calls:0,success:0,fail:0,lastError:""},
  footballDataOrg:{calls:0,success:0,fail:0,lastError:""},
  theSportsDB:{calls:0,success:0,fail:0,lastError:""},
  scoreBat:{calls:0,success:0,fail:0,lastError:""},
  gemini:{calls:0,success:0,fail:0,lastError:""},
  groq:{calls:0,success:0,fail:0,lastError:""},
  cloudflare:{calls:0,success:0,fail:0,lastError:""},
  openrouter:{calls:0,success:0,fail:0,lastError:""}
};
const providerHealth={
  geminiText:{state:"READY",blockedUntil:0,lastReason:"",failures:0},
  geminiVideo:{state:"READY",blockedUntil:0,lastReason:"",failures:0},
  openrouter:{state:"READY",blockedUntil:0,lastReason:"",failures:0},
  groq:{state:"READY",blockedUntil:0,lastReason:"",failures:0},
  cloudflare:{state:"READY",blockedUntil:0,lastReason:"",failures:0}
};
function classifyProviderFailure(err){
  const msg=String(err?.message||err||"");
  if(/403|paid plan|billing|payment|upgrade/i.test(msg))return {state:"PLAN_BLOCKED",ms:12*3600e3};
  if(/429|quota|resource[_ ]?exhausted|rate.?limit|too many requests/i.test(msg)){
    const daily=/daily|requests per day|rpd|quota exceeded|current quota/i.test(msg);
    return {state:daily?"QUOTA_EXHAUSTED":"RATE_LIMITED",ms:daily?6*3600e3:10*60e3};
  }
  if(/500|502|503|504|capacity|unavailable|timeout/i.test(msg))return {state:"TEMP_UNAVAILABLE",ms:2*60e3};
  return {state:"ERROR_COOLDOWN",ms:60e3};
}
function tripProvider(name,err){
  const h=providerHealth[name];if(!h)return;
  const c=classifyProviderFailure(err);
  h.state=c.state;h.blockedUntil=Date.now()+c.ms;h.lastReason=String(err?.message||err||"").slice(0,260);h.failures++;
}
function healProvider(name){
  const h=providerHealth[name];if(!h)return;
  h.state="READY";h.blockedUntil=0;h.lastReason="";
}
function providerCanCall(name){
  const h=providerHealth[name];
  if(!h)return true;
  if(h.blockedUntil&&Date.now()<h.blockedUntil)return false;
  if(h.blockedUntil&&Date.now()>=h.blockedUntil)healProvider(name);
  return true;
}
function providerHealthSnapshot(){
  const now=Date.now(),out={};
  for(const [k,v] of Object.entries(providerHealth))out[k]={...v,blockedForSeconds:v.blockedUntil>now?Math.ceil((v.blockedUntil-now)/1000):0};
  return out;
}
function usageStart(name){ if(providerUsage[name]) providerUsage[name].calls++; }
function usageOk(name,extra={}){ if(providerUsage[name]){ providerUsage[name].success++; Object.assign(providerUsage[name],extra); } if(providerHealth[name])healProvider(name); }
function usageFail(name,err){ if(providerUsage[name]){ providerUsage[name].fail++; providerUsage[name].lastError=String(err?.message||err||"").slice(0,240); } if(providerHealth[name])tripProvider(name,err); }
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

function edgeCleanTeamName(name){
  const tokens=normalizeTeamName(name).split(" ").filter(Boolean);
  // Common bookmaker/database affixes and Brazilian state suffixes.
  const edgeTokens=new Set([
    "fc","cf","sc","ac","afc","ec","se","ud","cd","ad","ca","club",
    "sp","rj","mg","rs","pr","ba","go","df","ce","pe","rn","pb","pa","am","ma","mt","ms","al","es"
  ]);
  let a=0,b=tokens.length;
  while(a<b && edgeTokens.has(tokens[a]))a++;
  while(b>a && edgeTokens.has(tokens[b-1]))b--;
  return tokens.slice(a,b).join(" ").trim();
}
function teamSearchVariants(requested){
  const raw=String(requested||"").trim();
  const norm=normalizeTeamName(raw);
  const core=edgeCleanTeamName(raw);
  const variants=[raw];

  // Put the clean football name early because free API quota matters.
  if(core && core.toLowerCase()!==raw.toLowerCase())variants.push(core);
  if(norm && norm.toLowerCase()!==raw.toLowerCase() && norm!==core)variants.push(norm);

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
    "krylia sovetov samara":["Krylya Sovetov","Krylia Sovetov"],
    "se palmeiras sp":["Palmeiras","SE Palmeiras"],
    "palmeiras sp":["Palmeiras"],
    "levante ud":["Levante"],
    "athletic club bilbao":["Athletic Bilbao","Athletic Club"],
    "ldu quito":["LDU Quito","Liga de Quito","LDU"],
    "lion city sailors":["Lion City Sailors"],
    "lion city sailors fc":["Lion City Sailors"],
    "bg pathum united":["BG Pathum United","Pathum United"]
  };

  for(const key of [norm,core]){
    for(const a of (aliases[key]||[]))variants.push(a);
  }

  const coreTokens=core.split(" ").filter(Boolean);
  if(coreTokens.length>1 && coreTokens[0].length>=4)variants.push(coreTokens[0]);

  return [...new Set(variants.map(x=>x.trim()).filter(Boolean))].slice(0,6);
}

function teamIdentityTokenSet(name){
  return new Set(significantTeamTokens(name));
}
function teamIdentityCompatibility(requested,candidate,variants=[]){
  const rn=normalizeTeamName(requested);
  const cn=normalizeTeamName(candidate);
  if(!rn||!cn)return 0;
  if(rn===cn)return 1;

  // Exact match to an explicit alias is authoritative.
  for(const v of variants){
    if(normalizeTeamName(v)===cn)return 1;
  }

  const req=[...teamIdentityTokenSet(requested)];
  const can=teamIdentityTokenSet(candidate);
  if(!req.length)return teamSimilarity(requested,candidate);

  const overlap=req.filter(t=>can.has(t)).length;
  const coverage=overlap/req.length;

  // Multi-token club names must retain the majority of their identity tokens.
  // This specifically prevents "Lion City Sailors" -> "Golden Lion".
  if(req.length>=3 && coverage<0.67)return coverage*0.35;
  if(req.length===2 && coverage<0.5)return coverage*0.45;

  return Math.max(coverage,teamSimilarity(requested,candidate)*0.75);
}

async function resolveTeam(requested,{force=false}={}){
  const variants=teamSearchVariants(requested);
  const all=[],seen=new Set();
  let lastQuota=null,checkedAt=isoNow(),tried=[];

  for(const q of variants){
    tried.push(q);
    const result=await apiFootball("/teams",{search:q},{cacheMs:24*3600e3,force});
    lastQuota=result.quota;checkedAt=result.fetchedAt;

    for(const x of (result.data.response||[])){
      const id=x.team?.id;
      if(!id||seen.has(id))continue;
      seen.add(id);
      const apiName=x.team?.name||"";
      const rawScore=Math.max(...variants.map(v=>teamSimilarity(v,apiName)));
      const compatibility=teamIdentityCompatibility(requested,apiName,variants);
      const score=Math.min(rawScore,compatibility);
      all.push({
        id,name:apiName,country:x.team?.country||"",logo:x.team?.logo||"",
        score,rawScore,compatibility,foundBy:q
      });
    }
    all.sort((a,b)=>b.score-a.score);
    if(all[0]?.score>=0.90)break;
  }

  const best=all.sort((a,b)=>b.score-a.score)[0]||null;
  return {
    requested,best,alternatives:all.slice(1,4),
    confidence:best?best.score:0,
    searchVariantsTried:tried,
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
function futureFixtureRank(match){
  const ts=Number(match?.fixture?.timestamp||0)*1000 || Date.parse(match?.fixture?.date||"");
  if(!Number.isFinite(ts))return Number.MAX_SAFE_INTEGER;
  return Math.abs(ts-Date.now());
}
async function fixtureByExactDate(homeId,awayId,date,{force=false}={}){
  if(!date)return {match:null,quota:null,checkedAt:isoNow(),method:"date-fallback"};
  const r=await apiFootball("/fixtures",{date,timezone:"Africa/Lusaka"},{cacheMs:5*60e3,force});
  const rows=(r.data.response||[]);
  const exact=rows.find(x=>{
    const h=x.teams?.home?.id,a=x.teams?.away?.id;
    return (h===homeId&&a===awayId)||(h===awayId&&a===homeId);
  })||null;
  return {match:exact,quota:r.quota,checkedAt:r.fetchedAt,method:"date-fallback"};
}
function parseWebDateCandidates(text){
  const s=String(text||"");
  const out=[];
  const push=(y,m,d)=>{
    const dt=new Date(Date.UTC(Number(y),Number(m)-1,Number(d),12,0,0));
    if(Number.isFinite(dt.getTime()))out.push(dt.toISOString().slice(0,10));
  };
  for(const m of s.matchAll(/\b(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})\b/g))push(m[1],m[2],m[3]);
  for(const m of s.matchAll(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/g))push(m[3],m[2],m[1]);
  const months={jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12};
  for(const m of s.matchAll(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})\b/gi)){
    push(m[3],months[m[1].toLowerCase()],m[2]);
  }
  for(const m of s.matchAll(/\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/gi)){
    push(m[3],months[m[2].toLowerCase()],m[1]);
  }
  return [...new Set(out)];
}
function parseWebKickoffCandidates(text,date){
  const s=String(text||"");
  const out=[];
  const addIso=(iso)=>{
    const t=Date.parse(iso);if(!Number.isFinite(t))return;
    const d=new Date(t).toISOString();if(d.slice(0,10)===date)out.push(d.replace(".000Z","Z"));
  };
  const pushUtc=(hh,mm,ampm="")=>{
    let h=Number(hh),m=Number(mm||0);
    if(ampm){const ap=String(ampm).toLowerCase();if(ap==="pm"&&h<12)h+=12;if(ap==="am"&&h===12)h=0;}
    if(h>=0&&h<24&&m>=0&&m<60)out.push(`${date}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00Z`);
  };
  const pushOffset=(hh,mm,ampm,offsetHours,offsetMinutes=0)=>{
    let h=Number(hh),m=Number(mm||0);
    if(ampm){const ap=String(ampm).toLowerCase();if(ap==="pm"&&h<12)h+=12;if(ap==="am"&&h===12)h=0;}
    if(h<0||h>23||m<0||m>59)return;
    const dt=new Date(`${date}T00:00:00Z`);
    const totalOffset=Number(offsetHours)*60+(Number(offsetHours)>=0?Number(offsetMinutes):-Number(offsetMinutes));
    dt.setUTCMinutes(h*60+m-totalOffset);out.push(dt.toISOString().replace(".000Z","Z"));
  };
  for(const m of s.matchAll(/\b(20\d{2}-\d{2}-\d{2}T\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\b/gi))addIso(m[1]);
  for(const m of s.matchAll(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(UTC|GMT)\b/gi))pushUtc(m[1],m[2]);
  for(const m of s.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(UTC|GMT)\b/gi))pushUtc(m[1],m[2]||"00",m[3]);
  for(const m of s.matchAll(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(?:[A-Z]{2,5}\s*)?\(\s*UTC([+-])(\d{1,2})(?::?(\d{2}))?\s*\)/g)){
    const sign=m[3]==="-"?-1:1;pushOffset(m[1],m[2],"",sign*Number(m[4]),Number(m[5]||0));
  }
  for(const m of s.matchAll(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\s*(SGT|Singapore Time)\b/gi))pushOffset(m[1],m[2]||"00",m[3],8,0);
  return [...new Set(out)].filter(x=>x.startsWith(date+"T"));
}
function kickoffMinuteKey(iso){
  const t=Date.parse(iso);
  if(!Number.isFinite(t))return "";
  return new Date(Math.round(t/60000)*60000).toISOString().slice(0,16);
}


function sourceDomain(url){
  try{return new URL(url).hostname.replace(/^www\./,"").toLowerCase();}catch{return "";}
}
function significantTeamTokens(name){
  const stop=new Set(["fc","cf","sc","ac","afc","ec","se","ud","cd","ad","ca","club","sp","rj","mg","rs","pr","ba","go","df"]);
  return edgeCleanTeamName(name).split(" ").map(x=>x.toLowerCase()).filter(x=>x.length>=4&&!stop.has(x));
}
function strictTeamTokens(name){
  const edge=edgeCleanTeamName(name).split(" ").map(x=>x.toLowerCase()).filter(Boolean);
  const stop=new Set(["fc","cf","sc","ac","afc","ec","se","ud","cd","ad","ca","club","sp","rj","mg","rs","pr","ba","go","df","ce","pe","rn","pb","pa","am","ma","mt","ms","al","es"]);
  return edge.filter(x=>x.length>=3&&!stop.has(x));
}
function strictTextMentionsTeam(text,name){
  const hay=` ${normalizeTeamName(text).toLowerCase()} `;
  const core=strictTeamTokens(name);
  if(!core.length)return false;
  if(core.every(t=>hay.includes(t)))return true;
  // Allow explicit aliases, but never collapse a multi-word club into an ambiguous
  // one-word token such as "Lion", "BG", "City" or "United".
  for(const variant of teamSearchVariants(name)){
    const vt=strictTeamTokens(variant);
    if(!vt.length)continue;
    if(core.length>=2 && vt.length<2)continue;
    if(vt.every(t=>hay.includes(t)))return true;
  }
  return false;
}
function textMentionsTeam(text,name){
  return strictTextMentionsTeam(text,name);
}
function taskRelevanceMode(category){
  // Exact-fixture questions should mention both clubs. Team-profile questions may
  // legitimately return one strong page per club, so they require either club.
  if(["fixture","competition","lineups","h2h","weather","predictions","motivation","counterevidence","market_thresholds"].includes(category))return "both";
  if(["official_home","squad_home"].includes(category))return "home";
  if(["official_away","squad_away"].includes(category))return "away";
  return "either";
}
function resultRelevantForTask(result,task,home,away){
  const text=`${result?.title||""} ${result?.content||""} ${result?.url||""}`;
  const h=strictTextMentionsTeam(text,home),a=strictTextMentionsTeam(text,away);
  const mode=taskRelevanceMode(task?.category||"");
  if(mode==="both")return h&&a;
  if(mode==="home")return h;
  if(mode==="away")return a;
  return h||a;
}
function pageRelevantForCategories(text,categories,home,away){
  const h=strictTextMentionsTeam(text,home),a=strictTextMentionsTeam(text,away);
  for(const c of categories||[]){
    const mode=taskRelevanceMode(c);
    if(mode==="both"&&h&&a)return true;
    if(mode==="home"&&h)return true;
    if(mode==="away"&&a)return true;
    if(mode==="either"&&(h||a))return true;
  }
  return false;
}
async function locateFixtureDateFromWeb(fixtureText,homeName="",awayName=""){
  try{
    const queries=[
      `"${homeName||fixtureText}" vs "${awayName||""}" exact date kickoff time UTC schedule 2026`,
      `"${homeName||fixtureText}" "${awayName||""}" fixture kickoff competition venue 2026`,
      `${fixtureText} exact fixture date kickoff UTC official`
    ];
    const all=[];
    for(const q of queries){
      const rows=await tavilySearch(q);
      for(const r of rows)if(!all.some(x=>x.url===r.url))all.push(r);
    }

    const today=Date.parse(zambiaDate(-1)+"T00:00:00Z");
    const max=Date.parse(zambiaDate(150)+"T23:59:59Z");
    const grouped=new Map();

    for(const r of all){
      const txt=`${r.title||""} ${r.content||""}`;
      // Search by the REQUESTED fixture names, not a possibly-wrong structured alias.
      if(homeName&&awayName && (!textMentionsTeam(txt,homeName)||!textMentionsTeam(txt,awayName)))continue;
      const domain=sourceDomain(r.url);
      if(!domain)continue;

      for(const date of parseWebDateCandidates(txt)){
        const ts=Date.parse(date+"T12:00:00Z");
        if(ts<today||ts>max)continue;
        if(!grouped.has(date))grouped.set(date,new Map());
        const kicks=parseWebKickoffCandidates(txt,date);
        grouped.get(date).set(domain,{
          date,url:r.url||"",title:r.title||"",domain,
          kickoffs:kicks
        });
      }
    }

    const ranked=[...grouped.entries()].map(([date,m])=>{
      const sources=[...m.values()];
      const kickGroups=new Map();
      for(const src of sources){
        for(const iso of src.kickoffs||[]){
          const key=kickoffMinuteKey(iso);
          if(!key)continue;
          if(!kickGroups.has(key))kickGroups.set(key,[]);
          kickGroups.get(key).push(src);
        }
      }
      const bestKick=[...kickGroups.entries()]
        .map(([key,rows])=>({key,rows,domains:new Set(rows.map(x=>x.domain)).size}))
        .sort((a,b)=>b.domains-a.domains)[0]||null;

      return {
        date,sources,domainCount:m.size,
        kickoff:bestKick?.rows?.[0]?.kickoffs?.find(x=>kickoffMinuteKey(x)===bestKick.key)||"",
        kickoffDomainCount:bestKick?.domains||0
      };
    }).sort((a,b)=>b.domainCount-a.domainCount||b.kickoffDomainCount-a.kickoffDomainCount||String(a.date).localeCompare(String(b.date)));

    const best=ranked[0]||null;
    return best?{
      ...best,
      confidence:best.kickoffDomainCount>=2?0.98:best.domainCount>=3?0.95:best.domainCount>=2?0.88:0.58,
      queries
    }:null;
  }catch{
    return null;
  }
}
function syntheticWebFixture({homeId,awayId,homeName,awayName,date,kickoff="",sources=[],confidence=0.88,provider="WEB_CONSENSUS"}){
  const exact=Boolean(kickoff);
  return {
    fixture:{
      id:null,
      date:exact?kickoff:`${date}T00:00:00+02:00`,
      timestamp:exact?Math.floor(Date.parse(kickoff)/1000):null,
      status:{long:exact?"Web-verified scheduled fixture":"Web-verified future date",short:"WEB"},
      venue:{}
    },
    league:{name:"",country:"",season:null,round:""},
    teams:{home:{id:homeId,name:homeName},away:{id:awayId,name:awayName}},
    lineups:[],
    _verification:provider,
    _verificationConfidence:confidence,
    _verificationSources:sources,
    _dateOnly:!exact
  };
}
async function findUpcomingFixture(homeId,awayId,{force=false,fixtureText="",homeName="",awayName=""}={}){
  const from=zambiaDate(-1),to=zambiaDate(150);
  let quota=null,checkedAt=isoNow(),errors=[];
  try{
    const r=await apiFootball("/fixtures/headtohead",{h2h:`${homeId}-${awayId}`,from,to},{cacheMs:10*60e3,force});
    quota=r.quota;checkedAt=r.fetchedAt;
    const rows=(r.data.response||[]).filter(x=>{
      const h=x.teams?.home?.id,a=x.teams?.away?.id;
      return (h===homeId&&a===awayId)||(h===awayId&&a===homeId);
    });
    rows.sort((a,b)=>futureFixtureRank(a)-futureFixtureRank(b));
    const exact=rows.find(x=>{
      const ts=Number(x?.fixture?.timestamp||0)*1000||Date.parse(x?.fixture?.date||"");
      return Number.isFinite(ts)&&ts>=Date.now()-6*3600e3;
    })||null;
    if(exact)return {match:exact,quota,checkedAt,lookup:{method:"api-football-headtohead",from,to,count:rows.length},errors};
  }catch(err){errors.push(`headtohead: ${String(err?.message||err)}`);}

  // Independent fallback providers + fresh-web date consensus.
  let fd={available:false},ts={available:false},web=null;
  try{[fd,ts,web]=await Promise.all([
    footballDataFindFixture(homeName||fixtureText,awayName||""),
    sportsDbFindFixture(homeName||fixtureText,awayName||""),
    locateFixtureDateFromWeb(fixtureText,homeName,awayName)
  ]);}catch(err){errors.push(`fallback-consensus: ${String(err?.message||err)}`);}

  const votes=new Map();
  const vote=(date,label,source,weight=1)=>{
    const d=String(date||"").slice(0,10);if(!/^20\d{2}-\d{2}-\d{2}$/.test(d))return;
    if(!votes.has(d))votes.set(d,[]);votes.get(d).push({label,source,weight});
  };
  if(fd?.available)vote(fd.best?.date,"football-data.org",fd.best,1);
  if(ts?.available)vote(ts.best?.date,"TheSportsDB",ts.best,1);
  if(web?.date){
    for(const src of web.sources||[])vote(web.date,`web:${src.domain}`,src,1);
  }
  const ranked=[...votes.entries()].map(([date,rows])=>({date,rows,weight:rows.reduce((n,x)=>n+x.weight,0),independent:new Set(rows.map(x=>x.label)).size}))
    .sort((a,b)=>b.independent-a.independent||b.weight-a.weight||String(a.date).localeCompare(String(b.date)));
  const best=ranked[0];
  if(best&&best.independent>=2){
    // Try once more to obtain an official API fixture ID on the agreed date.
    try{
      const d=await fixtureByExactDate(homeId,awayId,best.date,{force:true});
      if(d.match)return {match:d.match,quota:d.quota||quota,checkedAt:d.checkedAt,lookup:{method:"consensus-date+api-date",date:best.date,votes:best.rows},errors};
    }catch(err){errors.push(`api-date-after-consensus: ${String(err?.message||err)}`);}
    const webSources=best.rows.map(x=>({provider:x.label,url:x.source?.url||"",title:x.source?.title||""}));
    const exactKickoff=(web?.date===best.date && web?.kickoff && web?.kickoffDomainCount>=1)?web.kickoff:"";
    return {
      match:syntheticWebFixture({
        homeId,awayId,homeName,awayName,date:best.date,kickoff:exactKickoff,
        sources:webSources,
        confidence:exactKickoff?Math.max(0.95,web.confidence||0.95):(best.independent>=3?0.95:0.88),
        provider:exactKickoff?"MULTI_SOURCE_WEB_TIME":"MULTI_SOURCE_WEB"
      }),
      quota,checkedAt:isoNow(),
      lookup:{method:exactKickoff?"multi-source-web-time":"multi-source-web",date:best.date,kickoff:exactKickoff,votes:best.rows},
      errors
    };
  }
  return {match:null,quota,checkedAt,lookup:{method:"headtohead+multi-source-fallback",from,to,votes:ranked.slice(0,3)},errors};
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
    lineups:compactLineups(match),
    verification:match._verification||"API_FOOTBALL",
    verificationConfidence:match._verificationConfidence??1,
    verificationSources:match._verificationSources||[],
    dateOnly:Boolean(match._dateOnly)
  };
}
function lastQuota(...items){
  const flat=items.flat().filter(Boolean);
  for(let i=flat.length-1;i>=0;i--) if(flat[i].quota) return flat[i].quota;
  return null;
}
function compactResolvedTeam(r){
  return {
    id:r?.best?.id||null,
    name:r?.best?.name||"",
    country:r?.best?.country||"",
    confidence:Number(r?.confidence||0),
    requested:r?.requested||"",
    searchVariantsTried:Array.isArray(r?.searchVariantsTried)?r.searchVariantsTried:[]
  };
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
  if(home.best && teamIdentityCompatibility(parsed.home,home.best.name,teamSearchVariants(parsed.home))<0.67){
    warnings.push(`Rejected suspicious home-team match "${home.best.name}" for requested "${parsed.home}".`);
    home.best=null;home.confidence=0;
  }
  if(away.best && teamIdentityCompatibility(parsed.away,away.best.name,teamSearchVariants(parsed.away))<0.67){
    warnings.push(`Rejected suspicious away-team match "${away.best.name}" for requested "${parsed.away}".`);
    away.best=null;away.confidence=0;
  }
  if(!home.best||home.confidence<0.42) warnings.push(`Home team resolution is uncertain: "${parsed.home}". Tried: ${(home.searchVariantsTried||[]).join(" → ")}.`);
  if(!away.best||away.confidence<0.42) warnings.push(`Away team resolution is uncertain: "${parsed.away}". Tried: ${(away.searchVariantsTried||[]).join(" → ")}.`);
  if(!home.best||!away.best){
    return {
      status:"FAILED",checkedAt:isoNow(),warnings,requested:parsed,
      resolved:{home:compactResolvedTeam(home),away:compactResolvedTeam(away)},
      fixture:null,squads:null,injuries:[],transfers:[],confirmedLineups:false,
      quota:lastQuota(home,away)
    };
  }

  let homeSquad={players:[],quota:null,checkedAt:isoNow()},awaySquad={players:[],quota:null,checkedAt:isoNow()};
  try{homeSquad=await currentSquad(home.best.id,{force});}catch(err){warnings.push(`Home structured squad unavailable: ${String(err?.message||err).slice(0,180)}`);}
  try{awaySquad=await currentSquad(away.best.id,{force});}catch(err){warnings.push(`Away structured squad unavailable: ${String(err?.message||err).slice(0,180)}`);}
  let candidate;
  try{
    candidate=await findUpcomingFixture(home.best.id,away.best.id,{force,fixtureText,homeName:parsed.home,awayName:parsed.away});
  }catch(err){
    candidate={match:null,quota:null,checkedAt:isoNow(),errors:[String(err?.message||err)]};
  }
  let details=null, injuries={rows:[]}, transfers=[];
  if(candidate.match?.fixture?.id){
    try{details=await fixtureDetails(candidate.match.fixture.id,{force:true});}catch(err){warnings.push(`Fixture detail refresh unavailable: ${String(err?.message||err).slice(0,180)}`);details={match:candidate.match,quota:candidate.quota,checkedAt:candidate.checkedAt};}
    try{injuries=await fixtureInjuries(candidate.match.fixture.id,{force:true});}catch(err){warnings.push(`Structured injuries unavailable: ${String(err?.message||err).slice(0,180)}`);injuries={rows:[],quota:null,checkedAt:isoNow()};}
  }else if(candidate.match){
    details={match:candidate.match,quota:candidate.quota,checkedAt:candidate.checkedAt};
    warnings.push("Exact fixture date was independently verified outside API-Football; structured fixture ID/injuries may remain unavailable.");
  }else{
    warnings.push("Exact fixture verification did not complete through API-Football head-to-head/date lookup.");
    for(const e of (candidate.errors||[]).slice(0,2))warnings.push(`Fixture lookup detail: ${e}`);
  }
  // A fresh Relearn round adds transfer activity so stale squad/player claims get another check.
  if(round>1){
    const tr=await Promise.allSettled([recentTransfers(home.best.id,{force:true}),recentTransfers(away.best.id,{force:true})]);
    const ht=tr[0].status==="fulfilled"?tr[0].value:{rows:[]},at=tr[1].status==="fulfilled"?tr[1].value:{rows:[]};
    if(tr[0].status==="rejected")warnings.push(`Home transfer refresh unavailable: ${String(tr[0].reason?.message||tr[0].reason).slice(0,160)}`);
    if(tr[1].status==="rejected")warnings.push(`Away transfer refresh unavailable: ${String(tr[1].reason?.message||tr[1].reason).slice(0,160)}`);
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
  if(!homeSquad.players.length)warnings.push(`Current structured squad returned 0 players for ${home.best.name}; web evidence must not be presented as an official squad list.`);
  if(!awaySquad.players.length)warnings.push(`Current structured squad returned 0 players for ${away.best.name}; web evidence must not be presented as an official squad list.`);
  if(!confirmedLineups) warnings.push("Confirmed starting XIs are not available yet; do not present a predicted XI as confirmed.");

  let status="VERIFIED";
  if(warnings.length || home.confidence<0.65 || away.confidence<0.65 || !fixture) status="CAUTION";
  if(home.confidence<0.42 || away.confidence<0.42) status="FAILED";

  return {
    status,
    checkedAt:isoNow(),
    requested:parsed,
    resolved:{
      home:{id:home.best.id,name:home.best.name,country:home.best.country,confidence:home.confidence,requested:home.requested,searchVariantsTried:home.searchVariantsTried},
      away:{id:away.best.id,name:away.best.name,country:away.best.country,confidence:away.confidence,requested:away.requested,searchVariantsTried:away.searchVariantsTried}
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
  if(!f?.date)return {mode:"UNKNOWN",bettingAllowed:false,researchAllowed:true,fixtureDate:"",reason:"Fixture kickoff time could not be verified. Betting/value conclusions are blocked, but evidence analysis may continue in research-only mode."};
  const status=String(f.status||"").toLowerCase(),now=Date.now();
  if(f.dateOnly){
    const fixtureDay=String(f.date).slice(0,10),today=zambiaDate(0);
    if(fixtureDay>today)return {mode:"PREMATCH_WEB_VERIFIED",bettingAllowed:true,researchAllowed:true,fixtureDate:f.date,verification:f.verification||"WEB",reason:`Future fixture date ${fixtureDay} was verified by multiple independent sources; exact kickoff clock time is not structured.`};
    if(fixtureDay===today)return {mode:"UNKNOWN",bettingAllowed:false,researchAllowed:true,fixtureDate:f.date,verification:f.verification||"WEB",reason:"The fixture date is verified as today, but the exact kickoff clock time is not verified. Betting/value conclusions remain blocked; research-only analysis may continue."};
    return {mode:"POST_MATCH_AUDIT",bettingAllowed:false,researchAllowed:false,fixtureDate:f.date,verification:f.verification||"WEB",reason:"The independently verified fixture date is already in the past. Post-match evidence cannot be used as a pre-match prediction."};
  }
  const kickoff=Date.parse(f.date),futureStatuses=["not started","ns","time to be defined","tbd","scheduled","timed","web-verified scheduled fixture"];
  const finished=/finished|match finished|\bft\b|after extra time|penalties/i.test(status),live=/first half|second half|halftime|extra time|penalt|live|in play/i.test(status);
  if(finished||live||(Number.isFinite(kickoff)&&kickoff<=now-5*60*1000))return {mode:finished?"POST_MATCH_AUDIT":"LIVE_OR_STARTED",bettingAllowed:false,researchAllowed:false,fixtureDate:f.date,reason:finished?"This fixture has already finished. Post-match evidence must not be used as if it were a pre-match prediction.":"This fixture has started or its verified kickoff has passed. New pre-match council/value analysis is blocked."};
  if(Number.isFinite(kickoff)&&kickoff>now)return {mode:"PREMATCH",bettingAllowed:true,researchAllowed:true,fixtureDate:f.date,reason:"Verified fixture is still in the future."};
  if(futureStatuses.some(s=>status.includes(s)))return {mode:"PREMATCH",bettingAllowed:true,researchAllowed:true,fixtureDate:f.date,reason:"Fixture status indicates it has not started."};
  return {mode:"UNKNOWN",bettingAllowed:false,researchAllowed:true,fixtureDate:f.date,reason:"Fixture timing/status is ambiguous. Betting/value conclusions are blocked; research-only analysis may continue."};
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
  // Prefer the original bookmaker/user club names for search so a bad structured alias cannot poison video retrieval.
  const home=gate?.requested?.home||gate?.resolved?.home?.name||"";
  const away=gate?.requested?.away||gate?.resolved?.away?.name||"";
  const freshness=round>1?"latest recent":"recent";
  return [
    `"${home}" football ${freshness} match highlights official site:youtube.com`,
    `"${away}" football ${freshness} match highlights official site:youtube.com`,
    `"${home}" football tactical highlights recent match site:youtube.com`,
    `"${away}" football tactical highlights recent match site:youtube.com`
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
  const homeName=gate?.requested?.home||gate?.resolved?.home?.name||"";
  const awayName=gate?.requested?.away||gate?.resolved?.away?.name||"";
  const all=[];

  const sportsPositive=/football|soccer|match|highlights|goal|league|cup|afc|champions|friendly|fc\b|united/i;
  const obviousNonSports=/music video|official video|trailer|movie|series|paramount\+|song|lyrics|album|vevo/i;

  for(const group of videoScout){
    for(const r of (group.results||[])){
      if(!isYoutubeUrl(r.url)) continue;
      const text=`${r.title||""} ${r.content||""}`;
      const homeHit=textMentionsTeam(text,homeName);
      const awayHit=textMentionsTeam(text,awayName);

      if(!homeHit&&!awayHit)continue;
      if(obviousNonSports.test(text) && !sportsPositive.test(text))continue;

      let side=homeHit&&awayHit?"both":homeHit?"home":"away";
      all.push({...r,side});
    }
  }

  const seen=new Set();
  const unique=all.filter(x=>{
    const k=youtubeVideoKey(x.url);
    if(seen.has(k))return false;
    seen.add(k);return true;
  }).sort((a,b)=>{
    const score=x=>{
      const t=`${x.title||""} ${x.content||""}`;
      return (/\bofficial\b/i.test(t)?3:0)+(/\bhighlights?\b/i.test(t)?3:0)+(/\bfootball\b|\bsoccer\b|\bleague\b|\bcup\b/i.test(t)?2:0);
    };
    return score(b)-score(a);
  });

  const picked=[];
  const takeSide=(side,n)=>{
    for(const v of unique){
      if(picked.length>=4)break;
      if((v.side===side||v.side==="both")&&!picked.includes(v)){
        picked.push(v);
        if(--n<=0)break;
      }
    }
  };
  takeSide("home",2);
  takeSide("away",2);
  for(const v of unique)if(picked.length<4&&!picked.includes(v))picked.push(v);
  return picked.slice(0,4);
}
async function reviewYoutubeHighlights(videos, gate){
  if(!videos.length){
    return {status:"UNAVAILABLE",reviewedAt:isoNow(),videos:[],summary:"No public YouTube highlight links were found by the scouting searches.",observations:[]};
  }
  if(!process.env.GEMINI_API_KEY||!providerCanCall("geminiVideo")){
    return {
      status:"PARTIAL",reviewedAt:isoNow(),
      videos:videos.map(v=>({title:v.title,url:v.url,side:v.side||"general"})),
      summary:"Video links were found, but Gemini video review is not configured.",
      observations:[],crossVideoPatterns:[],
      warning:"Do not treat linked highlights as reviewed footage unless status is COMPLETE.",
      errors:["GEMINI_API_KEY is not configured for direct YouTube visual review."]
    };
  }
  const key=process.env.GEMINI_API_KEY;
  const preferred=process.env.GEMINI_VIDEO_MODEL||process.env.GEMINI_MODEL||"gemini-3.8-flash";
  const models=[preferred,"gemini-3.7-flash","gemini-3.6-flash","gemini-3.5-flash-lite"]
    .filter((x,i,a)=>x&&a.indexOf(x)===i);
  const { GoogleGenAI }=await import("@google/genai");
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
 "observations":[{"url":"exact supplied URL","teamOrMatch":"...","evidence":["..."],"limitations":["..."],"usefulness":"HIGH|MEDIUM|LOW"}],
 "crossVideoPatterns":["..."],
 "warning":"Highlights are selective evidence and not a full-match sample."
}`;

  const input=[{type:"text",text:prompt},...videos.map(v=>({type:"video",uri:v.url}))];
  const errors=[];

  for(const model of models){
    try{
      const interaction=await withTimeout(ai.interactions.create({model,input}),AI_REQUEST_TIMEOUT_MS,`Gemini video ${model}`);
      const out=String(interaction.output_text||interaction.outputText||"").trim();
      const parsed=parseJsonObject(out,`Video model ${model}`);healProvider("geminiVideo");
      return {
        status:"COMPLETE",reviewedAt:isoNow(),modelUsed:model,
        videos:videos.map(v=>({title:v.title,url:v.url,side:v.side||"general"})),...parsed
      };
    }catch(err){
      const msg=String(err?.message||err||"");
      errors.push(`${model}: ${msg.slice(0,260)}`);
      if(!/429|quota|rate|limit|model|unsupported|invalid_request|resource_exhausted/i.test(msg))break;
      await sleep(900);
    }
  }

  if(errors.length)tripProvider("geminiVideo",errors.join(" | "));
  return {
    status:"PARTIAL",reviewedAt:isoNow(),
    videos:videos.map(v=>({title:v.title,url:v.url,side:v.side||"general"})),
    summary:"Video links were found, but no configured free Gemini video model completed the visual review.",
    observations:[],crossVideoPatterns:[],
    warning:"Do not treat linked highlights as reviewed footage unless status is COMPLETE.",
    errors:errors.slice(-4)
  };
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


function sleepMs(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function fetchWithTimeout(url,options={},timeoutMs=12000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{return await fetch(url,{...options,signal:controller.signal});}
  finally{clearTimeout(timer);}
}
function withTimeout(promise,timeoutMs=AI_REQUEST_TIMEOUT_MS,label="Operation"){
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{const err=new Error(`${label} timed out after ${Math.round(timeoutMs/1000)}s.`);err.code="ETIMEDOUT";reject(err);},timeoutMs);});
  return Promise.race([promise,timeout]).finally(()=>clearTimeout(timer));
}

function isPrivateHostname(host){
  const h=String(host||"").toLowerCase();
  if(!h||h==="localhost"||h==="::1"||h.endsWith(".local"))return true;
  if(/^127\./.test(h)||/^10\./.test(h)||/^169\.254\./.test(h)||/^192\.168\./.test(h))return true;
  const m=h.match(/^172\.(\d{1,3})\./);
  return Boolean(m && Number(m[1])>=16 && Number(m[1])<=31);
}
function safePublicUrl(raw){
  try{
    const u=new URL(raw);
    if(!["http:","https:"].includes(u.protocol)||isPrivateHostname(u.hostname))return null;
    return u;
  }catch{return null;}
}
function decodeDuckRedirect(href){
  try{
    const u=new URL(href,"https://duckduckgo.com");
    const x=u.searchParams.get("uddg");
    return x?decodeURIComponent(x):u.href;
  }catch{return href;}
}
function normalizeGoogleHref(href){
  try{
    const u=new URL(href,"https://www.google.com");
    if(u.pathname==="/url"){
      const q=u.searchParams.get("q");
      if(q)return q;
    }
    if(/^https?:/i.test(u.href) && !/google\./i.test(u.hostname))return u.href;
  }catch{}
  return "";
}
function simpleResult(title,url,content="",provider="web"){
  const u=safePublicUrl(url); if(!u)return null;
  return {title:String(title||u.hostname).trim(),url:u.href,content:String(content||"").trim(),score:null,published_date:"",provider};
}

async function googleHtmlSearch(query,maxResults=8){
  const usage=providerUsage.googleSearch||{};usage.calls=(usage.calls||0)+1;providerUsage.googleSearch=usage;
  try{
    const r=await fetchWithTimeout(`https://www.google.com/search?hl=en&num=${Math.min(10,maxResults)}&q=${encodeURIComponent(query)}`,{
      headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36","Accept-Language":"en-US,en;q=0.9"}
    },9000);
    const txt=await r.text(); if(!r.ok)throw new Error(`HTTP ${r.status}`);
    const $=cheerio.load(txt),out=[];
    $("a").each((_,el)=>{
      if(out.length>=maxResults)return;
      const a=$(el),href=normalizeGoogleHref(a.attr("href")||"");
      const title=(a.find("h3").text()||a.text()||"").trim();
      if(!href||title.length<3)return;
      const row=simpleResult(title,href,"","google");
      if(row&&!out.some(x=>x.url===row.url))out.push(row);
    });
    usage.success=(usage.success||0)+1;return out;
  }catch(err){usage.fail=(usage.fail||0)+1;usage.lastError=String(err?.message||err).slice(0,240);return [];}
}
function normalizeBingHref(href){
  try{
    const u=new URL(href,"https://www.bing.com");
    if(/(^|\.)bing\.com$/i.test(u.hostname)){
      let payload=u.searchParams.get("u")||"";
      if(payload){
        if(payload.startsWith("a1"))payload=payload.slice(2);
        try{
          const decoded=Buffer.from(payload.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf8");
          if(/^https?:\/\//i.test(decoded))return decoded;
        }catch{}
      }
    }
    return u.href;
  }catch{return href;}
}
async function bingHtmlSearch(query,maxResults=8){
  const usage=providerUsage.bingSearch||{};usage.calls=(usage.calls||0)+1;providerUsage.bingSearch=usage;
  try{
    const r=await fetchWithTimeout(`https://www.bing.com/search?count=${Math.min(10,maxResults)}&q=${encodeURIComponent(query)}`,{
      headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36","Accept-Language":"en-US,en;q=0.9"}
    },9000);
    const txt=await r.text(); if(!r.ok)throw new Error(`HTTP ${r.status}`);
    const $=cheerio.load(txt),out=[];
    $("li.b_algo").each((_,el)=>{
      if(out.length>=maxResults)return;
      const box=$(el),a=box.find("h2 a").first();
      const row=simpleResult(a.text().trim(),normalizeBingHref(a.attr("href")||""),box.find(".b_caption p").text().trim(),"bing");
      if(row&&!out.some(x=>x.url===row.url))out.push(row);
    });
    usage.success=(usage.success||0)+1;return out;
  }catch(err){usage.fail=(usage.fail||0)+1;usage.lastError=String(err?.message||err).slice(0,240);return [];}
}
async function duckDuckGoHtmlSearch(query,maxResults=8){
  const usage=providerUsage.duckduckgo||{};usage.calls=(usage.calls||0)+1;providerUsage.duckduckgo=usage;
  try{
    const r=await fetchWithTimeout("https://html.duckduckgo.com/html/",{
      method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36"},
      body:new URLSearchParams({q:query}).toString()
    },9000);
    const txt=await r.text(); if(!r.ok)throw new Error(`HTTP ${r.status}`);
    const $=cheerio.load(txt),out=[];
    $(".result").each((_,el)=>{
      if(out.length>=maxResults)return;
      const box=$(el),a=box.find(".result__a").first();
      const row=simpleResult(a.text().trim(),decodeDuckRedirect(a.attr("href")||""),box.find(".result__snippet").text().trim(),"duckduckgo");
      if(row&&!out.some(x=>x.url===row.url))out.push(row);
    });
    usage.success=(usage.success||0)+1;return out;
  }catch(err){usage.fail=(usage.fail||0)+1;usage.lastError=String(err?.message||err).slice(0,240);return [];}
}

function stableHash(s){
  let h=2166136261>>>0;for(const ch of String(s||"")){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}return (h>>>0).toString(16);
}
function sourceKind(url,title="",query=""){
  const d=sourceDomain(url),t=`${title} ${url}`.toLowerCase();
  if(/youtube\.com|youtu\.be/.test(d))return "video";
  if(/reddit\.com/.test(d))return "community";
  if(/(^|\.)x\.com$|twitter\.com|facebook\.com|instagram\.com|tiktok\.com/.test(d))return "social";
  if(/fifa\.com|uefa\.com|the-afc\.com|cafonline\.com|conmebol\.com|premierleague\.com|laliga\.com|bundesliga\.com|legaseriea\.it/.test(d))return "official";
  if(/\bofficial\b/.test(t)&&/football|soccer|fc\b|club|league|cup|team/.test(t))return "official-candidate";
  if(/espn|bbc|reuters|skysports|beinsports|goal\.com|theathletic/.test(d))return "news";
  if(/sofascore|flashscore|fotmob|whoscored|footystats|soccerway|worldfootball|transfermarkt/.test(d))return "stats";
  return "web";
}
function sourceReliability(kind){
  return ({official:95,"official-candidate":82,stats:80,news:76,video:65,community:48,social:45,web:58})[kind]||55;
}
function researchModeConfig(mode){
  const m=String(mode||"deep").toLowerCase();
  // Keep discovery broad, but cap expensive full-page DOM parsing so free Render
  // instances do not exhaust memory. The source inventory can still be large.
  if(m==="standard")return {name:"standard",maxTasks:14,providersPerTask:2,maxDiscovered:105,maxPerTask:6,maxOpened:24,minTasksBeforeSaturation:10,saturationWindow:4};
  if(m==="maximum")return {name:"maximum",maxTasks:32,providersPerTask:4,maxDiscovered:360,maxPerTask:10,maxOpened:72,minTasksBeforeSaturation:20,saturationWindow:7};
  return {name:"deep",maxTasks:24,providersPerTask:3,maxDiscovered:210,maxPerTask:8,maxOpened:48,minTasksBeforeSaturation:15,saturationWindow:5};
}
function makeResearchLedger(fixture,gate,round,mode="deep"){
  const home=gate?.requested?.home||gate?.resolved?.home?.name||"",away=gate?.requested?.away||gate?.resolved?.away?.name||"";
  const pair=`"${home}" "${away}"`,exact=`"${home}" vs "${away}"`,year=new Date().getUTCFullYear();
  const tasks=[
    ["fixture","Exact fixture/date/kickoff",`${exact} exact fixture date kickoff time ${year} official`],
    ["competition","Competition/round/venue",`${exact} competition round venue ${year}`],
    ["official_home","Home official news",`"${home}" official team news ${away} ${year}`],
    ["official_away","Away official news",`"${away}" official team news ${home} ${year}`],
    ["squad_home","Home current squad",`"${home}" current squad roster ${year}`],
    ["squad_away","Away current squad",`"${away}" current squad roster ${year}`],
    ["injuries","Injuries/suspensions",`${pair} injuries suspensions latest team news`],
    ["lineups","Likely/confirmed lineups",`${exact} lineup predicted confirmed starting XI`],
    ["transfers","Recent transfers",`${pair} transfers arrivals departures latest`],
    ["form5","Last 5 form",`${pair} last 5 matches results form`],
    ["form10","Last 10 form",`${pair} last 10 matches results form`],
    ["homeaway","Home/away splits",`"${home}" home form "${away}" away form statistics`],
    ["opponents","Opponent strength",`${pair} recent opponents strength similar opponents results`],
    ["goals","Goals/xG/chance quality",`${pair} goals xG expected goals big chances recent statistics`],
    ["shots","Shots/SOT",`${pair} shots shots on target recent statistics`],
    ["possession","Possession/territory",`${pair} possession territory passing recent statistics`],
    ["corners","Corners/crossing",`${pair} corners for against crosses width recent statistics`],
    ["cards","Cards/referee",`${exact} referee cards fouls bookings referee appointment`],
    ["tactics","Tactics",`${pair} tactical analysis pressing transitions set pieces counter attack`],
    ["rest","Rest/travel/fatigue",`${pair} rest days travel fatigue fixture congestion rotation`],
    ["motivation","Motivation/context",`${exact} qualification table pressure motivation preview`],
    ["h2h","Head-to-head",`${exact} head to head H2H recent meetings results`],
    ["weather","Venue/weather",`${exact} weather venue pitch conditions kickoff`],
    ["predictions","External predictions",`${exact} prediction preview Forebet PredictZ WinDrawWin FootyStats`],
    ["reddit","Reddit discussion",`site:reddit.com ${pair} football`],
    ["x","X/Twitter public posts",`site:x.com ${pair} football`],
    ["facebook","Facebook public pages",`site:facebook.com ${pair} football club`],
    ["youtube","YouTube",`site:youtube.com ${pair} football highlights`],
    ["local_media","Local/regional media",`${pair} local sports news preview ${year}`],
    ["counterevidence","Contradictory evidence",`${exact} upset risk weaknesses concerns preview`],
    ["market_thresholds","Threshold distributions",`${pair} over under goals corners cards exact line statistics`],
    ["press","Press conferences",`${pair} press conference coach quotes team news`]
  ];
  if(round>1)tasks.unshift(["late_team_news","Late team news",`${exact} latest update today injury lineup suspension`],["fresh_contradictions","Fresh contradictions",`${exact} latest conflicting reports team news`]);
  return tasks.slice(0,researchModeConfig(mode).maxTasks).map(([category,question,query],i)=>({id:`Q${String(i+1).padStart(2,"0")}`,category,question,query,status:"pending",domains:0,results:0}));
}
async function searchFleet(query,{providersPerTask=3,maxResultsPerProvider=7}={}){
  const providers=[];if(process.env.TAVILY_API_KEY)providers.push(["tavily",()=>tavilySearch(query)]);
  providers.push(["google",()=>googleHtmlSearch(query,maxResultsPerProvider)],["bing",()=>bingHtmlSearch(query,maxResultsPerProvider)],["duckduckgo",()=>duckDuckGoHtmlSearch(query,maxResultsPerProvider)]);
  const offset=parseInt(stableHash(query).slice(0,4),16)%Math.max(1,providers.length);
  const ordered=[...providers.slice(offset),...providers.slice(0,offset)].slice(0,Math.max(1,Math.min(providersPerTask,providers.length)));
  const settled=await Promise.allSettled(ordered.map(async([name,fn])=>({name,rows:await fn()})));
  return settled.map((s,i)=>{
    const name=ordered[i]?.[0]||"search";
    if(s.status==="fulfilled")return {provider:name,results:(s.value.rows||[]).map(x=>({...x,provider:x.provider||name}))};
    return {provider:name,results:[],error:String(s.reason?.message||s.reason||"Search provider failed")};
  });
}
async function readResponseTextLimited(response,maxBytes=420000){
  if(!response.body||typeof response.body.getReader!=="function"){
    const text=await response.text();
    return text.length>maxBytes?text.slice(0,maxBytes):text;
  }
  const reader=response.body.getReader();
  const decoder=new TextDecoder();
  let total=0,out="";
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      if(!value)continue;
      const remaining=maxBytes-total;
      if(remaining<=0){try{await reader.cancel();}catch{}break;}
      const chunk=value.length>remaining?value.slice(0,remaining):value;
      total+=chunk.length;
      out+=decoder.decode(chunk,{stream:true});
      if(total>=maxBytes){try{await reader.cancel();}catch{}break;}
    }
    out+=decoder.decode();
    return out;
  }finally{
    try{reader.releaseLock();}catch{}
  }
}

async function readPublicPage(url){
  const usage=providerUsage.pageReader||{};usage.calls=(usage.calls||0)+1;providerUsage.pageReader=usage;
  const u=safePublicUrl(url);if(!u)return {ok:false,url,error:"Unsafe or unsupported URL."};
  try{
    const r=await fetchWithTimeout(u.href,{headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36","Accept":"text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.3","Accept-Language":"en-US,en;q=0.9"},redirect:"follow"},12000);
    const ctype=String(r.headers.get("content-type")||"").toLowerCase();
    if(!r.ok)throw new Error(`HTTP ${r.status}`);
    if(!/text\/html|application\/xhtml|text\/plain/.test(ctype))return {ok:false,url:u.href,error:`Unsupported content type ${ctype||"unknown"}`};
    let txt=await readResponseTextLimited(r,420000);
    let title="",body="";
    if(/html/.test(ctype)||/<html/i.test(txt)){const $=cheerio.load(txt);$("script,style,noscript,svg,canvas,iframe,form,nav,footer").remove();title=($("title").first().text()||$("h1").first().text()||u.hostname).replace(/\s+/g," ").trim();body=$("article").text()||$("main").text()||$("body").text();}
    else{title=u.hostname;body=txt;}
    body=String(body||"").replace(/\s+/g," ").trim();if(body.length>8000)body=body.slice(0,8000);
    usage.success=(usage.success||0)+1;return {ok:body.length>120,url:u.href,title,content:body,contentLength:body.length};
  }catch(err){usage.fail=(usage.fail||0)+1;usage.lastError=String(err?.message||err).slice(0,240);return {ok:false,url:u.href,error:String(err?.message||err)};}
}
function contentFingerprint(text){return stableHash(String(text||"").toLowerCase().replace(/https?:\/\/\S+/g," ").replace(/[^a-z0-9 ]+/g," ").replace(/\s+/g," ").trim().slice(0,5000));}
function warehouseSummary(entries,ledger,mode,saturationReached){
  const relevant=entries.filter(x=>x.relevant!==false);
  const opened=relevant.filter(x=>x.opened).length,usable=relevant.filter(x=>x.usable).length;
  const domains=new Set(relevant.filter(x=>x.usable).map(x=>sourceDomain(x.url)).filter(Boolean));
  const families=new Set(relevant.filter(x=>x.usable).map(x=>x.fingerprint).filter(Boolean));
  const kinds={};for(const x of relevant.filter(x=>x.usable))kinds[x.kind]=(kinds[x.kind]||0)+1;
  return {mode,discovered:entries.length,opened,usable,independentDomains:domains.size,independentContentFamilies:families.size,duplicatesRemoved:Math.max(0,usable-families.size),pageErrors:relevant.filter(x=>x.openError).length,saturationReached:Boolean(saturationReached),kinds,ledgerComplete:ledger.filter(x=>x.status==="complete").length,ledgerPartial:ledger.filter(x=>x.status==="partial").length,ledgerUnavailable:ledger.filter(x=>x.status==="unavailable").length};
}
async function buildResearchWarehouse({fixture,gate,round,mode="deep",progressId}){
  const cfg=researchModeConfig(mode),ledger=makeResearchLedger(fixture,gate,round,mode),byUrl=new Map(),providerLog=[],novelty=[],rejected=[];let saturationReached=false;
  const home=gate?.requested?.home||gate?.resolved?.home?.name||"";
  const away=gate?.requested?.away||gate?.resolved?.away?.name||"";
  for(let i=0;i<ledger.length;i++){
    const task=ledger[i];
    setResearchProgress(progressId,{percent:20+Math.round(((i+1)/ledger.length)*24),stage:"Research fleet",stageNumber:4,totalStages:12,message:`Research question ${i+1}/${ledger.length}: ${task.question}`});
    const beforeUrls=byUrl.size,beforeDomains=new Set([...byUrl.values()].filter(x=>x.relevant!==false).map(x=>sourceDomain(x.url))).size;
    const groups=await searchFleet(task.query,{providersPerTask:cfg.providersPerTask,maxResultsPerProvider:7});
    providerLog.push({taskId:task.id,category:task.category,query:task.query,groups});
    let addedForTask=0;
    for(const group of groups){
      for(const r of group.results||[]){
        if(addedForTask>=cfg.maxPerTask)break;
        if(!resultRelevantForTask(r,task,home,away)){
          rejected.push({title:r.title||r.url||"result",url:r.url||"",provider:r.provider||group.provider,query:task.query,category:task.category,reason:"Search result did not contain the required club identity tokens."});
          continue;
        }
        const u=safePublicUrl(r.url);if(!u)continue;
        const existing=byUrl.get(u.href),kind=sourceKind(u.href,r.title,task.query);
        const row=existing||{url:u.href,title:r.title||u.hostname,snippet:r.content||"",provider:r.provider||group.provider,discoveredBy:[],categories:[],opened:false,usable:false,relevant:true,kind,reliability:sourceReliability(kind)};
        if(!row.discoveredBy.includes(task.query))row.discoveredBy.push(task.query);
        if(!row.categories.includes(task.category))row.categories.push(task.category);
        if(!row.snippet&&r.content)row.snippet=r.content;
        if(!existing){
          if(byUrl.size>=cfg.maxDiscovered)continue;
          byUrl.set(u.href,row);addedForTask++;
        }else byUrl.set(u.href,row);
      }
    }
    const taskRows=[...byUrl.values()].filter(x=>x.categories.includes(task.category)&&x.relevant!==false);
    const domainCount=new Set(taskRows.map(x=>sourceDomain(x.url)).filter(Boolean)).size;
    task.results=taskRows.length;task.domains=domainCount;task.status=domainCount>=2?"complete":domainCount===1?"partial":"unavailable";
    const afterDomains=new Set([...byUrl.values()].filter(x=>x.relevant!==false).map(x=>sourceDomain(x.url))).size;
    novelty.push({urls:byUrl.size-beforeUrls,domains:afterDomains-beforeDomains});
    if(i+1>=cfg.minTasksBeforeSaturation&&novelty.length>=cfg.saturationWindow&&novelty.slice(-cfg.saturationWindow).every(x=>x.urls<=1&&x.domains===0)){saturationReached=true;break;}
  }
  const entries=[...byUrl.values()],picked=[],domainCounts=new Map();
  for(const x of entries.sort((a,b)=>b.reliability-a.reliability||b.categories.length-a.categories.length)){
    if(picked.length>=cfg.maxOpened)break;const d=sourceDomain(x.url)||"",n=domainCounts.get(d)||0;if(n>=4)continue;domainCounts.set(d,n+1);picked.push(x);
  }
  for(let i=0;i<picked.length;i+=2){
    const batch=picked.slice(i,i+2);
    setResearchProgress(progressId,{percent:45+Math.round((Math.min(i+2,picked.length)/Math.max(1,picked.length))*12),stage:"Page reading",stageNumber:5,totalStages:12,message:`Opening and reading source pages ${Math.min(i+2,picked.length)}/${picked.length}.`});
    const rows=await Promise.all(batch.map(x=>readPublicPage(x.url)));
    rows.forEach((r,j)=>{
      const x=batch[j];x.opened=true;
      if(r.ok){
        x.pageTitle=r.title||x.title;x.extractedText=r.content||"";x.contentLength=r.contentLength||0;
        const combined=`${x.pageTitle} ${x.extractedText} ${x.snippet||""} ${x.url}`;
        if(pageRelevantForCategories(combined,x.categories,home,away)){
          x.usable=true;x.relevant=true;x.fingerprint=contentFingerprint(x.extractedText||x.snippet);
        }else{
          x.usable=false;x.relevant=false;x.rejectionReason="Opened page did not confirm the required club identity.";
          rejected.push({title:x.pageTitle||x.title,url:x.url,provider:x.provider,query:(x.discoveredBy||[])[0]||"",category:(x.categories||[]).join(","),reason:x.rejectionReason});
        }
      }else{
        x.openError=r.error||"Unreadable page";
        const fallback=String(x.snippet||"").trim();
        if(fallback.length>60&&pageRelevantForCategories(`${x.title} ${fallback} ${x.url}`,x.categories,home,away)){
          x.usable=true;x.relevant=true;x.extractedText=fallback;x.fingerprint=contentFingerprint(fallback);
        }
      }
    });
  }
  for(const x of entries){
    if(!x.usable&&x.relevant!==false){
      const fallback=String(x.snippet||"").trim();
      if(fallback.length>80&&pageRelevantForCategories(`${x.title} ${fallback} ${x.url}`,x.categories,home,away)){
        x.usable=true;x.relevant=true;x.extractedText=fallback;x.fingerprint=contentFingerprint(fallback);
      }
    }
  }
  const summary=warehouseSummary(entries,ledger,cfg.name,saturationReached);
  summary.rejectedIrrelevant=rejected.length;summary.acceptedRelevant=entries.filter(x=>x.relevant!==false).length;
  return {mode:cfg.name,ledger,entries,rejected,providerLog,summary,createdAt:isoNow()};
}
function warehouseSources(warehouse,max=44){
  const seen=new Set(),out=[],ranked=(warehouse?.entries||[]).filter(x=>x.usable&&x.relevant!==false).sort((a,b)=>b.reliability-a.reliability||b.categories.length-a.categories.length||(b.contentLength||0)-(a.contentLength||0));
  for(const x of ranked){const family=x.fingerprint||x.url;if(seen.has(family))continue;seen.add(family);out.push({title:x.pageTitle||x.title||x.url,url:x.url,content:String(x.extractedText||x.snippet||"").slice(0,7000),score:x.reliability/100,published_date:"",provider:x.provider,kind:x.kind,categories:x.categories});if(out.length>=max)break;}
  return out;
}
function fixtureEvidenceFromWarehouse(fixtureText,gate,warehouse){
  const home=gate?.requested?.home||"",away=gate?.requested?.away||"",rows=(warehouse?.entries||[]).filter(x=>x.usable&&x.relevant!==false),grouped=new Map();
  for(const x of rows){
    const txt=`${x.title||""} ${x.snippet||""} ${x.extractedText||""}`;if(!textMentionsTeam(txt,home)||!textMentionsTeam(txt,away))continue;
    const d=sourceDomain(x.url);if(!d)continue;
    for(const date of parseWebDateCandidates(txt)){if(!grouped.has(date))grouped.set(date,new Map());grouped.get(date).set(d,{date,domain:d,url:x.url,title:x.title,kickoffs:parseWebKickoffCandidates(txt,date),kind:x.kind,reliability:x.reliability});}
  }
  const now=Date.now()-6*3600*1000,candidates=[];
  for(const [date,m] of grouped){
    const day=Date.parse(date+"T12:00:00Z");if(!Number.isFinite(day)||day<now-24*3600*1000)continue;
    const sources=[...m.values()],kickGroups=new Map();
    for(const s of sources)for(const k of s.kickoffs||[]){const key=kickoffMinuteKey(k);if(!key)continue;if(!kickGroups.has(key))kickGroups.set(key,[]);kickGroups.get(key).push(s);}
    const kick=[...kickGroups.entries()].map(([key,rs])=>({key,rows:rs,domains:new Set(rs.map(x=>x.domain)).size,reliability:Math.max(...rs.map(x=>x.reliability||0))})).sort((a,b)=>b.domains-a.domains||b.reliability-a.reliability)[0]||null;
    candidates.push({date,sources,domains:m.size,kickoff:kick?.rows?.[0]?.kickoffs?.find(x=>kickoffMinuteKey(x)===kick.key)||"",kickoffDomains:kick?.domains||0,bestReliability:Math.max(...sources.map(x=>x.reliability||0))});
  }
  return candidates.sort((a,b)=>b.domains-a.domains||b.kickoffDomains-a.kickoffDomains||b.bestReliability-a.bestReliability)[0]||null;
}
function upgradeGateWithWarehouse(gate,fixtureText,warehouse){
  if(gate?.fixture?.date&&gate?.fixture?.timestamp)return gate;
  const e=fixtureEvidenceFromWarehouse(fixtureText,gate,warehouse);if(!e||e.domains<2)return gate;
  const exact=Boolean(e.kickoff)&&(e.kickoffDomains>=2||e.bestReliability>=90);
  const home=gate?.requested?.home||gate?.resolved?.home?.name||"Home",away=gate?.requested?.away||gate?.resolved?.away?.name||"Away";
  const syn=syntheticWebFixture({homeId:gate?.resolved?.home?.id||null,awayId:gate?.resolved?.away?.id||null,homeName:home,awayName:away,date:e.date,kickoff:exact?e.kickoff:"",sources:e.sources,confidence:exact?0.97:Math.min(0.94,0.78+e.domains*0.05),provider:exact?"WAREHOUSE_WEB_TIME":"WAREHOUSE_WEB_DATE"});
  const next={...gate};next.fixture={id:syn.fixture.id,date:syn.fixture.date,timestamp:syn.fixture.timestamp,status:syn.fixture.status?.long||"",statusShort:syn.fixture.status?.short||"",venue:"",city:"",league:"",round:"",verification:syn._verification,verificationConfidence:syn._verificationConfidence,verificationSources:syn._verificationSources,dateOnly:syn._dateOnly};next.status=exact?"VERIFIED":"CAUTION";next.checkedAt=isoNow();
  next.resolved=next.resolved||{};
  if(next.resolved.home)next.resolved.home={...next.resolved.home,name:home,confidence:Math.max(Number(next.resolved.home.confidence||0),0.95),identityVerification:"WEB_FIXTURE_CONSENSUS"};
  if(next.resolved.away)next.resolved.away={...next.resolved.away,name:away,confidence:Math.max(Number(next.resolved.away.confidence||0),0.95),identityVerification:"WEB_FIXTURE_CONSENSUS"};
  next.warnings=(next.warnings||[]).filter(x=>!/fixture verification did not complete|did not find this matchup|kickoff/i.test(String(x)));next.warnings.push(exact?`Exact kickoff independently verified from ${e.domains} web domain(s) in the research warehouse.`:`Fixture date independently verified from ${e.domains} web domain(s); exact kickoff clock time still needs confirmation.`);
  return next;
}

async function rescueExactKickoff({fixture,gate,warehouse,progressId}){
  const home=gate?.requested?.home||gate?.resolved?.home?.name||"";
  const away=gate?.requested?.away||gate?.resolved?.away?.name||"";
  const targetDate=String(gate?.fixture?.date||"").slice(0,10);
  if(!home||!away||!targetDate)return null;
  const querySet=[
    `"${home}" "${away}" "${targetDate}" kickoff UTC`,
    `"${home}" "${away}" "${targetDate}" start time`,
    `site:fotmob.com "${home}" "${away}"`,
    `site:aiscore.com "${home}" "${away}"`,
    `site:ogscore.com "${home}" "${away}"`
  ];
  const byUrl=new Map();
  for(let i=0;i<querySet.length;i++){
    if(progressId)setResearchProgress(progressId,{percent:57,stage:"Kickoff verification",stageNumber:5,totalStages:12,message:`Targeted kickoff verification ${i+1}/${querySet.length}: ${querySet[i].slice(0,110)}`});
    const groups=await searchFleet(querySet[i],{providersPerTask:4,maxResultsPerProvider:8});
    for(const g of groups)for(const r of g.results||[]){
      const txt=`${r.title||""} ${r.content||""} ${r.url||""}`;
      if(!strictTextMentionsTeam(txt,home)||!strictTextMentionsTeam(txt,away))continue;
      const u=safePublicUrl(r.url);if(!u)continue;
      if(!byUrl.has(u.href))byUrl.set(u.href,{...r,url:u.href,provider:r.provider||g.provider});
    }
  }
  for(const x of warehouse?.entries||[]){
    if(!x.usable||x.relevant===false)continue;
    const txt=`${x.title||""} ${x.snippet||""} ${x.extractedText||""} ${x.url||""}`;
    if(strictTextMentionsTeam(txt,home)&&strictTextMentionsTeam(txt,away))byUrl.set(x.url,{title:x.pageTitle||x.title,url:x.url,content:x.extractedText||x.snippet||"",provider:x.provider||"warehouse"});
  }
  const records=[];
  for(const c of [...byUrl.values()].slice(0,24)){
    let txt=`${c.title||""} ${c.content||""}`;
    let times=parseWebKickoffCandidates(txt,targetDate);
    if(!times.length){const p=await readPublicPage(c.url);if(p.ok){txt=`${p.title||""} ${p.content||""}`;if(strictTextMentionsTeam(txt,home)&&strictTextMentionsTeam(txt,away))times=parseWebKickoffCandidates(txt,targetDate);}}
    if(!times.length)continue;
    const domain=sourceDomain(c.url);
    for(const kickoff of times)records.push({kickoff,domain,url:c.url,title:c.title||"",reliability:sourceReliability(sourceKind(c.url,c.title||"","kickoff verification"))});
  }
  const groups=new Map();
  for(const r of records){const key=kickoffMinuteKey(r.kickoff);if(!key)continue;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
  const ranked=[...groups.entries()].map(([key,rows])=>({key,rows,domains:[...new Set(rows.map(x=>x.domain).filter(Boolean))],bestReliability:Math.max(0,...rows.map(x=>x.reliability||0))})).sort((a,b)=>b.domains.length-a.domains.length||b.bestReliability-a.bestReliability);
  const best=ranked[0];if(!best||best.domains.length<2)return null;
  return {kickoff:best.rows[0].kickoff,domains:best.domains,sources:best.rows,confidence:best.domains.length>=3?0.99:0.97,method:"TARGETED_KICKOFF_WEB_CONSENSUS"};
}
function applyKickoffRescueToGate(gate,rescue){
  if(!rescue?.kickoff)return gate;
  const next={...gate,fixture:{...(gate?.fixture||{})}};
  next.fixture.date=rescue.kickoff;next.fixture.timestamp=Math.floor(Date.parse(rescue.kickoff)/1000);next.fixture.dateOnly=false;
  next.fixture.verification="TARGETED_KICKOFF_WEB_CONSENSUS";next.fixture.verificationConfidence=rescue.confidence||0.97;next.fixture.verificationSources=rescue.sources||[];
  next.fixture.status=next.fixture.status||"Web-verified scheduled fixture";next.fixture.statusShort=next.fixture.statusShort||"WEB";next.status="VERIFIED";
  next.warnings=(next.warnings||[]).filter(x=>!/exact kickoff|clock time|kickoff/i.test(String(x)));next.warnings.push(`Exact kickoff verified by ${rescue.domains.length} independent web domains.`);
  return next;
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
  if(!process.env.TAVILY_API_KEY)return [];
  const usage=providerUsage.tavily||{};usage.calls=(usage.calls||0)+1;providerUsage.tavily=usage;
  try{
    const response=await fetchWithTimeout("https://api.tavily.com/search",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${process.env.TAVILY_API_KEY}`},body:JSON.stringify({query,search_depth:"basic",max_results:7,include_answer:false,include_raw_content:false})},10000);
    const text=await response.text();if(!response.ok)throw new Error(`Tavily search failed (${response.status}): ${text.slice(0,240)}`);
    const data=parseHttpJson(text,"Tavily Search");usage.success=(usage.success||0)+1;
    return (data.results||[]).map(r=>({title:r.title||"",url:r.url||"",content:r.content||"",score:typeof r.score==="number"?r.score:null,published_date:r.published_date||"",provider:"tavily"}));
  }catch(err){usage.fail=(usage.fail||0)+1;usage.lastError=String(err?.message||err).slice(0,240);return [];}
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



function deterministicDataEngine({fixture,gate,sources,videoReview,temporalGuard,researchWarehouse}){
  const domains=new Set((sources||[]).map(x=>sourceDomain(x.url)).filter(Boolean));
  const signals=[
    {key:"BTTS_YES",market:"Both Teams To Score — Yes",rx:[/both teams to score\s*(?:-|:)?\s*yes/i,/btts\s*(?:-|:)?\s*yes/i]},
    {key:"BTTS_NO",market:"Both Teams To Score — No",rx:[/both teams to score\s*(?:-|:)?\s*no/i,/btts\s*(?:-|:)?\s*no/i]},
    {key:"TOTAL_GOALS_OVER_2.5",market:"Over 2.5 Goals",rx:[/over\s*2\.5\s*(?:goals?)?/i,/more than\s*2\.5\s*goals/i]},
    {key:"TOTAL_GOALS_UNDER_2.5",market:"Under 2.5 Goals",rx:[/under\s*2\.5\s*(?:goals?)?/i,/fewer than\s*2\.5\s*goals/i]},
    {key:"TOTAL_GOALS_OVER_1.5",market:"Over 1.5 Goals",rx:[/over\s*1\.5\s*(?:goals?)?/i]},
    {key:"TOTAL_GOALS_UNDER_3.5",market:"Under 3.5 Goals",rx:[/under\s*3\.5\s*(?:goals?)?/i]},
    {key:"TOTAL_CORNERS_OVER_8.5",market:"Over 8.5 Corners",rx:[/over\s*8\.5\s*corners?/i]},
    {key:"TOTAL_CORNERS_OVER_9.5",market:"Over 9.5 Corners",rx:[/over\s*9\.5\s*corners?/i]},
    {key:"TOTAL_CORNERS_UNDER_10.5",market:"Under 10.5 Corners",rx:[/under\s*10\.5\s*corners?/i]}
  ];
  const rows=[];
  for(const sig of signals){
    const ds=new Set(),refs=[];let mentions=0;
    for(const src of (sources||[])){
      const text=`${src.title||""} ${src.content||""}`;
      if(sig.rx.some(rx=>rx.test(text))){
        mentions++;const d=sourceDomain(src.url);if(d)ds.add(d);refs.push(src.url);
      }
    }
    if(mentions){
      const support=Math.min(95,30+ds.size*14+mentions*4);
      rows.push({canonicalMarketKey:sig.key,market:sig.market,supportScore:support,mentions,supportingDomains:ds.size,sourceUrls:refs.slice(0,5)});
    }
  }
  rows.sort((a,b)=>b.supportScore-a.supportScore||b.supportingDomains-a.supportingDomains);
  const identityScore=Math.round((((gate?.resolved?.home?.confidence||0)+(gate?.resolved?.away?.confidence||0))/2)*100);
  const fixtureScore=gate?.fixture?(gate.fixture.verification==="API_FOOTBALL"?100:Math.round((gate.fixture.verificationConfidence||0.8)*100)):0;
  const squadCounts=[gate?.squads?.home?.count||0,gate?.squads?.away?.count||0];
  const apiSquadScore=Math.min(100,Math.round((Math.min(30,squadCounts[0])+Math.min(30,squadCounts[1]))/60*100));
  const whEntries=(researchWarehouse?.entries||[]).filter(x=>x.usable&&x.relevant!==false);
  const webHomeSquadDomains=new Set(whEntries.filter(x=>(x.categories||[]).includes("squad_home")).map(x=>sourceDomain(x.url)).filter(Boolean)).size;
  const webAwaySquadDomains=new Set(whEntries.filter(x=>(x.categories||[]).includes("squad_away")).map(x=>sourceDomain(x.url)).filter(Boolean)).size;
  const webSquadScore=Math.min(90,(webHomeSquadDomains?35+Math.min(10,(webHomeSquadDomains-1)*5):0)+(webAwaySquadDomains?35+Math.min(10,(webAwaySquadDomains-1)*5):0));
  const squadScore=Math.max(apiSquadScore,webSquadScore);
  const diversityScore=Math.min(100,domains.size*8);
  const videoScore=videoReview?.status==="COMPLETE"?70:videoReview?.videos?.length?20:0;
  const overall=Math.round(identityScore*.20+fixtureScore*.25+squadScore*.20+diversityScore*.25+videoScore*.10);
  const strongest=rows[0]||null;
  return {
    engine:"LOCAL_DETERMINISTIC_V1",fixture,checkedAt:isoNow(),overallDataScore:overall,
    identityScore,fixtureVerificationScore:fixtureScore,squadCoverageScore:squadScore,sourceDiversityScore:diversityScore,videoSupportScore:videoScore,
    sourceDomains:domains.size,explicitMarketSignals:rows,
    strongestSignal:strongest,
    signalUsable:Boolean(temporalGuard?.bettingAllowed&&strongest&&strongest.supportingDomains>=3&&strongest.supportScore>=72),
    note:strongest?(strongest.supportingDomains>=2?"Signals count only explicit market wording found across independent source domains; they are not substitutes for full statistical distributions.":"An exact-market phrase was found on only one independent domain, so it is a weak single-source mention rather than multi-source evidence."):"No repeated explicit exact-market wording was detected across the gathered source snippets."
  };
}
function deterministicCouncilMember(payload){
  const e=payload.dataEngine||deterministicDataEngine(payload);
  const usable=e.signalUsable&&e.strongestSignal;
  return {
    provider:"Local",modelName:"Deterministic Statistical Engine",modelId:"local:deterministic-v1",available:true,brainType:"deterministic-engine",
    primaryMarket:usable?e.strongestSignal.market:"UNRESOLVED",
    canonicalMarketKey:usable?e.strongestSignal.canonicalMarketKey:"UNRESOLVED",
    marketFamily:usable?"Explicit multi-source market signal":"Data quality",
    fairProbabilityPct:null,confidence:usable?"MEDIUM":"LOW",classification:usable?"MEDIUM":"UNRESOLVED / HIGH RISK",
    strongestReasons:usable?[`${e.strongestSignal.supportingDomains} independent source domains explicitly referenced this exact market wording.`,`Local data score ${e.overallDataScore}/100.`]:[`Local data score ${e.overallDataScore}/100.`,`No deterministic market signal passed the multi-source threshold.`],
    counterEvidence:["This engine does not infer xG, tactical quality or hidden statistics from text snippets."],topAlternatives:[],dataWeaknesses:[e.note],antiBiasCheck:"No bookmaker odds or user market were used."
  };
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
function semanticCanonicalMarket(s){
  const raw=String(s||"").trim(),k=canonicalKey(raw);
  if(!raw||/UNRESOLVED|NO_PRE_MATCH|NO_BET|NONE/.test(k))return k||"UNRESOLVED";
  const t=raw.toLowerCase().replace(/[—–]/g,"-");
  if(/\bbtts\b/.test(t)||/both teams to score/.test(t))return /\bno\b/.test(t)?"BTTS_NO":"BTTS_YES";
  let m=t.match(/over\s*(\d+(?:\.\d+)?)/);if(m&&/goal/.test(t))return `TOTAL_GOALS_OVER_${m[1]}`;
  m=t.match(/under\s*(\d+(?:\.\d+)?)/);if(m&&/goal/.test(t))return `TOTAL_GOALS_UNDER_${m[1]}`;
  m=t.match(/over\s*(\d+(?:\.\d+)?)/);if(m&&/corner/.test(t))return `TOTAL_CORNERS_OVER_${m[1]}`;
  m=t.match(/under\s*(\d+(?:\.\d+)?)/);if(m&&/corner/.test(t))return `TOTAL_CORNERS_UNDER_${m[1]}`;
  if(/home.*or.*draw|\b1x\b|home double chance/.test(t))return "HOME_DOUBLE_CHANCE_1X";
  if(/away.*or.*draw|\bx2\b|away double chance/.test(t))return "AWAY_DOUBLE_CHANCE_X2";
  if(/draw no bet/.test(t)&&/home/.test(t))return "HOME_DNB";
  if(/draw no bet/.test(t)&&/away/.test(t))return "AWAY_DNB";
  return k;
}
function councilEvidencePack({fixture,gate,sources,videoReview,fallbackEvidence,dataEngine}){
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
    canonicalMarketKey:unresolved?"UNRESOLVED":semanticCanonicalMarket(obj?.canonicalMarketKey||obj?.primaryMarket||"UNRESOLVED"),
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
  normalized.retryAttempt=result.attempt;normalized.modelId=result.model;normalized.brainType="unique-model";
  return normalized;
}
async function groqCouncilMember(payload,model,display,specialistRole=""){
  const key=requireEnv("GROQ_API_KEY");
  const response=await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions",{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${key}`},
    body:JSON.stringify({model,temperature:0.2,max_completion_tokens:3500,messages:[{role:"user",content:councilPrompt({...payload,specialistRole})}]})
  },AI_REQUEST_TIMEOUT_MS);
  const txt=await response.text();
  if(!response.ok)throw new Error(`${display} council failed (${response.status}): ${txt.slice(0,260)}`);
  const d=parseHttpJson(txt,display);
  const out=normalizeCouncilResult("Groq",display,parseJsonObject(d.choices?.[0]?.message?.content||"",display));
  out.modelId=model;out.specialistRole=specialistRole||"General independent analyst";out.brainType=specialistRole?"specialist-agent":"unique-model";
  healProvider("groq");return out;
}
async function cloudflareCouncilMember(payload){
  const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_AUTH_TOKEN;
  if(!account||!token)throw new Error("Cloudflare AI is not configured.");
  const model=payload?._cfModel||process.env.CLOUDFLARE_LLAMA_MODEL||"@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const response=await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${model}`,{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`},
    body:JSON.stringify({messages:[{role:"user",content:councilPrompt(payload)}],temperature:0.2,max_tokens:3500})
  },AI_REQUEST_TIMEOUT_MS);
  const txt=await response.text();
  if(!response.ok)throw new Error(`Meta Llama council failed (${response.status}): ${txt.slice(0,260)}`);
  const d=parseHttpJson(txt,"Cloudflare Council");
  const out=d.result?.response ?? d.result?.text ?? d.result?.output_text ?? d.result ?? "";
  const display=payload?._cfName||"Meta Llama";
  const normalized=normalizeCouncilResult("Cloudflare",display,parseJsonObject(typeof out==="string"?out:JSON.stringify(out),display));
  normalized.modelId=model;normalized.specialistRole=payload?.specialistRole||"General independent analyst";normalized.brainType=payload?.specialistRole?"specialist-agent":"unique-model";healProvider("cloudflare");
  return normalized;
}
async function openRouterCouncilMember(payload){
  const key=requireEnv("OPENROUTER_API_KEY");
  const model=process.env.OPENROUTER_COUNCIL_MODEL||"openrouter/free";
  const response=await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions",{
    method:"POST",
    headers:{
      "Content-Type":"application/json","Authorization":`Bearer ${key}`,
      "HTTP-Referer":process.env.APP_PUBLIC_URL||"https://localhost/",
      "X-Title":"Football Fact-First Research"
    },
    body:JSON.stringify({model,temperature:0.2,max_tokens:3500,messages:[{role:"user",content:councilPrompt(payload)}]})
  },AI_REQUEST_TIMEOUT_MS);
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
function aggregateVoteRows(rows){
  const available=rows.filter(x=>x.available);
  const resolved=available.filter(x=>x.canonicalMarketKey&&x.canonicalMarketKey!=="UNRESOLVED");
  const groups=new Map();
  for(const r of resolved){const k=semanticCanonicalMarket(r.canonicalMarketKey||r.primaryMarket);if(!groups.has(k))groups.set(k,[]);groups.get(k).push({...r,canonicalMarketKey:k});}
  const ranked=[...groups.entries()].map(([key,members])=>({
    canonicalMarketKey:key,market:members[0]?.primaryMarket||key,count:members.length,
    models:members.map(x=>x.modelName),medianFairProbabilityPct:median(members.map(x=>Number(x.fairProbabilityPct)).filter(Number.isFinite))
  })).sort((a,b)=>b.count-a.count||(b.medianFairProbabilityPct||0)-(a.medianFairProbabilityPct||0));
  const top=ranked[0]||null,total=available.length||1,share=top?top.count/total:0;
  let convergence="NONE";
  if(available.length<2)convergence="INSUFFICIENT";
  else if(top?.count>=3&&share>=0.60)convergence="HIGH";
  else if(top?.count>=2&&share>=0.40)convergence="MEDIUM";
  else if(top?.count>=2)convergence="LOW";
  return {available:available.length,resolved:resolved.length,convergence,top,ranked,share};
}
function uniqueModelRepresentatives(results){
  const byModel=new Map();
  for(const r of results.filter(x=>x.available)){
    const key=`${r.provider}:${r.modelId||r.modelName}`;
    if(!byModel.has(key))byModel.set(key,[]);byModel.get(key).push(r);
  }
  const reps=[];
  for(const [key,rows] of byModel){
    const vote=aggregateVoteRows(rows);
    if(!vote.top){reps.push({...rows[0],canonicalMarketKey:"UNRESOLVED",primaryMarket:"UNRESOLVED",modelName:key});continue;}
    reps.push({...rows[0],canonicalMarketKey:vote.top.canonicalMarketKey,primaryMarket:vote.top.market,fairProbabilityPct:vote.top.medianFairProbabilityPct,modelName:key});
  }
  return reps;
}
function aggregateCouncil(results){
  // AI Council consensus is computed from AI models only. The local deterministic
  // checker is reported separately and never masquerades as an independent AI vote.
  const available=results.filter(x=>x.available && x.brainType!=="deterministic-engine");
  const modelReps=uniqueModelRepresentatives(available);
  const unique=aggregateVoteRows(modelReps);
  const consensusAllowed=unique.available>=COUNCIL_MIN_MODELS&&unique.top?.count>=2;
  return {
    availableModels:available.length,
    uniqueUnderlyingModels:modelReps.length,
    unresolvedModels:available.filter(x=>x.canonicalMarketKey==="UNRESOLVED").length,
    convergence:unique.available<COUNCIL_MIN_MODELS?"INSUFFICIENT":unique.convergence,
    consensusMarket:consensusAllowed?(unique.top?.market||"NO CONSENSUS"):"NO COUNCIL CONSENSUS",
    consensusCanonicalKey:consensusAllowed?(unique.top?.canonicalMarketKey||""):"",
    leadingSingleModelMarket:unique.available===1?(unique.top?.market||"UNRESOLVED"):"",
    modelsAgreeing:consensusAllowed?(unique.top?.models||[]):[],
    medianFairProbabilityPct:consensusAllowed?(unique.top?.medianFairProbabilityPct??null):null,
    groups:unique.ranked,
    agentConsensus:{convergence:unique.convergence,availableAgents:unique.available,share:unique.share,market:unique.top?.market||"NO CONSENSUS",count:unique.top?.count||0},
    uniqueModelConsensus:{convergence:unique.convergence,uniqueModels:unique.available,share:unique.share,market:unique.top?.market||"NO CONSENSUS",count:unique.top?.count||0},
    note:unique.available<COUNCIL_MIN_MODELS
      ? `Only ${unique.available} independent AI model vote(s) completed. At least ${COUNCIL_MIN_MODELS} are required for Council consensus.`
      : unique.top?`${unique.top.count} of ${unique.available} independent AI models selected the same canonical market.`:"No resolved market convergence was found."
  };
}

const SPECIALIST_ROLES=[
  "Current-squad authenticity auditor","Confirmed-lineup auditor","Injury and suspension impact analyst","Transfer and stale-roster auditor",
  "Opponent-strength adjusted form analyst","Last-five distribution analyst","Last-ten distribution analyst","Home/away split analyst",
  "Goals distribution analyst","Expected-goals and chance-quality analyst","Finishing sustainability analyst","Clean-sheet and concession analyst",
  "Total-shots analyst","Shots-on-target analyst","Shot-quality and blocked-shot analyst","Possession and territory analyst",
  "Wing-play and crossing analyst","Full-back involvement analyst","Total-corners analyst","Team-corners analyst","First-half corners analyst","Corner-handicap analyst",
  "Set-piece attack analyst","Set-piece defence analyst","Pressing-intensity analyst","Transition-attack analyst","Transition-defence analyst","Low-block breakdown analyst",
  "High-line vulnerability analyst","Central-midfield control analyst","Counter-press analyst","Goalkeeper impact analyst","Bench-depth analyst","Late-game substitute impact analyst",
  "First-half goals analyst","Second-half goals analyst","Team-goals analyst","BTTS analyst","Asian-handicap analyst","European-handicap analyst",
  "1X2 analyst","Double-chance analyst","Draw-no-bet analyst","Win-a-half analyst","Combination-market analyst","Exact-line threshold analyst",
  "Cards and team-cards analyst","Fouls analyst","Referee-tendency analyst","Discipline game-state analyst",
  "Rest and fixture-congestion analyst","Travel and venue analyst","Weather analyst","Motivation and competition-context analyst","Table-pressure analyst","Cup-leg aggregate-state analyst",
  "Underdog resistance analyst","Favourite vulnerability analyst","Lead-protection analyst","Comeback-state analyst","Scoreless-state analyst","Early-goal stress-test analyst",
  "Red-card stress-test analyst","Rotation stress-test analyst","Key-player absence stress-test analyst","Tactical-shape sensitivity analyst",
  "Historical H2H relevance auditor","Similar-opponent analyst","Opponent-quality distortion auditor","Small-sample auditor","Recency-weighting analyst","Data-conflict auditor",
  "Source-quality auditor","Stale-information auditor","Video-evidence tactical analyst","Highlight-selection bias auditor","Public-prediction contamination auditor",
  "Adversarial kill-the-pick analyst","Exact-opposite market analyst","Failure-set analyst","Probability calibration analyst","Conservative uncertainty analyst",
  "Market-family elimination analyst","Runner-up market analyst","No-bet threshold analyst","Independent synthesis auditor","Final anti-bias auditor"
];

async function openRouterFreeModels(){
  if(!process.env.OPENROUTER_API_KEY)return [];
  try{
    const r=await fetchWithTimeout("https://openrouter.ai/api/v1/models?max_price=0&output_modalities=text",{headers:{"Authorization":`Bearer ${process.env.OPENROUTER_API_KEY}`}},20000);
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
    const r=await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${key}`,"HTTP-Referer":process.env.APP_PUBLIC_URL||"https://localhost/","X-Title":"Football Fact-First Research"},
      body:JSON.stringify({model:modelId,temperature:0.2,max_tokens:1800,messages:[{role:"user",content:councilPrompt({...payload,specialistRole})}]})
    },AI_REQUEST_TIMEOUT_MS);
    const text=await r.text();
    if(!r.ok)throw new Error(`${display} failed (${r.status}): ${text.slice(0,220)}`);
    const d=parseHttpJson(text,"OpenRouter Chat");
    const out=normalizeCouncilResult("OpenRouter",display,parseJsonObject(d.choices?.[0]?.message?.content||"",display));
    out.modelId=d.model||modelId;out.modelName=(d.model&&modelId==="openrouter/free")?`OpenRouter Free → ${d.model}`:display;
    out.specialistRole=specialistRole||"General independent analyst";out.brainType=specialistRole?"specialist-agent":"unique-model";
    usageOk("openrouter");healProvider("openrouter");return out;
  }catch(err){usageFail("openrouter",err);throw err;}
}
async function geminiSpecialistMember(payload,role,index){
  const result=await geminiTextWithRetry({
    prompt:councilPrompt({...payload,specialistRole:role}),
    maxOutputTokens:2200,responseMimeType:"application/json",
    preferredModel:process.env.GEMINI_COUNCIL_MODEL||process.env.GEMINI_MODEL||"gemini-3.8-flash"
  });
  const out=normalizeCouncilResult("Google",`Gemini Specialist ${index+1}`,parseJsonObject(result.output,"Gemini specialist"));
  out.specialistRole=role;out.brainType="specialist-agent";out.modelId=result.model;
  return out;
}
async function runInBatches(jobs,batchSize=5){
  const results=[];
  for(let i=0;i<jobs.length;i+=batchSize){
    const chunk=jobs.slice(i,i+batchSize);
    const settled=await Promise.allSettled(chunk.map(j=>{
      if(j.healthName&&!providerCanCall(j.healthName))return Promise.reject(new Error(`${j.healthName} provider circuit is ${providerHealth[j.healthName]?.state||"blocked"}; skipped during cooldown.`));
      return j.run();
    }));
    settled.forEach((x,k)=>{
      const j=chunk[k];
      if(x.status==="fulfilled")results.push(x.value);
      else{
        if(j.healthName)tripProvider(j.healthName,x.reason);
        results.push({provider:j.provider,modelName:j.name,modelId:j.modelId,available:false,specialistRole:j.role||"",brainType:j.brainType||"",error:String(x.reason?.message||x.reason||"Brain failed")});
      }
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
    specialistAgents:available.filter(x=>x.brainType==="specialist-agent").length,
    deterministicEngines:available.filter(x=>x.brainType==="deterministic-engine").length,
    quotaSkipped:members.filter(x=>x.available===false&&/quota|rate|cooldown|blocked/i.test(String(x.error||""))).length
  };
}

async function runAiCouncil(payload,{targetSize=4,existingMembers=[]}={}){
  const target=Math.max(COUNCIL_MIN_MODELS,Math.min(COUNCIL_MAX_MODELS,Number(targetSize||4)));
  const jobs=[];
  const existingAi=(existingMembers||[]).filter(x=>x.brainType!=="deterministic-engine");
  const used=new Set(existingAi.map(x=>`${x.provider}:${x.modelId||x.modelName}:${x.specialistRole||""}`));
  const add=(job)=>{const key=`${job.provider}:${job.modelId||job.name}:${job.role||""}`;if(!used.has(key)){used.add(key);jobs.push(job);}};

  // Independent models first. This is the real Council.
  if(process.env.OPENROUTER_API_KEY&&providerCanCall("openrouter")){
    const freeModels=await openRouterFreeModels();
    for(const fm of freeModels.slice(0,COUNCIL_MAX_MODELS))
      add({provider:"OpenRouter",name:fm.name,modelId:fm.id,brainType:"unique-model",healthName:"openrouter",run:()=>openRouterSpecificCouncilMember(payload,fm.id,fm.name)});
  }
  if(process.env.GROQ_API_KEY&&providerCanCall("groq")){
    for(const [modelId,name] of [["openai/gpt-oss-120b","OpenAI GPT-OSS 120B"],["openai/gpt-oss-20b","OpenAI GPT-OSS 20B"],["qwen/qwen3.8-27b","Qwen 3.8 27B"]])
      add({provider:"Groq",name,modelId,brainType:"unique-model",healthName:"groq",run:()=>groqCouncilMember(payload,modelId,name)});
  }
  if(process.env.CLOUDFLARE_ACCOUNT_ID&&process.env.CLOUDFLARE_AUTH_TOKEN&&providerCanCall("cloudflare")){
    for(const [modelId,name] of [[process.env.CLOUDFLARE_LLAMA_MODEL||"@cf/meta/llama-3.3-70b-instruct-fp8-fast","Cloudflare AI"]])
      add({provider:"Cloudflare",name,modelId,brainType:"unique-model",healthName:"cloudflare",run:()=>cloudflareCouncilMember({...payload,_cfModel:modelId,_cfName:name})});
  }
  if(process.env.GEMINI_API_KEY&&providerCanCall("geminiText")){
    const configuredModel=process.env.GEMINI_COUNCIL_MODEL||process.env.GEMINI_MODEL||"gemini-3.8-flash";
    add({provider:"Google",name:`Gemini ${configuredModel}`,modelId:configuredModel,brainType:"unique-model",healthName:"geminiText",run:()=>geminiCouncilMember(payload)});
  }

  let members=[...existingAi],cursor=0,stoppedEarly=false,stopReason="";
  const waveSize=3;
  while(members.length<target && cursor<jobs.length){
    const needed=Math.min(waveSize,target-members.length);
    const wave=jobs.slice(cursor,cursor+needed);cursor+=needed;
    const fresh=await runInBatches(wave,3);members.push(...fresh);
    const agg=aggregateCouncil(members);
    const uc=agg.uniqueModelConsensus||{};
    if(members.length>=3 && uc.uniqueModels>=3 && uc.convergence==="HIGH" && uc.share>=0.67){
      stoppedEarly=true;stopReason="Adaptive stop: at least 3 independent AI models reached strong agreement.";break;
    }
    if(cursor<jobs.length&&members.length<target)await sleep(500);
  }

  const statisticalChecker=deterministicCouncilMember(payload);
  const counts=councilSummaryCounts(members),aggregation=aggregateCouncil(members);
  return {
    checkedAt:isoNow(),requestedIndependentModels:target,requestedAgentSeats:target,members,counts,aggregation,
    statisticalChecker,stoppedEarly,stopReason,providerHealth:providerHealthSnapshot(),
    councilReady:aggregation.uniqueUnderlyingModels>=COUNCIL_MIN_MODELS,
    minimumIndependentModels:COUNCIL_MIN_MODELS,
    warning:aggregation.uniqueUnderlyingModels<COUNCIL_MIN_MODELS
      ? `Council not independently verified: ${aggregation.uniqueUnderlyingModels} independent AI model(s) completed; ${COUNCIL_MIN_MODELS} required.`
      : "Council consensus uses independent underlying AI models only; the statistical checker is separate."
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
function localBenchmarkPrediction(payload){
  const text=String(payload?.content||"").replace(/\s+/g," ").trim();
  const scope=`${payload?.title||""} ${payload?.url||""} ${text}`;
  const fixtureMatched=strictTextMentionsTeam(scope,payload?.home||"")&&strictTextMentionsTeam(scope,payload?.away||"");
  if(!fixtureMatched)return {fixtureMatched:false,predictionAvailable:false};

  const expected=String(payload?.expectedDate||"").slice(0,10);
  const expectedYear=expected.slice(0,4);
  const hasExpected=!expected||scope.includes(expected)||scope.includes(expected.split("-").reverse().join("/"))||scope.includes(expected.split("-").reverse().join("-"))||(expectedYear&&scope.includes(expectedYear));
  const stale=expectedYear && /\b20\d{2}\b/.test(scope) && !hasExpected;
  if(stale)return {fixtureMatched:true,freshnessStatus:"STALE",predictionAvailable:false};

  const candidates=[];
  const add=(market,selection,key,index,raw)=>{if(!candidates.some(x=>x.canonicalMarketKey===key))candidates.push({market,selection,canonicalMarketKey:key,probabilityPct:null,correctScore:"",publishedOdds:"",_index:index,_raw:raw});};
  const patterns=[
    [/\b(?:prediction|tip|pick|selection|betting tip|recommended bet)\s*[:\-–—]?\s*(both teams to score\s*(?:-\s*)?yes|btts\s*yes)\b/i,"Both Teams To Score","Yes","BTTS_YES"],
    [/\b(?:prediction|tip|pick|selection|betting tip|recommended bet)\s*[:\-–—]?\s*(both teams to score\s*(?:-\s*)?no|btts\s*no)\b/i,"Both Teams To Score","No","BTTS_NO"],
    [/\b(?:prediction|tip|pick|selection|betting tip|recommended bet)\s*[:\-–—]?\s*(over\s*2\.5(?:\s*goals?)?)\b/i,"Total Goals","Over 2.5","TOTAL_GOALS_OVER_2.5"],
    [/\b(?:prediction|tip|pick|selection|betting tip|recommended bet)\s*[:\-–—]?\s*(under\s*2\.5(?:\s*goals?)?)\b/i,"Total Goals","Under 2.5","TOTAL_GOALS_UNDER_2.5"],
    [/\b(?:prediction|tip|pick|selection|betting tip|recommended bet)\s*[:\-–—]?\s*(home win|home team to win|1)\b/i,"1X2","Home Win","HOME_WIN"],
    [/\b(?:prediction|tip|pick|selection|betting tip|recommended bet)\s*[:\-–—]?\s*(away win|away team to win|2)\b/i,"1X2","Away Win","AWAY_WIN"],
    [/\b(?:prediction|tip|pick|selection|betting tip|recommended bet)\s*[:\-–—]?\s*(draw|x)\b/i,"1X2","Draw","DRAW"]
  ];
  for(const [rx,market,selection,key] of patterns){const m=rx.exec(text);if(m)add(market,selection,key,m.index,m[0]);}

  const scoreRx=/\b(?:correct score|predicted score|score prediction)\s*[:\-–—]?\s*(\d{1,2})\s*[-:]\s*(\d{1,2})\b/i;
  const sm=scoreRx.exec(text);if(sm){
    const score=`${sm[1]}-${sm[2]}`;
    candidates.push({market:"Correct Score",selection:score,canonicalMarketKey:`CORRECT_SCORE_${sm[1]}_${sm[2]}`,probabilityPct:null,correctScore:score,publishedOdds:"",_index:sm.index,_raw:sm[0]});
  }
  if(!candidates.length)return {fixtureMatched:true,freshnessStatus:hasExpected?"CURRENT":"UNKNOWN",predictionAvailable:false};

  candidates.sort((a,b)=>a._index-b._index);
  const primary={...candidates[0]};delete primary._index;delete primary._raw;
  const others=candidates.slice(1).map(x=>{const y={...x};delete y._index;delete y._raw;return y;});
  return {fixtureMatched:true,matchedFixture:`${payload.home} vs ${payload.away}`,fixtureDate:expected,freshnessStatus:hasExpected?"CURRENT":"UNKNOWN",predictionAvailable:true,primaryPrediction:primary,otherPredictions:others,explanationAvailable:false,rationaleSummary:[],sourceEvidenceSummary:"A labeled prediction was extracted directly from the readable source text by the local deterministic parser.",warnings:["No AI was required for this explicit labeled prediction. Source explanation is shown only when safely parsed separately."],parserModel:"LOCAL_EXPLICIT_PREDICTION_PARSER"};
}

async function parseBenchmarkPrediction(payload){
  const local=localBenchmarkPrediction(payload);
  if(local?.fixtureMatched&&local?.predictionAvailable&&local?.freshnessStatus!=="STALE")return local;
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
      fixtureMatched:Boolean(local?.fixtureMatched),
      freshnessStatus:String(local?.freshnessStatus||"UNKNOWN"),
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
  const queries=[`site:${domain} "${home}" "${away}" ${date||""} prediction`,`site:${domain} "${home}" "${away}" ${year} tip forecast`];
  let searchResults=[];
  for(const q of queries){
    const groups=await searchFleet(q,{providersPerTask:4,maxResultsPerProvider:8});
    for(const g of groups)for(const x of g.results||[])searchResults.push({...x,_query:q,_provider:g.provider});
  }
  const seen=new Set();
  searchResults=searchResults.filter(r=>{
    if(!r.url)return false;const d=sourceDomain(r.url);if(!d||(!d.endsWith(domain)&&d!==domain))return false;
    if(!strictTextMentionsTeam(`${r.title||""} ${r.content||""} ${r.url||""}`,home))return false;
    if(!strictTextMentionsTeam(`${r.title||""} ${r.content||""} ${r.url||""}`,away))return false;
    if(seen.has(r.url))return false;seen.add(r.url);return true;
  });
  const candidates=selectBenchmarkCandidates(searchResults,home,away,date);
  if(!candidates.length)return {name,domain,status:"NO_EXACT_FIXTURE_SOURCE",found:false,predictionAvailable:false,explanationAvailable:false,prediction:null,rationaleSummary:[],sourceUrl:"",sourceTitle:"",diagnostics:{queries,searchResultCount:searchResults.length}};

  for(const c of candidates.slice(0,4)){
    let pageContent=`${c.title}\n${c.content||""}`,extracted=false;
    const direct=await readPublicPage(c.url);
    if(direct.ok&&strictTextMentionsTeam(`${direct.title} ${direct.content}`,home)&&strictTextMentionsTeam(`${direct.title} ${direct.content}`,away)){
      pageContent=`${direct.title}\n${direct.content}`;extracted=true;
    }else{
      try{const tv=await tavilyExtractUrl(c.url,`${home} vs ${away} ${date||""} prediction correct score 1X2 BTTS over under probability explanation`);if(tv.ok&&tv.content){pageContent=tv.content;extracted=true;}}catch{}
    }
    const parsed=await parseBenchmarkPrediction({siteName:name,home,away,expectedDate:date,url:c.url,title:c.title,content:pageContent});
    if(parsed.fixtureMatched&&parsed.predictionAvailable&&parsed.freshnessStatus!=="STALE"){
      if(parsed.primaryPrediction)parsed.primaryPrediction.canonicalMarketKey=semanticCanonicalMarket(parsed.primaryPrediction.canonicalMarketKey||parsed.primaryPrediction.market||parsed.primaryPrediction.selection);
      return {name,domain,status:"PREDICTION_EXTRACTED",found:true,predictionAvailable:true,explanationAvailable:Boolean(parsed.explanationAvailable),prediction:parsed.primaryPrediction||null,otherPredictions:Array.isArray(parsed.otherPredictions)?parsed.otherPredictions:[],rationaleSummary:Array.isArray(parsed.rationaleSummary)?parsed.rationaleSummary:[],sourceEvidenceSummary:String(parsed.sourceEvidenceSummary||""),fixtureDate:String(parsed.fixtureDate||""),freshnessStatus:String(parsed.freshnessStatus||"UNKNOWN"),sourceUrl:c.url,sourceTitle:c.title,sourcePublishedDate:c.published_date||"",warnings:Array.isArray(parsed.warnings)?parsed.warnings:[],parserModel:parsed.parserModel||"",diagnostics:{queries,searchResultCount:searchResults.length,candidateCount:candidates.length,extracted}};
    }
  }
  return {name,domain,status:"NO_CURRENT_EXPLICIT_PREDICTION",found:true,predictionAvailable:false,explanationAvailable:false,prediction:null,otherPredictions:[],rationaleSummary:[],sourceEvidenceSummary:"An exact fixture page was found, but no current explicit prediction could be safely extracted from the readable page text.",sourceUrl:candidates[0]?.url||"",sourceTitle:candidates[0]?.title||"",freshnessStatus:"UNKNOWN",warnings:["Unrelated, generic or stale prediction links were suppressed."],diagnostics:{queries,searchResultCount:searchResults.length,candidateCount:candidates.length}};
}
function externalBenchmarkConsensus(websites=[]){
  const valid=(websites||[]).filter(x=>x.predictionAvailable&&x.prediction?.canonicalMarketKey);
  const groups=new Map();
  for(const x of valid){
    const k=semanticCanonicalMarket(x.prediction.canonicalMarketKey||x.prediction.market||x.prediction.selection);
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

function analysisPrompt({fixture,round,originalMarket,previousRounds,sources,gate,videoReview,fallbackEvidence,temporalGuard,dataEngine}){
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

LOCAL DETERMINISTIC ENGINE (non-AI, no bookmaker odds):
${JSON.stringify(dataEngine||{},null,2)}

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
  if(!providerCanCall("geminiText"))throw new Error(`Gemini text circuit is ${providerHealth.geminiText.state}; cooldown active.`);
  const key=requireEnv("GEMINI_API_KEY");
  const configured=preferredModel||process.env.GEMINI_MODEL||"gemini-3.8-flash";
  const fallbackModels=[configured,"gemini-3.7-flash","gemini-3.6-flash","gemini-3.5-flash-lite"]
    .filter((m,i,a)=>m&&a.indexOf(m)===i);
  const errors=[];
  usageStart("gemini");

  for(const model of fallbackModels){
    for(let attempt=1;attempt<=3;attempt++){
      const response=await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{
        method:"POST",
        headers:{"Content-Type":"application/json","x-goog-api-key":key},
        body:JSON.stringify({
          contents:[{parts:[{text:prompt}]}],
          generationConfig:{temperature:0.15,maxOutputTokens,responseMimeType}
        })
      },AI_REQUEST_TIMEOUT_MS);
      const text=await response.text();

      if(response.ok){
        const data=parseHttpJson(text,`Gemini ${model}`);
        const output=(data.candidates?.[0]?.content?.parts||[]).map(p=>p.text||"").join("").trim();
        usageOk("gemini");
        return {model,output,attempt};
      }

      errors.push(`${model} attempt ${attempt}: HTTP ${response.status} ${text.slice(0,300)}`);
      const quota429=response.status===429 && /quota|resource[_ ]?exhausted|rate.?limit/i.test(text);

      // A quota 429 is not improved by hammering the same model three times.
      // Move to the next model immediately, preserving free-tier requests.
      if(quota429)break;

      const retryable=[429,500,502,503,504].includes(response.status);
      if(!retryable)break;
      if(attempt<3){
        const delay=[1800,4200,8500][attempt-1]+Math.floor(Math.random()*900);
        await sleep(delay);
      }
    }
  }

  const err=new Error(`Gemini unavailable after automatic retries/fallbacks. ${errors.slice(-4).join(" | ")}`);
  usageFail("gemini",err);tripProvider("geminiText",err);
  throw err;
}


function markPrimaryAnalysis(obj,provider,model,attempts=[]){
  obj._primaryProvider=provider;
  obj._primaryModel=model;
  obj._primaryAttempts=attempts;
  return obj;
}

async function groqPrimaryAnalyze(payload,model="openai/gpt-oss-120b",display="OpenAI GPT-OSS 120B"){
  const key=requireEnv("GROQ_API_KEY");
  usageStart("groq");
  try{
    const response=await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${key}`},
      body:JSON.stringify({
        model,temperature:0.15,max_completion_tokens:9000,
        messages:[{role:"user",content:analysisPrompt(payload)}]
      })
    },AI_REQUEST_TIMEOUT_MS);
    const txt=await response.text();
    if(!response.ok)throw new Error(`${display} primary analysis failed (${response.status}): ${txt.slice(0,320)}`);
    const d=parseHttpJson(txt,display);
    const parsed=parseJsonObject(d.choices?.[0]?.message?.content||"",display);
    usageOk("groq");
    return markPrimaryAnalysis(parsed,"Groq",display);
  }catch(err){usageFail("groq",err);throw err;}
}

async function cloudflarePrimaryAnalyze(payload,modelId,display){
  const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_AUTH_TOKEN;
  if(!account||!token)throw new Error("Cloudflare Workers AI is not configured.");
  usageStart("cloudflare");
  try{
    const response=await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${modelId}`,{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`},
      body:JSON.stringify({
        messages:[{role:"user",content:analysisPrompt(payload)}],
        temperature:0.15,max_tokens:9000
      })
    },AI_REQUEST_TIMEOUT_MS);
    const txt=await response.text();
    if(!response.ok)throw new Error(`${display} primary analysis failed (${response.status}): ${txt.slice(0,320)}`);
    const d=parseHttpJson(txt,display);
    const out=d.result?.response ?? d.result?.text ?? d.result?.output_text ?? d.result ?? "";
    const parsed=parseJsonObject(typeof out==="string"?out:JSON.stringify(out),display);
    usageOk("cloudflare");
    return markPrimaryAnalysis(parsed,"Cloudflare",display);
  }catch(err){usageFail("cloudflare",err);throw err;}
}

async function openRouterPrimaryAnalyze(payload){
  const key=requireEnv("OPENROUTER_API_KEY");
  const model=process.env.OPENROUTER_PRIMARY_MODEL||"openrouter/free";
  usageStart("openrouter");
  try{
    const response=await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions",{
      method:"POST",
      headers:{
        "Content-Type":"application/json","Authorization":`Bearer ${key}`,
        "HTTP-Referer":process.env.APP_PUBLIC_URL||"https://localhost/",
        "X-Title":"Football Fact-First Research"
      },
      body:JSON.stringify({
        model,temperature:0.15,max_tokens:9000,
        response_format:{type:"json_object"},
        messages:[{role:"user",content:analysisPrompt(payload)}]
      })
    },AI_REQUEST_TIMEOUT_MS);
    const txt=await response.text();
    if(!response.ok)throw new Error(`OpenRouter Free primary analysis failed (${response.status}): ${txt.slice(0,320)}`);
    const d=parseHttpJson(txt,"OpenRouter Primary");
    const parsed=parseJsonObject(d.choices?.[0]?.message?.content||"","OpenRouter Primary");
    usageOk("openrouter");
    return markPrimaryAnalysis(parsed,"OpenRouter",d.model||model);
  }catch(err){usageFail("openrouter",err);throw err;}
}

function degradedPrimaryAnalysis(payload,attempts=[]){
  const {fixture,gate,sources,videoReview,temporalGuard,dataEngine}=payload;
  const fixtureOk=Boolean(gate?.fixture?.date);
  const squadsOk=Boolean(gate?.squads?.home?.count && gate?.squads?.away?.count);
  const sourceCount=Array.isArray(sources)?sources.length:0;
  const videoOk=videoReview?.status==="COMPLETE";

  const coverage=CHECKLIST.map(item=>{
    let status="unavailable",note="Primary AI synthesis unavailable.";
    if(item==="fixture_verification"){
      status=fixtureOk?"complete":gate?.resolved?"partial":"unavailable";
      note=fixtureOk?"Fixture and kickoff were verified.":"Fixture timing is not fully verified.";
    }else if(item==="current_squads_authenticity"){
      status=squadsOk?"complete":gate?.resolved?"partial":"unavailable";
      note=squadsOk?"Current structured squads were returned.":"Current squad coverage is incomplete.";
    }else if(item==="confirmed_lineups"){
      status=gate?.confirmedLineups?"complete":"unavailable";
      note=gate?.confirmedLineups?"Confirmed XIs are available.":"Confirmed XIs are not available.";
    }else if(item==="injuries_suspensions"){
      status=Array.isArray(gate?.injuries)?"partial":"unavailable";
      note="Structured injury coverage may be incomplete.";
    }else if(item==="recent_transfers"){
      status=Array.isArray(gate?.transfers)&&gate.transfers.length?"complete":"partial";
      note="Transfer check depends on round/provider coverage.";
    }else if(item==="video_evidence"){
      status=videoOk?"complete":(videoReview?.videos?.length?"partial":"unavailable");
      note=videoOk?"Automated visual review completed.":"Video links may exist, but automated visual review did not complete.";
    }else if(sourceCount>=8){
      status="partial";
      note="Fresh web evidence exists, but no primary AI provider was available to synthesize this category reliably.";
    }
    return {item,status,note};
  });

  return {
    fixture,
    fixtureVerified:fixtureOk,
    verificationNote:fixtureOk?"Fixture verification succeeded, but primary AI synthesis was unavailable.":"Fixture and/or kickoff verification is incomplete.",
    freshness:{
      structuredCheckedAt:gate?.checkedAt||"",
      fixtureDate:gate?.fixture?.date||"",
      confirmedLineupsAvailable:Boolean(gate?.confirmedLineups),
      freshnessNote:"Research sources were gathered, but no configured primary AI provider completed synthesis."
    },
    authenticityAssessment:{
      status:gate?.status||"FAILED",
      homeCurrentClubVerified:Boolean(gate?.resolved?.home?.name),
      awayCurrentClubVerified:Boolean(gate?.resolved?.away?.name),
      note:(gate?.warnings||[]).join(" ")||"Structured identity data was gathered."
    },
    staleClaimsRejected:[],
    verifiedCurrentPlayersReferenced:[],
    videoReviewSummary:videoOk?"Video review completed, but no text-analysis provider was available.":"Video review incomplete or unavailable.",
    dataAnalysis:{
      evidenceQualityScore:sourceCount>=12?55:sourceCount>=6?45:30,
      structuredDataScore:squadsOk&&fixtureOk?70:squadsOk?55:35,
      webEvidenceScore:Math.min(70,25+sourceCount*3),
      videoEvidenceScore:videoOk?55:0,
      contradictionRiskScore:75,
      dataFreshnessScore:sourceCount?65:30,
      keyPatterns:[],
      keyContradictions:["Primary AI synthesis unavailable; sporting patterns were not inferred automatically."],
      analysisNarrative:`Data gathering completed and the local deterministic engine scored the evidence at ${dataEngine?.overallDataScore??"—"}/100, but all configured primary AI analysts were unavailable or quota-limited. The app preserved the evidence instead of inventing a betting conclusion.`,
      marketScores:[]
    },
    dataCoverage:coverage,
    matchProfile:{
      squadAndLineups:"See structured authenticity data; no AI synthesis available.",
      formAndOpponentStrength:"Not synthesized automatically.",
      attackAndDefence:"Not synthesized automatically.",
      shotsPossessionTerritory:"Not synthesized automatically.",
      cornersWidthSetPieces:"Not synthesized automatically.",
      disciplineReferee:"Not synthesized automatically.",
      tacticsAndGameState:"Not synthesized automatically.",
      contextRestMotivation:"Not synthesized automatically.",
      h2hVenueWeatherVideo:"Not synthesized automatically."
    },
    marketScreen:[],
    shortlist:[],
    finalMarket:"UNRESOLVED",
    runnerUp:"NONE",
    classification:"UNRESOLVED / HIGH RISK",
    whyFinal:"All configured primary AI analysis providers were unavailable or quota-limited. No market was invented.",
    remainingDanger:"AI synthesis unavailable. Connect another analysis provider or wait for quota recovery.",
    originalMarketComparison:"",
    missingData:["Primary AI synthesis unavailable."],
    antiBiasCheck:"No market was forced from incomplete AI coverage.",
    roundConvergence:"No primary analysis available.",
    sourceRefs:[],
    _primaryProvider:"NONE",
    _primaryModel:"No provider available",
    _primaryAttempts:attempts
  };
}

function normalizePrimaryAnalysisShape(analysis){
  if(!analysis||typeof analysis!=="object")return analysis;
  const scores=Array.isArray(analysis?.dataAnalysis?.marketScores)?analysis.dataAnalysis.marketScores:[];
  let shortlist=Array.isArray(analysis.shortlist)?analysis.shortlist.filter(x=>x&&typeof x==="object"&&String(x.market||"").trim()):[];
  if(!shortlist.length&&scores.length){
    shortlist=scores.filter(x=>String(x.market||"").trim()).slice(0,4).map(x=>({
      market:String(x.market),canonicalMarketKey:semanticCanonicalMarket(x.canonicalMarketKey||x.market),marketFamily:String(x.marketFamily||""),
      fairProbabilityPct:x.fairProbabilityPct??null,probabilityConfidence:x.probabilityConfidence||"LOW",sportingSupportScore:x.sportingSupportScore??x.dataSupportScore??null,
      contradictionRiskScore:x.contradictionRiskScore??null,dataSupportScore:x.dataSupportScore??null,oddsLookup:x.oddsLookup||{betTerms:[],selectionTerms:[]},
      support:Array.isArray(x.support)?x.support:[],counterEvidence:Array.isArray(x.counterEvidence)?x.counterEvidence:[],survivesKillTest:true
    }));
  }
  analysis.shortlist=shortlist.map(x=>({...x,canonicalMarketKey:semanticCanonicalMarket(x.canonicalMarketKey||x.market)}));
  if(analysis.finalMarket&&analysis.finalMarket!=="UNRESOLVED")analysis.finalCanonicalMarketKey=semanticCanonicalMarket(analysis.finalMarket);
  return analysis;
}

async function primaryAnalyzeWithFallback(payload){
  const attempts=[];
  const record=(name,err)=>{const msg=String(err?.message||err).slice(0,420);attempts.push(`${name}: ${msg}`);return msg;};

  // Preserve Gemini quota for visual video review. Prefer other healthy text providers.
  if(process.env.OPENROUTER_API_KEY&&providerCanCall("openrouter")){
    try{const out=await openRouterPrimaryAnalyze(payload);healProvider("openrouter");out._primaryAttempts=attempts;return out;}
    catch(err){tripProvider("openrouter",err);record("OpenRouter",err);}
  }
  if(process.env.GROQ_API_KEY&&providerCanCall("groq")){
    for(const [model,display] of [["openai/gpt-oss-120b","OpenAI GPT-OSS 120B"],["openai/gpt-oss-20b","OpenAI GPT-OSS 20B"],["qwen/qwen3.8-27b","Qwen 3.8 27B"]]){
      try{const out=await groqPrimaryAnalyze(payload,model,display);healProvider("groq");out._primaryAttempts=attempts;return out;}
      catch(err){tripProvider("groq",err);record(`Groq ${display}`,err);if(!providerCanCall("groq"))break;}
    }
  }
  if(process.env.CLOUDFLARE_ACCOUNT_ID&&process.env.CLOUDFLARE_AUTH_TOKEN&&providerCanCall("cloudflare")){
    for(const [model,display] of [["@cf/meta/llama-3.3-70b-instruct-fp8-fast","Meta Llama 3.3 70B"],["@cf/google/gemma-4-26b-a4b-it","Gemma 4 26B"],["@cf/nvidia/nemotron-3-120b-a12b","NVIDIA Nemotron 3 120B"],["@cf/zai-org/glm-4.7-flash","GLM 4.7 Flash"]]){
      try{const out=await cloudflarePrimaryAnalyze(payload,model,display);healProvider("cloudflare");out._primaryAttempts=attempts;return out;}
      catch(err){tripProvider("cloudflare",err);record(`Cloudflare ${display}`,err);if(!providerCanCall("cloudflare"))break;}
    }
  }
  if(process.env.GEMINI_API_KEY&&providerCanCall("geminiText")){
    try{const out=await geminiAnalyze(payload);healProvider("geminiText");out._primaryProvider="Google";out._primaryModel=out._geminiModelUsed||process.env.GEMINI_MODEL||"Gemini";out._primaryAttempts=attempts;return out;}
    catch(err){tripProvider("geminiText",err);record("Gemini text",err);}
  }
  const out=degradedPrimaryAnalysis(payload,attempts);
  out._providerHealth=providerHealthSnapshot();
  return out;
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

app.get("/api/version",(req,res)=>{
  res.setHeader("Cache-Control","no-store");
  res.json({ok:true,version:APP_VERSION,protocol:"independent-ai-council-v2"});
});

app.get("/api/health",(req,res)=>{
  res.json({
    ok:true,version:APP_VERSION,
    tavilyConfigured:Boolean(process.env.TAVILY_API_KEY),
    builtinSearchEnabled:true,
    searchFleetProviders:["Google HTML best-effort","Bing HTML","DuckDuckGo HTML",...(process.env.TAVILY_API_KEY?["Tavily"]:[])],
    geminiConfigured:Boolean(process.env.GEMINI_API_KEY),
    apiFootballConfigured:Boolean(process.env.API_FOOTBALL_KEY),
    groqConfigured:Boolean(process.env.GROQ_API_KEY),
    cloudflareConfigured:Boolean(process.env.CLOUDFLARE_ACCOUNT_ID&&process.env.CLOUDFLARE_AUTH_TOKEN),
    openRouterConfigured:Boolean(process.env.OPENROUTER_API_KEY),
    anyPrimaryAiConfigured:Boolean(process.env.GEMINI_API_KEY||process.env.OPENROUTER_API_KEY||process.env.GROQ_API_KEY||(process.env.CLOUDFLARE_ACCOUNT_ID&&process.env.CLOUDFLARE_AUTH_TOKEN)),
    footballDataOrgConfigured:Boolean(process.env.FOOTBALL_DATA_ORG_KEY),
    theSportsDBConfigured:true,
    scoreBatConfigured:Boolean(process.env.SCOREBAT_TOKEN),
    model:process.env.GEMINI_MODEL||"gemini-3.8-flash",
    councilMinIndependentModels:COUNCIL_MIN_MODELS,
    councilMaxModels:COUNCIL_MAX_MODELS,
    aiRequestTimeoutMs:AI_REQUEST_TIMEOUT_MS
  });
});



app.get("/api/research-progress/:id",(req,res)=>{
  res.setHeader("Cache-Control","no-store");
  const p=researchProgress.get(String(req.params.id||""));
  if(!p)return res.status(404).json({ok:false,error:"Progress job not found or already expired."});
  res.json({ok:true,...p});
});

async function aiPreflight(){
  const checks=[];
  const prompt='Return ONLY this JSON object: {"status":"READY"}';
  const push=(provider,configured,ok,model,error='')=>checks.push({provider,configured,ok,model:model||'',error:String(error||'').slice(0,240)});

  if(process.env.GEMINI_API_KEY){
    try{const r=await geminiTextWithRetry({prompt,maxOutputTokens:80,responseMimeType:'application/json',preferredModel:process.env.GEMINI_COUNCIL_MODEL||process.env.GEMINI_MODEL||'gemini-3.8-flash'});push('Gemini',true,true,r.model);}
    catch(e){push('Gemini',true,false,'',e.message);}
  }else push('Gemini',false,false,'','Not configured');

  if(process.env.OPENROUTER_API_KEY){
    try{
      const r=await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${process.env.OPENROUTER_API_KEY}`,'HTTP-Referer':process.env.APP_PUBLIC_URL||'https://localhost/','X-Title':'Football Fact-First Research'},body:JSON.stringify({model:'openrouter/free',temperature:0,max_tokens:80,messages:[{role:'user',content:prompt}]})},AI_REQUEST_TIMEOUT_MS);
      const text=await r.text();if(!r.ok)throw new Error(`HTTP ${r.status}: ${text.slice(0,180)}`);const d=parseHttpJson(text,'OpenRouter preflight');push('OpenRouter',true,true,d.model||'openrouter/free');
    }catch(e){push('OpenRouter',true,false,'',e.message);}
  }else push('OpenRouter',false,false,'','Not configured');

  if(process.env.GROQ_API_KEY){
    try{
      const model='openai/gpt-oss-20b';
      const r=await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${process.env.GROQ_API_KEY}`},body:JSON.stringify({model,temperature:0,max_completion_tokens:80,messages:[{role:'user',content:prompt}]})},AI_REQUEST_TIMEOUT_MS);
      const text=await r.text();if(!r.ok)throw new Error(`HTTP ${r.status}: ${text.slice(0,180)}`);push('Groq',true,true,model);
    }catch(e){push('Groq',true,false,'',e.message);}
  }else push('Groq',false,false,'','Not configured');

  if(process.env.CLOUDFLARE_ACCOUNT_ID&&process.env.CLOUDFLARE_AUTH_TOKEN){
    try{
      const model=process.env.CLOUDFLARE_LLAMA_MODEL||'@cf/meta/llama-3.3-70b-instruct-fp8-fast';
      const r=await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID)}/ai/run/${model}`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${process.env.CLOUDFLARE_AUTH_TOKEN}`},body:JSON.stringify({messages:[{role:'user',content:prompt}],temperature:0,max_tokens:80})},AI_REQUEST_TIMEOUT_MS);
      const text=await r.text();if(!r.ok)throw new Error(`HTTP ${r.status}: ${text.slice(0,180)}`);push('Cloudflare',true,true,model);
    }catch(e){push('Cloudflare',true,false,'',e.message);}
  }else push('Cloudflare',false,false,'','Not configured');

  let openRouterFreeModelsCount=0;
  if(process.env.OPENROUTER_API_KEY){try{openRouterFreeModelsCount=(await openRouterFreeModels()).length;}catch{}}
  const respondingProviders=checks.filter(x=>x.ok).length;
  // OpenRouter can supply several independent underlying models; otherwise each working provider contributes at least one.
  const potentialIndependentModels=Math.min(COUNCIL_MAX_MODELS,(checks.find(x=>x.provider==='OpenRouter'&&x.ok)?Math.max(1,openRouterFreeModelsCount):0)+checks.filter(x=>x.ok&&x.provider!=='OpenRouter').length);
  return {checkedAt:isoNow(),checks,respondingProviders,openRouterFreeModelsCount,potentialIndependentModels,councilReady:potentialIndependentModels>=COUNCIL_MIN_MODELS,minimumIndependentModels:COUNCIL_MIN_MODELS};
}

app.get('/api/ai-preflight',async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try{res.json({ok:true,...await aiPreflight()});}
  catch(err){res.status(500).json({ok:false,error:err.message||'AI preflight failed.'});}
});

app.get("/api/provider-status",async(req,res)=>{
  const configured=providerConfigured();
  let openRouterFreeModelsCount=0;
  if(configured.openrouter){try{openRouterFreeModelsCount=(await openRouterFreeModels()).length;}catch{}}
  res.json({ok:true,configured,usage:providerUsage,health:providerHealthSnapshot(),openRouterFreeModelsCount});
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
    // Council uses any configured AI provider; Gemini is optional.

    const fixture=cleanFixture(req.body?.fixture);
    const existingMembers=Array.isArray(req.body?.existingMembers)?req.body.existingMembers:[];
    const targetSize=Math.max(existingMembers.length+1,Math.min(100,Number(req.body?.targetSize||existingMembers.length+10)));
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


function compactSourcesForClient(sources=[]){
  return (sources||[]).map(x=>({
    ...x,
    content:String(x?.content||"").slice(0,1800)
  }));
}
function compactWarehouseForClient(w){
  if(!w)return null;
  return {
    mode:w.mode,summary:w.summary,createdAt:w.createdAt,
    ledger:(w.ledger||[]).map(x=>({...x})),
    entries:(w.entries||[]).map(x=>({
      url:x.url,title:x.pageTitle||x.title||x.url,provider:x.provider,
      categories:x.categories||[],kind:x.kind,reliability:x.reliability,
      opened:Boolean(x.opened),usable:Boolean(x.usable),relevant:x.relevant!==false,
      contentLength:x.contentLength||0,openError:x.openError||"",rejectionReason:x.rejectionReason||""
    })),
    rejected:(w.rejected||[]).slice(0,500).map(x=>({...x}))
  };
}
function compactGateForClient(gate){
  if(!gate)return gate;
  const clone=JSON.parse(JSON.stringify(gate));
  for(const side of ["home","away"]){
    if(clone?.squads?.[side]?.players){
      clone.squads[side].players=clone.squads[side].players.slice(0,36).map(p=>({name:p.name||"",position:p.position||""}));
    }
  }
  if(Array.isArray(clone.injuries))clone.injuries=clone.injuries.slice(0,40);
  if(Array.isArray(clone.transfers))clone.transfers=clone.transfers.slice(0,30);
  return clone;
}

async function executeResearchJob(body,progressId){
  setResearchProgress(progressId,{percent:2,stage:"Starting research round",stageNumber:1,totalStages:12,message:"Request received. Preparing the fixture for a fresh independent research round."});
  const fixture=cleanFixture(body?.fixture);
  if(!fixture||fixture.length<5)throw new Error("Please provide a valid fixture, preferably 'Team A vs Team B'.");
  const round=Math.max(1,Math.min(20,Number(body?.round||1)));
  const originalMarket=String(body?.originalMarket||"").trim().slice(0,180);
  const previousRounds=Array.isArray(body?.previousRounds)?body.previousRounds:[];
  const councilSize=Math.max(COUNCIL_MIN_MODELS,Math.min(COUNCIL_MAX_MODELS,Number(body?.councilSize||4)));

  const researchMode=String(body?.researchMode||"deep").toLowerCase();
  setResearchProgress(progressId,{percent:6,stage:"Initial identity check",stageNumber:2,totalStages:12,message:`Round ${round}: resolving team identities and checking structured fixture providers.`});
  let gate=await buildBestAvailableGate(fixture,round);

  setResearchProgress(progressId,{percent:12,stage:"Fallback cross-checks",stageNumber:3,totalStages:12,message:"Cross-checking teams and fixture with secondary structured providers."});
  const fallbackEvidence=await collectFallbackEvidence(fixture,gate);

  setResearchProgress(progressId,{percent:18,stage:"Research fleet",stageNumber:4,totalStages:12,message:`Launching multi-engine research fleet in ${researchMode.toUpperCase()} mode.`});
  const researchWarehouse=await buildResearchWarehouse({fixture,gate,round,mode:researchMode,progressId});

  gate=upgradeGateWithWarehouse(gate,fixture,researchWarehouse);
  if(gate?.fixture?.dateOnly){
    const kickoffRescue=await rescueExactKickoff({fixture,gate,warehouse:researchWarehouse,progressId});
    if(kickoffRescue)gate=applyKickoffRescueToGate(gate,kickoffRescue);
  }
  const temporalGuard=fixtureTemporalGuard(gate);

  const sources=warehouseSources(researchWarehouse,researchMode==="maximum"?60:44);
  if(!sources.length)throw new Error("The research fleet could not recover any usable public evidence for this fixture.");

  const webScout=(researchWarehouse.providerLog||[]).map(x=>({category:x.category,query:x.query,results:(x.groups||[]).flatMap(g=>(g.results||[]).map(r=>({...r,searchProvider:g.provider})))}));

  const videoQueries=makeVideoQueries(fixture,gate,round),videoScout=[];
  setResearchProgress(progressId,{percent:58,stage:"Video scouting",stageNumber:6,totalStages:12,message:`Looking for relevant football highlights through the multi-engine search fleet (${videoQueries.length} queries).`});
  for(let vi=0;vi<videoQueries.length;vi++){
    const q=videoQueries[vi];
    setResearchProgress(progressId,{percent:58+Math.round(((vi+1)/Math.max(1,videoQueries.length))*5),stage:"Video scouting",stageNumber:6,totalStages:12,message:`Video search ${vi+1}/${videoQueries.length}: ${q.slice(0,120)}`});
    const groups=await searchFleet(q,{providersPerTask:2,maxResultsPerProvider:6});
    videoScout.push({category:"video-search",query:q,results:groups.flatMap(g=>(g.results||[]).map(r=>({...r,provider:r.provider||g.provider})))});
  }
  const videoCandidates=chooseVideoCandidates(videoScout,gate);
  setResearchProgress(progressId,{percent:64,stage:"Video review",stageNumber:7,totalStages:12,message:`Reviewing ${videoCandidates.length} selected public football video source(s) where supported.`});
  const videoReview=await reviewYoutubeHighlights(videoCandidates,gate);

  const allScoutedLinks=[
    ...(researchWarehouse.entries||[]).map(x=>({category:(x.categories||[]).join(",")||"web",title:x.pageTitle||x.title||x.url,url:x.url,published_date:"",score:x.reliability/100,query:(x.discoveredBy||[])[0]||"",kind:x.kind,provider:x.provider,status:x.relevant===false?"REJECTED":"ACCEPTED",reason:x.rejectionReason||""})),
    ...(researchWarehouse.rejected||[]).filter(x=>x.url).map(x=>({category:x.category||"web",title:x.title||x.url,url:x.url,published_date:"",score:0,query:x.query||"",kind:"rejected",provider:x.provider||"",status:"REJECTED",reason:x.reason||"Irrelevant to requested clubs."})),
    ...flattenScoutLinks([],videoScout).map(x=>({...x,status:"SCOUTED"}))
  ];
  const dataEngine=deterministicDataEngine({fixture,gate,sources,videoReview,temporalGuard,researchWarehouse});
  setResearchProgress(progressId,{percent:69,stage:"Data analysis",stageNumber:8,totalStages:12,message:`Running local deterministic checks plus AI synthesis across ${sources.length} deduplicated sources.`});
  const analysis=normalizePrimaryAnalysisShape(await primaryAnalyzeWithFallback({fixture,round,originalMarket,previousRounds,sources,gate,videoReview,fallbackEvidence,temporalGuard,dataEngine}));

  if(analysis.dataAnalysis && videoReview.status!=="COMPLETE"){
    analysis.dataAnalysis.videoEvidenceScore=0;
    analysis.missingData=Array.isArray(analysis.missingData)?analysis.missingData:[];
    if(!analysis.missingData.some(x=>/video/i.test(String(x)))){
      analysis.missingData.push("Automated visual video review did not complete; linked videos were not counted as reviewed evidence.");
    }
  }

  if(gate.status==="FAILED"){
    analysis.finalMarket="UNRESOLVED";
    analysis.classification="UNRESOLVED / HIGH RISK";
    analysis.remainingDanger=`Authenticity gate failed: ${(gate.warnings||[]).join(" ")}`;
  }
  if(!temporalGuard.bettingAllowed){
    analysis.researchOnlyCandidates=[...(analysis.shortlist||[])];
    analysis.finalMarket=temporalGuard.mode==="POST_MATCH_AUDIT"?"POST-MATCH AUDIT ONLY":"NO PRE-MATCH BET — TIMING NOT VERIFIED";
    analysis.classification="UNRESOLVED / HIGH RISK";
    analysis.originalMarketComparison="";
    analysis.remainingDanger=temporalGuard.reason;
    analysis.whyFinal=temporalGuard.reason;
  }

  setResearchProgress(progressId,{percent:77,stage:"AI Council",stageNumber:9,totalStages:12,message:temporalGuard.researchAllowed?`Running the independent AI Council with up to ${councilSize} agent seat(s). Odds remain hidden.${temporalGuard.bettingAllowed?"":" Research-only mode: no betting/value conclusion will be released."}`:"Council blocked because the fixture is already live/finished."});
  const aiCouncil=temporalGuard.researchAllowed
    ? await runAiCouncil({fixture,gate,sources,videoReview,fallbackEvidence,dataEngine},{targetSize:councilSize})
    : {checkedAt:isoNow(),members:[],counts:{agentSeats:0,availableAgents:0,uniqueModels:0,specialistAgents:0},aggregation:{availableModels:0,unresolvedModels:0,convergence:"BLOCKED",consensusMarket:"BLOCKED BY TEMPORAL GUARD",consensusCanonicalKey:"",modelsAgreeing:[],medianFairProbabilityPct:null,groups:[],note:temporalGuard.reason}};
  if(aiCouncil&&temporalGuard.researchAllowed&&!temporalGuard.bettingAllowed){aiCouncil.researchOnly=true;aiCouncil.researchOnlyReason=temporalGuard.reason;}

  setResearchProgress(progressId,{percent:86,stage:"External benchmarks",stageNumber:10,totalStages:12,message:temporalGuard.researchAllowed?"Extracting actual current predictions and published reasoning from external benchmark sources.":"External predictions blocked because the fixture is already live/finished."});
  const externalBenchmarks=temporalGuard.researchAllowed
    ? await externalPredictionBenchmarks(fixture,gate)
    : {checkedAt:isoNow(),websites:[],apiFootball:{available:false},consensus:{status:"BLOCKED",availablePredictions:0},rule:`Blocked: ${temporalGuard.reason}`};
  if(externalBenchmarks&&temporalGuard.researchAllowed&&!temporalGuard.bettingAllowed){externalBenchmarks.researchOnly=true;externalBenchmarks.rule=`Research-only benchmark extraction. ${temporalGuard.reason}`;}

  setResearchProgress(progressId,{percent:93,stage:"Odds & value audit",stageNumber:11,totalStages:12,message:temporalGuard.bettingAllowed?"Sporting analysis is complete. Only now checking available prices and potential value.":"Odds/value stage blocked because this is not a verified pre-match fixture."});
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

  const primaryKey=semanticCanonicalMarket((analysis.shortlist||[]).find(x=>x.market===analysis.finalMarket)?.canonicalMarketKey||analysis.finalMarket);
  const councilKey=semanticCanonicalMarket(agg.consensusCanonicalKey||agg.consensusMarket||"");
  const same=Boolean(councilKey)&&primaryKey===councilKey;
  const finalConvergence={
    status:!councilKey||["NONE","INSUFFICIENT","BLOCKED"].includes(agg.convergence)?"NO COUNCIL CONSENSUS":same?"PRIMARY + COUNCIL CONVERGED":"PRIMARY / COUNCIL DISAGREE",
    primaryMarket:analysis.finalMarket||"UNRESOLVED",
    councilMarket:agg.consensusMarket||"NO CONSENSUS",
    councilConvergence:agg.convergence||"NONE",
    note:same?"The primary fact-first analysis and independent council point to the same canonical market.":"Disagreement or insufficient council coverage is preserved instead of forcing agreement."
  };

  setResearchProgress(progressId,{percent:98,stage:"Presentation",stageNumber:12,totalStages:12,message:"Building charts, source audit, market screen, council summary and final round presentation."});

  return {
    ok:true,fixture,round,researchMode,
    searchesUsed:(researchWarehouse.providerLog||[]).length+videoQueries.length,
    queries:(researchWarehouse.ledger||[]).map(x=>x.query),videoQueries,sources:compactSourcesForClient(sources),
    authenticityGate:compactGateForClient(gate),videoReview,fallbackEvidence,
    researchWarehouse:compactWarehouseForClient(researchWarehouse),queryLedger:researchWarehouse.ledger||[],
    sourceAudit:{allScoutedLinks},
    dataEngine,
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
    percent:1,stage:"Queued",stageNumber:1,totalStages:12,
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

// Legacy endpoint guard: old cached clients expected /api/research to return
// a finished round synchronously. Returning HTTP 202 made those clients render an empty round.
app.post("/api/research",(req,res)=>{
  res.status(409).json({
    ok:false,
    code:"CLIENT_UPDATE_REQUIRED",
    requiredVersion:APP_VERSION,
    error:"Your browser is running an older Football Fact-First interface. Reopen the live Render URL so public/index.html updates to v3.8 before starting research."
  });
});


app.use((req,res)=>{
  res.setHeader("Cache-Control","no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname,"public","index.html"));
});
app.listen(PORT,()=>console.log(`Football Fact-First Research v${APP_VERSION} running on port ${PORT}`));
