// Is this copy of YouCoded an official release, built by the release workflows?
//
// WHY a file the release workflows rewrite (scripts/stamp-official-build.mjs), not a
// runtime guess: only releases should count in the owner's analytics (Destin,
// 2026-10-31, analytics deck D-1). A dev window, a build someone made from the source
// code, and a `-releasetest`/test-build installer all leave this `false`, so their
// check-ins are never sent — a volunteer developer testing a change no longer looks
// like a real user. The stamp script refuses to run unless it finds this exact line.
export const OFFICIAL_BUILD: boolean = false;
