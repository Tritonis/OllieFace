import fs from 'node:fs';
for (const d of process.argv.slice(2)) {
  const m = JSON.parse(fs.readFileSync(`${d}/manifest.json`, 'utf8'));
  const c = m.shots.find(x => x.name === '04-combat').subject.checks.find(x => x.subject === 'horde');
  const gated = c.perSep.map((v, i) => [v, c.perPx[i]]).sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0]);
  console.log(`${d}  worstGatedSep=${c.worstGatedSep}  sepP50=${c.sepP50}  px=${c.px}  gated=[${gated.join(',')}]`);
}
