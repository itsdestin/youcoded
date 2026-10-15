// ycshim.c — linked into every bundled musl program (DT_NEEDED, first) so they run inside an Android app.
//
// WHY (2026-10-14, Android clean rebuild; proved on a Galaxy Z Flip7, Android 17, in an untrusted_app sandbox):
//  1. Android's app seccomp filter KILLS a process that calls io_uring_setup (SIGSYS). libuv (Node) probes
//     it when its event loop starts, and UV_USE_IO_URING=0 does not stop the probe. We answer ENOSYS, so
//     libuv falls back to epoll.
//  2. An app may not execve() a file in its own data folder, so a "#!" script there cannot be run by the
//     kernel. We run its interpreter instead, with the script as an argument (reading it is allowed).
//  3. Android has no /bin/sh, /bin/bash or /usr/bin/env. An exec of a missing /bin/* or /usr/bin/* path
//     is retried with the same name looked up in PATH (the bundled bash, env, node…).
//  4. Android has no /etc/resolv.conf, /etc/ssl, … A program opening a missing /etc/<x> gets
//     $YOUCODED_ETC/<x> when that exists (c-ares reads /etc/resolv.conf itself; musl's own resolver is
//     patched separately, see patch-musl.py).
// musl's own execvp/execv call its internal execve, which an interposed execve never sees, so the
// PATH-searching forms are interposed too.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

extern char **environ;

long syscall(long n, ...) {
  va_list ap; va_start(ap, n);
  long a[6]; for (int i = 0; i < 6; i++) a[i] = va_arg(ap, long);
  va_end(ap);
  if (n == SYS_io_uring_setup || n == SYS_io_uring_enter || n == SYS_io_uring_register) { errno = ENOSYS; return -1; }
  static long (*real)(long, ...);
  if (!real) real = (long (*)(long, ...))dlsym(RTLD_NEXT, "syscall");
  return real(n, a[0], a[1], a[2], a[3], a[4], a[5]);
}

// --- /etc redirection -------------------------------------------------------------------------

static const char *etc_redirect(const char *path, char *buf, size_t len) {
  if (!path || strncmp(path, "/etc/", 5) != 0) return path;
  const char *dir = getenv("YOUCODED_ETC");
  if (!dir || !*dir) return path;
  if (snprintf(buf, len, "%s/%s", dir, path + 5) >= (int)len) return path;
  return access(buf, F_OK) == 0 ? buf : path;
}

FILE *fopen(const char *path, const char *mode) {
  static FILE *(*real)(const char *, const char *);
  if (!real) real = dlsym(RTLD_NEXT, "fopen");
  char buf[512];
  return real(etc_redirect(path, buf, sizeof buf), mode);
}

int open(const char *path, int flags, ...) {
  static int (*real)(const char *, int, ...);
  if (!real) real = dlsym(RTLD_NEXT, "open");
  mode_t mode = 0;
  if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); }
  char buf[512];
  return real(etc_redirect(path, buf, sizeof buf), flags, mode);
}

int openat(int dirfd, const char *path, int flags, ...) {
  static int (*real)(int, const char *, int, ...);
  if (!real) real = dlsym(RTLD_NEXT, "openat");
  mode_t mode = 0;
  if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); }
  char buf[512];
  return real(dirfd, etc_redirect(path, buf, sizeof buf), flags, mode);
}

// --- exec -------------------------------------------------------------------------------------

static int find_in_path(const char *name, char *out, size_t len) {
  const char *p = getenv("PATH"); if (!p) return -1;
  while (*p) {
    const char *e = strchr(p, ':'); size_t l = e ? (size_t)(e - p) : strlen(p);
    if (l > 0 && l + strlen(name) + 2 < len) {
      memcpy(out, p, l); out[l] = '/'; strcpy(out + l + 1, name);
      if (access(out, X_OK) == 0) return 0;
    }
    if (!e) break; p = e + 1;
  }
  return -1;
}

static const char *base_name(const char *p) { const char *b = strrchr(p, '/'); return b ? b + 1 : p; }

// A /bin/x, /usr/bin/x or /usr/local/bin/x that does not exist is looked up by name in PATH.
static const char *remap_system_path(const char *path, char *buf, size_t len) {
  if (access(path, X_OK) == 0) return path;
  if (strncmp(path, "/bin/", 5) && strncmp(path, "/usr/bin/", 9) && strncmp(path, "/usr/local/bin/", 15) && strncmp(path, "/sbin/", 6)) return path;
  return find_in_path(base_name(path), buf, len) == 0 ? buf : path;
}

int execve(const char *path, char *const argv[], char *const envp[]) {
  static int (*real)(const char *, char *const[], char *const[]);
  if (!real) real = dlsym(RTLD_NEXT, "execve");
  char mapped[512];
  path = remap_system_path(path, mapped, sizeof mapped);
  char buf[256];
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd >= 0) {
    ssize_t n = read(fd, buf, sizeof buf - 1); close(fd);
    if (n > 2 && buf[0] == '#' && buf[1] == '!') {
      buf[n] = 0; char *nl = strchr(buf, '\n'); if (nl) *nl = 0;
      char *interp = buf + 2; while (*interp == ' ' || *interp == '\t') interp++;
      char *arg = strpbrk(interp, " \t");
      if (arg) { *arg++ = 0; while (*arg == ' ' || *arg == '\t') arg++; if (!*arg) arg = NULL; }
      char resolved[512];
      // "#!/usr/bin/env X": X is the real interpreter, found in PATH.
      if (!strcmp(base_name(interp), "env") && arg) {
        char *sp = strpbrk(arg, " \t"); if (sp) *sp = 0;
        if (find_in_path(arg, resolved, sizeof resolved) != 0) { errno = ENOENT; return -1; }
        interp = resolved; arg = NULL;
      } else {
        const char *m = remap_system_path(interp, resolved, sizeof resolved);
        if (m == resolved) interp = resolved;
      }
      int argc = 0; while (argv[argc]) argc++;
      char **nargv = calloc(argc + 4, sizeof(char *)); if (!nargv) { errno = ENOMEM; return -1; }
      int k = 0;
      nargv[k++] = interp; if (arg) nargv[k++] = arg; nargv[k++] = (char *)path;
      for (int i = 1; i < argc; i++) nargv[k++] = argv[i];
      return real(interp, nargv, envp);
    }
  }
  return real(path, argv, envp);
}

int execvpe(const char *file, char *const argv[], char *const envp[]) {
  if (strchr(file, '/')) return execve(file, argv, envp);
  char full[512];
  if (find_in_path(file, full, sizeof full) != 0) { errno = ENOENT; return -1; }
  return execve(full, argv, envp);
}
int execvp(const char *file, char *const argv[]) { return execvpe(file, argv, environ); }
int execv(const char *path, char *const argv[]) { return execve(path, argv, environ); }
