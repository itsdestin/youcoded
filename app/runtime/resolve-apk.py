import sys,re
pk={};prov={}
for fn,repo in [('main.idx','main'),('community.idx','community')]:
  for blk in open(fn).read().split('\n\n'):
    d={}
    for l in blk.splitlines():
      if len(l)>2 and l[1]==':': d.setdefault(l[0],l[2:])
    if 'P' not in d: continue
    d['repo']=repo; pk[d['P']]=d
    for p in d.get('p','').split():
      prov.setdefault(re.split('[=<>]',p)[0],d['P'])
seen=[];todo=sys.argv[1:]
while todo:
  n=todo.pop()
  n=re.split('[=<>~]',n)[0]
  if n.startswith('!'):continue
  name=n if n in pk else prov.get(n)
  if not name or name in seen: continue
  seen.append(name)
  todo+=pk[name].get('D','').split()
for s in seen: print(pk[s]['repo'],s,pk[s]['V'],pk[s].get('S'))
