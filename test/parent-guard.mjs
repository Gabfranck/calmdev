// Loaded (node --import) into every server a test spawns, through NODE_OPTIONS from test/test-env.mjs and test/isolated-env.mjs.
// A test killed in mid-flight (SIGKILL, a crashed runner, a killed suite) runs no exit handler: its servers stayed up for hours
// (two escadrille-verify-* suites left 5 servers and 6 fake claudes for 5 h, 7 November). The server watches its parent and
// stops with it: SIGTERM, then SIGKILL after 3 s. The fake claudes it started are node processes under the same NODE_OPTIONS:
// they follow their server the same way. A parent already init at the start (ppid 1) is not watched.
const parent = process.ppid;
if (parent > 1) {
  const alive = () => { try { process.kill(parent, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const timer = setInterval(() => {
    if (process.ppid === parent && alive()) return;
    clearInterval(timer);
    try { process.kill(process.pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(process.pid, 'SIGKILL'); } catch {} }, 3000).unref();
  }, 1000);
  timer.unref();
}
