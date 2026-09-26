// peer-cred.ts — the kernel-verified identity of whoever connected to the
// askpass socket. Design §2.2, §3 item 4; review 1 D3 ("the pid a connecting
// helper claims is self-reported, not kernel-verified"); review 2 E6 (the
// startup self-test, and the fd-extraction risk it exists to catch).
//
// WHY this is the ONLY source of pid truth AskpassServer trusts: the askpass
// helper sends nothing but `{"v":1}\n` (askpass.cjs, by design — no pid, no
// argv). Anything a peer claims about itself is worthless as identity;
// getsockopt(SO_PEERCRED)/getsockopt(LOCAL_PEERPID) is latched by the KERNEL
// at connect() time to the credentials of the process that actually called
// connect(), and cannot be spoofed by whatever that process then says over
// the wire.
'use strict';

import type { Socket } from 'net';

export interface PeerCred {
  pid: number;
  uid: number;
  gid: number;
}

// Lazy — this file is required from the main process's own module graph
// (unlike askpass.cjs, which is a standalone script outside app.asar and
// resolves koffi relative to its own directory). Ordinary require()
// resolution is correct here.
let koffiModule: unknown = null;
function koffi(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  if (!koffiModule) koffiModule = require('koffi');
  return koffiModule;
}

let libcHandle: any = null;
function libc(): any {
  if (!libcHandle) libcHandle = koffi().load('libc.so.6');
  return libcHandle;
}

let libSystemHandle: any = null;
function libSystem(): any {
  if (!libSystemHandle) libSystemHandle = koffi().load('libSystem.B.dylib');
  return libSystemHandle;
}

const SOL_SOCKET = 1;
const SO_PEERCRED = 17; // Linux

const SOL_LOCAL = 0; // macOS
const LOCAL_PEERPID = 2; // macOS

let ucredType: unknown = null;
let linuxGetsockopt: ((fd: number, level: number, optname: number, optval: unknown, optlen: unknown) => number) | null = null;
function linuxGetsockoptFn(): NonNullable<typeof linuxGetsockopt> {
  if (linuxGetsockopt) return linuxGetsockopt;
  const k = koffi();
  // struct ucred { pid_t pid; uid_t uid; gid_t gid; } — three 32-bit ints,
  // exactly Linux's <bits/socket.h> layout.
  ucredType = k.struct('ucred', { pid: 'int32_t', uid: 'uint32_t', gid: 'uint32_t' });
  const fn = libc().func(
    'int getsockopt(int sockfd, int level, int optname, _Out_ ucred *optval, _Inout_ uint32_t *optlen)',
  ) as NonNullable<typeof linuxGetsockopt>;
  linuxGetsockopt = fn;
  return fn;
}

let darwinGetsockopt: ((fd: number, level: number, optname: number, optval: unknown, optlen: unknown) => number) | null = null;
function darwinGetsockoptFn(): NonNullable<typeof darwinGetsockopt> {
  if (darwinGetsockopt) return darwinGetsockopt;
  const fn = libSystem().func(
    'int getsockopt(int sockfd, int level, int optname, _Out_ int32_t *optval, _Inout_ uint32_t *optlen)',
  ) as NonNullable<typeof darwinGetsockopt>;
  darwinGetsockopt = fn;
  return fn;
}

/**
 * Pull the raw fd out of a `net.Socket` (connecting OR accepted — both have
 * a `_handle` with `.fd` once the connection is established).
 *
 * WHY the shape check (review 2 E6): `net.Socket` has NO PUBLIC API for its
 * underlying fd. `_handle.fd` is undocumented/private and could disappear or
 * change shape on a future Node/Electron bump with no semver signal at all —
 * so every caller here treats anything other than a small non-negative
 * integer as "cannot resolve fd" and fails closed, rather than trusting a
 * malformed value.
 */
function extractFd(socket: Socket): number | null {
  const handle = (socket as unknown as { _handle?: { fd?: unknown } })._handle;
  const fd = handle?.fd;
  if (typeof fd !== 'number' || !Number.isInteger(fd) || fd < 0 || fd > 0xffff) return null;
  return fd;
}

function readLinuxPeerCred(fd: number): PeerCred | null {
  void ucredType; // referenced only to force struct registration before use
  const fn = linuxGetsockoptFn();
  const out: { pid?: number; uid?: number; gid?: number } = {};
  const optlen = [12]; // sizeof(ucred): three int32s
  const rc = fn(fd, SOL_SOCKET, SO_PEERCRED, out, optlen);
  if (rc !== 0) return null;
  if (typeof out.pid !== 'number' || typeof out.uid !== 'number' || typeof out.gid !== 'number') return null;
  if (!Number.isInteger(out.pid) || out.pid <= 0) return null;
  return { pid: out.pid, uid: out.uid, gid: out.gid };
}

function readDarwinPeerPid(fd: number): PeerCred | null {
  const fn = darwinGetsockoptFn();
  const out = [0];
  const optlen = [4]; // sizeof(pid_t)
  const rc = fn(fd, SOL_LOCAL, LOCAL_PEERPID, out, optlen);
  if (rc !== 0) return null;
  const pid = out[0];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  // getsockopt(LOCAL_PEERPID) does not also hand back uid/gid the way
  // SO_PEERCRED does — callers on macOS resolve those (if needed) from
  // /proc-equivalent state via ProcReader, keyed off this pid.
  return { pid, uid: -1, gid: -1 };
}

/**
 * The kernel-verified peer of `socket` — a connecting or just-accepted unix
 * socket. Returns null (never throws) on any platform this isn't
 * implemented for, or on any failure to resolve the fd or read the kernel
 * state; callers must treat null as "cannot verify", i.e. refuse.
 */
export function peerCredPid(socket: Socket): PeerCred | null {
  const fd = extractFd(socket);
  if (fd === null) return null;
  try {
    if (process.platform === 'linux') return readLinuxPeerCred(fd);
    if (process.platform === 'darwin') return readDarwinPeerPid(fd);
    return null;
  } catch {
    return null;
  }
}

/**
 * Startup self-test (design §2.2, review 2 E6): open a REAL loopback
 * connection to our own listening socket and confirm the kernel says its
 * peer (i.e. us, on the other end) is this exact process. This is the only
 * thing that stands between "SO_PEERCRED/LOCAL_PEERPID via `_handle.fd`
 * still works on this shipped Electron/Node build" and silently trusting
 * nothing (or worse, silently falling back to a self-reported pid). A
 * connecting client's peer, over a unix socket, is whoever is on the other
 * end — since AskpassServer listens in this same process, a successful
 * connect's peer credentials must read back as `process.pid`; anything else
 * means this mechanism cannot be trusted at all and the caller must not
 * start the server.
 */
export async function selfTest(socketPath: string): Promise<boolean> {
  const net: typeof import('net') = require('net');
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const socket: import('net').Socket = net.createConnection({ path: socketPath });
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // already gone
      }
      resolve(ok);
    };
    socket.once('connect', () => {
      try {
        const cred = peerCredPid(socket);
        finish(cred !== null && cred.pid === process.pid);
      } catch {
        finish(false);
      }
    });
    socket.once('error', () => finish(false));
  });
}
