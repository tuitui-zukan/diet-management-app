/*
 * ダイエット管理アプリ ロジック
 * 保存先はすべてブラウザのlocalStorage（この端末のこのアプリにだけ保存される）。
 * サーバーには一切送信されないので、データはiPhone内に閉じている。
 */
(function () {
  "use strict";

  // ---------- 共通：保存まわり ----------
  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
    showSaveIndicator();
  }

  let saveIndicatorTimer = null;
  function showSaveIndicator() {
    const el = document.getElementById("save-indicator");
    el.textContent = "保存しました";
    el.classList.add("show");
    clearTimeout(saveIndicatorTimer);
    saveIndicatorTimer = setTimeout(() => el.classList.remove("show"), 900);
  }

  // ---------- 共通：日付まわり ----------
  // 「今日」は端末のローカル時刻基準（チェックはリアルタイムで押すため）
  function localISODateString(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function todayISO() {
    return localISODateString(new Date());
  }

  // 週の計算はすべてUTC基準で統一し、タイムゾーンのズレでバグらないようにする
  function isoDateStringFromUTC(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function isoWeekIdFromUTCDate(d) {
    const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = (dt.getUTCDay() + 6) % 7; // 月曜=0
    dt.setUTCDate(dt.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
    const fDayNum = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - fDayNum + 3);
    const weekNum = 1 + Math.round((dt - firstThursday) / 604800000);
    return `${dt.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
  }

  function currentWeekId() {
    const now = new Date();
    const utcDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    return isoWeekIdFromUTCDate(utcDate);
  }

  function mondayOfISOWeek(weekId) {
    const [yearStr, weekStr] = weekId.split("-W");
    const year = Number(yearStr);
    const week = Number(weekStr);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
    const week1Monday = new Date(jan4);
    week1Monday.setUTCDate(jan4.getUTCDate() - jan4DayNum);
    const monday = new Date(week1Monday);
    monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
    return monday;
  }

  function getWeekDates(weekId) {
    const monday = mondayOfISOWeek(weekId);
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setUTCDate(monday.getUTCDate() + i);
      dates.push(d);
    }
    return dates;
  }

  function shiftWeek(weekId, deltaWeeks) {
    const monday = mondayOfISOWeek(weekId);
    monday.setUTCDate(monday.getUTCDate() + deltaWeeks * 7);
    return isoWeekIdFromUTCDate(monday);
  }

  function formatWeekLabel(weekId) {
    const dates = getWeekDates(weekId);
    const start = dates[0];
    const end = dates[6];
    return `${start.getUTCMonth() + 1}/${start.getUTCDate()} 〜 ${end.getUTCMonth() + 1}/${end.getUTCDate()}`;
  }

  function renderWeekDots(container, isDoneFn) {
    container.innerHTML = "";
    const dows = ["日", "月", "火", "水", "木", "金", "土"];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const iso = localISODateString(d);
      const done = isDoneFn(iso);
      const wrap = document.createElement("div");
      wrap.className = "day-dot";
      wrap.innerHTML = `<div class="dot ${done ? "done" : ""}">${done ? "✓" : ""}</div><div class="dow">${dows[d.getDay()]}</div>`;
      container.appendChild(wrap);
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // URLに使う文字だけを対象にする（日本語の助詞・句読点がスペースなしで
  // 直後に続いても、URLの一部として誤って取り込まないようにするため）
  const URL_PATTERN = /https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;

  function cleanTrailingPunctuation(url) {
    return url.replace(/[)\]},.;:!?]+$/, "");
  }

  // テキスト中のURLを見つけて、タップできる<a>タグ入りのHTMLに変換する
  // （innerHTMLに差し込む前提。それ以外の部分はescapeHtmlでエスケープ済み）
  function linkifyHtml(text) {
    const pattern = new RegExp(URL_PATTERN);
    let lastIndex = 0;
    let html = "";
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const rawUrl = match[0];
      const url = cleanTrailingPunctuation(rawUrl);
      const trailing = rawUrl.slice(url.length);
      html += escapeHtml(text.slice(lastIndex, match.index));
      const label = url.includes("instagram.com") ? "📷 Instagramを開く" : url;
      html += `<a href="${url}" target="_blank" rel="noopener" class="inline-link">${escapeHtml(label)}</a>`;
      html += escapeHtml(trailing);
      lastIndex = match.index + rawUrl.length;
    }
    html += escapeHtml(text.slice(lastIndex));
    return html;
  }

  // ---------- タブ切り替え ----------
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  function switchTab(tab) {
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    document.getElementById(`tab-${tab}`).classList.remove("hidden");
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  }

  // ---------- 筋トレ／マッサージ共通モジュール ----------
  // どちらも「メニュー項目を追加→毎日項目ごとにチェック」という同じ構造なので使い回す

  // 旧バージョン（自由記述＋1日1チェック）のデータが残っていれば、
  // 各行を項目として移行し、チェック済みだった日は全項目チェック済み扱いにする
  function loadChecklistState(storageKey) {
    const raw = loadJSON(storageKey, null);
    if (!raw) return { items: [], log: {} };
    if (Array.isArray(raw.items)) return raw;

    const lines = (raw.text || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const items = lines.map((name, i) => ({ id: `migrated_${i}`, name }));
    const log = {};
    if (items.length > 0) {
      Object.keys(raw.log || {}).forEach((date) => {
        if (raw.log[date]) {
          log[date] = {};
          items.forEach((it) => { log[date][it.id] = true; });
        }
      });
    }
    const migrated = { items, log };
    saveJSON(storageKey, migrated);
    return migrated;
  }

  function createChecklistModule(config) {
    const state = loadChecklistState(config.storageKey);
    const newItemInput = document.getElementById(config.newItemInputId);
    const newUrlInput = document.getElementById(config.newUrlInputId);
    const addBtn = document.getElementById(config.addBtnId);
    const listEl = document.getElementById(config.listId);
    const progressEl = document.getElementById(config.progressId);
    const dotsEl = document.getElementById(config.weekDotsId);
    const totalEl = document.getElementById(config.totalId);

    function addItem() {
      const name = newItemInput.value.trim();
      const url = newUrlInput.value.trim();
      if (!name) return;
      state.items.push({ id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name, url });
      newItemInput.value = "";
      newUrlInput.value = "";
      saveJSON(config.storageKey, state);
      render();
    }
    addBtn.addEventListener("click", addItem);
    [newItemInput, newUrlInput].forEach((el) => {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addItem();
        }
      });
    });

    function toggleToday(itemId) {
      const today = todayISO();
      if (!state.log[today]) state.log[today] = {};
      if (state.log[today][itemId]) delete state.log[today][itemId];
      else state.log[today][itemId] = true;
      saveJSON(config.storageKey, state);
      render();
    }

    function deleteItem(itemId) {
      state.items = state.items.filter((it) => it.id !== itemId);
      saveJSON(config.storageKey, state);
      render();
    }

    function isDayComplete(dateISO) {
      if (state.items.length === 0) return false;
      const dayLog = state.log[dateISO] || {};
      return state.items.every((it) => !!dayLog[it.id]);
    }

    function render() {
      const today = todayISO();
      const todayLog = state.log[today] || {};

      listEl.innerHTML = "";
      if (state.items.length === 0) {
        const li = document.createElement("li");
        li.className = "empty-hint";
        li.textContent = "メニューを追加してください";
        listEl.appendChild(li);
      } else {
        state.items.forEach((it) => {
          const done = !!todayLog[it.id];
          const li = document.createElement("li");
          li.className = `item-row ${done ? "done" : ""}`;
          const nameHtml = it.url
            ? `${escapeHtml(it.name)} <a href="${escapeHtml(it.url)}" target="_blank" rel="noopener" class="inline-link-icon" aria-label="参考URLを開く">🔗</a>`
            : linkifyHtml(it.name); // 旧データ（名前欄に直接URLが入っている）はそのままリンク化して表示
          li.innerHTML = `<input type="checkbox" ${done ? "checked" : ""} data-id="${it.id}"><span class="item-name">${nameHtml}</span><button class="item-delete" data-id="${it.id}" aria-label="削除">×</button>`;
          listEl.appendChild(li);
        });
        listEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
          cb.addEventListener("change", () => toggleToday(cb.dataset.id));
        });
        listEl.querySelectorAll(".item-delete").forEach((btn) => {
          btn.addEventListener("click", () => deleteItem(btn.dataset.id));
        });
      }

      const doneCount = state.items.filter((it) => !!todayLog[it.id]).length;
      progressEl.textContent = state.items.length ? `今日：${doneCount}/${state.items.length} 完了` : "";

      renderWeekDots(dotsEl, (dateISO) => isDayComplete(dateISO));
      const totalDays = Object.keys(state.log).filter((d) => isDayComplete(d)).length;
      totalEl.textContent = `全メニュー達成日数：${totalDays}日`;
    }

    render();
  }

  createChecklistModule({
    storageKey: "dietapp_workout_v1",
    newItemInputId: "workout-new-item",
    newUrlInputId: "workout-new-url",
    addBtnId: "workout-add-btn",
    listId: "workout-item-list",
    progressId: "workout-progress",
    weekDotsId: "workout-week-dots",
    totalId: "workout-total",
  });

  createChecklistModule({
    storageKey: "dietapp_massage_v1",
    newItemInputId: "massage-new-item",
    newUrlInputId: "massage-new-url",
    addBtnId: "massage-add-btn",
    listId: "massage-item-list",
    progressId: "massage-progress",
    weekDotsId: "massage-week-dots",
    totalId: "massage-total",
  });

  // ---------- 常備調味料・食材（週をまたいでリセットされない） ----------
  (function initPantry() {
    const LS_PANTRY = "dietapp_pantry_v1";
    const pantryState = loadJSON(LS_PANTRY, { text: "" });
    const pantryEl = document.getElementById("meal-pantry");
    pantryEl.value = pantryState.text || "";
    pantryEl.addEventListener("input", () => {
      pantryState.text = pantryEl.value;
      saveJSON(LS_PANTRY, pantryState);
    });
  })();

  // ---------- 献立モジュール ----------
  (function initMeal() {
    const LS_MEAL = "dietapp_meal_v1";
    const mealState = loadJSON(LS_MEAL, { weeks: {} });
    let weekId = currentWeekId();

    const weekLabelEl = document.getElementById("meal-week-label");
    const prevBtn = document.getElementById("meal-prev-week");
    const nextBtn = document.getElementById("meal-next-week");
    const budgetEl = document.getElementById("meal-budget");
    const inventoryEl = document.getElementById("meal-inventory");
    const planEl = document.getElementById("meal-plan");
    const planLinksEl = document.getElementById("meal-plan-links");
    const daysEl = document.getElementById("meal-days");
    const actualCostEl = document.getElementById("meal-actual-cost");
    const diffEl = document.getElementById("meal-diff");

    function getWeekData(id) {
      if (!mealState.weeks[id]) {
        mealState.weeks[id] = { budget: "", inventory: "", plan: "", actualCost: "", days: {} };
      }
      return mealState.weeks[id];
    }

    function renderDiff(data) {
      const budget = Number(data.budget) || 0;
      const actual = Number(data.actualCost) || 0;
      if (!data.budget && !data.actualCost) {
        diffEl.textContent = "";
        diffEl.className = "diff-text";
        return;
      }
      const diff = budget - actual;
      if (diff >= 0) {
        diffEl.textContent = `予算内：残り${diff.toLocaleString()}円`;
        diffEl.className = "diff-text under";
      } else {
        diffEl.textContent = `予算オーバー：${Math.abs(diff).toLocaleString()}円`;
        diffEl.className = "diff-text over";
      }
    }

    // 献立欄に貼り付けたテキストからURLを見つけて、タップできるリンクにする
    // （textareaは中の文字をHTMLとして表示できないので、下に別枠でボタンを出す）
    function extractUrls(text) {
      const matches = text.match(URL_PATTERN) || [];
      const cleaned = matches.map(cleanTrailingPunctuation);
      return [...new Set(cleaned)];
    }

    function renderPlanLinks(text) {
      const urls = extractUrls(text);
      planLinksEl.innerHTML = "";
      urls.forEach((url) => {
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener";
        a.className = "link-chip";
        a.textContent = url.includes("instagram.com") ? "📷 Instagramを開く" : `🔗 ${url}`;
        planLinksEl.appendChild(a);
      });
    }

    function renderDays(data) {
      daysEl.innerHTML = "";
      const dates = getWeekDates(weekId);
      const dows = ["月", "火", "水", "木", "金", "土", "日"];
      dates.forEach((d, i) => {
        const iso = isoDateStringFromUTC(d);
        const checked = !!data.days[iso];
        const row = document.createElement("label");
        row.className = "meal-day-row";
        row.innerHTML = `<span class="day-label">${d.getUTCMonth() + 1}/${d.getUTCDate()}（${dows[i]}）</span><input type="checkbox" ${checked ? "checked" : ""} data-date="${iso}">`;
        daysEl.appendChild(row);
      });
      daysEl.querySelectorAll("input[type=checkbox]").forEach((cb) => {
        cb.addEventListener("change", () => {
          if (cb.checked) data.days[cb.dataset.date] = true;
          else delete data.days[cb.dataset.date];
          saveJSON(LS_MEAL, mealState);
        });
      });
    }

    function render() {
      const data = getWeekData(weekId);
      weekLabelEl.textContent = formatWeekLabel(weekId);
      budgetEl.value = data.budget;
      inventoryEl.value = data.inventory;
      planEl.value = data.plan;
      actualCostEl.value = data.actualCost;
      renderDays(data);
      renderDiff(data);
      renderPlanLinks(data.plan || "");
    }

    budgetEl.addEventListener("input", () => {
      const data = getWeekData(weekId);
      data.budget = budgetEl.value;
      saveJSON(LS_MEAL, mealState);
      renderDiff(data);
    });
    inventoryEl.addEventListener("input", () => {
      getWeekData(weekId).inventory = inventoryEl.value;
      saveJSON(LS_MEAL, mealState);
    });
    planEl.addEventListener("input", () => {
      getWeekData(weekId).plan = planEl.value;
      saveJSON(LS_MEAL, mealState);
      renderPlanLinks(planEl.value);
    });
    actualCostEl.addEventListener("input", () => {
      const data = getWeekData(weekId);
      data.actualCost = actualCostEl.value;
      saveJSON(LS_MEAL, mealState);
      renderDiff(data);
    });
    prevBtn.addEventListener("click", () => {
      weekId = shiftWeek(weekId, -1);
      render();
    });
    nextBtn.addEventListener("click", () => {
      weekId = shiftWeek(weekId, 1);
      render();
    });

    render();
  })();

  // ---------- Service Workerの後始末 ----------
  // 以前オフライン対応のためにService Workerを使っていたが、ファイル単位で
  // 新旧キャッシュが混在し「更新したのに一部だけ古いまま」になる不具合の温床になったため撤去した。
  // 端末に登録済みの古いService Worker／キャッシュが残っていれば、ここで確実に消しておく。
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((reg) => reg.unregister());
    });
  }
  if (window.caches) {
    caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)));
  }
})();
