// WHY a complete executable specification: policy tests compare the ENTIRE parsed
// workflow, not a handful of substrings that leave room for selective assertions.
export function workflow() {
  const guard="github.event_name == 'pull_request' && github.head_ref == 'session/29-linux-ci-winner' && github.base_ref == 'session/29-linux-build-bench' && github.event.pull_request.head.repo.full_name == github.repository";
  const checkout={uses:'actions/checkout@v7',with:{'fetch-depth':0,'persist-credentials':false}};
  const node={uses:'actions/setup-node@v7',with:{'node-version':22,cache:'npm','cache-dependency-path':'desktop/package-lock.json'}};
  const run=command=>({run:command});
  const bench=command=>run(`node scripts/linux-build-bench.mjs ${command}`);
  const upload=(name,paths,days=7)=>({if:'always()',uses:'actions/upload-artifact@v7',with:{name,path:paths,'compression-level':0,'if-no-files-found':'error','retention-days':days}});
  const download=(name,destination)=>({uses:'actions/download-artifact@v8',with:{name,path:destination}});
  const env={BENCH_EVIDENCE:'${{ github.workspace }}/bench-evidence'};
  const job=(name,steps,extra={})=>({name,if:guard,'runs-on':'ubuntu-latest','timeout-minutes':25,env:{...env},steps,...extra});
  const setup=[checkout,node,bench('stamp setup-complete'),bench('stage npm-ci npm ci')];
  const prep=job('Winner diagnostic - preflight and one prepared Linux app',[
    ...setup,
    bench('stage policies node --test ../scripts/ci-policy.test.mjs ../scripts/beta-version.test.mjs ../scripts/linux-build-bench.test.mjs ../scripts/linux-speed-winner.test.mjs'),
    {name:'Run all retained readonly validation checks concurrently',...bench('stage cheap-preflight-total node ../scripts/linux-speed-winner.mjs preflight')},
    bench('stage preparation-total node ../scripts/linux-build-bench.mjs prepare'),bench('stamp upload-start'),
    {uses:'actions/upload-artifact@v7',with:{name:'winner-prepared-app',path:'bench-evidence/prepared.tar\nbench-evidence/prepared-manifest.json\nbench-evidence/fingerprint.json\nbench-evidence/archive-info.json\n','compression-level':0,'if-no-files-found':'error','retention-days':3}},
    bench('stamp upload-end'),upload('winner-evidence-prep','bench-evidence/*\n!bench-evidence/prepared.tar\n'),
  ],{env:{...env,CSC_IDENTITY_AUTO_DISCOVERY:'false'}});
  const inventory=job('Winner diagnostic - immutable inventory and default receipts',[
    ...setup,
    {run:'node scripts/linux-build-bench.mjs stage receipt-total node ../scripts/linux-speed-winner.mjs receipt',env:{GITHUB_TOKEN:'${{ github.token }}'}},
    upload('winner-evidence-inventory','bench-evidence/'),
  ],{permissions:{contents:'read',actions:'read'}});
  const packages=job('Winner diagnostic - package ${{ matrix.variant }}',[
    ...setup,bench('stage apt-update sudo apt-get update'),bench('stage apt-install sudo apt-get install -y rpm libarchive-tools'),bench('stamp download-start'),
    download('winner-prepared-app','prepared'),bench('stamp download-end'),
    bench('stage package-total node ../scripts/linux-build-bench.mjs package "$BENCH_VARIANT"'),bench('stamp upload-start'),
    upload('winner-evidence-${{ matrix.variant }}','bench-evidence/*'),
  ],{needs:'prep',strategy:{'fail-fast':false,'max-parallel':4,matrix:{variant:['AppImage-default','deb-fast','rpm-fast','pacman-fast']}},env:{...env,BENCH_VARIANT:'${{ matrix.variant }}'}});
  const shards=job('Winner diagnostic - full suite shard ${{ matrix.shard }} of 4',[
    ...setup,bench('stage shard-total node ../scripts/linux-build-bench.mjs shard "$BENCH_SHARD"'),bench('stamp upload-start'),upload('winner-evidence-shard-${{ matrix.shard }}','bench-evidence/*'),
  ],{strategy:{'fail-fast':false,'max-parallel':4,matrix:{shard:[1,2,3,4]}},env:{...env,BENCH_SHARD:'${{ matrix.shard }}'}});
  const gate=job('Winner diagnostic - validate all evidence (not a required build check)',[
    checkout,{uses:'actions/setup-node@v7',with:{'node-version':22}},bench('stamp download-start'),
    {uses:'actions/download-artifact@v8',with:{pattern:'winner-evidence-*',path:'results'}},bench('stamp download-end'),
    {if:'always()',run:'node scripts/linux-build-bench.mjs timeline'},
    {if:'always()',run:'node scripts/linux-speed-winner.mjs aggregate'},
    upload('winner-diagnostic-linux-summary','bench-evidence/*'),
  ],{needs:['prep','inventory','packages','shards'],if:`always() && ${guard}`,'timeout-minutes':10,env:{...env,BENCH_NEEDS:'${{ toJSON(needs) }}'}});
  return {name:'EXPERIMENT ONLY - Linux frozen-source winner trial',on:{pull_request:null},permissions:{contents:'read'},concurrency:{group:'linux-speed-winner-${{ github.event.pull_request.number }}','cancel-in-progress':true},jobs:{prep,inventory,packages,shards,gate}};
}
