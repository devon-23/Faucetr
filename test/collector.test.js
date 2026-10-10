const { TranscriptReader } = require('../out/collector/transcript.js');
const fs=require('fs'); const path=require('path'); const p=path.join(__dirname,'.tmp-transcript.jsonl');
const mk=(rid,inp,cr,cc,out,extra={})=>JSON.stringify({type:'assistant',sessionId:'sess-A',requestId:rid,timestamp:'2026-10-09T12:00:00.000Z',cwd:'/tmp/x',message:{model:'claude-opus-5',usage:{input_tokens:inp,cache_read_input_tokens:cr,cache_creation_input_tokens:cc,output_tokens:out}},...extra});
let pass=0,fail=0;
const t=(name,cond,got)=>{ if(cond){pass++;console.log('  PASS  '+name);} else {fail++;console.log('  FAIL  '+name+'  got: '+JSON.stringify(got));} };

(async()=>{
// 1. live append
fs.writeFileSync(p, mk('r1',10,1000,500,50)+'\n');
const r=new TranscriptReader(p);
await r.refresh(); let s=r.snapshot(null);
console.log('TEST GROUP: live append + dedup');
t('first request folded', s.cumulative.requests===1, s.cumulative.requests);
t('context = 10+1000+500 = 1510', s.context.tokens===1510, s.context.tokens);

fs.appendFileSync(p, mk('r2',5,2000,100,80)+'\n');
const changed=await r.refresh(); s=r.snapshot(null);
t('live append detected', changed===true, changed);
t('2 requests cumulative', s.cumulative.requests===2, s.cumulative.requests);
t('context tracks LATEST only (2105)', s.context.tokens===2105, s.context.tokens);
t('cacheRead summed (3000)', s.cumulative.cacheRead===3000, s.cumulative.cacheRead);

// 2. duplicate requestId
fs.appendFileSync(p, mk('r2',5,2000,100,80)+'\n');
await r.refresh(); s=r.snapshot(null);
t('duplicate requestId ignored', s.cumulative.requests===2, s.cumulative.requests);
t('cacheRead not double-counted', s.cumulative.cacheRead===3000, s.cumulative.cacheRead);

// 3. malformed line
console.log('\nTEST GROUP: malformed + partial');
fs.appendFileSync(p, '{this is not json\n');
await r.refresh(); s=r.snapshot(null);
t('malformed line skipped, no crash', s.cumulative.requests===2, s.cumulative.requests);

// 4. partial line carried across reads
const line=mk('r3',7,500,0,30);
fs.appendFileSync(p, line.slice(0,40));          // write HALF a line
let ch=await r.refresh(); s=r.snapshot(null);
t('partial line NOT folded prematurely', s.cumulative.requests===2, s.cumulative.requests);
fs.appendFileSync(p, line.slice(40)+'\n');        // complete it
await r.refresh(); s=r.snapshot(null);
t('completed partial line folded', s.cumulative.requests===3, s.cumulative.requests);
t('context from completed line (507)', s.context.tokens===507, s.context.tokens);

// 5. sidechain isolation
console.log('\nTEST GROUP: sidechain + compaction');
fs.appendFileSync(p, mk('r4',1,9000,0,400,{isSidechain:true})+'\n');
await r.refresh(); s=r.snapshot(null);
t('sidechain excluded from main cumulative', s.cumulative.requests===3, s.cumulative.requests);
t('sidechain tracked separately', s.sidechain.requests===1&&s.sidechain.promptTokens===9001, s.sidechain);
t('sidechain does NOT move context occupancy', s.context.tokens===507, s.context.tokens);

// 6. compaction
fs.appendFileSync(p, JSON.stringify({type:'system',sessionId:'sess-A',timestamp:'2026-10-09T12:05:00.000Z',compactMetadata:{trigger:'auto',preTokens:180000,postTokens:12000,cumulativeDroppedTokens:168000}})+'\n');
await r.refresh(); s=r.snapshot(null);
t('compaction recorded', s.compactions.length===1&&s.compactions[0].trigger==='auto', s.compactions);
t('context DROPS to postTokens (12000)', s.context.tokens===12000, s.context.tokens);
t('cumulative PRESERVED through compaction', s.cumulative.requests===3, s.cumulative.requests);
t('cacheRead preserved through compaction', s.cumulative.cacheRead===3500, s.cumulative.cacheRead);
t('droppedTokens captured', s.droppedTokens===168000, s.droppedTokens);
t('lifecycle = compacted', s.lifecycle==='compacted', s.lifecycle);

// 7. truncation / file replacement (/clear)
console.log('\nTEST GROUP: truncation + capacity');
fs.writeFileSync(p, mk('rNEW',3,100,0,10)+'\n');   // file now SHORTER
await r.refresh(); s=r.snapshot(null);
t('truncation resets state (1 request)', s.cumulative.requests===1, s.cumulative.requests);
t('stale compactions cleared', s.compactions.length===0, s.compactions.length);
t('context from new file (103)', s.context.tokens===103, s.context.tokens);

// 8. capacity / ratio
s=r.snapshot(200000);
t('ratio computed with known capacity', Math.abs(s.context.ratio-103/200000)<1e-9, s.context.ratio);
t('isEstimate flagged true', s.context.isEstimate===true, s.context.isEstimate);
s=r.snapshot(null);
t('ratio null without capacity (NOT 0)', s.context.ratio===null, s.context.ratio);

// 9. missing file
const r2=new TranscriptReader('/private/tmp/nope-does-not-exist.jsonl');
const mc=await r2.refresh(); const s2=r2.snapshot(null);
t('missing file: no crash, no data', mc===false&&s2.context.tokens===null&&s2.cumulative===null, {mc});

// 10. negative/NaN hostile input
fs.appendFileSync(p, JSON.stringify({type:'assistant',sessionId:'sess-A',requestId:'rBad',timestamp:'bogus',message:{usage:{input_tokens:-5,cache_read_input_tokens:'abc',cache_creation_input_tokens:null,output_tokens:Infinity}}})+'\n');
await r.refresh(); s=r.snapshot(null);
t('hostile values sanitized to 0, no NaN', s.context.tokens===0&&!Number.isNaN(s.cumulative.output), {ctx:s.context.tokens,out:s.cumulative.output});

fs.unlinkSync(p);
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail?1:0);
})();
