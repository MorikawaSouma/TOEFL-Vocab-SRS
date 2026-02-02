/* global $, localStorage */

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
        const st = defaultState();
        return st;
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

  function countDue(deckId, atMs) {
    return getDeckCards(deckId).filter((c) => isDue(c, atMs)).length;
  }

  // SM-2 inspired scheduling (Anki-like)
  // grade: 0 (忘了), 3 (模糊), 5 (记得)
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

  function ensureDayLog(dk) {
    if (!state.logsByDay[dk]) {
      state.logsByDay[dk] = { total: 0, correct: 0, new: 0, byDeck: {} };
    }
    const day = state.logsByDay[dk];
    if (typeof day.new !== "number") day.new = 0;
    if (!day.byDeck || typeof day.byDeck !== "object") day.byDeck = {};
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

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

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

      // 兼容：
      // 3列：word, meaning, example
      // 6列：word, meaning, example, pos, topic, syn
      // 7列：word, meaning, example, pos, topic, syn, collocation
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
        const due = countDue(d.id, at);
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

  const reviewSession = {
    deckId: null,
    queue: [],
    index: 0,
    currentCardId: null,
    currentKind: "review", // "review" | "new"
    shown: false,
    // filters/mode are from state.settings
  };

  function isNewCard(card) {
    return !card.lastReviewedAt;
  }

  function countNewToday(deckId) {
    const dk = dateKeyFromMs(nowMs());
    const day = state.logsByDay[dk];
    if (!day) return 0;
    if (deckId === "__all__") return Number(day.new || 0);
    const bd = day.byDeck && day.byDeck[deckId];
    return (bd && Number(bd.new || 0)) || 0;
  }

  function normalizeTag(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replaceAll(/\s+/g, " ");
  }

  function cardMatchesFilters(card) {
    const ft = normalizeTag(state.settings && state.settings.filterTopic);
    const fp = normalizeTag(state.settings && state.settings.filterPos);

    if (ft) {
      const ct = normalizeTag(card.topic);
      if (!ct || ct !== ft) return false;
    }

    if (fp) {
      const cp = normalizeTag(card.pos);
      if (!cp) return false;
      // 允许输入 "adj" 也能匹配 "adj." 等
      if (!cp.startsWith(fp)) return false;
    }

    return true;
  }

  function buildReviewQueue(deckId) {
    const at = nowMs();
    const dueCards = getDeckCards(deckId)
      .filter((c) => isDue(c, at) && !isNewCard(c) && cardMatchesFilters(c))
      .sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0));
    return dueCards.map((c) => c.id);
  }

  function buildNewQueue(deckId, limit) {
    const remaining = Math.max(0, Number(limit || 0) - countNewToday(deckId));
    if (remaining <= 0) return [];

    // new cards: never reviewed
    const newCards = getDeckCards(deckId)
      .filter((c) => isNewCard(c) && cardMatchesFilters(c))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, remaining);

    return newCards.map((c) => c.id);
  }

  function buildSessionQueue(deckId) {
    const newLimit = Number(state.settings && state.settings.newPerDay) || 0;
    const reviewQ = buildReviewQueue(deckId);
    const newQ = buildNewQueue(deckId, newLimit);
    // review first, then new
    return { reviewQ, newQ, queue: reviewQ.concat(newQ) };
  }

  function renderReviewSummary() {
    const deckId = $("#review-deck-select").val() || state.selectedDeckId;
    if (!deckId || !state.decks[deckId]) {
      $("#review-summary").html("<div class=\"text-sm text-slate-500\">请先创建牌组</div>");
      return;
    }

    const at = nowMs();
    const total = getDeckCards(deckId).length;
    const dueReview = buildReviewQueue(deckId).length;
    const newLimit = Number(state.settings && state.settings.newPerDay) || 0;
    const newToday = countNewToday(deckId);
    const newRemaining = Math.max(0, newLimit - newToday);
    const newAvailable = getDeckCards(deckId).filter((c) => isNewCard(c)).length;
    const newPlanned = Math.min(newRemaining, newAvailable);

    $("#review-summary").html(
      [
        `<span class="badge">牌组：${escapeHtml(state.decks[deckId].name)}</span>`,
        `<span class="badge">总卡片：${total}</span>`,
        `<span class="badge">到期复习：${dueReview}</span>`,
        `<span class="badge">今日新增：${newToday}/${newLimit}</span>`,
        `<span class="badge">待学新卡：${newAvailable}</span>`,
        `<span class="badge">本次将学：${newPlanned}</span>`,
      ].join(" ")
    );

    if (!reviewSession.deckId || reviewSession.deckId !== deckId) {
      resetReviewSession(deckId);
    }
  }

  function resetReviewSession(deckId) {
    reviewSession.deckId = deckId;
    const q = buildSessionQueue(deckId);
    reviewSession.queue = q.queue;
    reviewSession.index = 0;
    reviewSession.currentCardId = null;
    reviewSession.currentKind = "review";
    reviewSession.shown = false;
    showNextCard();
  }

  function showCard(cardId) {
    const card = state.cards[cardId];
    if (!card) return;

    reviewSession.currentCardId = cardId;
    reviewSession.shown = false;
    reviewSession.currentKind = isNewCard(card) ? "new" : "review";

    const mode = (state.settings && state.settings.reviewMode) || "en2zh";

    $("#spell-feedback").text("").removeClass("text-red-600 text-green-700");
    $("#spell-input").val("");

    if (mode === "zh2en") {
      // prompt: 中文释义；answer: 英文单词
      $("#card-front").text(card.back);
      $("#card-back").addClass("hidden").text("");
      $("#btn-show").prop("disabled", true);
      $("#grade-area").addClass("hidden");
      $("#spell-area").removeClass("hidden");
    } else {
      // en2zh
      $("#card-front").text(card.front);
      $("#card-back").addClass("hidden").text(card.back);
      $("#btn-show").prop("disabled", false);
      $("#grade-area").removeClass("hidden");
      $("#spell-area").addClass("hidden");
      $(".grade-btn").prop("disabled", true);
    }

    if (card.example) {
      $("#card-example").removeClass("hidden").text(card.example);
    } else {
      $("#card-example").addClass("hidden").text("");
    }

    // 加大卡片正文信息的字号与间距
    $("#card-front").addClass("card-front-big");
    $("#card-back").addClass("card-back-big");
    $("#card-example").addClass("card-example-big");

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

    $("#card-meta").html(`<div class="meta-panel">${metaRows}</div>`);

    // 进度显示已移除（避免误导且节省空间）
  }

  function showNextCard() {
    const total = reviewSession.queue.length;
    if (total === 0) {
      reviewSession.currentCardId = null;
      $("#card-front").text("暂无到期卡片");
      $("#card-back").addClass("hidden").text("");
      $("#card-example").addClass("hidden").text("");
      $("#btn-show").prop("disabled", true);
      $(".grade-btn").prop("disabled", true);
      $("#card-meta").text("");
      return;
    }

    const nextId = reviewSession.queue[reviewSession.index % total];
    showCard(nextId);
  }

  function gradeCurrent(grade) {
    const cardId = reviewSession.currentCardId;
    const card = state.cards[cardId];
    if (!card) return;

    const at = nowMs();
    applyGrade(card, grade, at);
    const mode = (state.settings && state.settings.reviewMode) || "en2zh";
    logReview(card.deckId, card.id, grade, at, reviewSession.currentKind, mode);

    saveState();

    // remove from current due queue (it is no longer due)
    reviewSession.queue = reviewSession.queue.filter((id) => id !== cardId);

    renderDeckList();
    renderReviewSummary();
    renderStats();

    toast("已记录");

    // keep index as is; show next
    showNextCard();
  }

  function buildTemplateText() {
    return [
      "apple\t苹果\tI eat an apple every day.",
      "banana\t香蕉",
      "abandon,放弃,He abandoned the plan.",
    ].join("\n");
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
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vocab-backup-${dateKeyFromMs(nowMs())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

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
      if (deckId === "__all__") {
        todayTotal = today.total;
        todayCorrect = today.correct;
        todayNew = Number(today.new || 0);
      } else {
        const bd = today.byDeck && today.byDeck[deckId];
        if (bd) {
          todayTotal = bd.total;
          todayCorrect = bd.correct;
          todayNew = Number(bd.new || 0);
        }
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
        if (deckId === "__all__") total = day.total;
        else total = (day.byDeck && day.byDeck[deckId] && day.byDeck[deckId].total) || 0;
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

  function computeAccByTag(deckId, tagField, modeFilter) {
    const acc = {};
    const cardById = state.cards || {};

    Object.keys(state.logsByDay).forEach((dk) => {
      const day = ensureDayLog(dk);
      const events = day.events || [];
      events.forEach((ev) => {
        if (!ev || ev.deckId !== deckId) return;
        if (modeFilter && ev.mode !== modeFilter) return;

        const c = cardById[ev.cardId];
        if (!c) return;

        const key = normalizeTag(c[tagField]) || "(未标注)";
        if (!acc[key]) acc[key] = { key, total: 0, correct: 0 };
        acc[key].total += 1;
        if (ev.correct) acc[key].correct += 1;
      });
    });

    const arr = Object.values(acc).sort((a, b) => {
      const aAcc = a.total ? a.correct / a.total : 0;
      const bAcc = b.total ? b.correct / b.total : 0;
      if (aAcc !== bAcc) return aAcc - bAcc; // 正确率低的排前面=薄弱项
      return b.total - a.total;
    });
    return arr;
  }

  function renderStats() {
    let deckId = $("#stats-deck-select").val() || state.selectedDeckId;
    if (!deckId || !state.decks[deckId]) return;

    const s = getStatsForDeck(deckId);
    $("#stat-today").text(String(s.todayTotal));
    $("#stat-acc").text(`${s.acc}%（新增 ${s.todayNew}）`);
    $("#stat-due").text(String(s.dueReview));
    $("#stat-new").text(String(s.newAvailable));

    const trend = buildTrend(deckId, 14);
    renderSparkline(trend);

    const modeFilter = null;
    const topicDist = computeAccByTag(deckId, "topic", modeFilter);
    const posDist = computeAccByTag(deckId, "pos", modeFilter);
    renderTagAccTable("#stats-topic", topicDist);
    renderTagAccTable("#stats-pos", posDist);
  }

  function initEvents() {
    $(document).on("click", ".nav-btn", function () {
      const view = $(this).data("view");
      renderNav(view);
      if (view === "review") {
        renderReviewSummary();
      }
      if (view === "stats") {
        renderStats();
      }
    });

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

      // delete cards
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

    $("#import-deck-select").on("change", function () {
      const id = $(this).val();
      if (id) setSelectedDeck(id);
    });

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

      $("#import-hint").text(
        importParsed.errors.length
          ? `有 ${importParsed.errors.length} 行无法解析，已跳过。示例：第 ${importParsed.errors[0].line} 行：${importParsed.errors[0].raw}`
          : dupCount
            ? `检测到 ${dupCount} 条重复单词，可在右侧选择“跳过重复/覆盖旧卡”。`
            : ""
      );

      $("#btn-commit-import").prop("disabled", importParsed.items.length === 0);
    });

    $("#btn-clear-import").on("click", function () {
      $("#import-text").val("");
      $("#import-preview").html("<div class=\"px-3 py-3 text-sm text-slate-500\">暂无预览</div>");
      $("#import-preview-count").text("");
      $("#import-hint").text("");
      $("#btn-commit-import").prop("disabled", true);
      importParsed = { items: [], errors: [] };
    });

    $("#btn-commit-import").on("click", function () {
      const deckId = $("#import-deck-select").val() || state.selectedDeckId;
      if (!deckId || !state.decks[deckId]) {
        toast("请先选择牌组");
        return;
      }
      if (!importParsed.items.length) {
        toast("没有可导入内容");
        return;
      }
      const dupMode = $("#import-dup-mode").val();
      commitImport(importParsed.items, deckId, dupMode);
      $("#btn-clear-import").trigger("click");
    });

    $("#btn-download-template").on("click", function () {
      downloadText("vocab-template.txt", buildTemplateText());
    });

    $("#review-deck-select").on("change", function () {
      const id = $(this).val();
      if (id) {
        setSelectedDeck(id);
        resetReviewSession(id);
      }
    });

    $("#new-per-day").on("change", function () {
      const v = Math.max(0, Math.floor(Number($(this).val() || 0)));
      state.settings.newPerDay = v;
      saveState();
      renderReviewSummary();
      resetReviewSession(state.selectedDeckId);
      renderStats();
      toast("已更新每日新增上限");
    });

    $("#review-mode").on("change", function () {
      const v = $(this).val();
      state.settings.reviewMode = v === "zh2en" ? "zh2en" : "en2zh";
      saveState();
      resetReviewSession(state.selectedDeckId);
      toast("已切换复习模式");
    });

    $("#btn-apply-filter").on("click", function () {
      state.settings.filterTopic = $("#filter-topic").val() || "";
      state.settings.filterPos = $("#filter-pos").val() || "";
      saveState();
      resetReviewSession(state.selectedDeckId);
      renderReviewSummary();
      toast("已应用筛选");
    });

    $("#btn-show").on("click", function () {
      if (!reviewSession.currentCardId) return;
      reviewSession.shown = true;
      $("#card-back").removeClass("hidden");
      $(".grade-btn").prop("disabled", false);
      $(this).prop("disabled", true);
    });

    function normalizeAnswer(s) {
      return String(s || "")
        .trim()
        .toLowerCase()
        .replaceAll(/\s+/g, " ");
    }

    function pronounceWord(word) {
      const w = String(word || "").trim();
      if (!w) return;
      if (!("speechSynthesis" in window)) {
        toast("当前浏览器不支持发音");
        return;
      }
      const u = new SpeechSynthesisUtterance(w);
      u.lang = "en-US";
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    }

    function revealSpell() {
      const card = state.cards[reviewSession.currentCardId];
      if (!card) return;
      $("#spell-feedback")
        .removeClass("text-green-700")
        .addClass("text-slate-600")
        .text(`答案：${card.front}`);
    }

    function submitSpell() {
      const card = state.cards[reviewSession.currentCardId];
      if (!card) return;

      const input = normalizeAnswer($("#spell-input").val());
      const ans = normalizeAnswer(card.front);

      if (!input) {
        toast("请输入拼写");
        return;
      }

      const correct = input === ans;

      $("#spell-feedback")
        .removeClass("text-red-600 text-green-700")
        .addClass(correct ? "text-green-700" : "text-red-600")
        .text(correct ? "正确" : `不正确，答案：${card.front}`);

      // 拼写模式：正确=5，不正确=0
      gradeCurrent(correct ? 5 : 0);
    }

    $("#btn-check-spell").on("click", function () {
      submitSpell();
    });

    $("#spell-input").on("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        submitSpell();
      }
    });

    $("#btn-reveal-spell").on("click", function () {
      revealSpell();
    });

    $("#btn-pronounce").on("click", function () {
      const card = state.cards[reviewSession.currentCardId];
      if (!card) return;
      pronounceWord(card.front);
    });

    $(".grade-btn").on("click", function () {
      const grade = $(this).data("grade");
      gradeCurrent(grade);
    });

    $("#btn-skip").on("click", function () {
      if (!reviewSession.queue.length) return;
      reviewSession.index = (reviewSession.index + 1) % reviewSession.queue.length;
      showNextCard();
    });

    $("#stats-deck-select").on("change", function () {
      const id = $(this).val();
      if (id) {
        setSelectedDeck(id);
        renderStats();
      }
    });

    $("#btn-export").on("click", function () {
      exportJson();
    });

    $("#backup-file").on("change", function (e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function () {
        try {
          const parsed = JSON.parse(String(reader.result || ""));
          if (!parsed || typeof parsed !== "object" || !parsed.decks || !parsed.cards) {
            toast("备份文件格式不正确");
            return;
          }
          state = parsed;
          ensureSelectedDeck();
          saveState();
          renderAll();
          toast("已导入备份");
        } catch (err) {
          toast("导入失败");
        } finally {
          $("#backup-file").val("");
        }
      };
      reader.readAsText(file);
    });

    $("#btn-reset").on("click", function () {
      if (!confirm("确定清空全部数据？该操作不可撤销。")) return;
      localStorage.removeItem(STORAGE_KEY);
      state = defaultState();
      saveState();
      renderAll();
      toast("已清空");
    });
  }

  function renderReviewControls() {
    $("#new-per-day").val(String(Number(state.settings && state.settings.newPerDay) || 0));
    $("#review-mode").val((state.settings && state.settings.reviewMode) || "en2zh");
    $("#filter-topic").val((state.settings && state.settings.filterTopic) || "");
    $("#filter-pos").val((state.settings && state.settings.filterPos) || "");
  }

  function renderAll() {
    ensureSelectedDeck();
    renderDeckSelects();
    renderDeckList();
    renderReviewControls();
    renderReviewSummary();
    renderStats();
  }

  let state = loadState();
  ensureSelectedDeck();

  $(function () {
    initEvents();
    renderAll();
    renderNav("decks");
  });
})();

