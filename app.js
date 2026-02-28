/* global $, localStorage, DOMPurify, marked */

(function () {
  const STORAGE_KEY = "vocab_anki_like_v1";
  const DAY_MS = 24 * 60 * 60 * 1000;

  function nowMs() {
    return Date.now();
  }

  function dateKeyFromMs(ms) {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${da}`;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function uid(prefix) {
    return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
  }

  function toast(msg) {
    const $t = $("#toast");
    $t.text(msg).removeClass("hidden");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      $t.addClass("hidden");
    }, 1800);
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  // ===== TTS =====
  function pronounceText(text) {
    const t = String(text || "").trim();
    if (!t) return;
    if (!("speechSynthesis" in window)) {
      toast("当前浏览器不支持发音");
      return;
    }
    const u = new SpeechSynthesisUtterance(t);
    u.lang = "en-US";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  // ===== State =====
  function defaultState() {
    const deckId = uid("deck");
    return {
      version: 1,
      selectedDeckId: deckId,
      settings: {
        newPerDay: 20,
        reviewMode: "en2zh",
        filterTopic: "",
        filterPos: "",
      },
      decks: {
        [deckId]: {
          id: deckId,
          name: "默认牌组",
          createdAt: nowMs(),
          updatedAt: nowMs(),
        },
      },
      cards: {},
      logsByDay: {},
    };
  }

  let state = loadState();

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return defaultState();

      if (!parsed.settings || typeof parsed.settings !== "object") {
        parsed.settings = { newPerDay: 20, reviewMode: "en2zh", filterTopic: "", filterPos: "" };
      } else {
        if (typeof parsed.settings.newPerDay !== "number") parsed.settings.newPerDay = 20;
        if (parsed.settings.reviewMode !== "en2zh" && parsed.settings.reviewMode !== "zh2en") parsed.settings.reviewMode = "en2zh";
        if (typeof parsed.settings.filterTopic !== "string") parsed.settings.filterTopic = "";
        if (typeof parsed.settings.filterPos !== "string") parsed.settings.filterPos = "";
      }

      if (!parsed.decks || Object.keys(parsed.decks).length === 0) {
        return defaultState();
      }

      return parsed;
    } catch (e) {
      return defaultState();
    }
  }

  function saveState() {
    state._lastSavedAt = nowMs();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function ensureSelectedDeck() {
    if (state.selectedDeckId && state.decks[state.selectedDeckId]) return;
    const ids = Object.keys(state.decks);
    state.selectedDeckId = ids[0] || null;
  }

  function getDeckCards(deckId) {
    return Object.values(state.cards).filter((c) => c.deckId === deckId);
  }

  function isDue(card, atMs) {
    return (card.dueAt || 0) <= atMs;
  }

  // ===== Scheduling =====
  function applyGrade(card, grade, atMs) {
    const g = clamp(Number(grade), 0, 5);

    const prevEF = typeof card.ef === "number" ? card.ef : 2.5;
    let ef = prevEF + (0.1 - (5 - g) * (0.08 + (5 - g) * 0.02));
    ef = Math.max(1.3, ef);

    let reps = Number(card.reps || 0);
    let intervalDays = Number(card.intervalDays || 0);

    if (g < 3) {
      reps = 0;
      intervalDays = 1;
    } else {
      reps += 1;
      if (reps === 1) intervalDays = 1;
      else if (reps === 2) intervalDays = 6;
      else intervalDays = Math.max(1, Math.round(intervalDays * ef));
    }

    const dueAt = atMs + intervalDays * DAY_MS;

    card.ef = ef;
    card.reps = reps;
    card.intervalDays = intervalDays;
    card.lastReviewedAt = atMs;
    card.dueAt = dueAt;
    card.updatedAt = atMs;

    return card;
  }

  // ===== Logs =====
  function ensureDayLog(dk) {
    if (!state.logsByDay[dk]) {
      state.logsByDay[dk] = { total: 0, correct: 0, new: 0, byDeck: {}, events: [] };
    }
    const day = state.logsByDay[dk];
    if (typeof day.new !== "number") day.new = 0;
    if (!day.byDeck || typeof day.byDeck !== "object") day.byDeck = {};
    if (!Array.isArray(day.events)) day.events = [];
    return day;
  }

  function ensureDeckDayLog(day, deckId) {
    if (!day.byDeck[deckId]) {
      day.byDeck[deckId] = { total: 0, correct: 0, new: 0 };
    }
    const bd = day.byDeck[deckId];
    if (typeof bd.new !== "number") bd.new = 0;
    return bd;
  }

  function logReview(deckId, cardId, grade, atMs, kind, mode) {
    const dk = dateKeyFromMs(atMs);
    const day = ensureDayLog(dk);
    const bd = ensureDeckDayLog(day, deckId);

    const g = Number(grade);
    const correct = g >= 3;

    const ev = {
      t: atMs,
      deckId,
      cardId,
      grade: g,
      correct,
      kind: kind === "new" ? "new" : "review",
      mode: mode === "zh2en" ? "zh2en" : "en2zh",
    };

    day.events.push(ev);
    if (day.events.length > 20000) day.events.shift();

    day.total += 1;
    bd.total += 1;

    if (correct) {
      day.correct += 1;
      bd.correct += 1;
    }

    if (kind === "new") {
      day.new += 1;
      bd.new += 1;
    }

    state.logsByDay[dk] = day;
  }

  // ===== Import / Export =====
  function parseImportText(text) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const items = [];
    const errors = [];

    lines.forEach((line, idx) => {
      let parts;
      if (line.includes("\t")) parts = line.split("\t");
      else parts = line.split(",");

      const front = (parts[0] || "").trim();
      const back = (parts[1] || "").trim();

      const example = (parts[2] || "").trim();
      const pos = (parts[3] || "").trim();
      const topic = (parts[4] || "").trim();
      const syn = (parts[5] || "").trim();
      const collocation = (parts[6] || "").trim();

      if (!front || !back) {
        errors.push({ line: idx + 1, raw: line });
        return;
      }

      items.push({ front, back, example, pos, topic, syn, collocation });
    });

    return { items, errors };
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(state, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vocab-backup-${dateKeyFromMs(nowMs())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ===== Decks =====
  function renderNav(activeView) {
    $(".nav-btn").each(function () {
      const $b = $(this);
      const v = $b.data("view");
      if (v === activeView) $b.addClass("active");
      else $b.removeClass("active");
    });

    $(".view").addClass("hidden");
    $("#view-" + activeView).removeClass("hidden");
  }

  function renderDeckSelects() {
    const deckEntries = Object.values(state.decks).sort((a, b) => a.createdAt - b.createdAt);
    const options = deckEntries
      .map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`)
      .join("");

    $("#import-deck-select").html(options);
    $("#review-deck-select").html(options);
    $("#stats-deck-select").html(options);

    if (state.selectedDeckId) {
      $("#import-deck-select").val(state.selectedDeckId);
      $("#review-deck-select").val(state.selectedDeckId);
      $("#stats-deck-select").val(state.selectedDeckId);
    }
  }

  function renderDeckList() {
    ensureSelectedDeck();
    const at = nowMs();
    const decks = Object.values(state.decks).sort((a, b) => a.createdAt - b.createdAt);
    const html = decks
      .map((d) => {
        const total = getDeckCards(d.id).length;
        const due = getDeckCards(d.id).filter((c) => isDue(c, at)).length;
        const isSel = d.id === state.selectedDeckId;

        return `
          <div class="rounded-2xl border border-slate-200 bg-white p-4">
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="text-base font-semibold">${escapeHtml(d.name)}</div>
                <div class="mt-1 flex flex-wrap gap-2">
                  <span class="badge">总卡片：${total}</span>
                  <span class="badge">到期：${due}</span>
                </div>
              </div>
              <div class="flex flex-col gap-2">
                <button class="btn ${isSel ? "btn-primary" : ""} btn-select-deck" data-id="${escapeHtml(d.id)}">${
          isSel ? "当前" : "选择"
        }</button>
                <button class="btn btn-rename-deck" data-id="${escapeHtml(d.id)}">重命名</button>
                <button class="btn btn-delete-deck" data-id="${escapeHtml(d.id)}">删除</button>
              </div>
            </div>
          </div>
        `;
      })
      .join("");

    $("#deck-list").html(html || "<div class=\"text-sm text-slate-500\">还没有牌组</div>");
  }

  function setSelectedDeck(deckId) {
    if (!state.decks[deckId]) return;
    state.selectedDeckId = deckId;
    saveState();
    renderDeckSelects();
    renderDeckList();
    renderReviewSummary();
    renderStats();
  }

  function buildDeckFrontIndex(deckId) {
    const idx = {};
    Object.values(state.cards).forEach((c) => {
      if (c.deckId !== deckId) return;
      const key = String(c.front || "").trim().toLowerCase();
      if (!key) return;
      idx[key] = c.id;
    });
    return idx;
  }

  function renderImportPreview(previewItems, errors, dupInfo) {
    const rows = previewItems
      .slice(0, 200)
      .map(
        (it) => `
        <div class="flex gap-3 border-b border-slate-100 px-3 py-2">
          <div class="w-1/3 font-semibold">${escapeHtml(it.front)}</div>
          <div class="w-2/3 text-slate-700">${escapeHtml(it.back)}${
          it.example ? `<div class="mt-1 text-xs text-slate-500">${escapeHtml(it.example)}</div>` : ""
        }</div>
        </div>
      `
      )
      .join("");

    $("#import-preview").html(rows || "<div class=\"px-3 py-3 text-sm text-slate-500\">暂无预览</div>");

    const eCount = errors.length;
    const okCount = previewItems.length;
    const dupCount = (dupInfo && dupInfo.duplicates) || 0;
    let hint = `${okCount} 条可导入`;
    if (dupCount) hint += `（其中 ${dupCount} 条与现有单词重复）`;
    if (eCount > 0) hint += `，${eCount} 行格式有误（已跳过）`;
    $("#import-preview-count").text(hint);
  }

  function commitImport(items, deckId, dupMode) {
    const at = nowMs();
    const mode = dupMode === "overwrite" ? "overwrite" : "skip";
    const frontIndex = buildDeckFrontIndex(deckId);
    let added = 0;
    let updated = 0;
    let skipped = 0;

    items.forEach((it) => {
      const key = String(it.front || "").trim().toLowerCase();
      const existingId = key ? frontIndex[key] : null;

      if (existingId) {
        if (mode === "skip") {
          skipped += 1;
          return;
        }

        const c = state.cards[existingId];
        if (c) {
          c.front = it.front;
          c.back = it.back;
          c.example = it.example || "";
          c.pos = it.pos || c.pos || "";
          c.topic = it.topic || c.topic || "";
          c.syn = it.syn || c.syn || "";
          c.collocation = it.collocation || c.collocation || "";
          c.updatedAt = at;
          state.cards[existingId] = c;
          updated += 1;
        }
        return;
      }

      const id = uid("card");
      state.cards[id] = {
        id,
        deckId,
        front: it.front,
        back: it.back,
        example: it.example || "",
        pos: it.pos || "",
        topic: it.topic || "",
        syn: it.syn || "",
        collocation: it.collocation || "",
        createdAt: at,
        updatedAt: at,
        ef: 2.5,
        reps: 0,
        intervalDays: 0,
        lastReviewedAt: null,
        dueAt: at,
      };
      added += 1;
    });

    if (state.decks[deckId]) state.decks[deckId].updatedAt = at;

    saveState();
    renderDeckList();
    renderReviewSummary();
    renderStats();

    const parts = [];
    if (added) parts.push(`新增 ${added}`);
    if (updated) parts.push(`覆盖 ${updated}`);
    if (skipped) parts.push(`跳过 ${skipped}`);
    toast(parts.length ? `导入完成：${parts.join("，")}` : "导入完成");
  }

  // ===== Review session =====
  const reviewSession = {
    deckId: null,
    queue: [],
    index: 0,
    currentCardId: null,
    currentKind: "review",
    shown: false,
    sessionMode: null, // "new" | "review" | "reinforce" | null
  };

  function isNewCard(card) {
    return !card.lastReviewedAt;
  }

  function normalizeTag(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replaceAll(/\s+/g, " ");
  }

  function cardMatchesFilters(card) {
    const ft = normalizeTag(state.settings.filterTopic);
    const fp = normalizeTag(state.settings.filterPos);

    if (ft) {
      const ct = normalizeTag(card.topic);
      if (!ct || ct !== ft) return false;
    }

    if (fp) {
      const cp = normalizeTag(card.pos);
      if (!cp) return false;
      if (!cp.startsWith(fp)) return false;
    }

    return true;
  }

  function buildReviewQueue(deckId) {
    const at = nowMs();
    return getDeckCards(deckId)
      .filter((c) => isDue(c, at) && !isNewCard(c) && cardMatchesFilters(c))
      .sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0))
      .map((c) => c.id);
  }

  function getReinforceQueue(deckId) {
    const at = nowMs();
    return getDeckCards(deckId)
      .filter((c) => !isNewCard(c) && !isDue(c, at) && cardMatchesFilters(c))
      .sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0))
      .map((c) => c.id);
  }

  function countNewToday(deckId) {
    const dk = dateKeyFromMs(nowMs());
    const day = state.logsByDay[dk];
    if (!day) return 0;
    const bd = day.byDeck && day.byDeck[deckId];
    return (bd && Number(bd.new || 0)) || 0;
  }

  function buildNewQueue(deckId, limit) {
    const remaining = Math.max(0, Number(limit || 0) - countNewToday(deckId));
    if (remaining <= 0) return [];

    return getDeckCards(deckId)
      .filter((c) => isNewCard(c) && cardMatchesFilters(c))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, remaining)
      .map((c) => c.id);
  }

  function getNewPlanned(deckId) {
    const newLimit = Number(state.settings.newPerDay) || 0;
    return buildNewQueue(deckId, newLimit);
  }

  function renderReviewSummary() {
    const deckId = $("#review-deck-select").val() || state.selectedDeckId;
    if (!deckId || !state.decks[deckId]) return;

    const at = nowMs();
    const total = getDeckCards(deckId).length;
    const dueReview = buildReviewQueue(deckId).length;
    const newLimit = Number(state.settings.newPerDay) || 0;
    const newToday = countNewToday(deckId);
    const newAvailable = getDeckCards(deckId).filter((c) => isNewCard(c)).length;
    const newRemaining = Math.max(0, newLimit - newToday);
    const newPlanned = Math.min(newRemaining, newAvailable);

    $("#review-summary").html(
      [
        `<span class="badge">牌组：${escapeHtml(state.decks[deckId].name)}</span>`,
        `<span class="badge">总卡片：${total}</span>`,
        `<span class="badge">到期复习：${dueReview}</span>`,
        `<span class="badge">今日新增：${newToday}/${newLimit}</span>`,
        `<span class="badge">待学新卡：${newAvailable}</span>`,
      ].join(" ")
    );

    $("#new-count").text(newPlanned);
    $("#review-count").text(dueReview);
    $("#reinforce-count").text(getReinforceQueue(deckId).length);

    if (!reviewSession.deckId || reviewSession.deckId !== deckId) {
      resetReviewSession(deckId);
    }
  }

  function renderSessionPreview(kind) {
    const deckId = $("#review-deck-select").val() || state.selectedDeckId;
    if (!deckId || !state.decks[deckId]) {
      toast("请先选择牌组");
      return;
    }

    let ids = [];
    let title = "";

    if (kind === "review") {
      ids = buildReviewQueue(deckId);
      title = "到期复习列表";
    } else if (kind === "reinforce") {
      ids = getReinforceQueue(deckId);
      title = "巩固学习列表";
    } else {
      return;
    }

    const total = ids.length;
    const limit = 200;
    const shown = Math.min(total, limit);

    $("#review-preview-title").text(
      total
        ? `${title}：共 ${total} 张，当前显示前 ${shown} 张`
        : `${title}：当前没有卡片`
    );

    if (!total) {
      $("#review-preview-list").html(
        '<div class="px-3 py-3 text-sm text-slate-500">暂无卡片</div>'
      );
      $("#review-preview").removeClass("hidden");
      return;
    }

    const rows = ids.slice(0, limit)
      .map((id) => {
        const c = state.cards[id];
        if (!c) return "";
        const front = escapeHtml(c.front || "");
        const back = escapeHtml(c.back || "");
        const metaParts = [];
        if (c.pos) metaParts.push(escapeHtml(c.pos));
        if (c.topic) metaParts.push(escapeHtml(c.topic));
        const meta = metaParts.length
          ? `<span class="ml-2 text-xs text-slate-400">${metaParts.join(" · ")}</span>`
          : "";
        const backHtml = back
          ? `<div class="mt-1 text-sm text-slate-700">${back}</div>`
          : "";
        return `
          <div class="border-b border-slate-100 px-3 py-2">
            <div class="text-sm font-semibold">${front}${meta}</div>
            ${backHtml}
          </div>
        `;
      })
      .filter(Boolean)
      .join("");

    $("#review-preview-list").html(
      rows || '<div class="px-3 py-3 text-sm text-slate-500">暂无卡片</div>'
    );
    $("#review-preview").removeClass("hidden");
  }

  function resetReviewSession(deckId) {
    reviewSession.deckId = deckId;
    reviewSession.queue = [];
    reviewSession.index = 0;
    reviewSession.currentCardId = null;
    reviewSession.currentKind = "review";
    reviewSession.shown = false;
    reviewSession.sessionMode = null;

    $("#review-card-area").addClass("hidden");
    $("#session-choice").removeClass("hidden");
    $("#review-preview").addClass("hidden");
  }

  function showCard(cardId) {
    const card = state.cards[cardId];
    if (!card) return;

    reviewSession.currentCardId = cardId;
    reviewSession.shown = false;
    reviewSession.currentKind = isNewCard(card) ? "new" : "review";

    const mode = state.settings.reviewMode || "en2zh";

    $("#spell-feedback").text("").removeClass("text-red-600 text-green-700");
    $("#spell-input").val("");

    const kindLabel = reviewSession.currentKind === "new" ? "新增" : "复习";
    const ef = Number(card.ef || 2.5).toFixed(2);
    const reps = String(card.reps || 0);
    const interval = String(card.intervalDays || 0) + "天";

    const metaRows = [
      `<div class="meta-head">${escapeHtml(kindLabel)}</div>`,
      `<div class="meta-grid">
        <div class="meta-item"><span class="meta-k">易记系数（EF）：</span><span class="meta-v">${escapeHtml(ef)}</span></div>
        <div class="meta-item"><span class="meta-k">连续记住次数（reps）：</span><span class="meta-v">${escapeHtml(reps)}</span></div>
        <div class="meta-item"><span class="meta-k">下次间隔（interval）：</span><span class="meta-v">${escapeHtml(interval)}</span></div>
        ${card.pos ? `<div class=\"meta-item\"><span class=\"meta-k\">词性（pos）：</span><span class=\"meta-v\">${escapeHtml(card.pos)}</span></div>` : ""}
        ${card.topic ? `<div class=\"meta-item\"><span class=\"meta-k\">主题（topic）：</span><span class=\"meta-v\">${escapeHtml(card.topic)}</span></div>` : ""}
      </div>`,
      (card.syn || card.collocation)
        ? `<div class="meta-grid meta-grid-wide">
            ${card.syn ? `<div class=\"meta-item meta-item-wide\"><span class=\"meta-k\">同义词（syn）：</span><span class=\"meta-v\">${escapeHtml(card.syn)}</span></div>` : ""}
            ${card.collocation ? `<div class=\"meta-item meta-item-wide\"><span class=\"meta-k\">搭配（coll）：</span><span class=\"meta-v\">${escapeHtml(card.collocation)}</span></div>` : ""}
          </div>`
        : "",
    ].join("");

    $("#card-meta").removeClass("hidden").html(`<div class=\"meta-panel\">${metaRows}</div>`);

    if (mode === "zh2en") {
      $("#card-front").text(card.back);
      $("#card-back").addClass("hidden").text(card.back);
      $("#grade-area").addClass("hidden");
      $("#spell-area").removeClass("hidden");
      $("#btn-show").prop("disabled", true);
    } else {
      $("#card-front").text(card.front);
      $("#card-back").addClass("hidden").text(card.back);
      $("#grade-area").removeClass("hidden");
      $("#spell-area").addClass("hidden");
      $(".grade-btn").prop("disabled", false);
      $("#btn-show").prop("disabled", false);

      if (card.example) {
        $("#card-example").removeClass("hidden").text(card.example);
      } else {
        $("#card-example").addClass("hidden").text("");
      }

      setTimeout(() => pronounceText(card.front), 150);
    }

    $("#card-front").addClass("card-front-big");
    $("#card-back").addClass("card-back-big");
    $("#card-example").addClass("card-example-big");
  }

  function showNextCard() {
    if (!reviewSession.queue.length) {
      if (reviewSession.sessionMode) {
        toast("本轮学习结束！");
        $("#review-card-area").addClass("hidden");
        $("#session-choice").removeClass("hidden");
        reviewSession.sessionMode = null;
        renderReviewSummary();
      }
      return;
    }

    const total = reviewSession.queue.length;
    const nextId = reviewSession.queue[reviewSession.index % total];
    showCard(nextId);
  }

  function gradeCurrent(grade) {
    const cardId = reviewSession.currentCardId;
    const card = state.cards[cardId];
    if (!card) return;

    const at = nowMs();
    applyGrade(card, grade, at);

    const mode = state.settings.reviewMode || "en2zh";
    logReview(card.deckId, card.id, grade, at, reviewSession.currentKind, mode);

    saveState();

    reviewSession.queue = reviewSession.queue.filter((id) => id !== cardId);

    renderDeckList();
    renderReviewSummary();
    renderStats();

    toast("已记录");
    showNextCard();
  }

  // ===== Stats =====
  function getStatsForDeck(deckId) {
    const at = nowMs();
    const totalCards = getDeckCards(deckId).length;
    const dueReview = buildReviewQueue(deckId).length;
    const newAvailable = getDeckCards(deckId).filter((c) => isNewCard(c)).length;

    const todayKey = dateKeyFromMs(at);
    const today = state.logsByDay[todayKey];

    let todayTotal = 0;
    let todayCorrect = 0;
    let todayNew = 0;

    if (today) {
      const bd = today.byDeck && today.byDeck[deckId];
      if (bd) {
        todayTotal = bd.total;
        todayCorrect = bd.correct;
        todayNew = Number(bd.new || 0);
      }
    }

    const acc = todayTotal ? Math.round((todayCorrect / todayTotal) * 100) : 0;
    return { totalCards, dueReview, newAvailable, todayTotal, todayNew, acc };
  }

  function buildTrend(deckId, days) {
    const at = nowMs();
    const arr = [];
    for (let i = days - 1; i >= 0; i--) {
      const dk = dateKeyFromMs(at - i * DAY_MS);
      const day = state.logsByDay[dk];
      let total = 0;
      if (day) {
        const bd = day.byDeck && day.byDeck[deckId];
        if (bd) total = bd.total;
      }
      arr.push({ dk, total });
    }
    return arr;
  }

  function renderSparkline(trend) {
    const max = Math.max(1, ...trend.map((t) => t.total));
    const bars = trend
      .map((t) => {
        const h = Math.round((t.total / max) * 60);
        return `
          <div class="flex flex-col items-center justify-end" style="width: 10px;">
            <div title="${escapeHtml(t.dk)}：${t.total}" style="height:${h}px; width:10px; background: rgb(15 23 42); border-radius:4px; opacity:${
          t.total ? 0.9 : 0.15
        }"></div>
          </div>
        `;
      })
      .join("");

    $("#sparkline").html(
      `<div class="flex items-end gap-1" style="height:70px;">${bars}</div><div class="mt-2 text-xs text-slate-500">柱高=当天复习次数</div>`
    );
  }

  function computeAccByTag(deckId, tagField) {
    const acc = {};
    const cardById = state.cards || {};

    Object.keys(state.logsByDay).forEach((dk) => {
      const day = ensureDayLog(dk);
      const events = day.events || [];
      events.forEach((ev) => {
        if (!ev || ev.deckId !== deckId) return;
        const c = cardById[ev.cardId];
        if (!c) return;
        const key = normalizeTag(c[tagField]) || "(未标注)";
        if (!acc[key]) acc[key] = { key, total: 0, correct: 0 };
        acc[key].total += 1;
        if (ev.correct) acc[key].correct += 1;
      });
    });

    return Object.values(acc).sort((a, b) => {
      const aAcc = a.total ? a.correct / a.total : 0;
      const bAcc = b.total ? b.correct / b.total : 0;
      if (aAcc !== bAcc) return aAcc - bAcc;
      return b.total - a.total;
    });
  }

  function renderTagAccTable(containerId, items) {
    const rows = items
      .slice(0, 30)
      .map((it) => {
        const acc = it.total ? Math.round((it.correct / it.total) * 100) : 0;
        return `
          <div class="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <div class="text-sm font-semibold">${escapeHtml(it.key)}</div>
            <div class="text-xs text-slate-500">${acc}%（${it.correct}/${it.total}）</div>
          </div>
        `;
      })
      .join("");
    $(containerId).html(rows || `<div class="px-3 py-3 text-sm text-slate-500">暂无数据</div>`);
  }

  function renderStats() {
    const deckId = $("#stats-deck-select").val() || state.selectedDeckId;
    if (!deckId || !state.decks[deckId]) return;

    const s = getStatsForDeck(deckId);
    $("#stat-today").text(String(s.todayTotal));
    $("#stat-acc").text(`${s.acc}%（新增 ${s.todayNew}）`);
    $("#stat-due").text(String(s.dueReview));
    $("#stat-new").text(String(s.newAvailable));

    const trend = buildTrend(deckId, 14);
    renderSparkline(trend);

    const topicDist = computeAccByTag(deckId, "topic");
    const posDist = computeAccByTag(deckId, "pos");
    renderTagAccTable("#stats-topic", topicDist);
    renderTagAccTable("#stats-pos", posDist);
  }

  // ===== AI drawer =====
  const AI_KEY_STORAGE = "deepseek_api_key";
  const AI_CHAT_STORAGE = "deepseek_chat_v1";
  const AI_MAX_TURNS = 10;

  function loadAiKey() {
    return localStorage.getItem(AI_KEY_STORAGE) || "";
  }

  function saveAiKey(key) {
    localStorage.setItem(AI_KEY_STORAGE, key);
  }

  function loadAiChat() {
    try {
      const raw = localStorage.getItem(AI_CHAT_STORAGE);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveAiChat(messages) {
    localStorage.setItem(AI_CHAT_STORAGE, JSON.stringify(messages));
  }

  function clampAiChat(messages) {
    const max = AI_MAX_TURNS * 2;
    if (messages.length <= max) return messages;
    return messages.slice(messages.length - max);
  }

  function openAiDrawer() {
    $("body").addClass("ai-drawer-open");
  }

  function closeAiDrawer() {
    $("body").removeClass("ai-drawer-open");
  }

  function renderAiMessages() {
    const msgs = loadAiChat();
    const html = msgs
      .map((m) => {
        const cls = m.role === "user" ? "user" : "assistant";
        let contentHtml;
        if (m.role === "user") {
          contentHtml = escapeHtml(m.content);
        } else if (m._loading) {
          contentHtml = escapeHtml(m.content);
        } else if (m._error) {
          contentHtml = `<p class=\"text-red-700\">${escapeHtml(m.content)}</p>`;
        } else {
          contentHtml = DOMPurify.sanitize(marked.parse(m.content));
        }
        return `<div class=\"ai-message ${cls}\">${contentHtml}</div>`;
      })
      .join("");

    const initialMessageHtml = DOMPurify.sanitize(
      marked.parse("你可以问：这个词在 TPO 阅读里怎么理解？例句在说什么？给我同义替换/拆句。")
    );

    $("#ai-chat-messages").html(html || `<div class=\"ai-message assistant\">${initialMessageHtml}</div>`);
    const container = $("#ai-chat-messages").parent();
    container.scrollTop(container[0].scrollHeight);
  }

  async function callDeepseek(messages, apiKey) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 30000);

    try {
      const resp = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: "deepseek-chat", messages, temperature: 0.3 }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${txt}`);
      }

      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error("返回内容为空");
      return String(content);
    } finally {
      clearTimeout(t);
    }
  }

  function buildCardContextPrompt() {
    const card = state.cards[reviewSession.currentCardId];
    if (!card) return "";

    const parts = [
      `当前单词：${card.front}`,
      `中文释义：${card.back}`,
      card.example ? `例句：${card.example}` : "",
      card.pos ? `词性：${card.pos}` : "",
      card.topic ? `主题：${card.topic}` : "",
      card.syn ? `同义词：${card.syn}` : "",
      card.collocation ? `搭配：${card.collocation}` : "",
    ].filter(Boolean);

    return (
      "请作为托福TPO阅读词汇助教，帮助我理解该词在学术语境中的含义，并解释例句。\n" +
      parts.join("\n") +
      "\n\n我接下来会继续追问，请保持上下文连续。"
    );
  }

  // ===== Events =====
  function initEvents() {
    $(document).on("click", ".nav-btn", function () {
      const view = $(this).data("view");
      renderNav(view);
      if (view === "review") renderReviewSummary();
      if (view === "stats") renderStats();
    });

    $("#new-per-day").on("change", function () {
      let v = Number($(this).val());
      if (!Number.isFinite(v) || v < 0) v = 0;
      v = Math.round(v);
      state.settings.newPerDay = v;
      $("#new-per-day").val(String(v));
      saveState();
      renderReviewSummary();
      toast("已更新每日新增上限");
    });

    $("#review-mode").on("change", function () {
      const val = $(this).val();
      const mode = val === "zh2en" ? "zh2en" : "en2zh";
      state.settings.reviewMode = mode;
      $("#review-mode").val(mode);
      saveState();
      if (reviewSession.currentCardId) {
        showCard(reviewSession.currentCardId);
      }
    });

    $("#new-per-day").on("change", function () {
      let v = Number($(this).val());
      if (!Number.isFinite(v) || v < 0) v = 0;
      v = Math.round(v);
      state.settings.newPerDay = v;
      $("#new-per-day").val(String(v));
      saveState();
      renderReviewSummary();
      toast("已更新每日新增上限");
    });

    // deck buttons
    $("#btn-create-deck").on("click", function () {
      const name = $("#new-deck-name").val().trim();
      if (!name) {
        toast("请输入牌组名称");
        return;
      }
      const id = uid("deck");
      const at = nowMs();
      state.decks[id] = { id, name, createdAt: at, updatedAt: at };
      state.selectedDeckId = id;
      $("#new-deck-name").val("");
      saveState();
      renderDeckSelects();
      renderDeckList();
      renderReviewSummary();
      renderStats();
      toast("已创建");
    });

    $(document).on("click", ".btn-select-deck", function () {
      const id = $(this).data("id");
      setSelectedDeck(id);
    });

    $(document).on("click", ".btn-rename-deck", function () {
      const id = $(this).data("id");
      const d = state.decks[id];
      if (!d) return;
      const name = prompt("新名称：", d.name);
      if (!name) return;
      d.name = name.trim();
      d.updatedAt = nowMs();
      state.decks[id] = d;
      saveState();
      renderDeckSelects();
      renderDeckList();
      renderReviewSummary();
      renderStats();
      toast("已重命名");
    });

    $(document).on("click", ".btn-delete-deck", function () {
      const id = $(this).data("id");
      if (!state.decks[id]) return;
      if (!confirm("确定删除该牌组？（卡片也会一起删除）")) return;
      Object.keys(state.cards).forEach((cid) => {
        if (state.cards[cid].deckId === id) delete state.cards[cid];
      });
      delete state.decks[id];
      ensureSelectedDeck();
      saveState();
      renderDeckSelects();
      renderDeckList();
      renderReviewSummary();
      renderStats();
      toast("已删除");
    });

    // export/reset
    $("#btn-export").on("click", function () {
      exportJson();
    });

    $("#btn-reset").on("click", function () {
      if (!confirm("确定清空全部数据？该操作不可撤销。")) return;
      localStorage.removeItem(STORAGE_KEY);
      state = defaultState();
      saveState();
      renderAll();
      toast("已清空");
    });

    // session buttons
    function startReviewSession(mode) {
      const deckId = $("#review-deck-select").val() || state.selectedDeckId;
      if (!deckId || !state.decks[deckId]) {
        toast("请先选择牌组");
        return;
      }

      if (mode === "new") {
        reviewSession.sessionMode = "new";
        reviewSession.queue = getNewPlanned(deckId);
      } else if (mode === "review") {
        reviewSession.sessionMode = "review";
        reviewSession.queue = buildReviewQueue(deckId);
      } else if (mode === "reinforce") {
        reviewSession.sessionMode = "reinforce";
        reviewSession.queue = getReinforceQueue(deckId);
      }

      reviewSession.index = 0;
      reviewSession.currentCardId = null;
      reviewSession.shown = false;

      $("#session-choice").addClass("hidden");
      $("#review-card-area").removeClass("hidden");
      $("#review-preview").addClass("hidden");
      showNextCard();
    }

    $("#btn-start-new").on("click", () => startReviewSession("new"));
    $("#btn-start-review").on("click", () => startReviewSession("review"));
    $("#btn-start-reinforce").on("click", () => startReviewSession("reinforce"));

    $("#btn-preview-review").on("click", () => renderSessionPreview("review"));
    $("#btn-preview-reinforce").on("click", () => renderSessionPreview("reinforce"));

    $("#btn-back-to-choice").on("click", function () {
      reviewSession.queue = [];
      reviewSession.index = 0;
      reviewSession.currentCardId = null;
      reviewSession.sessionMode = null;
      $("#review-card-area").addClass("hidden");
      $("#session-choice").removeClass("hidden");
      renderReviewSummary();
      toast("已返回选择界面");
    });

    $("#btn-show").on("click", function () {
      const mode = state.settings.reviewMode || "en2zh";
      if (mode !== "en2zh") return;
      if (!reviewSession.currentCardId) return;
      $("#card-back").removeClass("hidden");
      $(this).prop("disabled", true);
    });

    $("#btn-pronounce-en2zh").on("click", function () {
      const card = state.cards[reviewSession.currentCardId];
      if (!card) return;
      pronounceText(card.front);
    });

    $("#btn-pronounce").on("click", function () {
      const card = state.cards[reviewSession.currentCardId];
      if (!card) return;
      pronounceText(card.front);
    });

    $("#btn-check-spell").on("click", function () {
      const card = state.cards[reviewSession.currentCardId];
      if (!card) return;

      const rawInput = String($("#spell-input").val() || "");
      const input = rawInput.trim();
      if (!input) {
        $("#spell-feedback")
          .text("请输入拼写")
          .removeClass("text-green-700")
          .addClass("text-red-600");
        return;
      }

      const normalize = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
      const target = normalize(card.front);
      const user = normalize(input);

      const correct = user === target;

      if (correct) {
        $("#spell-feedback")
          .text("正确！已按“记得”计入统计")
          .removeClass("text-red-600")
          .addClass("text-green-700");
        
        // 只有这里调用 gradeCurrent(5)，它内部会调用 showNextCard()
        gradeCurrent(5);
      } else {
        $("#spell-feedback")
          .text(`不完全正确，请重试`)
          .removeClass("text-green-700")
          .addClass("text-red-600");
        
        // 记录一次错误（grade=0），但不切卡
        const cardId = reviewSession.currentCardId;
        const card = state.cards[cardId];
        if (card) {
           const at = nowMs();
           // 只记录 log，不修改 card 的 interval/ef（或者你也想修改？通常拼错一次就算忘了）
           // 这里我们按“忘了”处理：applyGrade(card, 0, at)
           // 注意：如果这里 applyGrade 会导致 card 的 interval 变短。
           // 如果用户希望“拼错不跳卡”，通常意味着他想在当前界面直到拼对。
           // 但“忘了”这个事实已经发生了。
           // 策略：记录一次 grade=0 的 log，并更新卡片状态为“忘了”，但不调用 showNextCard。
           
           applyGrade(card, 0, at);
           const mode = state.settings.reviewMode || "en2zh";
           logReview(card.deckId, card.id, 0, at, reviewSession.currentKind, mode);
           saveState();
           renderReviewSummary();
           renderStats();
           toast("已记录为“忘了”，请继续尝试拼写");
        }
      }
    });

    $("#btn-reveal-spell").on("click", function () {
      const card = state.cards[reviewSession.currentCardId];
      if (!card) return;
      const answer = String(card.front || "").trim();
      $("#spell-input").val(answer);
      $("#spell-feedback")
        .text(`答案：${answer}`)
        .removeClass("text-green-700 text-red-600");
    });

    // import
    let importParsed = { items: [], errors: [] };
    $("#btn-parse-import").on("click", function () {
      importParsed = parseImportText($("#import-text").val());
      const deckId = $("#import-deck-select").val() || state.selectedDeckId;
      const frontIndex = deckId ? buildDeckFrontIndex(deckId) : {};
      const dupCount = importParsed.items.reduce((acc, it) => {
        const key = String(it.front || "").trim().toLowerCase();
        return acc + (key && frontIndex[key] ? 1 : 0);
      }, 0);
      renderImportPreview(importParsed.items, importParsed.errors, { duplicates: dupCount });
      $("#btn-commit-import").prop("disabled", importParsed.items.length === 0);
    });

    $("#btn-commit-import").on("click", function () {
      const deckId = $("#import-deck-select").val() || state.selectedDeckId;
      if (!deckId || !state.decks[deckId]) return;
      const dupMode = $("#import-dup-mode").val();
      commitImport(importParsed.items, deckId, dupMode);
    });

    // deck select in review
    $("#review-deck-select").on("change", function () {
      const id = $(this).val();
      if (id) {
        setSelectedDeck(id);
        resetReviewSession(id);
      }
    });

    // grading & skip
    $(".grade-btn").on("click", function () {
      const grade = $(this).data("grade");
      gradeCurrent(grade);
    });

    $("#btn-skip").on("click", function () {
      if (!reviewSession.queue.length) return;
      reviewSession.index = (reviewSession.index + 1) % reviewSession.queue.length;
      showNextCard();
    });

    // keyboard shortcuts in review view
    $(document).on("keydown", function (e) {
      const activeViewIsReview = !$("#view-review").hasClass("hidden");
      if (!activeViewIsReview) return;

      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const key = e.key.toLowerCase();

      if (key === " " || key === "spacebar") {
        // Space: show meaning
        const mode = state.settings.reviewMode || "en2zh";
        if (mode === "en2zh" && !$("#btn-show").prop("disabled")) {
          e.preventDefault();
          $("#btn-show").trigger("click");
        }
      } else if (key === "v") {
        e.preventDefault();
        const mode = state.settings.reviewMode || "en2zh";
        if (mode === "en2zh") $("#btn-pronounce-en2zh").trigger("click");
        else $("#btn-pronounce").trigger("click");
      } else if (key === "j") {
        e.preventDefault();
        $(".grade-btn[data-grade=0]").trigger("click");
      } else if (key === "k") {
        e.preventDefault();
        $(".grade-btn[data-grade=3]").trigger("click");
      } else if (key === "l") {
        e.preventDefault();
        $(".grade-btn[data-grade=5]").trigger("click");
      }
    });

    // stats deck select
    $("#stats-deck-select").on("change", function () {
      const id = $(this).val();
      if (id) {
        setSelectedDeck(id);
        renderStats();
      }
    });

    // AI drawer basic
    $("#ai-api-key").val(loadAiKey());
    renderAiMessages();
    $("#btn-toggle-ai").on("click", function () {
      openAiDrawer();
      renderAiMessages();
    });
    $("#btn-close-ai").on("click", closeAiDrawer);
    $("#btn-save-key").on("click", function () {
      const key = String($("#ai-api-key").val() || "").trim();
      if (!key) return;
      saveAiKey(key);
      toast("已保存 API Key（仅本机）");
    });
    $("#btn-ai-clear").on("click", function () {
      saveAiChat([]);
      renderAiMessages();
    });
    $("#btn-ai-inject").on("click", function () {
      const prompt = buildCardContextPrompt();
      if (!prompt) return;
      $("#ai-input").val(prompt);
    });
    $("#btn-ai-send").on("click", async function () {
      const apiKey = String($("#ai-api-key").val() || loadAiKey()).trim();
      const text = String($("#ai-input").val() || "").trim();
      if (!apiKey || !text) return;
      $("#ai-input").val("");

      let msgs = loadAiChat();
      msgs.push({ role: "user", content: text });
      msgs = clampAiChat(msgs);
      saveAiChat(msgs);
      renderAiMessages();

      try {
        const system = {
          role: "system",
          content:
            "你是托福TPO阅读词汇助教。用中文解释词义与例句，必要时拆句；给出1-2个更自然的同义替换；避免废话。",
        };
        const sendMsgs = [system].concat(clampAiChat(loadAiChat()));
        const answer = await callDeepseek(sendMsgs, apiKey);
        msgs = loadAiChat();
        msgs.push({ role: "assistant", content: answer });
        msgs = clampAiChat(msgs);
        saveAiChat(msgs);
        renderAiMessages();
      } catch (e) {
        toast("AI 请求失败");
      }
    });
  }

  function renderReviewControls() {
    $("#new-per-day").val(String(Number(state.settings.newPerDay) || 0));
    $("#review-mode").val(state.settings.reviewMode || "en2zh");
    $("#filter-topic").val(state.settings.filterTopic || "");
    $("#filter-pos").val(state.settings.filterPos || "");
  }

  function renderAll() {
    ensureSelectedDeck();
    renderDeckSelects();
    renderDeckList();
    renderReviewControls();
    renderReviewSummary();
    renderStats();
  }

  ensureSelectedDeck();

  $(function () {
    initEvents();
    renderAll();
    renderNav("decks");
  });
})();
