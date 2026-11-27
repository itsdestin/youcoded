// stubs.ts — honest answers for programs that cannot exist on an iPhone.
//
// WHY (iPhone app, card #89): the built-in shell has no Python, Node, installers or compilers. Left alone, a missing
// program says only "command not found", and the assistant tries again or tells the person to install it. These are
// NOT registered as commands (so `which`, `command -v` and `type` truthfully say they are absent); instead, when a
// command ends with "command not found" for one of them, that one line is replaced by a sentence saying what is
// missing and what to use instead.
const NA = 'is not available on this iPhone';
const TABLE: Array<[names: string, message: string]> = [
  ['python python3 pip pip3', `${NA}: there is no Python here. For data work use jq, awk, sort and cut; for anything bigger, write the file and say what it needs.`],
  ['node npm npx yarn pnpm deno bun js-exec', `${NA}: there is no Node here. Use jq or awk for data work; for a web page, just write the .html file.`],
  ['sqlite3', `${NA}: there is no SQLite here. Use jq, awk or sort on a text or JSON file.`],
  ['sudo apt apt-get brew yum dnf pacman snap', 'cannot be used here: programs cannot be installed on this iPhone. Only the built-in commands exist (run `help`).'],
  ['make gcc cc clang cargo go ruby perl php java ffmpeg convert magick pandoc ssh scp rsync docker gh open vim nano vi less', `${NA}.`],
];

const MESSAGES = new Map<string, string>(TABLE.flatMap(([names, msg]) => names.split(' ').map((n) => [n, msg] as const)));

/** The names this table speaks for (a test pins that none of them is also a real command). */
export const STUB_NAMES: readonly string[] = [...MESSAGES.keys()];

/** Replace `bash: NAME: command not found` with the sentence for NAME, when there is one. just-bash words the same
 *  situation differently for python, python3 and sqlite3 ("not available in browser environments … use the Node.js
 *  bundle"), which would send the assistant looking for something that does not exist here: that line is replaced too. */
export function explainMissingCommands(stderr: string): string {
  return stderr.replace(/^bash: ([^\s:]+): command (?:not found|not available in browser environments\..*)$/gm, (line, name: string) => {
    const msg = MESSAGES.get(name);
    return msg ? `${name} ${msg}` : line;
  });
}
