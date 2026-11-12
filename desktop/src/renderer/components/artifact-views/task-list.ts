// Ticking a markdown task list (`- [ ] item`) in the file viewer.
//
// WHY positions in the SOURCE, matched to checkboxes by order: the rendered page
// shows one <input type=checkbox> per task item, in document order, and the
// source has one `[ ]`/`[x]` marker per task item in the same order. Counting
// markers (skipping code fences, where the renderer draws no checkbox) lets a
// tick on the Nth checkbox edit exactly the Nth marker, without touching the
// markdown renderer.

const FENCE_RE = /^\s{0,3}(```+|~~~+)/;
// A list marker, then [ ] / [x] / [X]. Block-quote prefixes ("> - [ ]") are allowed.
const TASK_RE = /^((?:\s*>)*\s*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\]\s)/;

/** Offsets (into `content`) of the character inside each task marker's brackets, in document order. */
export function findTaskMarkers(content: string): number[] {
  const out: number[] = [];
  let fence: string | null = null;
  let offset = 0;
  for (const line of content.split('\n')) {
    const f = FENCE_RE.exec(line);
    if (f) {
      const mark = f[1][0];
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
    } else if (fence === null) {
      const m = TASK_RE.exec(line);
      if (m) out.push(offset + m[1].length);
    }
    offset += line.length + 1;
  }
  return out;
}

/** `content` with the Nth task marker ticked/unticked; null when there is no such marker. */
export function setTaskChecked(content: string, index: number, checked: boolean): string | null {
  const at = findTaskMarkers(content)[index];
  if (at === undefined) return null;
  return content.slice(0, at) + (checked ? 'x' : ' ') + content.slice(at + 1);
}
