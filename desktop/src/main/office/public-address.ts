// Which network addresses a picture download may reach (finish plan Task 1, fix round 1).
// WHY: a web address in a document (typed into "Image from URL", or in pasted web content) makes
// MAIN fetch it. Main can reach this machine and the local network — a router page, a printer, a
// dev server, a cloud metadata endpoint — so only public internet addresses are allowed. The
// check runs on the RESOLVED addresses, so a name like "localhost", or any name that resolves
// into these ranges, is refused as well.
import { BlockList, isIP } from 'node:net';

// [first address, prefix length, family, the reason logged when refused]
const RANGES: [string, number, 'ipv4' | 'ipv6', string][] = [
  ['0.0.0.0', 8, 'ipv4', 'unspecified'],
  ['127.0.0.0', 8, 'ipv4', 'loopback'],
  ['10.0.0.0', 8, 'ipv4', 'private'],
  ['172.16.0.0', 12, 'ipv4', 'private'],
  ['192.168.0.0', 16, 'ipv4', 'private'],
  ['169.254.0.0', 16, 'ipv4', 'link-local'],
  ['100.64.0.0', 10, 'ipv4', 'carrier-grade NAT'],
  ['192.0.0.0', 24, 'ipv4', 'special-purpose'],
  ['198.18.0.0', 15, 'ipv4', 'special-purpose'],
  ['224.0.0.0', 4, 'ipv4', 'multicast'],
  ['240.0.0.0', 4, 'ipv4', 'reserved'],
  ['::', 128, 'ipv6', 'unspecified'],
  ['::1', 128, 'ipv6', 'loopback'],
  ['fc00::', 7, 'ipv6', 'unique-local'],
  ['fe80::', 10, 'ipv6', 'link-local'],
  ['fec0::', 10, 'ipv6', 'site-local'],
  ['ff00::', 8, 'ipv6', 'multicast'],
  ['64:ff9b:1::', 48, 'ipv6', 'local NAT64'],
];

// One list per reason, so the log can say which class was refused. WHY node's BlockList: it
// also matches an IPv4-mapped IPv6 address (::ffff:127.0.0.1, ::ffff:7f00:1) against the IPv4
// ranges, which a hand-written prefix match easily misses.
const LISTS = RANGES.map(([addr, prefix, family, why]) => {
  const list = new BlockList();
  list.addSubnet(addr, prefix, family);
  return { list, why };
});

/** null when `ip` is a public address; otherwise the class it belongs to (for the log). A
 *  string that is not an IP address at all is refused too. */
export function nonPublicReason(ip: string): string | null {
  const bare = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, ''); // [v6] literal, zone id
  const v = isIP(bare);
  if (!v) return 'not an address';
  for (const { list, why } of LISTS) if (list.check(bare, v === 4 ? 'ipv4' : 'ipv6')) return why;
  return null;
}
