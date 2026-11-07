// FIAB 5 (6 November): the files a branch brings, counted from its merge base with main, never from the HEAD of the
// main checkout (which may sit on another branch, or behind main): what main gained meanwhile is not the branch's.
//   guardFilesArgs(rev, base) → the git arguments  ·  filesOf(out) → the list, one path per line
export const guardFilesArgs = (rev, base = 'main') => ['diff', '--name-only', '--no-renames', `${base}...${rev}`];
export const filesOf = (out) => String(out || '').split('\n').map((l) => l.trim()).filter(Boolean);
