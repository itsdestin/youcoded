#!/usr/bin/env python3
# patch-musl.py <musl source dir> — musl's resolver reads its /etc files from $YOUCODED_ETC when set.
#
# WHY (2026-10-14, Android clean rebuild): an Android app cannot create /etc/resolv.conf, and musl reads
# it with an internal open the compatibility shim (ycshim.c) cannot see. Without this, every name lookup
# in Node, git and Claude Code fails with EAI_AGAIN (seen on a Galaxy Z Flip7). The app writes
# $YOUCODED_ETC/resolv.conf from the phone's active network. Idempotent.
import pathlib
import sys

src = pathlib.Path(sys.argv[1])
DECL = 'char *__yc_etc(const char *name, const char *dflt, char *buf, unsigned long len);\n'
FILES = {
    'src/network/resolvconf.c': ['resolv.conf'],
    'src/network/lookup_serv.c': ['services'],
    'src/network/lookup_name.c': ['hosts'],
    'src/network/getnameinfo.c': ['hosts', 'services'],
}
for rel, names in FILES.items():
    p = src / rel
    s = p.read_text()
    if '__yc_etc' in s:
        continue
    s = s.replace('#include', DECL + '#include', 1)
    for n in names:
        old = f'__fopen_rb_ca("/etc/{n}", '
        if old not in s:
            sys.exit(f'patch-musl: {rel} no longer opens /etc/{n} the expected way; update this patch')
        s = s.replace(old, f'__fopen_rb_ca(__yc_etc("{n}", "/etc/{n}", (char[256]){{0}}, 256), ')
    p.write_text(s)

(src / 'src/network/yc_etc.c').write_text('''/* YouCoded (Android): the resolver's /etc files come from $YOUCODED_ETC when set and present. */
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
char *__yc_etc(const char *name, const char *dflt, char *buf, unsigned long len)
{
	const char *d = getenv("YOUCODED_ETC");
	size_t dl, nl;
	if (!d || !*d) return (char *)dflt;
	dl = strlen(d); nl = strlen(name);
	if (dl + nl + 2 > len) return (char *)dflt;
	memcpy(buf, d, dl); buf[dl] = '/'; memcpy(buf + dl + 1, name, nl + 1);
	if (access(buf, R_OK) != 0) return (char *)dflt;
	return buf;
}
''')
