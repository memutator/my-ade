/** Synthetic Pack fixture shared by the scheduler and real-daemon acceptance tests. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function createDomainPackFixture(root: string): {
  home: string; configDir: string; packsRoot: string; sourcePath: string
} {
  const home = join(root, 'home')
  const configDir = join(root, 'config')
  const packsRoot = join(root, 'packs')
  const packRoot = join(packsRoot, 'external-fixture')
  const sourceRoot = join(home, 'fixture-harness')
  for (const path of [sourceRoot, configDir, packRoot]) mkdirSync(path, { recursive: true })
  const sourcePath = join(sourceRoot, 'usage.jsonl')
  const manifest = {
    schemaVersion: 1,
    pack: { id: 'fixture.external', name: 'External fixture', publisher: 'fixture', createdAt: 1,
      metadata: { discovery: { configRoots: [{ kind: 'home-relative', path: sourceRoot }] } } },
    revision: { packId: 'fixture.external', revision: 1, contentDigest: '', runnerProtocol: '1',
      subjectRefs: [{ kind: 'harness', harnessId: 'fake' }], requirements: [], createdAt: 1,
      implementations: ['identify', 'usage'].map((capability) => ({ id: `fixture.${capability}`,
        capability, contract: { id: `mahas.integration.${capability}`, revision: 1 },
        support: { state: 'implemented' }, supportDetails: { fixture: true }, entrypoint: { mode: 'script', resource: 'collector.mjs', runtime: 'node' },
        limits: { timeoutMs: 5_000, maxOutputBytes: 100_000, maxBatchRecords: 1 } })) }
  }
  writeFileSync(join(packRoot, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(packRoot, 'collector.mjs'), `
  import {existsSync,readFileSync,statSync} from 'node:fs';
  import {join} from 'node:path';
  let text=''; for await (const chunk of process.stdin) text+=chunk;
  const r=JSON.parse(text), p=r.payload, now=Date.now(); let payload;
  if(r.capability==='identify') payload={installations:p.candidateLocators.filter(existsSync).map(path=>({harnessId:'fake',configNamespace:path,dataNamespace:path,presence:'present',evidence:[]}))};
  else if(r.action==='discover-sources') { const path=join(p.dataNamespace,'usage.jsonl'); payload={sources:existsSync(path)?[{sourceKey:'fixture.usage',kind:'file',locator:{path},generation:String(statSync(path).ino),identityEvidence:{}}]:[]}; }
  else { const data=readFileSync(p.source.locator.path,'utf8'); const lines=data.split('\\n'); lines.pop(); const offset=p.cursor?.offset??0;
   const rows=lines.slice(offset,offset+p.maxRecords).map(JSON.parse); payload={observations:[],sessions:[],handles:[],attachments:[],events:[],usageAttributionHints:[],quotaReadings:[],
   usageReadings:rows.map(row=>({sourceRecordKey:row.id,measurementKey:'tokens',mode:'delta',values:{inputTotal:row.tokens,outputTotal:0,total:row.tokens,cacheReadInput:null,cacheWriteInput:null,reasoningOutput:null},semantics:{unit:'tokens',componentRelations:[],completeness:'partial',nativeFields:{}},timeCoverage:{kind:'point',at:row.at,basis:'fixture timestamp'},sourceEvidence:{}})),
   nextCursor:{offset:offset+rows.length},exhausted:offset+rows.length>=lines.length,coverage:{completeness:'partial'},diagnostics:[]}; }
  process.stdout.write(JSON.stringify({protocolVersion:r.protocolVersion,operationId:r.operationId,capability:r.capability,target:r.target,contract:r.contract,pack:r.pack,...(r.action?{action:r.action}:{}),status:'success',payload,diagnostics:[],startedAt:now,completedAt:Date.now()})+'\\n');
  `)
  writeFileSync(sourcePath, JSON.stringify({ id: 'a', tokens: 100, at: 1789257600000 }) + '\n')
  return { home, configDir, packsRoot, sourcePath }
}
