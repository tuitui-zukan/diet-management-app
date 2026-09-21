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
  function showSaveIndicator(message) {
    const el = document.getElementById("save-indicator");
    el.textContent = message || "保存しました";
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

  // ---------- 項目リストの共通エディタ（追加・削除のみ、チェック機能なし） ----------
  // 常備品・在庫・固定メニューの3箇所で使う
  function splitToItems(text) {
    return (text || "")
      .split(/[\n,、]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name, i) => ({ id: `migrated_${Date.now()}_${i}`, name, url: "" }));
  }

  function createItemListEditor(config) {
    const nameInput = document.getElementById(config.newItemInputId);
    const urlInput = config.newUrlInputId ? document.getElementById(config.newUrlInputId) : null;
    const addBtn = document.getElementById(config.addBtnId);
    const listEl = document.getElementById(config.listId);

    function addItem() {
      const name = nameInput.value.trim();
      if (!name) return;
      const url = urlInput ? urlInput.value.trim() : "";
      const items = config.getItems();
      items.push({ id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name, url });
      config.setItems(items);
      nameInput.value = "";
      if (urlInput) urlInput.value = "";
      render();
    }
    addBtn.addEventListener("click", addItem);
    [nameInput, urlInput].filter(Boolean).forEach((el) => {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addItem();
        }
      });
    });

    function deleteItem(id) {
      config.setItems(config.getItems().filter((it) => it.id !== id));
      render();
    }

    function render() {
      const items = config.getItems();
      listEl.innerHTML = "";
      if (items.length === 0) {
        const li = document.createElement("li");
        li.className = "empty-hint";
        li.textContent = "項目を追加してください";
        listEl.appendChild(li);
      } else {
        items.forEach((it) => {
          const nameHtml = it.url
            ? `${escapeHtml(it.name)} <a href="${escapeHtml(it.url)}" target="_blank" rel="noopener" class="inline-link-icon" aria-label="参考URLを開く">🔗</a>`
            : linkifyHtml(it.name);
          const li = document.createElement("li");
          li.className = "item-row";
          li.innerHTML = `<span class="item-name">${nameHtml}</span><button class="item-delete" data-id="${it.id}" aria-label="削除">×</button>`;
          listEl.appendChild(li);
        });
        listEl.querySelectorAll(".item-delete").forEach((btn) => {
          btn.addEventListener("click", () => deleteItem(btn.dataset.id));
        });
      }
      if (config.onRender) config.onRender();
    }

    render();
    return { render };
  }

  // ---------- 常備調味料・食材（週をまたいでリセットされない） ----------
  (function initPantry() {
    const LS_PANTRY = "dietapp_pantry_v2";
    let pantryState = loadJSON(LS_PANTRY, null);
    if (!pantryState) {
      const old = loadJSON("dietapp_pantry_v1", null); // 旧バージョン（自由記述）から移行
      pantryState = { items: old && old.text ? splitToItems(old.text) : [] };
      saveJSON(LS_PANTRY, pantryState);
    }

    createItemListEditor({
      getItems: () => pantryState.items,
      setItems: (items) => {
        pantryState.items = items;
        saveJSON(LS_PANTRY, pantryState);
      },
      newItemInputId: "pantry-new-item",
      addBtnId: "pantry-add-btn",
      listId: "pantry-item-list",
    });
  })();

  // ---------- 献立モジュール ----------
  (function initMeal() {
    const LS_MEAL = "dietapp_meal_v1";
    const LS_MENU_LIBRARY = "dietapp_menu_library_v1";
    const LS_MEAL_DEFAULTS = "dietapp_meal_defaults_v1";
    const mealState = loadJSON(LS_MEAL, { weeks: {} });
    const menuLibraryState = loadJSON(LS_MENU_LIBRARY, { items: [] });
    const mealDefaults = loadJSON(LS_MEAL_DEFAULTS, { breakfast: [], lunch: [], dinner: [] });
    let weekId = currentWeekId();

    const weekLabelEl = document.getElementById("meal-week-label");
    const prevBtn = document.getElementById("meal-prev-week");
    const nextBtn = document.getElementById("meal-next-week");
    const budgetEl = document.getElementById("meal-budget");
    const mealGridEl = document.getElementById("meal-grid");
    const defaultsEl = document.getElementById("meal-defaults");
    const defaultsApplyBtn = document.getElementById("meal-defaults-apply-btn");
    const actualCostEl = document.getElementById("meal-actual-cost");
    const diffEl = document.getElementById("meal-diff");
    const promptBtn = document.getElementById("meal-prompt-btn");
    const promptResultEl = document.getElementById("meal-prompt-result");
    const promptTextEl = document.getElementById("meal-prompt-text");
    const promptCopyBtn = document.getElementById("meal-prompt-copy-btn");

    function saveMealDefaults() {
      saveJSON(LS_MEAL_DEFAULTS, mealDefaults);
    }

    function getWeekData(id) {
      if (!mealState.weeks[id]) {
        mealState.weeks[id] = { budget: "", actualCost: "", days: {} };
      }
      return mealState.weeks[id];
    }

    const MEAL_SLOTS = [["breakfast", "朝食"], ["lunch", "昼食"], ["dinner", "夕食"]];

    function getDaySlots(data, dateISO) {
      const existing = data.days[dateISO];
      const isValid = existing && typeof existing === "object" && !Array.isArray(existing);
      if (!isValid) {
        // 新規の日は、設定済みのデフォルトメニューから自動で埋める
        data.days[dateISO] = {};
        MEAL_SLOTS.forEach(([key]) => {
          data.days[dateISO][key] = { menuIds: [...(mealDefaults[key] || [])], done: false };
        });
      } else {
        // 旧バージョン（1食1メニューまでの形）からの移行
        MEAL_SLOTS.forEach(([key]) => {
          const slot = existing[key];
          if (!slot || typeof slot !== "object") {
            existing[key] = { menuIds: [], done: false };
          } else if (!Array.isArray(slot.menuIds)) {
            existing[key] = { menuIds: slot.menuId ? [slot.menuId] : [], done: !!slot.done };
          }
        });
      }
      return data.days[dateISO];
    }

    function renderMealGrid() {
      mealGridEl.innerHTML = "";
      const data = getWeekData(weekId);
      const dates = getWeekDates(weekId);
      const dows = ["月", "火", "水", "木", "金", "土", "日"];

      dates.forEach((d, i) => {
        const iso = isoDateStringFromUTC(d);
        const daySlots = getDaySlots(data, iso);

        const block = document.createElement("div");
        block.className = "meal-day-block";

        const heading = document.createElement("p");
        heading.className = "meal-day-heading";
        heading.textContent = `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${dows[i]}）`;
        block.appendChild(heading);

        MEAL_SLOTS.forEach(([slotKey, slotLabel]) => {
          const slotData = daySlots[slotKey];
          // ライブラリから削除済みのメニューは割り当てから外す
          slotData.menuIds = slotData.menuIds.filter((id) => menuLibraryState.items.some((m) => m.id === id));

          const slotBlock = document.createElement("div");
          slotBlock.className = "meal-slot-block";

          const header = document.createElement("div");
          header.className = "meal-slot-header";

          const label = document.createElement("span");
          label.className = "meal-slot-label";
          label.textContent = slotLabel;
          header.appendChild(label);

          const doneLabel = document.createElement("label");
          doneLabel.className = "meal-slot-done";
          const doneCheckbox = document.createElement("input");
          doneCheckbox.type = "checkbox";
          doneCheckbox.checked = !!slotData.done;
          doneCheckbox.addEventListener("change", () => {
            slotData.done = doneCheckbox.checked;
            saveJSON(LS_MEAL, mealState);
          });
          doneLabel.appendChild(doneCheckbox);
          doneLabel.appendChild(document.createTextNode("実行済み"));
          header.appendChild(doneLabel);
          slotBlock.appendChild(header);

          // メニューを選んで追加する行
          const addRow = document.createElement("div");
          addRow.className = "meal-slot-add-row";
          const select = document.createElement("select");
          const emptyOption = document.createElement("option");
          emptyOption.value = "";
          emptyOption.textContent = "メニューを選択";
          select.appendChild(emptyOption);
          menuLibraryState.items.forEach((menu) => {
            const opt = document.createElement("option");
            opt.value = menu.id;
            opt.textContent = menu.name;
            select.appendChild(opt);
          });
          addRow.appendChild(select);

          const addSlotBtn = document.createElement("button");
          addSlotBtn.type = "button";
          addSlotBtn.className = "add-btn";
          addSlotBtn.textContent = "追加";
          addSlotBtn.addEventListener("click", () => {
            if (!select.value || slotData.menuIds.includes(select.value)) return;
            slotData.menuIds.push(select.value);
            saveJSON(LS_MEAL, mealState);
            renderMealGrid();
          });
          addRow.appendChild(addSlotBtn);
          slotBlock.appendChild(addRow);

          // 割り当て済みメニューの一覧（複数可、個別に削除できる）
          const itemsList = document.createElement("ul");
          itemsList.className = "meal-slot-items";
          if (slotData.menuIds.length === 0) {
            const li = document.createElement("li");
            li.className = "empty-hint";
            li.textContent = "未選択";
            itemsList.appendChild(li);
          } else {
            slotData.menuIds.forEach((menuId) => {
              const menu = menuLibraryState.items.find((m) => m.id === menuId);
              if (!menu) return;
              const li = document.createElement("li");
              li.className = "item-row";
              const linkHtml = menu.url
                ? ` <a href="${escapeHtml(menu.url)}" target="_blank" rel="noopener" class="inline-link-icon" aria-label="参考URLを開く">🔗</a>`
                : "";
              li.innerHTML = `<span class="item-name">${escapeHtml(menu.name)}${linkHtml}</span><button type="button" class="item-delete" aria-label="削除">×</button>`;
              li.querySelector(".item-delete").addEventListener("click", () => {
                slotData.menuIds = slotData.menuIds.filter((id) => id !== menuId);
                saveJSON(LS_MEAL, mealState);
                renderMealGrid();
              });
              itemsList.appendChild(li);
            });
          }
          slotBlock.appendChild(itemsList);

          block.appendChild(slotBlock);
        });

        mealGridEl.appendChild(block);
      });
    }

    // 朝食・昼食・夕食ごとの「いつものメニュー」設定。新しい日はここから自動で埋まる
    function renderMealDefaults() {
      defaultsEl.innerHTML = "";
      MEAL_SLOTS.forEach(([slotKey, slotLabel]) => {
        if (!Array.isArray(mealDefaults[slotKey])) mealDefaults[slotKey] = [];
        mealDefaults[slotKey] = mealDefaults[slotKey].filter((id) => menuLibraryState.items.some((m) => m.id === id));

        const slotBlock = document.createElement("div");
        slotBlock.className = "meal-slot-block";

        const header = document.createElement("div");
        header.className = "meal-slot-header";
        const label = document.createElement("span");
        label.className = "meal-slot-label";
        label.textContent = slotLabel;
        header.appendChild(label);
        slotBlock.appendChild(header);

        const addRow = document.createElement("div");
        addRow.className = "meal-slot-add-row";
        const select = document.createElement("select");
        const emptyOption = document.createElement("option");
        emptyOption.value = "";
        emptyOption.textContent = "メニューを選択";
        select.appendChild(emptyOption);
        menuLibraryState.items.forEach((menu) => {
          const opt = document.createElement("option");
          opt.value = menu.id;
          opt.textContent = menu.name;
          select.appendChild(opt);
        });
        addRow.appendChild(select);

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "add-btn";
        addBtn.textContent = "追加";
        addBtn.addEventListener("click", () => {
          if (!select.value || mealDefaults[slotKey].includes(select.value)) return;
          mealDefaults[slotKey].push(select.value);
          saveMealDefaults();
          renderMealDefaults();
        });
        addRow.appendChild(addBtn);
        slotBlock.appendChild(addRow);

        const itemsList = document.createElement("ul");
        itemsList.className = "meal-slot-items";
        if (mealDefaults[slotKey].length === 0) {
          const li = document.createElement("li");
          li.className = "empty-hint";
          li.textContent = "未設定";
          itemsList.appendChild(li);
        } else {
          mealDefaults[slotKey].forEach((menuId) => {
            const menu = menuLibraryState.items.find((m) => m.id === menuId);
            if (!menu) return;
            const li = document.createElement("li");
            li.className = "item-row";
            const linkHtml = menu.url
              ? ` <a href="${escapeHtml(menu.url)}" target="_blank" rel="noopener" class="inline-link-icon" aria-label="参考URLを開く">🔗</a>`
              : "";
            li.innerHTML = `<span class="item-name">${escapeHtml(menu.name)}${linkHtml}</span><button type="button" class="item-delete" aria-label="削除">×</button>`;
            li.querySelector(".item-delete").addEventListener("click", () => {
              mealDefaults[slotKey] = mealDefaults[slotKey].filter((id) => id !== menuId);
              saveMealDefaults();
              renderMealDefaults();
            });
            itemsList.appendChild(li);
          });
        }
        slotBlock.appendChild(itemsList);

        defaultsEl.appendChild(slotBlock);
      });
    }

    defaultsApplyBtn.addEventListener("click", () => {
      const data = getWeekData(weekId);
      const dates = getWeekDates(weekId);
      dates.forEach((d) => {
        const iso = isoDateStringFromUTC(d);
        const daySlots = getDaySlots(data, iso);
        MEAL_SLOTS.forEach(([slotKey]) => {
          (mealDefaults[slotKey] || []).forEach((menuId) => {
            if (!daySlots[slotKey].menuIds.includes(menuId)) {
              daySlots[slotKey].menuIds.push(menuId);
            }
          });
        });
      });
      saveJSON(LS_MEAL, mealState);
      renderMealGrid();
      showSaveIndicator("今週に反映しました");
    });

    const menuLibraryEditor = createItemListEditor({
      getItems: () => menuLibraryState.items,
      setItems: (items) => {
        menuLibraryState.items = items;
        saveJSON(LS_MENU_LIBRARY, menuLibraryState);
      },
      newItemInputId: "menu-library-new-item",
      newUrlInputId: "menu-library-new-url",
      addBtnId: "menu-library-add-btn",
      listId: "menu-library-item-list",
      onRender: () => {
        renderMealDefaults(); // 削除されたメニューをデフォルトからも除去
        renderMealGrid(); // 登録メニューが変われば週の献立の選択肢も更新
      },
    });

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

    // 常備品・在庫・予算から、Claudeにそのまま渡せる依頼文を組み立てる
    function buildPrompt() {
      const data = getWeekData(weekId);
      const pantryState = loadJSON("dietapp_pantry_v2", { items: [] });
      const budgetText = data.budget ? `${Number(data.budget).toLocaleString()}円` : "指定なし";
      const pantryText = pantryState.items.map((it) => it.name).join("、") || "（特になし）";

      return `以下の条件で、ダイエット向け・栄養バランスを考えた1週間分の献立を作ってください。

【予算】${budgetText}
【常備している調味料・食材】
${pantryText}

条件：
- カロリーと栄養バランス（PFCバランス）を意識してください
- 予算内に収めてください
- 上記の食材を優先的に使い、余らせないようにしてください
- 保存してあるインスタの投稿のスクリーンショットも一緒に渡すので、使えそうなものがあれば取り入れてください

最後に、回答の一番下に下記の形式で1週間分をまとめて出力してください（このアプリへ貼り付けて読み込ませるためのものです。この部分は説明を挟まず、指定の形式のまま出力してください）：
月曜,朝食,料理名
月曜,昼食,料理名
月曜,夕食,料理名
火曜,朝食,料理名
（以下、水曜〜日曜も同じ形式で）`;
    }

    promptBtn.addEventListener("click", () => {
      promptTextEl.value = buildPrompt();
      promptResultEl.classList.remove("hidden");
    });

    promptCopyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(promptTextEl.value);
        showSaveIndicator("コピーしました");
      } catch (e) {
        promptTextEl.select();
      }
    });

    // Claudeの回答から「曜日,食事,料理名」の行を見つけて、
    // 未登録の料理は固定メニューに自動登録し、週の献立に割り当てる
    const importTextEl = document.getElementById("meal-import-text");
    const importBtn = document.getElementById("meal-import-btn");
    const importStatusEl = document.getElementById("meal-import-status");
    const SLOT_LABEL_TO_KEY = { 朝食: "breakfast", 昼食: "lunch", 夕食: "dinner" };
    // 依頼文で指定した「月曜,朝食,料理名」形式（1行完結）
    const MEAL_LINE_PATTERN = /^(月|火|水|木|金|土|日)(?:曜日?)?\s*[,、]\s*(朝食|昼食|夕食)\s*[,、]\s*(.+)$/;
    // Claudeが見出し形式で返してきた場合（### 月曜日 → #### 昼：料理名 のような書き方）にも対応する
    const DOW_HEADING_PATTERN = /^(月|火|水|木|金|土|日)曜日?$/;
    const MEAL_HEADING_PATTERN = /^(朝食?|昼食?|夕食|夜食?|夜)[:：]\s*(.+)$/;

    function normalizeSlotLabel(raw) {
      if (raw === "朝" || raw === "朝食") return "朝食";
      if (raw === "昼" || raw === "昼食") return "昼食";
      if (raw === "夕食" || raw === "夜" || raw === "夜食") return "夕食";
      return null;
    }

    // 見出し行の「### 」「#### 」やよく使われる絵文字・強調記号を取り除き、中身だけにする
    function stripHeadingNoise(line) {
      return line
        .replace(/^#+\s*/, "")
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
        .replace(/\*\*/g, "")
        .trim();
    }

    // 「① 鶏むね甘辛そぼろ（冷蔵4日）」のような見出しから、①→料理名の対応表を作る
    // （表の中で①②③④のように番号だけで参照されるケースに対応するため）
    function buildNumberedRecipeMap(text) {
      const map = {};
      const pattern = /^#{1,6}\s*([①②③④⑤⑥⑦⑧⑨⑩])\s*(.+)$/;
      text.split("\n").forEach((line) => {
        const m = line.trim().match(pattern);
        if (m) {
          const name = m[2].replace(/[（(].*$/, "").trim();
          if (name) map[m[1]] = name;
        }
      });
      return map;
    }

    // 表のマス目（例：「①そぼろ＋ごはん＋②スープ」）を個別の料理名に分割する
    function splitMealCell(raw, numberedRecipeMap) {
      return raw
        .split(/[＋+、]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((fragment) => {
          const m = fragment.match(/^([①②③④⑤⑥⑦⑧⑨⑩])(.*)$/);
          if (!m) return fragment;
          if (numberedRecipeMap[m[1]]) return numberedRecipeMap[m[1]];
          return m[2].trim() || fragment;
        })
        .filter(Boolean);
    }

    // Markdownの表形式（| 曜日 | 朝 | 昼 | 夜 |）を解析する
    function parseMealPlanTable(text, addResult) {
      const tableLines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("|") && (l.match(/\|/g) || []).length >= 3);
      if (tableLines.length < 2) return;

      const splitRow = (line) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

      let headerIdx = -1;
      let headerCells = null;
      for (let i = 0; i < tableLines.length; i += 1) {
        const cells = splitRow(tableLines[i]);
        if (cells.some((c) => /曜日|朝|昼|夜/.test(c.replace(/\*/g, "")))) {
          headerIdx = i;
          headerCells = cells;
          break;
        }
      }
      if (!headerCells) return;

      let dowColumn = -1;
      const slotColumns = {};
      headerCells.forEach((cell, idx) => {
        const stripped = cell.replace(/\*/g, "").trim();
        if (/^曜日?$/.test(stripped)) dowColumn = idx;
        if (/^朝食?$/.test(stripped)) slotColumns["朝食"] = idx;
        if (/^昼食?$/.test(stripped)) slotColumns["昼食"] = idx;
        if (/^(夕食|夜食?)$/.test(stripped)) slotColumns["夕食"] = idx;
      });
      if (dowColumn === -1 || Object.keys(slotColumns).length === 0) return;

      const numberedRecipeMap = buildNumberedRecipeMap(text);

      for (let i = headerIdx + 1; i < tableLines.length; i += 1) {
        const cells = splitRow(tableLines[i]);
        if (cells.every((c) => /^-+$/.test(c))) continue; // 区切り行はスキップ
        const dowCellRaw = (cells[dowColumn] || "").replace(/\*/g, "").trim();
        const dowMatch = dowCellRaw.match(/^(月|火|水|木|金|土|日)(曜日?)?$/);
        if (!dowMatch) continue;
        const dow = dowMatch[1];

        Object.keys(slotColumns).forEach((slotLabel) => {
          const raw = (cells[slotColumns[slotLabel]] || "").replace(/\*/g, "").trim();
          if (!raw) return;
          splitMealCell(raw, numberedRecipeMap).forEach((name) => addResult(dow, slotLabel, name));
        });
      }
    }

    function parseMealPlanText(text) {
      const results = [];
      const seen = new Set();
      function addResult(dow, slot, name) {
        const key = `${dow}|${slot}|${name}`;
        if (seen.has(key) || !name) return;
        seen.add(key);
        results.push({ dow, slot, name });
      }

      const lines = text.split("\n");

      // パターン1：「月曜,朝食,料理名」の1行完結フォーマット
      lines.forEach((line) => {
        const m = line.trim().match(MEAL_LINE_PATTERN);
        if (m) addResult(m[1], m[2], m[3].trim());
      });

      // パターン2：見出しで曜日→食事の順に並んでいる形式
      let currentDow = null;
      lines.forEach((line) => {
        const stripped = stripHeadingNoise(line);
        const dowMatch = stripped.match(DOW_HEADING_PATTERN);
        if (dowMatch) {
          currentDow = dowMatch[1];
          return;
        }
        if (!currentDow) return;
        const mealMatch = stripped.match(MEAL_HEADING_PATTERN);
        if (mealMatch) {
          const slot = normalizeSlotLabel(mealMatch[1]);
          if (slot) addResult(currentDow, slot, mealMatch[2].trim());
        }
      });

      // パターン3：Markdownの表形式（| 曜日 | 朝 | 昼 | 夜 |）
      parseMealPlanTable(text, addResult);

      return results;
    }

    function findOrCreateMenu(name) {
      let menu = menuLibraryState.items.find((m) => m.name === name);
      if (!menu) {
        menu = { id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name, url: "" };
        menuLibraryState.items.push(menu);
      }
      return menu;
    }

    importBtn.addEventListener("click", () => {
      const parsed = parseMealPlanText(importTextEl.value);
      if (parsed.length === 0) {
        importStatusEl.textContent = "献立の形式を読み取れませんでした。「月曜,朝食,料理名」のような行が含まれているか確認してください。";
        return;
      }
      const dows = ["月", "火", "水", "木", "金", "土", "日"];
      const dates = getWeekDates(weekId);
      const dowToIso = {};
      dates.forEach((d, i) => {
        dowToIso[dows[i]] = isoDateStringFromUTC(d);
      });

      const data = getWeekData(weekId);
      let addedCount = 0;
      parsed.forEach(({ dow, slot, name }) => {
        const iso = dowToIso[dow];
        const slotKey = SLOT_LABEL_TO_KEY[slot];
        if (!iso || !slotKey) return;
        const daySlots = getDaySlots(data, iso);
        const menu = findOrCreateMenu(name);
        if (!daySlots[slotKey].menuIds.includes(menu.id)) {
          daySlots[slotKey].menuIds.push(menu.id);
          addedCount += 1;
        }
      });

      saveJSON(LS_MENU_LIBRARY, menuLibraryState);
      saveJSON(LS_MEAL, mealState);
      menuLibraryEditor.render();
      renderMealDefaults();
      renderMealGrid();
      importTextEl.value = "";
      importStatusEl.textContent = `${addedCount}件を週の献立に反映しました`;
    });

    function render() {
      const data = getWeekData(weekId);
      weekLabelEl.textContent = formatWeekLabel(weekId);
      budgetEl.value = data.budget;
      actualCostEl.value = data.actualCost;
      renderMealGrid();
      renderDiff(data);
    }

    budgetEl.addEventListener("input", () => {
      const data = getWeekData(weekId);
      data.budget = budgetEl.value;
      saveJSON(LS_MEAL, mealState);
      renderDiff(data);
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

  // ---------- 設定タブ：データのエクスポート/インポート ----------
  // iPhoneでは「ホーム画面のアプリ」と「Safariの通常タブ」で保存場所が分かれてしまうため、
  // データをテキストで書き出し・読み込みできるようにして、移行やバックアップに使えるようにする
  (function initSettings() {
    const DATA_KEYS = [
      "dietapp_workout_v1",
      "dietapp_massage_v1",
      "dietapp_pantry_v1",
      "dietapp_pantry_v2",
      "dietapp_meal_v1",
      "dietapp_menu_library_v1",
      "dietapp_meal_defaults_v1",
    ];

    const exportBtn = document.getElementById("export-btn");
    const exportResultEl = document.getElementById("export-result");
    const exportTextEl = document.getElementById("export-text");
    const exportCopyBtn = document.getElementById("export-copy-btn");
    const importTextEl = document.getElementById("import-text");
    const importBtn = document.getElementById("import-btn");

    function buildExportData() {
      const data = {};
      DATA_KEYS.forEach((key) => {
        const raw = localStorage.getItem(key);
        if (raw !== null) data[key] = raw;
      });
      return JSON.stringify({ exportedAt: new Date().toISOString(), data }, null, 2);
    }

    exportBtn.addEventListener("click", () => {
      exportTextEl.value = buildExportData();
      exportResultEl.classList.remove("hidden");
    });

    exportCopyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(exportTextEl.value);
        showSaveIndicator("コピーしました");
      } catch (e) {
        exportTextEl.select();
      }
    });

    importBtn.addEventListener("click", () => {
      const raw = importTextEl.value.trim();
      if (!raw) return;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        alert("読み込めませんでした。エクスポートしたテキストをそのまま貼り付けてください。");
        return;
      }
      if (!parsed || typeof parsed.data !== "object") {
        alert("読み込めませんでした。エクスポートしたテキストをそのまま貼り付けてください。");
        return;
      }
      const ok = confirm("現在のデータを、貼り付けた内容で上書きします。よろしいですか？");
      if (!ok) return;
      Object.keys(parsed.data).forEach((key) => {
        if (DATA_KEYS.includes(key)) {
          localStorage.setItem(key, parsed.data[key]);
        }
      });
      alert("復元しました。画面を再読み込みします。");
      window.location.reload();
    });
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
