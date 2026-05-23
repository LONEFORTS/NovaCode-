/**
 * ZoomCode - app.js
 * Mobile C++ IDE with auto-zoom for external keyboards
 * 100% Free | No API keys needed | Piston + Wandbox APIs
 */

"use strict";

// ===== CONSTANTS =====
const ZOOM_SCALE      = 1.85;          // 185% zoom when typing
const ZOOM_IDLE_MS    = 3000;          // milliseconds before zoom-out
const CACHE_TTL_MS    = 60 * 60 * 1000; // 1 hour cache
const PISTON_API      = "https://emkc.org/api/v2/piston/execute";
const WANDBOX_API     = "https://wandbox.org/api/compile.json";

// ===== DOM ELEMENTS =====
const $  = (id) => document.getElementById(id);
const editor        = $("code-editor");
const highlightCode = $("highlight-code");
const lineNums      = $("line-numbers");
const editorContainer = $("editor-container");
const outputPanel   = $("output-panel");
const outputContent = $("output-content");
const outputIcon    = $("output-icon");
const compileBadge  = $("compile-badge");
const compileTime   = $("compile-time");
const toolbar       = $("toolbar");
const mainArea      = $("main-area");
const loadingOverlay = $("loading-overlay");
const toast         = $("toast");
const statusDot     = $("status-dot");
const statusText    = $("status-text");
const statusZoom    = $("status-zoom");
const statusLines   = $("status-lines");
const inputModal    = $("input-modal");
const stdinInput    = $("stdin-input");

// ===== STATE =====
const state = {
  isZoomed:      false,
  uiHidden:      false,
  outputHidden:  false,
  isCompiling:   false,
  zoomTimer:     null,
  currentZoom:   1,
  pendingCode:   null,
};

// ===== CACHE =====
const cache = {
  get(code) {
    try {
      const key = "zc_" + btoa(encodeURIComponent(code)).slice(0, 60);
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const { result, ts } = JSON.parse(raw);
      if (Date.now() - ts > CACHE_TTL_MS) { localStorage.removeItem(key); return null; }
      return result;
    } catch { return null; }
  },
  set(code, result) {
    try {
      const key = "zc_" + btoa(encodeURIComponent(code)).slice(0, 60);
      localStorage.setItem(key, JSON.stringify({ result, ts: Date.now() }));
    } catch {}
  }
};

// ===== SYNTAX HIGHLIGHTER =====
function highlight(raw) {
  // 1. Escape HTML entities
  let code = raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 2. Track positions to avoid double-replacing inside strings/comments
  // Use a token-based approach: replace with placeholders

  const tokens = [];
  let tid = 0;
  const placeholder = (cls, text) => {
    const id = `\x00${tid++}\x00`;
    tokens.push({ id, cls, text });
    return id;
  };

  // 3. Multi-line block comments  /* ... */
  code = code.replace(/(\/\*[\s\S]*?\*\/)/g, (m) => placeholder("hl-comment", m));

  // 4. Single-line comments  // ...
  code = code.replace(/(\/\/[^\n]*)/g, (m) => placeholder("hl-comment", m));

  // 5. Strings  "..."  (handles escaped quotes)
  code = code.replace(/("(?:[^"\\]|\\.)*")/g, (m) => placeholder("hl-string", m));

  // 6. Char literals  '...'
  code = code.replace(/('(?:[^'\\]|\\.)*')/g, (m) => placeholder("hl-string", m));

  // 7. Preprocessor directives  #include #define etc.
  code = code.replace(/^(#\s*(?:include|define|ifdef|ifndef|endif|pragma|undef|if|else|elif|error|warning)\b[^\n]*)/gm,
    (m) => placeholder("hl-preproc", m));

  // 8. C++ Keywords
  const keywords = [
    "alignas","alignof","and","and_eq","asm","auto","bitand","bitor","bool",
    "break","case","catch","char","char8_t","char16_t","char32_t","class",
    "compl","concept","const","consteval","constexpr","constinit","const_cast",
    "continue","co_await","co_return","co_yield","decltype","default","delete",
    "do","double","dynamic_cast","else","enum","explicit","export","extern",
    "false","float","for","friend","goto","if","inline","int","long","mutable",
    "namespace","new","noexcept","not","not_eq","nullptr","operator","or",
    "or_eq","private","protected","public","register","reinterpret_cast",
    "requires","return","short","signed","sizeof","static","static_assert",
    "static_cast","struct","switch","template","this","thread_local","throw",
    "true","try","typedef","typeid","typename","union","unsigned","using",
    "virtual","void","volatile","wchar_t","while","xor","xor_eq","override","final"
  ];
  const kwRegex = new RegExp(`\\b(${keywords.join("|")})\\b`, "g");
  code = code.replace(kwRegex, (m) => placeholder("hl-keyword", m));

  // 9. STL & common types
  const types = [
    "string","vector","map","set","unordered_map","unordered_set","list",
    "deque","stack","queue","priority_queue","pair","tuple","array","bitset",
    "iostream","fstream","sstream","algorithm","functional","numeric",
    "iterator","memory","thread","mutex","atomic","chrono","optional",
    "variant","any","cout","cin","cerr","clog","endl","flush",
    "make_pair","make_tuple","make_shared","make_unique","move","forward",
    "begin","end","size","empty","push_back","pop_back","front","back",
    "insert","erase","find","count","sort","reverse","min","max",
    "abs","sqrt","pow","floor","ceil","rand","srand","printf","scanf",
    "malloc","free","std","NULL","EOF"
  ];
  const typRegex = new RegExp(`\\b(${types.join("|")})\\b`, "g");
  code = code.replace(typRegex, (m) => placeholder("hl-std", m));

  // 10. Numbers (hex, float, int)
  code = code.replace(/\b(0x[0-9a-fA-F]+|0b[01]+|\d+\.\d*[fFlL]?|\d+[fFlLuU]*)\b/g,
    (m) => placeholder("hl-number", m));

  // 11. Replace placeholders with actual spans
  tokens.forEach(({ id, cls, text }) => {
    code = code.split(id).join(`<span class="${cls}">${text}</span>`);
  });

  return code;
}

// ===== LINE NUMBERS =====
function updateLineNumbers(text) {
  const lines = text.split("\n");
  const cursorLine = getCursorLine();
  let html = "";
  for (let i = 1; i <= Math.max(lines.length, 1); i++) {
    html += `<div class="line-num${i === cursorLine ? " active" : ""}">${i}</div>`;
  }
  lineNums.innerHTML = html;

  statusLines.textContent = `Ln ${cursorLine}`;
}

function getCursorLine() {
  const text = editor.value.substring(0, editor.selectionStart);
  return text.split("\n").length;
}

// ===== EDITOR SYNC =====
function syncEditor() {
  const text = editor.value;
  highlightCode.innerHTML = highlight(text) + "\n"; // extra newline to match height
  updateLineNumbers(text);
  syncScroll();
}

function syncScroll() {
  highlightCode.parentElement.scrollTop = editor.scrollTop;
  highlightCode.parentElement.scrollLeft = editor.scrollLeft;
  lineNums.scrollTop = editor.scrollTop;
}

// ===== ZOOM =====
function zoomIn() {
  if (state.isZoomed) return;
  state.isZoomed = true;
  state.currentZoom = ZOOM_SCALE;

  editorContainer.style.transform = `scale(${ZOOM_SCALE})`;
  editorContainer.style.transformOrigin = "top left";
  editorContainer.style.width  = `${100 / ZOOM_SCALE}%`;
  editorContainer.style.height = `${100 / ZOOM_SCALE}%`;

  statusZoom.textContent = `Zoom: ${Math.round(ZOOM_SCALE * 100)}%`;
  statusDot.className = "dot-typing";
  statusText.textContent = "Typing";
}

function zoomOut() {
  if (!state.isZoomed) return;
  state.isZoomed = false;
  state.currentZoom = 1;

  editorContainer.style.transform = "scale(1)";
  editorContainer.style.width  = "100%";
  editorContainer.style.height = "100%";

  statusZoom.textContent = "Zoom: 100%";
  statusDot.className = "dot-ready";
  statusText.textContent = "Ready";
}

function resetZoomTimer() {
  clearTimeout(state.zoomTimer);
  state.zoomTimer = setTimeout(zoomOut, ZOOM_IDLE_MS);
}

// ===== UI TOGGLE =====
function toggleUI() {
  state.uiHidden = !state.uiHidden;

  if (state.uiHidden) {
    toolbar.classList.add("hidden");
    outputPanel.classList.add("hidden");
    mainArea.classList.add("toolbar-hidden", "output-hidden");
    showToast("UI Hidden — Ctrl+H to show");
  } else {
    toolbar.classList.remove("hidden");
    outputPanel.classList.remove("hidden");
    mainArea.classList.remove("toolbar-hidden", "output-hidden");
    showToast("UI Visible");
  }
}

// ===== TOAST =====
let toastTimer = null;
function showToast(msg, duration = 2000) {
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), duration);
}

// ===== STATUS =====
function setStatus(mode, text) {
  statusDot.className = `dot-${mode}`;
  statusText.textContent = text;
}

// ===== FORMAT CODE =====
function formatCode() {
  let code = editor.value;
  if (!code.trim()) { showToast("Nothing to format!"); return; }

  const lines = code.split("\n");
  let indent = 0;
  const result = [];

  lines.forEach((raw) => {
    let line = raw.trim();
    if (!line) { result.push(""); return; }

    // Decrease indent for closing braces
    if (line.startsWith("}") || line.startsWith(")") || line.startsWith("]")) {
      indent = Math.max(0, indent - 1);
    }

    result.push("    ".repeat(indent) + line);

    // Increase indent after opening braces (if not immediately closed)
    const opens  = (line.match(/{|\(|\[/g) || []).length;
    const closes = (line.match(/}|\)|\]/g) || []).length;
    indent = Math.max(0, indent + opens - closes);
  });

  editor.value = result.join("\n");
  syncEditor();
  showToast("✨ Code Formatted!");
}

// ===== DETECT cin =====
function hasCin(code) {
  return /\bcin\s*>>/.test(code) || /scanf\s*\(/.test(code) || /getline\s*\(/.test(code);
}

// ===== COMPILER =====
async function compilePiston(code, stdin = "") {
  const res = await fetch(PISTON_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      language: "c++",
      version: "10.2.0",
      files: [{ name: "main.cpp", content: code }],
      stdin: stdin,
      compile_timeout: 10000,
      run_timeout: 5000,
    }),
  });

  if (!res.ok) throw new Error(`Piston HTTP ${res.status}`);
  const data = await res.json();

  let output = "";
  if (data.compile && data.compile.stderr) output += data.compile.stderr;
  if (data.run) {
    if (data.run.stdout) output += data.run.stdout;
    if (data.run.stderr) output += data.run.stderr;
  }
  const exitCode = data.run ? data.run.code : -1;
  return { output: output.trim() || "(No output)", success: exitCode === 0, source: "Piston" };
}

async function compileWandbox(code, stdin = "") {
  const res = await fetch(WANDBOX_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      compiler: "gcc-head",
      options: "c++17,warning",
      stdin,
    }),
  });

  if (!res.ok) throw new Error(`Wandbox HTTP ${res.status}`);
  const data = await res.json();

  let output = "";
  if (data.compiler_error) output += data.compiler_error + "\n";
  if (data.program_output) output += data.program_output;
  if (data.program_error) output += data.program_error;

  const success = !data.compiler_error && !data.program_error;
  return { output: output.trim() || "(No output)", success, source: "Wandbox" };
}

async function runCode(stdin = "") {
  const code = editor.value.trim();
  if (!code) { showToast("⚠️ Write some code first!"); return; }

  // Check cache
  const cacheKey = code + "||" + stdin;
  const cached = cache.get(cacheKey);
  if (cached) {
    displayOutput(cached);
    showToast("⚡ From cache (instant!)");
    return;
  }

  // Show loading
  state.isCompiling = true;
  loadingOverlay.classList.add("visible");
  setStatus("running", "Compiling...");

  // If output hidden, show it
  if (state.uiHidden) {
    outputPanel.classList.remove("hidden");
    mainArea.classList.remove("output-hidden");
  }

  const startTime = Date.now();

  try {
    let result;
    try {
      result = await compilePiston(code, stdin);
    } catch (e) {
      console.warn("Piston failed, trying Wandbox:", e);
      result = await compileWandbox(code, stdin);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    result.elapsed = elapsed;
    cache.set(cacheKey, result);
    displayOutput(result);

  } catch (err) {
    displayOutput({
      output: `❌ Network Error: ${err.message}\n\nPlease check your internet connection.\nBoth Piston and Wandbox APIs are unreachable.`,
      success: false,
      source: "Error",
      elapsed: "—"
    });
  } finally {
    loadingOverlay.classList.remove("visible");
    state.isCompiling = false;
    setStatus("ready", "Ready");
  }
}

function displayOutput(result) {
  const { output, success, source, elapsed } = result;

  outputContent.innerHTML = success
    ? `<span class="output-success">${escapeHtml(output)}</span>`
    : `<span class="output-error">${escapeHtml(output)}</span>`;

  outputIcon.className = success ? "success" : "error";
  outputIcon.textContent = success ? "✔" : "✘";

  compileBadge.textContent = success ? "SUCCESS" : "ERROR";
  compileBadge.className   = success ? "success" : "error";

  compileTime.textContent = elapsed ? `${elapsed}s via ${source}` : "";
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ===== RUN with cin check =====
function handleRun() {
  if (state.isCompiling) return;
  const code = editor.value.trim();
  if (!code) { showToast("⚠️ Write some code first!"); return; }

  if (hasCin(code)) {
    // Show input modal
    stdinInput.value = "";
    inputModal.classList.add("visible");
    setTimeout(() => stdinInput.focus(), 100);
  } else {
    runCode("");
  }
}

// ===== TAB KEY SUPPORT =====
editor.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const start = editor.selectionStart;
    const end   = editor.selectionEnd;
    editor.value = editor.value.slice(0, start) + "    " + editor.value.slice(end);
    editor.selectionStart = editor.selectionEnd = start + 4;
    syncEditor();
  }

  // Auto-closing brackets
  const pairs = { "{": "}", "(": ")", "[": "]", '"': '"', "'": "'" };
  if (pairs[e.key]) {
    const start = editor.selectionStart;
    const end   = editor.selectionEnd;
    if (start === end) {
      e.preventDefault();
      const close = pairs[e.key];
      editor.value = editor.value.slice(0, start) + e.key + close + editor.value.slice(end);
      editor.selectionStart = editor.selectionEnd = start + 1;
      syncEditor();
    }
  }

  // Enter: auto-indent
  if (e.key === "Enter") {
    const start = editor.selectionStart;
    const lineStart = editor.value.lastIndexOf("\n", start - 1) + 1;
    const currentLine = editor.value.slice(lineStart, start);
    const indent = currentLine.match(/^(\s*)/)[1];
    const charBefore = editor.value[start - 1];
    const charAfter  = editor.value[start];

    if (charBefore === "{" && charAfter === "}") {
      e.preventDefault();
      const extra = indent + "    ";
      editor.value = editor.value.slice(0, start) + "\n" + extra + "\n" + indent + editor.value.slice(start);
      editor.selectionStart = editor.selectionEnd = start + 1 + extra.length;
      syncEditor();
    } else if (indent) {
      e.preventDefault();
      editor.value = editor.value.slice(0, start) + "\n" + indent + editor.value.slice(start);
      editor.selectionStart = editor.selectionEnd = start + 1 + indent.length;
      syncEditor();
    }
  }
});

// ===== KEYBOARD SHORTCUTS (Global) =====
document.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key === "r") {
    e.preventDefault();
    handleRun();
    return;
  }

  if (ctrl && e.key === "h") {
    e.preventDefault();
    toggleUI();
    return;
  }

  if (ctrl && e.shiftKey && e.key === "F") {
    e.preventDefault();
    formatCode();
    return;
  }
});

// ===== TYPING EVENTS (Auto-Zoom) =====
editor.addEventListener("input", () => {
  syncEditor();
  zoomIn();
  resetZoomTimer();
});

editor.addEventListener("keydown", () => {
  zoomIn();
  resetZoomTimer();
});

editor.addEventListener("scroll", syncScroll);
editor.addEventListener("click", () => updateLineNumbers(editor.value));
editor.addEventListener("keyup", () => updateLineNumbers(editor.value));

// ===== BUTTONS =====
$("btn-run").addEventListener("click", handleRun);
$("btn-format").addEventListener("click", formatCode);
$("btn-clear").addEventListener("click", () => {
  if (editor.value && !confirm("Clear all code?")) return;
  editor.value = "";
  syncEditor();
  showToast("Editor cleared");
});
$("btn-toggle-ui").addEventListener("click", toggleUI);
$("btn-clear-output").addEventListener("click", () => {
  outputContent.innerHTML = '<span class="output-hint">// Press ▶ Run or Ctrl+R to compile and run...</span>';
  compileBadge.textContent = "";
  compileBadge.className = "";
  compileTime.textContent = "";
  outputIcon.className = "";
  outputIcon.textContent = "◉";
});

// Modal buttons
$("btn-cancel-input").addEventListener("click", () => {
  inputModal.classList.remove("visible");
});
$("btn-submit-input").addEventListener("click", () => {
  inputModal.classList.remove("visible");
  runCode(stdinInput.value);
});

// Close modal on backdrop click
inputModal.addEventListener("click", (e) => {
  if (e.target === inputModal) inputModal.classList.remove("visible");
});

// ===== SERVICE WORKER =====
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js")
      .then(() => console.log("ZoomCode SW registered"))
      .catch((e) => console.warn("SW failed:", e));
  });
}

// ===== LOAD SAVED CODE =====
function loadSavedCode() {
  try {
    const saved = localStorage.getItem("zc_code");
    if (saved) {
      editor.value = saved;
      syncEditor();
    }
  } catch {}
}

function saveCode() {
  try {
    localStorage.setItem("zc_code", editor.value);
  } catch {}
}

// Auto-save every 5 seconds
setInterval(saveCode, 5000);

// Save on page unload
window.addEventListener("beforeunload", saveCode);

// ===== INIT =====
function init() {
  loadSavedCode();
  syncEditor();
  editor.focus();
  setStatus("ready", "Ready");
  statusZoom.textContent = "Zoom: 100%";

  // If no saved code, set a sample
  if (!editor.value.trim()) {
    editor.value = `#include <iostream>
#include <vector>
#include <string>
using namespace std;

int main() {
    // Welcome to ZoomCode!
    cout << "Hello from ZoomCode!" << endl;
    
    int n = 5;
    for (int i = 1; i <= n; i++) {
        cout << "Count: " << i << endl;
    }
    
    vector<string> langs = {"C++", "Java", "Python"};
    for (const string& lang : langs) {
        cout << "Language: " << lang << endl;
    }
    
    return 0;
}`;
    syncEditor();
  }
}

init();
