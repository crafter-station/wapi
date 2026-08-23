import fs from 'node:fs';
const txt = fs.readFileSync('llms.txt','utf8');
const lines = txt.split('\n');
const refIdx = lines.findIndex(l => l.trim() === '## API Reference');
const index = lines.slice(0, refIdx).join('\n');
fs.mkdirSync('reference', {recursive:true});
fs.writeFileSync('INDEX.md', index);

// find all ### section starts
const starts = [];
for (let i = refIdx; i < lines.length; i++) if (lines[i].startsWith('### ')) starts.push(i);
let n = 0;
const manifest = [];
for (let s = 0; s < starts.length; s++) {
  const a = starts[s], b = s+1 < starts.length ? starts[s+1] : lines.length;
  const body = lines.slice(a,b).join('\n').trimEnd();
  const url = (body.match(/^URL: (\S+)/m)||[])[1] || '';
  const ep  = (body.match(/^Endpoint: (.+)$/m)||[])[1] || '';
  const parts = url.split('/');
  const cat = parts[parts.length-2] || 'misc';
  const slug = parts[parts.length-1] || ('section-'+s);
  fs.mkdirSync(`reference/${cat}`, {recursive:true});
  fs.writeFileSync(`reference/${cat}/${slug}.md`, body+'\n');
  manifest.push({cat, slug, title: lines[a].slice(4).trim(), endpoint: ep, url});
  n++;
}
fs.writeFileSync('manifest.json', JSON.stringify(manifest,null,2));
console.log('sections written:', n);
const byCat = {};
for (const m of manifest) (byCat[m.cat] ||= []).push(m);
for (const [c,v] of Object.entries(byCat)) console.log(c.padEnd(24), v.length);
