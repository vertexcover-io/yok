// Runs inside an HTML artifact's sandboxed frame. The frame has an opaque origin, so the viewer
// cannot read its DOM: selections, highlights and clicks cross by postMessage instead.
(() => {
  const MARK_CSS =
    "mark.hl{color:inherit;background:#fde7a4;border-bottom:2px solid #c99400;border-radius:2px;cursor:pointer;padding:0 1px}mark.hl.k-delete{background:#fbe2df;border-bottom-color:#b2362d;text-decoration:line-through}mark.hl.k-replace{background:#ebe5fa;border-bottom-color:#6449b0}mark.hl.is-draft{background:transparent;border-bottom-style:dashed}mark.hl.is-done{background:transparent;border-bottom-width:1px}mark.hl.pulse{animation:pulseMark 1.2s ease-out}@keyframes pulseMark{0%,40%{box-shadow:0 0 0 4px #c99400}100%{box-shadow:0 0 0 0 transparent}}";

  const send = (message) => parent.postMessage(message, "*");
  const body = () => document.body;

  const textOffset = (container, offset) => {
    const range = document.createRange();
    range.selectNodeContents(body());
    range.setEnd(container, offset);
    return range.toString().length;
  };

  const elementOf = (node) => (node.nodeType === 1 ? node : node.parentElement);

  function cssPath(node) {
    let cur = elementOf(node);
    const parts = [];
    while (cur && cur !== body()) {
      if (cur.tagName !== "MARK") {
        const same = [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName);
        const nth = same.length > 1 ? `:nth-of-type(${same.indexOf(cur) + 1})` : "";
        parts.unshift(
          cur.tagName.toLowerCase() + (cur.classList[0] ? `.${cur.classList[0]}` : "") + nth,
        );
      }
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function captureSelection() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!body().contains(range.commonAncestorContainer)) return null;
    const raw = range.toString();
    const quote = raw.trim();
    if (!quote) return null;
    const start =
      textOffset(range.startContainer, range.startOffset) + (raw.length - raw.trimStart().length);
    const box = range.getBoundingClientRect();
    return {
      quote,
      start,
      selector: cssPath(range.startContainer),
      rect: { left: box.left, top: box.top, width: box.width, bottom: box.bottom },
    };
  }

  function clearMarks() {
    for (const mark of body().querySelectorAll("mark.hl")) {
      const parentNode = mark.parentNode;
      mark.replaceWith(...mark.childNodes);
      parentNode.normalize();
    }
  }

  function wrapRange({ start, end, id, cls }) {
    const walker = document.createTreeWalker(body(), NodeFilter.SHOW_TEXT);
    const hits = [];
    let pos = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const stop = pos + n.data.length;
      if (stop > start && pos < end)
        hits.push([n, Math.max(start, pos) - pos, Math.min(end, stop) - pos]);
      pos = stop;
      if (pos >= end) break;
    }
    for (const [node, a, b] of hits) {
      let text = node;
      if (a > 0) text = text.splitText(a);
      if (b - a < text.data.length) text.splitText(b - a);
      const mark = document.createElement("mark");
      mark.className = cls;
      mark.dataset.cid = id;
      text.parentNode.insertBefore(mark, text);
      mark.appendChild(text);
    }
  }

  function selectText(text) {
    const walker = document.createTreeWalker(body(), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.data.indexOf(text);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(n, at);
      range.setEnd(n, at + text.length);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
  }

  function focusMark(id) {
    const mark = [...body().querySelectorAll("mark.hl")].find((m) => m.dataset.cid === id);
    if (!mark) return;
    mark.scrollIntoView({ block: "center", behavior: "smooth" });
    mark.classList.remove("pulse");
    void mark.offsetWidth;
    mark.classList.add("pulse");
  }

  const commands = {
    highlight: (m) => {
      clearMarks();
      for (const mark of m.marks) wrapRange(mark);
    },
    focus: (m) => focusMark(m.id),
    select: (m) => selectText(m.text),
    clearSelection: () => document.getSelection()?.removeAllRanges(),
  };

  window.addEventListener("message", (e) => {
    if (e.source !== parent || typeof e.data?.t !== "string") return;
    commands[e.data.t]?.(e.data);
  });

  document.addEventListener("selectionchange", () =>
    send({ t: "selection", sel: captureSelection() }),
  );
  document.addEventListener("click", (e) => {
    const mark = e.target.closest?.("mark[data-cid]");
    if (mark && document.getSelection()?.isCollapsed) send({ t: "mark", id: mark.dataset.cid });
  });

  const style = document.createElement("style");
  style.textContent = MARK_CSS;
  document.head.append(style);
  send({ t: "ready", text: body().textContent });
})();
