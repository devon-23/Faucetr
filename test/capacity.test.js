const { resolveCapacity } = require('../out/collector/capacity.js');
let pass=0,fail=0;
const t=(n,c,got)=>{ if(c){pass++;console.log('  PASS  '+n);} else {fail++;console.log('  FAIL  '+n+'  got: '+JSON.stringify(got));} };

let r = resolveCapacity({ authoritative: 200000, override: 999, observedPeak: 50 });
t('authoritative wins over everything', r.tokens===200000 && r.source==='authoritative' && r.isEstimate===false, r);

r = resolveCapacity({ override: 500000, observedPeak: 300000 });
t('override beats inference', r.tokens===500000 && r.source==='override' && r.isEstimate===true, r);

r = resolveCapacity({ observedPeak: 50000 });
t('small peak infers 200k', r.tokens===200000 && r.source==='inferred', r);

r = resolveCapacity({ observedPeak: 285152 });
t('REAL 285,152 peak infers 1M (not 200k)', r.tokens===1000000, r);

r = resolveCapacity({ observedPeak: 339036 });
t('REAL 339,036 peak infers 1M', r.tokens===1000000, r);

r = resolveCapacity({});
t('no data => null capacity, never a default', r.tokens===null && r.source==='unknown', r);

r = resolveCapacity({ authoritative: 0, observedPeak: 1000 });
t('zero authoritative rejected, falls through', r.source==='inferred', r);

r = resolveCapacity({ authoritative: NaN, observedPeak: 1000 });
t('NaN authoritative rejected', r.source==='inferred', r);

r = resolveCapacity({ observedPeak: 199500 });
t('just under 200k stays 200k', r.tokens===200000, r);

r = resolveCapacity({ observedPeak: 2000000 });
t('beyond known tiers clamps to largest', r.tokens===1000000, r);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail?1:0);
