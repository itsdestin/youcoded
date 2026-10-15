// claude-launch.c — usr/bin/claude: starts Anthropic's Claude Code binary, unmodified, through the bundled musl loader.
//
// WHY (2026-10-15): Anthropic's terms for offering Claude Code in a product require that "the Claude Code binary must
// not be modified" (code.claude.com/docs/en/legal-and-compliance). The official linux-arm64-musl build names
// /lib/ld-musl-aarch64.so.1 as its loader, which Android does not have, so instead of rewriting that header the
// binary ships byte-for-byte as libclaude.so and this launcher runs it the way any dynamic program is run:
//   <loader> --argv0 claude <native-lib-dir>/libclaude.so <args…>
// Proved on a phone before the rebuild (A0): version, a network call and the full TUI under a terminal.
// The loader path is fixed at build time (LOADER, per package id); the binary sits next to this launcher.
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef LOADER
#error "build with -DLOADER=\"/data/data/<appId>/files/usr/lib/ld-musl-aarch64.so.1\""
#endif

int main(int argc, char **argv) {
  char self[PATH_MAX];
  ssize_t n = readlink("/proc/self/exe", self, sizeof self - 1);
  if (n <= 0) { perror("claude: cannot find itself"); return 127; }
  self[n] = 0;
  char *slash = strrchr(self, '/');
  if (!slash) return 127;
  char target[PATH_MAX];
  if (snprintf(target, sizeof target, "%.*s/libclaude.so", (int)(slash - self), self) >= (int)sizeof target) return 127;

  char **nargv = calloc((size_t)argc + 5, sizeof(char *));
  if (!nargv) return 127;
  int k = 0;
  nargv[k++] = (char *)LOADER;
  nargv[k++] = "--argv0";
  nargv[k++] = "claude";
  nargv[k++] = target;
  for (int i = 1; i < argc; i++) nargv[k++] = argv[i];
  execv(LOADER, nargv);
  fprintf(stderr, "claude: could not start (%s)\n", strerror(errno));
  return 127;
}
