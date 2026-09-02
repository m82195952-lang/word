/* 生词本前端逻辑 v2：即点即存 + 离线词库优先 + 网络并行兜底 */
(function () {
  'use strict';

  const STORAGE_KEY = 'vocab.words.v1';

  // ---------- 状态 ----------
  let words = loadWords();          // 生词数组
  let audio = null;                 // 共享音频播放器
  let pendingDelete = {};           // 二次确认删除
  let editingId = null;             // 正在编辑的单词 id
  let toastTimer = null;
  let offlineDict = null;           // 离线词库 { word: { ph, zh } }
  let offlineLoading = false;
  let offlineLoaded = false;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const addForm = $('addForm');
  const wordInput = $('wordInput');
  const addBtn = $('addBtn');
  const hint = $('hint');
  const filterInput = $('filterInput');
  const listEl = $('list');
  const emptyState = $('emptyState');
  const wordCount = $('wordCount');
  const modalOverlay = $('modalOverlay');
  const editWord = $('editWord');
  const editPhoneticUs = $('editPhoneticUs');
  const editPhoneticUk = $('editPhoneticUk');
  const editDefs = $('editDefs');
  const editSave = $('editSave');
  const editCancel = $('editCancel');
  const toastEl = $('toast');

  // ---------- 工具 ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function loadWords() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveWords() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(words));
    updateCount();
  }

  function updateCount() {
    wordCount.textContent = '共 ' + words.length + ' 个单词';
  }

  function toast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), ms || 2200);
  }

  // ---------- 朗读：在线音频优先，失败/缺失时用系统语音 ----------
  function speak(word) {
    try {
      if (!('speechSynthesis' in window)) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(word);
      u.lang = 'en-US';
      u.rate = 0.95;
      speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  }

  function play(url, word) {
    if (!url) {
      if (word) speak(word);
      else toast('该单词暂无音频');
      return;
    }
    if (!audio) audio = new Audio();
    audio.src = url;
    audio.play().catch(() => {
      if (word) speak(word);
      else toast('播放失败，请检查网络后重试');
    });
  }

  // ---------- 离线词库 ----------
  function loadOfflineDict() {
    if (offlineLoaded || offlineLoading) return;
    offlineLoading = true;
    fetch('dict.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        offlineDict = d;
        offlineLoaded = true;
      })
      .catch(() => { /* 失败可稍后重试 */ })
      .finally(() => { offlineLoading = false; });
  }

  function offlineLookup(word) {
    if (!offlineDict) return null;
    const hit = offlineDict[word.toLowerCase()];
    if (!hit) return null;
    return {
      phoneticUs: hit.ph || '',
      phoneticUk: '',
      definitions: hit.zh ? [hit.zh] : [],
      enDefs: [],
      audioUs: '',
      audioUk: '',
    };
  }

  // ---------- 网络查询（并行 + 超时） ----------
  function fetchWithTimeout(url, ms) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    return fetch(url, { signal: c.signal }).finally(() => clearTimeout(t));
  }

  const POS_MAP = {
    noun: 'n.', verb: 'v.', adjective: 'adj.', adverb: 'adv.',
    interjection: 'int.', pronoun: 'pron.', preposition: 'prep.',
    conjunction: 'conj.', determiner: 'det.', exclamation: 'int.',
    numeral: 'num.', phrase: 'phr.',
  };
  const normPh = (t) => (t || '').replace(/^\/|\/$/g, '');

  async function lookupNetwork(word) {
    // 并行请求：MyMemory 中文翻译 + dictionaryapi.dev 音标/音频/英文释义
    const mmP = fetchWithTimeout(
      'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(word) + '&langpair=en|zh-CN', 6000)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const dapiP = fetchWithTimeout(
      'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word), 6000)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [mmj, dapi] = await Promise.all([mmP, dapiP]);

    const out = { phoneticUs: '', phoneticUk: '', definitions: [], enDefs: [], audioUs: '', audioUk: '', posHint: '' };

    if (Array.isArray(dapi) && dapi.length) {
      const e = dapi[0];
      for (const p of e.phonetics || []) {
        const text = normPh(p.text);
        if (p.audio) {
          if (/uk|gb/i.test(p.audio)) { if (!out.audioUk) out.audioUk = p.audio; if (!out.phoneticUk) out.phoneticUk = text; }
          else { if (!out.audioUs) out.audioUs = p.audio; if (!out.phoneticUs) out.phoneticUs = text; }
        }
      }
      if (!out.phoneticUs && !out.phoneticUk) {
        const ph = (e.phonetics || []).find((p) => p.text);
        if (ph) out.phoneticUs = normPh(ph.text);
      }
      for (const m of e.meanings || []) {
        const pos = (m.partOfSpeech || '').trim();
        if (!out.posHint) out.posHint = POS_MAP[pos.toLowerCase()] || pos;
        for (const d of (m.definitions || []).slice(0, 2)) {
          const def = (d.definition || '').trim();
          if (def) out.enDefs.push((pos ? pos + ': ' : '') + def);
        }
      }
    }

    const zh = ((mmj && mmj.responseData && mmj.responseData.translatedText) || '').trim();
    if (zh && zh.toLowerCase() !== word.toLowerCase()) {
      out.definitions = [(out.posHint ? out.posHint + ' ' : '') + zh];
    }
    out.enDefs = out.enDefs.slice(0, 6);
    delete out.posHint;
    return out;
  }

  // 总查询：有电脑服务器则优先(有道) → 离线词库 → 网络并行兜底
  let hasProxy = null;   // 同源 /api/dict 是否存在（电脑模式），启动时探测一次

  async function detectProxy() {
    try {
      const r = await fetchWithTimeout('/api/dict', 3000);
      hasProxy = r.status !== 404;   // 服务器返回 400（缺参数），静态托管返回 404
    } catch (e) {
      hasProxy = false;
    }
  }

  async function lookupWord(word) {
    if (hasProxy === null) {
      try { await detectProxy(); } catch (e) { hasProxy = false; }
    }

    // 1) 电脑模式：本地服务器 /api/dict（有道词典，音标分英美、释义最全）
    if (hasProxy) {
      try {
        const r = await fetchWithTimeout('/api/dict?word=' + encodeURIComponent(word), 6000);
        if (r && r.ok) {
          const j = await r.json();
          if (j.ok && (j.data.phoneticUs || j.data.phoneticUk || (j.data.definitions || []).length)) {
            return {
              phoneticUs: j.data.phoneticUs || '',
              phoneticUk: j.data.phoneticUk || '',
              definitions: (j.data.definitions || []).slice(0, 8),
              enDefs: [],
              audioUs: j.data.audioUs || '',
              audioUk: j.data.audioUk || '',
            };
          }
        }
      } catch (e) { /* 继续走离线/网络 */ }
    }

    // 2) 离线词库（毫秒级，无需联网）
    const hit = offlineLookup(word);
    if (hit) return hit;

    // 3) 网络兜底
    return await lookupNetwork(word);
  }

  // ---------- 渲染 ----------
  function phoneticChips(p) {
    const lines = [];
    const us = (p.phoneticUs || '').trim();
    const uk = (p.phoneticUk || '').trim();
    if (us && uk && us !== uk) {
      lines.push({ tag: '美', text: '/' + us + '/', audio: p.audioUs });
      lines.push({ tag: '英', text: '/' + uk + '/', audio: p.audioUk });
    } else {
      const one = us || uk;
      if (one) lines.push({ tag: '', text: '/' + one + '/', audio: us ? p.audioUs : p.audioUk });
    }
    if (!lines.length && (p.audioUs || p.audioUk)) lines.push({ tag: '音', text: '', audio: p.audioUs || p.audioUk });
    return lines;
  }

  function renderList() {
    const q = filterInput.value.trim().toLowerCase();
    const shown = words.filter((w) => {
      if (!q) return true;
      return w.word.toLowerCase().includes(q) ||
        (w.definitions || []).some((d) => d.toLowerCase().includes(q)) ||
        (w.enDefs || []).some((d) => d.toLowerCase().includes(q));
    });

    listEl.innerHTML = '';
    for (const w of shown) {
      const phLines = phoneticChips(w);
      const zhDefs = (w.definitions || []).map((d) => '<div class="def-line">' + esc(d) + '</div>').join('');
      const enDefs = (w.enDefs || []).map((d) => '<div class="def-line en">' + esc(d) + '</div>').join('');
      const allDefs = (w.definitions || []).concat(w.enDefs || []);
      const needsExpand = allDefs.length > 1 || allDefs.join('').length > 90;
      const isDeleting = !!pendingDelete[w.id];

      const card = document.createElement('article');
      card.className = 'card word-card';
      card.innerHTML =
        '<div class="word-top">' +
          '<div class="word-main" title="点击朗读">' +
            '<div class="word-text">' + esc(w.word) + '</div>' +
            (phLines.length
              ? '<div class="word-phonetic">' + phLines.map((l) =>
                  '<span class="ph-line">' +
                  (l.tag ? '<span class="ph-tag">' + l.tag + '</span>' : '') +
                  '<span>' + esc(l.text) + '</span>' +
                  (l.audio ? '<button class="ph-sound" data-audio="' + esc(l.audio) + '">🔊</button>' : '') +
                  '</span>').join('') + '</div>'
              : '') +
            (zhDefs || enDefs ? '<div class="word-defs' + (needsExpand ? '' : ' expanded') + '">' + zhDefs + enDefs + '</div>' : '') +
            (needsExpand ? '<button class="expand-btn" data-expand="1">展开全部 ▾</button>' : '') +
            (w.pending
              ? '<div class="word-date loading">正在获取释义…</div>'
              : '<div class="word-date">' + new Date(w.addedAt).toLocaleDateString('zh-CN') + ' 添加</div>') +
          '</div>' +
          '<div class="word-tools">' +
            '<button class="icon-btn play" data-play="' + esc(w.audioUs || w.audioUk || '') + '" title="朗读">▶</button>' +
            '<button class="icon-btn refetch" data-refetch="' + esc(w.id) + '" title="重新获取释义">↻</button>' +
            '<button class="icon-btn edit" data-edit="' + esc(w.id) + '" title="编辑">✎</button>' +
            '<button class="icon-btn danger" data-del="' + esc(w.id) + '" title="删除">' + (isDeleting ? '确认' : '✕') + '</button>' +
          '</div>' +
        '</div>';
      listEl.appendChild(card);
    }

    emptyState.classList.toggle('hidden', words.length > 0);
  }

  // ---------- 事件委托 ----------
  function wordOf(target) {
    const card = target.closest('.word-card');
    if (card) {
      const t = card.querySelector('.word-text');
      return t ? t.textContent.trim() : '';
    }
    return '';
  }

  listEl.addEventListener('click', (e) => {
    const t = e.target;
    const playBtn = t.closest('[data-play]');
    if (playBtn) { play(playBtn.getAttribute('data-play'), wordOf(playBtn)); return; }
    const sound = t.closest('[data-audio]');
    if (sound) { play(sound.getAttribute('data-audio'), wordOf(sound)); return; }
    const refBtn = t.closest('[data-refetch]');
    if (refBtn) { refetchWord(refBtn.getAttribute('data-refetch'), refBtn); return; }
    const delBtn = t.closest('[data-del]');
    if (delBtn) { deleteWord(delBtn.getAttribute('data-del')); return; }
    const editBtn = t.closest('[data-edit]');
    if (editBtn) { openEdit(editBtn.getAttribute('data-edit')); return; }
    const exp = t.closest('[data-expand]');
    if (exp) {
      const defs = exp.parentElement.querySelector('.word-defs');
      defs.classList.add('expanded');
      exp.remove();
      return;
    }
    const main = t.closest('.word-main');
    if (main) {
      const w = words.find((x) => x.word === main.querySelector('.word-text').textContent.trim());
      if (w) play(w.audioUs || w.audioUk, w.word);
    }
  });

  // 将查询结果合并进记录（只填非空字段）
  function applyData(rec, d) {
    if (!d) return false;
    let touched = false;
    if (d.phoneticUs) { rec.phoneticUs = d.phoneticUs; touched = true; }
    if (d.phoneticUk) { rec.phoneticUk = d.phoneticUk; touched = true; }
    if (d.definitions && d.definitions.length) { rec.definitions = d.definitions; touched = true; }
    if (d.enDefs && d.enDefs.length) { rec.enDefs = d.enDefs; touched = true; }
    if (d.audioUs) { rec.audioUs = d.audioUs; touched = true; }
    if (d.audioUk) { rec.audioUk = d.audioUk; touched = true; }
    return touched;
  }

  async function enrichWord(rec) {
    try {
      const d = await lookupWord(rec.word);
      rec.pending = false;
      const got = applyData(rec, d);
      saveWords();
      renderList();
      if (got) toast('✓ 已获取音标和释义');
      else toast('未能获取释义，可点卡片上的 ↻ 重试');
    } catch (err) {
      rec.pending = false;
      saveWords();
      renderList();
      toast('查询失败，可点卡片上的 ↻ 重试');
    }
  }

  async function refetchWord(id, btn) {
    const w = words.find((x) => x.id === id);
    if (!w || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '…';
    w.pending = true;
    renderList();
    try {
      const d = await lookupWord(w.word);
      const got = applyData(w, d);
      w.pending = false;
      saveWords();
      renderList();
      if (got) toast('✓ 已更新释义');
      else toast('仍未找到该词的释义');
    } catch (err) {
      w.pending = false;
      saveWords();
      renderList();
      toast('查询失败：' + err.message);
    }
  }

  // ---------- 添加（即点即存） ----------
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const word = wordInput.value.trim();
    if (!word) { toast('请输入单词'); return; }
    if (!/^[a-zA-Z][a-zA-Z\s'\-.]*$/.test(word)) { toast('请输入英文单词（可含空格、连字符）'); return; }

    const exists = words.some((w) => w.word.toLowerCase() === word.toLowerCase());
    if (exists) {
      toast('「' + word + '」已在生词本中');
      wordInput.value = '';
      wordInput.focus();
      return;
    }

    // 先落库：单词立刻保存并显示
    const rec = {
      id: uid(),
      word: word,
      phoneticUs: '',
      phoneticUk: '',
      definitions: [],
      enDefs: [],
      audioUs: '',
      audioUk: '',
      addedAt: Date.now(),
      pending: true,
    };
    words.unshift(rec);
    saveWords();
    renderList();
    wordInput.value = '';
    wordInput.focus();

    // 后台补充音标和释义（离线词库命中时几乎瞬间完成）
    if (!offlineDict) loadOfflineDict();
    const off = offlineLookup(word);
    if (off) {
      rec.pending = false;
      applyData(rec, off);
      saveWords();
      renderList();
      toast('✓ 已添加并获取释义');
    } else {
      toast('✓ 已添加，正在获取释义…', 1600);
      await enrichWord(rec);
    }
  });

  // ---------- 删除（二次确认） ----------
  function deleteWord(id) {
    const now = Date.now();
    if (pendingDelete[id] && now - pendingDelete[id] < 3000) {
      words = words.filter((w) => w.id !== id);
      delete pendingDelete[id];
      saveWords();
      renderList();
      toast('已删除');
    } else {
      pendingDelete[id] = now;
      renderList();
      toast('再点一次「确认」删除');
    }
  }

  // ---------- 编辑 ----------
  function openEdit(id) {
    const w = words.find((x) => x.id === id);
    if (!w) return;
    editingId = id;
    editWord.value = w.word;
    editPhoneticUs.value = w.phoneticUs || '';
    editPhoneticUk.value = w.phoneticUk || '';
    editDefs.value = (w.definitions || []).join('\n');
    modalOverlay.classList.remove('hidden');
    setTimeout(() => editWord.focus(), 50);
  }

  function closeEdit() {
    modalOverlay.classList.add('hidden');
    editingId = null;
  }

  editSave.addEventListener('click', () => {
    if (!editingId) return;
    const w = words.find((x) => x.id === editingId);
    if (!w) return;
    w.word = editWord.value.trim() || w.word;
    w.phoneticUs = editPhoneticUs.value.trim();
    w.phoneticUk = editPhoneticUk.value.trim();
    w.definitions = editDefs.value.split('\n').map((s) => s.trim()).filter(Boolean);
    w.pending = false;
    saveWords();
    renderList();
    closeEdit();
    toast('✓ 已保存修改');
  });

  editCancel.addEventListener('click', closeEdit);
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeEdit(); });

  // ---------- 搜索 ----------
  filterInput.addEventListener('input', renderList);

  // ---------- 离线缓存（Service Worker，仅 HTTPS 托管时生效） ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* HTTP 下注册失败可忽略 */ });
    });
  }

  // ---------- 初始化 ----------
  detectProxy();       // 探测是否为电脑模式（一次即可）
  loadOfflineDict();   // 后台预载离线词库，保证首查可用
  renderList();
  updateCount();
})();
