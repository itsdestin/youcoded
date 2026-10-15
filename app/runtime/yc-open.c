// yc-open.c — `xdg-open <url>` for the Android app: asks the app to open a web link in the phone's browser.
//
// WHY (2026-10-14, Android clean rebuild): Claude Code's sign-in (`claude auth login`) and other tools open
// links with xdg-open, which Android does not have. This tiny program is installed as usr/bin/xdg-open and
// sends {"method":"openExternal","params":{"url":…}} over the app's host socket (YOUCODED_HOST_SOCKET,
// the same line the backend uses — HostSocketServer.kt), then exits 0 when the app says it opened it.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: xdg-open <url>\n"); return 1; }
  const char *url = argv[1];
  if (strncmp(url, "http://", 7) && strncmp(url, "https://", 8)) { fprintf(stderr, "xdg-open: only web links can be opened on the phone\n"); return 1; }
  const char *name = getenv("YOUCODED_HOST_SOCKET");
  if (!name || name[0] != '@') { fprintf(stderr, "xdg-open: not running inside the YouCoded app\n"); return 1; }

  struct sockaddr_un addr; memset(&addr, 0, sizeof addr);
  addr.sun_family = AF_UNIX;
  size_t n = strlen(name + 1);
  if (n + 1 > sizeof addr.sun_path) return 1;
  memcpy(addr.sun_path + 1, name + 1, n); // abstract namespace: leading NUL
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0 || connect(fd, (struct sockaddr *)&addr, (socklen_t)(sizeof(sa_family_t) + 1 + n)) != 0) {
    fprintf(stderr, "xdg-open: could not reach the app\n"); return 1;
  }

  // JSON-escape the URL (quotes, backslashes, control characters).
  char msg[8192]; size_t o = 0;
  o += (size_t)snprintf(msg, sizeof msg, "{\"id\":1,\"method\":\"openExternal\",\"params\":{\"url\":\"");
  for (const char *c = url; *c && o < sizeof msg - 16; c++) {
    if (*c == '"' || *c == '\\') { msg[o++] = '\\'; msg[o++] = *c; }
    else if ((unsigned char)*c < 0x20) o += (size_t)snprintf(msg + o, sizeof msg - o, "\\u%04x", *c);
    else msg[o++] = *c;
  }
  o += (size_t)snprintf(msg + o, sizeof msg - o, "\"}}\n");
  if (write(fd, msg, o) != (ssize_t)o) return 1;

  char reply[1024]; ssize_t r = read(fd, reply, sizeof reply - 1);
  close(fd);
  if (r <= 0) return 1;
  reply[r] = 0;
  if (strstr(reply, "\"error\"")) { fprintf(stderr, "xdg-open: %s", reply); return 1; }
  return 0;
}
