// The "is this a fixed local disk?" decision, fed mocked machine facts (never the real one).
import { describe, it, expect } from 'vitest';
import {
  isCloudSyncPath, judgeLinuxMount, judgeMacVolume, judgeWindowsDrive, judgePathVolume, type VolumeDeps, type LinuxDeviceFacts,
} from '../../src/main/artifacts/volume-safety';

const internal: LinuxDeviceFacts = { sysPath: '/sys/devices/pci0000:00/0000:00:1d.0/nvme/nvme0/nvme0n1/nvme0n1p2', removable: '0', slaves: [] };
const usb: LinuxDeviceFacts = { sysPath: '/sys/devices/pci0000:00/0000:00:14.0/usb2/2-1/host6/target6:0:0/block/sdb/sdb1', removable: '0', slaves: [] };
const mount = (o: Partial<Parameters<typeof judgeLinuxMount>[0] & object> = {}) => ({ mountPoint: '/', fsType: 'ext4', source: '/dev/nvme0n1p2', device: internal, ...o });

describe('cloud-sync folders', () => {
  it.each(['/home/u/Dropbox/p', 'C:\\Users\\u\\OneDrive - Acme\\p', '/Users/u/Library/CloudStorage/GoogleDrive-x/p', '/Users/u/Library/Mobile Documents/com~apple~CloudDocs/p', '/home/u/Google Drive/p', '/home/u/iCloud Drive/p'])('%s', (p) => {
    expect(isCloudSyncPath(p)).toBe(true);
  });
  it('ordinary folders pass', () => expect(isCloudSyncPath('/home/u/projects/app')).toBe(false));
});

describe('Linux', () => {
  it('an internal disk is safe', () => expect(judgeLinuxMount(mount(), '/home/u/p').safe).toBe(true));
  it('a USB disk is not, even though it says removable=0', () => expect(judgeLinuxMount(mount({ mountPoint: '/run/media/u/X', source: '/dev/sdb1', device: usb }), '/run/media/u/X/p').safe).toBe(false));
  it('a removable flag is not', () => expect(judgeLinuxMount(mount({ device: { ...internal, removable: '1' } }), '/home/u/p').safe).toBe(false));
  it('network and fuse mounts are not', () => {
    for (const fsType of ['nfs4', 'cifs', 'fuse.sshfs', 'fuse.rclone', '9p', 'tmpfs', 'overlay']) expect(judgeLinuxMount(mount({ fsType }), '/home/u/p').safe).toBe(false);
  });
  it('a source that is not a device is not', () => expect(judgeLinuxMount(mount({ source: '//srv/share' }), '/home/u/p').safe).toBe(false));
  it('unknown disk facts are not', () => expect(judgeLinuxMount(mount({ device: null }), '/home/u/p').safe).toBe(false));
  it('an unplugged drive leaves a stub folder on the root disk: not safe', () => {
    expect(judgeLinuxMount(mount(), '/run/media/u/BACKUP/p').safe).toBe(false);
    expect(judgeLinuxMount(mount(), '/mnt/data/p').safe).toBe(false);
  });
  it('a mapper stack is safe only when every layer is', () => {
    expect(judgeLinuxMount(mount({ device: { sysPath: '/sys/devices/virtual/block/dm-0', removable: null, slaves: [internal] } }), '/home/u/p').safe).toBe(true);
    expect(judgeLinuxMount(mount({ device: { sysPath: '/sys/devices/virtual/block/dm-0', removable: null, slaves: [usb] } }), '/home/u/p').safe).toBe(false);
  });
  it('no mount table is not', () => expect(judgeLinuxMount(null, '/home/u/p').safe).toBe(false));
});

describe('macOS', () => {
  const ok = { internal: true, removableMedia: false, ejectable: false, network: false };
  it('the internal startup volume is safe', () => expect(judgeMacVolume({ mountPoint: '/System/Volumes/Data', info: ok }, '/Users/u/p').safe).toBe(true));
  it('external, removable, network, unknown are not', () => {
    for (const info of [{ ...ok, internal: false }, { ...ok, removableMedia: true }, { ...ok, ejectable: true }, { ...ok, network: true }, null]) {
      expect(judgeMacVolume({ mountPoint: '/Volumes/X', info }, '/Volumes/X/p').safe).toBe(false);
    }
  });
  it('an unmounted /Volumes/X folder resolves to the startup disk: not safe', () => {
    expect(judgeMacVolume({ mountPoint: '/', info: ok }, '/Volumes/Backup/p').safe).toBe(false);
  });
});

describe('Windows', () => {
  it('fixed + internal bus is safe', () => expect(judgeWindowsDrive({ letter: 'C', driveType: 3, busType: 'NVMe' }, 'C:\\p').safe).toBe(true));
  it('a USB hard drive (reports fixed) is not', () => expect(judgeWindowsDrive({ letter: 'E', driveType: 3, busType: 'USB' }, 'E:\\p').safe).toBe(false));
  it('removable, network, missing, unknown bus, UNC are not', () => {
    expect(judgeWindowsDrive({ letter: 'E', driveType: 2, busType: '' }, 'E:\\p').safe).toBe(false);
    expect(judgeWindowsDrive({ letter: 'Z', driveType: 4, busType: '' }, 'Z:\\p').safe).toBe(false);
    expect(judgeWindowsDrive({ letter: 'F', driveType: null, busType: '' }, 'F:\\p').safe).toBe(false);
    expect(judgeWindowsDrive({ letter: 'D', driveType: 3, busType: '' }, 'D:\\p').safe).toBe(false);
    expect(judgeWindowsDrive(null, '\\\\srv\\share\\p').safe).toBe(false);
  });
});

describe('judgePathVolume end to end with fake machine facts', () => {
  const files: Record<string, string> = {
    '/proc/self/mountinfo': '1 0 259:2 / / rw - ext4 /dev/nvme0n1p2 rw\n50 1 8:17 / /run/media/u/USB\\040DISK rw - ext4 /dev/sdb1 rw\n',
    '/sys/devices/pci0000:00/nvme/nvme0n1/nvme0n1p2/partition': '2', '/sys/devices/pci0000:00/nvme/nvme0n1/removable': '0',
    '/sys/devices/pci0000:00/usb2/2-1/block/sdb/sdb1/partition': '1', '/sys/devices/pci0000:00/usb2/2-1/block/sdb/removable': '0',
  };
  const real: Record<string, string> = {
    '/sys/class/block/nvme0n1p2': '/sys/devices/pci0000:00/nvme/nvme0n1/nvme0n1p2',
    '/sys/class/block/sdb1': '/sys/devices/pci0000:00/usb2/2-1/block/sdb/sdb1',
  };
  const dirs = new Set(['/', '/home', '/home/u', '/run', '/run/media', '/run/media/u', '/run/media/u/USB DISK']);
  const deps: VolumeDeps = {
    platform: 'linux',
    realpath: async (p) => real[p] ?? p,
    isDir: async (p) => dirs.has(p),
    readText: async (p) => files[p] ?? null,
    readDir: async () => [],
    run: async () => null,
  };
  it('home on the internal disk', async () => expect((await judgePathVolume('/home/u/p', deps)).safe).toBe(true));
  it('a folder on the mounted USB disk', async () => expect((await judgePathVolume('/run/media/u/USB DISK/p', deps)).safe).toBe(false));
  it('a drive that is not mounted', async () => expect((await judgePathVolume('/run/media/u/GONE/p', deps)).safe).toBe(false));
  it('a cloud folder', async () => expect((await judgePathVolume('/home/u/Dropbox/p', deps)).safe).toBe(false));
  it('macOS asks df then diskutil', async () => {
    const run = async (cmd: string) => cmd.endsWith('df')
      ? 'Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk3s5 1 1 1 10% /System/Volumes/Data\n'
      : '<dict><key>Internal</key><true/><key>RemovableMediaOrExternalDevice</key><false/><key>Ejectable</key><false/></dict>';
    expect((await judgePathVolume('/Users/u/p', { ...deps, platform: 'darwin', run, isDir: async (p) => p === '/Users/u' || p === '/Users' || p === '/' })).safe).toBe(true);
  });
  it('Windows: failed or missing PowerShell answer is not safe; fixed NVMe is', async () => {
    expect((await judgePathVolume('E:\\p', { ...deps, platform: 'win32', run: async () => null })).safe).toBe(false);
    expect((await judgePathVolume('C:\\p', { ...deps, platform: 'win32', run: async () => '3|NVMe\r\n' })).safe).toBe(true);
    expect((await judgePathVolume('E:\\p', { ...deps, platform: 'win32', run: async () => '3|USB\r\n' })).safe).toBe(false);
  });
});
