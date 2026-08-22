/* 生词本前端逻辑 */
(function () {
  'use strict';

  const STORAGE_KEY = 'vocab.words.v1';

  // ---------- 状态 ----------
  let words = loadWords();          // 生词数组
  let previewData = null;           // 待确认的查询结果
  let editingId = null;             // 正在编辑的单词 id
  let audio = null;                 // 共享的音频播放器
  let pendingDelete = {};           // 二次确认删除
  let toastTimer = null;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const addForm = $('addForm');
  const wordInput = $('wordInput');
  const addBtn = $('addBtn');
  const hint = $('hint');
  const preview = $('preview');
  const previewWord = $('previewWord');
  const previewStatus = $('previewStatus');
  const previewPhonetic = $('previewPhonetic');
  const previewDefs = $('previewDefs');
  const previewConfirm = $('previewConfirm');
  const previewCancel = $('previewCancel');
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

  // ---------- 朗读：优先在线音频，失败/无音频时用手机系统语音（离线可用） ----------
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

  // ---------- 词典查询 ----------
  const POS_MAP = {
    noun: 'n.', verb: 'v.', adjective: 'adj.', adverb: 'adv.',
    interjection: 'int.', pronoun: 'pron.', preposition: 'prep.',
    conjunction: 'conj.', determiner: 'det.', exclamation: 'int.',
    numeral: 'num.', phrase: 'phr.',
  };
  const normPh = (t) => (t || '').replace(/^\/|\/$/g, '');

  async function lookupWord(word) {
    // 模式 1：同源代理（电脑版服务器提供，有道词典，中文释义质量最好）
    try {
      const r = await fetch('/api/dict?word=' + encodeURIComponent(word));
      if (r.ok) {
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
    } catch (e) { /* 静态托管时 /api/dict 不存在，继续走模式 2 */ }

    // 模式 2：静态托管（无服务器）→ 直连两个支持 CORS 的词典 API
    return await lookupStatic(word);
  }

  async function lookupStatic(word) {
    const out = { phoneticUs: '', phoneticUk: '', definitions: [], enDefs: [], audioUs: '', audioUk: '', posHint: '' };

    // 2a) 音标 + 英文释义 + 真人发音音频（dictionaryapi.dev，CORS 开放但偶发 502，自动重试）
    try {
      const arr = await fetchDictApiDev(word);
      if (Array.isArray(arr) && arr.length) {
        const e = arr[0];
        for (const p of e.phonetics || []) {
          const text = normPh(p.text);
          if (p.audio) {
            if (/uk|gb/i.test(p.audio)) { out.audioUk = out.audioUk || p.audio; if (!out.phoneticUk) out.phoneticUk = text; }
            else { out.audioUs = out.audioUs || p.audio; if (!out.phoneticUs) out.phoneticUs = text; }
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
    } catch (e) { /* 全部重试失败则跳过，中文释义与 TTS 兜底 */ }

    // 2b) 中文释义（MyMemory 免费翻译，CORS 开放）
    try {
      const r = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(word) + '&langpair=en|zh-CN');
      if (r.ok) {
        const j = await r.json();
        const zh = ((j.responseData && j.responseData.translatedText) || '').trim();
        if (zh && zh.toLowerCase() !== word.toLowerCase()) {
          out.definitions = [(out.posHint ? out.posHint + ' ' : '') + zh];
        }
      }
    } catch (e) { /* ignore */ }

    out.definitions = out.definitions.slice(0, 8);
    out.enDefs = out.enDefs.slice(0, 6);
    delete out.posHint;
    return out;
  }

  // dictionaryapi.dev 偶发 502，最多重试 3 次
  async function fetchDictApiDev(word) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 700 * attempt));
      try {
        const r = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word));
        if (!r.ok) { lastErr = new Error('HTTP ' + r.status); continue; }
        return await r.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('dictionaryapi.dev 不可用');
  }

  // ---------- 渲染 ----------
  function phoneticLines(p) {
    const lines = [];
    if (p.phoneticUs) lines.push({ tag: '美', text: '/' + p.phoneticUs + '/', audio: p.audioUs });
    if (p.phoneticUk) lines.push({ tag: '英', text: '/' + p.phoneticUk + '/', audio: p.audioUk });
    if (!lines.length && (p.audioUs || p.audioUk)) lines.push({ tag: '音', text: '', audio: p.audioUs || p.audioUk });
    return lines;
  }

  function defsBlock(w, cls) {
    const zh = (w.definitions || []).map((d) => '<div class="def-line">' + esc(d) + '</div>').join('');
    const en = (w.enDefs || []).map((d) => '<div class="def-line en">' + esc(d) + '</div>').join('');
    return '<div class="word-defs' + (cls ? ' ' + cls : '') + '">' + zh + en + '</div>';
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
      const phLines = phoneticLines(w);
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
                  '<span class="ph-line"><span class="ph-tag">' + l.tag + '</span>' +
                  '<span>' + esc(l.text) + '</span>' +
                  (l.audio ? '<button class="ph-sound" data-audio="' + esc(l.audio) + '">🔊</button>' : '') +
                  '</span>').join('') + '</div>'
              : '') +
            (allDefs.length ? defsBlock(w, needsExpand ? '' : 'expanded') : '') +
            (needsExpand ? '<button class="expand-btn" data-expand="1">展开全部 ▾</button>' : '') +
            '<div class="word-date">' + new Date(w.addedAt).toLocaleDateString('zh-CN') + ' 添加</div>' +
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
    return previewWord.textContent.trim();
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

  async function refetchWord(id, btn) {
    const w = words.find((x) => x.id === id);
    if (!w || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const d = await lookupWord(w.word);
      if (d.phoneticUs || d.phoneticUk || d.definitions.length || d.enDefs.length) {
        if (d.phoneticUs) w.phoneticUs = d.phoneticUs;
        if (d.phoneticUk) w.phoneticUk = d.phoneticUk;
        if (d.definitions.length) w.definitions = d.definitions;
        if (d.enDefs.length) w.enDefs = d.enDefs;
        if (d.audioUs) w.audioUs = d.audioUs;
        if (d.audioUk) w.audioUk = d.audioUk;
        saveWords();
        renderList();
        toast('✓ 已更新释义');
      } else {
        toast('仍未找到该词的释义');
      }
    } catch (err) {
      toast('查询失败：' + err.message);
    }
  }

  // ---------- 添加流程 ----------
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

    addBtn.disabled = true;
    hint.textContent = '正在查询音标和释义…';
    let data;
    let fetchErr = '';
    try {
      data = await lookupWord(word);
    } catch (err) {
      data = null;
      fetchErr = err.message;
    } finally {
      addBtn.disabled = false;
      hint.textContent = '添加后自动标注音标、中文释义，并支持朗读';
    }

    if (data) {
      previewData = Object.assign({ word: word }, data);
      showPreview();
    } else {
      previewData = { word: word, phoneticUs: '', phoneticUk: '', definitions: [], enDefs: [], audioUs: '', audioUk: '' };
      showPreview('查询失败：' + fetchErr);
    }
  });

  function showPreview(extraMsg) {
    const p = previewData;
    previewWord.textContent = p.word;
    const hasZh = (p.definitions || []).length > 0;
    const hasEn = (p.enDefs || []).length > 0;
    previewStatus.textContent = hasZh ? '✓ 已获取释义' : (hasEn ? '未获取到中文释义' : (extraMsg || '未获取到释义'));
    previewStatus.className = 'status-chip' + (hasZh ? '' : ' warn');

    const phLines = phoneticLines(p);
    previewPhonetic.innerHTML = phLines.map((l) =>
      '<span class="ph-line"><span class="ph-tag">' + l.tag + '</span>' +
      '<span>' + esc(l.text) + '</span>' +
      (l.audio ? '<button class="ph-sound" data-audio="' + esc(l.audio) + '">🔊</button>' : '') +
      '</span>').join('');

    const zhHtml = (p.definitions || []).map((d) => '<li>' + esc(d) + '</li>').join('');
    const enHtml = (p.enDefs || []).map((d) => '<div class="en-line">' + esc(d) + '</div>').join('');
    previewDefs.innerHTML =
      (zhHtml ? '<ul>' + zhHtml + '</ul>' : '') +
      (enHtml ? '<div class="en-list">' + (zhHtml ? '<div class="en-label">英文释义</div>' : '') + enHtml + '</div>' : '') +
      (!zhHtml && !enHtml ? '<div style="color:#c2410c;font-size:13px">' + (extraMsg ? esc(extraMsg) : '未找到释义，可确认添加后手动编辑') + '</div>' : '');

    preview.classList.remove('hidden');
    preview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  previewConfirm.addEventListener('click', () => {
    if (!previewData) return;
    words.unshift({
      id: uid(),
      word: previewData.word,
      phoneticUs: previewData.phoneticUs || '',
      phoneticUk: previewData.phoneticUk || '',
      definitions: (previewData.definitions || []).slice(0, 8),
      enDefs: (previewData.enDefs || []).slice(0, 6),
      audioUs: previewData.audioUs || '',
      audioUk: previewData.audioUk || '',
      addedAt: Date.now(),
    });
    saveWords();
    renderList();
    preview.classList.add('hidden');
    previewData = null;
    wordInput.value = '';
    wordInput.focus();
    toast('✓ 已添加到生词本');
  });

  previewCancel.addEventListener('click', () => {
    preview.classList.add('hidden');
    previewData = null;
    wordInput.focus();
  });

  // 预览区音频
  previewPhonetic.addEventListener('click', (e) => {
    const s = e.target.closest('[data-audio]');
    if (s) play(s.getAttribute('data-audio'), previewWord.textContent.trim());
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
  renderList();
  updateCount();
})();
