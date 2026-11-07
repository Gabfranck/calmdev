// Called by the app (src-tauri/src/main.rs) when the server does not answer: a title and one sentence that says what to do.
// `text` in backquotes becomes code the developer can select and copy.
window.calmdevFail = (title, detail) => {
  document.body.classList.add('failed');
  document.getElementById('title').textContent = title;
  const p = document.getElementById('detail');
  p.textContent = '';
  String(detail).split('`').forEach((part, i) => {
    if (i % 2) { const c = document.createElement('code'); c.textContent = part; p.append(c); } else p.append(part);
  });
};
