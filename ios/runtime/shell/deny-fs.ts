// deny-fs.ts — hides the app's credential files from the built-in shell.
//
// WHY (iPhone app, card #89): the shell sees the whole Documents folder (it is "HOME", and what the Files app shows),
// and a file such as `~/.claude.json` or `~/.git-credentials` can hold a key. The assistant's own Read/Grep tools already
// refuse those (`isCredentialPath`, one shared list), so the shell must not be a way around that rule. This wraps the
// shell's file system: a credential file looks absent when listed, and a read, write, copy or move of it is refused.
// It follows links, so a link pointing at a credential file is refused too. The app's own key store is not in the shell's
// view at all (it is not mounted), so this layer is only about files inside HOME.
import { isCredentialPath } from '../../../desktop/src/main/harness/tools/credential-paths';

/** Which arguments of each file-system call are paths. */
const PATH_ARGS: Record<string, number[]> = {
  readFile: [0], readFileBytes: [0], readFileBuffer: [0], writeFile: [0], appendFile: [0], exists: [0], stat: [0], lstat: [0],
  mkdir: [0], createExclusive: [0], readdir: [0], readdirWithFileTypes: [0], rm: [0], cp: [0, 1], mv: [0, 1], chmod: [0],
  symlink: [1], link: [0, 1], readlink: [0], realpath: [0], utimes: [0],
};

type Fs = Record<string, any>;

/** `homes` = every spelling of the Documents folder (the logical path and the real one: iOS reaches it through /var). */
export function denyCredentialFiles<T extends object>(inner: T, homes: string[]): T {
  const fs = inner as Fs;
  const lexical = (p: string) => homes.some((h) => isCredentialPath(p, h));
  // A link can name a credential file under an innocent name, so the place it really leads is checked as well.
  const refused = async (p: string) => {
    if (lexical(p)) return true;
    try { return lexical(await fs.realpath(p)); } catch { return false; }
  };
  const join = (dir: string, name: string) => `${dir === '/' ? '' : dir}/${name}`;
  // WHY "no such file", not "permission denied": just-bash turns only a "no such file" error into a normal command failure
  // ("cat: x: No such file or directory", `echo > x` fails with exit 1); any other kind aborts the whole script and throws
  // away its earlier output. And for a hidden file "it is not there" is what the listing says too.
  const deny = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });

  const wrapped: Fs = {
    async cp(src: string, dest: string, opts?: any) {
      for (const p of [src, dest]) if (await refused(p)) throw deny(p);
      // A folder copy is done inside the file system in one go, which would carry a hidden file along: walk it here instead.
      if (opts?.recursive && (await fs.stat(src)).isDirectory) {
        await fs.mkdir(dest, { recursive: true });
        for (const name of await wrapped.readdir(src)) await wrapped.cp(join(src, name), join(dest, name), opts);
        return;
      }
      return fs.cp(src, dest, opts);
    },
    async readdir(dir: string) {
      const names: string[] = await fs.readdir(dir);
      const keep = await Promise.all(names.map(async (n) => !(await refused(join(dir, n)))));
      return names.filter((_, i) => keep[i]);
    },
    async readdirWithFileTypes(dir: string) {
      const entries: Array<{ name: string }> = await fs.readdirWithFileTypes(dir);
      const keep = await Promise.all(entries.map(async (e) => !(await refused(join(dir, e.name)))));
      return entries.filter((_, i) => keep[i]);
    },
  };

  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      if (prop in wrapped) return wrapped[prop];
      const idx = PATH_ARGS[prop];
      if (!idx) return value.bind(target);
      return async (...args: any[]) => {
        for (const i of idx) {
          const p = args[i];
          if (typeof p === 'string' && (await refused(p))) {
            if (prop === 'exists') return false; // `[ -f x ]` just says no
            throw deny(p);
          }
        }
        return value.apply(target, args);
      };
    },
  });
}
