const storageKey = "zfl18-boardgame-rule-cards";
const today = new Date();
const RC = window.RelayCore;

const defaultState = {
  selectedId: "",
  editorName: "主理人",
  games: [
    {
      id: crypto.randomUUID(),
      name: "奥尔良",
      minPlayers: 2,
      maxPlayers: 4,
      duration: 90,
      complexity: "中",
      lastPlayed: "2025-11-20",
      cover: "",
      forgets: ["商站建造前先确认道路或水路连接", "袋中随从抽完后不是重洗弃堆，而是从已回袋内容继续抽"],
      disputes: ["事件顺序和玩家动作结算先后", "科技板是否能替代所有同类随从"],
      setup: ["按人数放置货物板块", "每位玩家拿起始随从、商人和个人板"],
      scoring: ["货物分数", "商站和市民乘区块", "金币和建筑剩余加分"]
    },
    {
      id: crypto.randomUUID(),
      name: "盖亚计划",
      minPlayers: 1,
      maxPlayers: 4,
      duration: 150,
      complexity: "重",
      lastPlayed: "2025-08-02",
      cover: "",
      forgets: ["联邦连接时卫星数量和能量消耗要一起核对", "研究升到顶必须拿对应科技板限制"],
      disputes: ["被动充能是否能拒绝", "星球改造费用受哪些能力影响"],
      setup: ["随机终局计分板和回合得分板", "按种族设置起始资源和母星"],
      scoring: ["终局计分板", "科技轨排名", "联邦和建筑分"]
    },
    {
      id: crypto.randomUUID(),
      name: "花砖物语",
      minPlayers: 2,
      maxPlayers: 4,
      duration: 45,
      complexity: "轻",
      lastPlayed: "2026-03-15",
      cover: "",
      forgets: ["每轮结束先铺墙再补工厂展示区", "地板线扣分后清空对应砖"],
      disputes: ["同色砖放置限制是否看整面墙", "中央区起始玩家标记是否必须拿"],
      setup: ["按人数放工厂圆盘", "每个圆盘补4块砖"],
      scoring: ["横竖相邻即时分", "完整行列和颜色终局加分"]
    }
  ]
};

let state = loadState();
state.games.forEach((game) => RC.normalizeGame(game));
if (typeof state.editorName !== "string" || !state.editorName.trim()) state.editorName = "主理人";
if (!state.selectedId) state.selectedId = state.games[0]?.id || "";

/* 多标签页协作：baseline 记录本页加载/上次保存时的状态，
   保存时与 localStorage 里的最新持久化状态做三方合并，
   避免后保存的页面覆盖其他标签页的草稿与进度。 */
let baseline = RC.clone(state);
let lastWritten = localStorage.getItem(storageKey) || "";

/* 页面级临时状态（不持久化）：草稿模式、重排方案预览、差异/合并/历史面板等。 */
const ui = {
  editingDraft: false,
  proposal: null,
  diffFor: null,
  mergeConfirm: null,
  historyFor: null,
  skipFor: null,
  editFor: null,
  notice: "",
  importReport: null
};

const els = {
  searchInput: document.querySelector("#searchInput"),
  playerFilter: document.querySelector("#playerFilter"),
  complexityFilter: document.querySelector("#complexityFilter"),
  sortMode: document.querySelector("#sortMode"),
  gameForm: document.querySelector("#gameForm"),
  nameInput: document.querySelector("#nameInput"),
  minPlayersInput: document.querySelector("#minPlayersInput"),
  maxPlayersInput: document.querySelector("#maxPlayersInput"),
  durationInput: document.querySelector("#durationInput"),
  complexityInput: document.querySelector("#complexityInput"),
  lastPlayedInput: document.querySelector("#lastPlayedInput"),
  coverInput: document.querySelector("#coverInput"),
  gameList: document.querySelector("#gameList"),
  detailView: document.querySelector("#detailView"),
  gameCount: document.querySelector("#gameCount"),
  ruleCount: document.querySelector("#ruleCount"),
  staleGame: document.querySelector("#staleGame"),
  visibleCount: document.querySelector("#visibleCount"),
  relayPanel: document.querySelector("#relayPanel"),
  exportBtn: document.querySelector("#exportBtn"),
  importFile: document.querySelector("#importFile"),
  importReport: document.querySelector("#importReport")
};

function loadState() {
  const saved = localStorage.getItem(storageKey);
  if (!saved) return structuredClone(defaultState);
  try {
    return { ...structuredClone(defaultState), ...JSON.parse(saved) };
  } catch {
    return structuredClone(defaultState);
  }
}

function saveState() {
  reconcileWithPersisted();
  const serialized = JSON.stringify(state);
  if (serialized !== lastWritten) {
    lastWritten = serialized;
    localStorage.setItem(storageKey, serialized);
  }
  baseline = RC.clone(state);
}

function readPersistedState() {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/* 三方合并（本页内存 / 持久化 / 本页基准）：
   - 其他标签页新增的桌游并进来；本页删除的桌游不复活；
   - 草稿按所有者求并集，同名冲突取 updatedAt 较新者；
   - 接力进度按关卡合并：本页没动过的关卡采用其他页的进度。 */
function reconcileWithPersisted() {
  const persisted = readPersistedState();
  if (!persisted || !Array.isArray(persisted.games)) return;
  const baselineById = new Map((baseline.games || []).map((game) => [game.id, game]));
  const memoryIds = new Set(state.games.map((game) => game.id));
  persisted.games.forEach((persistedGame) => {
    if (!memoryIds.has(persistedGame.id) && !baselineById.has(persistedGame.id)) {
      const cloned = RC.clone(persistedGame);
      RC.normalizeGame(cloned);
      state.games.push(cloned);
    }
  });
  const persistedById = new Map(persisted.games.map((game) => [game.id, game]));
  state.games.forEach((game) => {
    const persistedGame = persistedById.get(game.id);
    if (!persistedGame) return;
    const baselineGame = baselineById.get(game.id);
    game.drafts = mergeDrafts(game.drafts, persistedGame.drafts, baselineGame && baselineGame.drafts);
    if (game.relay && persistedGame.relay) {
      mergeRelayProgress(game.relay, persistedGame.relay, baselineGame && baselineGame.relay);
    }
  });
}

function mergeDrafts(memoryDrafts, persistedDrafts, baselineDrafts) {
  const merged = { ...(memoryDrafts || {}) };
  Object.entries(persistedDrafts || {}).forEach(([owner, persistedDraft]) => {
    const memoryDraft = merged[owner];
    const baselineDraft = baselineDrafts ? baselineDrafts[owner] : undefined;
    if (!memoryDraft) {
      /* 本页没动过且不是本页删的 → 其他页新增的草稿，保留 */
      if (!baselineDraft) merged[owner] = persistedDraft;
      return;
    }
    if (!baselineDraft) {
      /* 两边都新建了同名草稿：较新者胜 */
      merged[owner] = String(persistedDraft.updatedAt || "") > String(memoryDraft.updatedAt || "")
        ? persistedDraft
        : memoryDraft;
      return;
    }
    const memoryChanged = JSON.stringify(memoryDraft) !== JSON.stringify(baselineDraft);
    const persistedChanged = JSON.stringify(persistedDraft) !== JSON.stringify(baselineDraft);
    if (!memoryChanged && persistedChanged) merged[owner] = persistedDraft;
  });
  return merged;
}

function mergeRelayProgress(memoryRelay, persistedRelay, baselineRelay) {
  if (!baselineRelay || !Array.isArray(baselineRelay.items)) return;
  const baselineById = new Map(baselineRelay.items.map((item) => [item.id, item]));
  const persistedById = new Map((persistedRelay.items || []).map((item) => [item.id, item]));
  (memoryRelay.items || []).forEach((item) => {
    const baselineItem = baselineById.get(item.id);
    const persistedItem = persistedById.get(item.id);
    if (!baselineItem || !persistedItem) return;
    if (item.status === baselineItem.status && persistedItem.status !== baselineItem.status) {
      item.status = persistedItem.status;
      item.skipReason = persistedItem.skipReason || "";
    }
  });
}

function daysSince(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  return Math.max(0, Math.floor((today - date) / 86400000));
}

function getAllRules(game) {
  return [...game.forgets, ...game.disputes, ...game.setup, ...game.scoring];
}

function currentGame() {
  return state.games.find((item) => item.id === state.selectedId) || state.games[0] || null;
}

/* 当前正在展示/编辑的计划结构：草稿模式下是草稿，否则是正式计划。 */
function activePlan(game) {
  if (ui.editingDraft && game.drafts[state.editorName]) return game.drafts[state.editorName];
  return game.relay;
}

function pushUndo(relay, label) {
  relay.undoStack.push({
    items: RC.clone(relay.items),
    budgetMinutes: relay.budgetMinutes,
    members: [...relay.members],
    label
  });
  if (relay.undoStack.length > 30) relay.undoStack.shift();
}

function nowStamp() {
  return new Date().toISOString();
}

function formatTime(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function getFilteredGames() {
  const keyword = els.searchInput.value.trim();
  const player = els.playerFilter.value;
  const complexity = els.complexityFilter.value;
  const games = state.games.filter((game) => {
    const text = `${game.name}${getAllRules(game).join("")}`;
    const matchesKeyword = !keyword || text.includes(keyword);
    const matchesPlayer = player === "all" || (Number(player) >= game.minPlayers && Number(player) <= game.maxPlayers);
    const matchesComplexity = complexity === "all" || game.complexity === complexity;
    return matchesKeyword && matchesPlayer && matchesComplexity;
  });

  if (els.sortMode.value === "name") return games.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  if (els.sortMode.value === "complexity") {
    const rank = { 轻: 1, 中: 2, 重: 3 };
    return games.sort((a, b) => rank[b.complexity] - rank[a.complexity]);
  }
  return games.sort((a, b) => daysSince(b.lastPlayed) - daysSince(a.lastPlayed));
}

function renderSummary() {
  const allRuleCount = state.games.reduce((sum, game) => sum + getAllRules(game).length, 0);
  const stale = [...state.games].sort((a, b) => daysSince(b.lastPlayed) - daysSince(a.lastPlayed))[0];
  els.gameCount.textContent = state.games.length;
  els.ruleCount.textContent = allRuleCount;
  els.staleGame.textContent = stale ? `${daysSince(stale.lastPlayed)}天` : "-";
}

function renderList() {
  const games = getFilteredGames();
  els.visibleCount.textContent = `${games.length}个匹配`;
  els.gameList.innerHTML =
    games
      .map((game) => {
        const selected = game.id === state.selectedId ? "selected" : "";
        return `
          <article class="game-card ${selected}" data-game-id="${game.id}">
            <div class="cover">
              ${
                game.cover
                  ? `<img src="${game.cover}" alt="${escapeHtml(game.name)}封面" />`
                  : `<span>${escapeHtml(game.name.slice(0, 2))}</span>`
              }
              <span class="stale-ribbon">${daysSince(game.lastPlayed)}天未玩</span>
            </div>
            <div class="game-body">
              <h3>${escapeHtml(game.name)}</h3>
              <div class="game-meta">
                <span class="pill">${game.minPlayers}-${game.maxPlayers}人</span>
                <span class="pill">${game.duration}分钟</span>
                <span class="pill heavy">${escapeHtml(game.complexity)}</span>
              </div>
            </div>
          </article>
        `;
      })
      .join("") || `<p class="empty">没有符合筛选的桌游。</p>`;
}

function renderDetail() {
  const game = currentGame();
  if (!game) {
    els.detailView.innerHTML = `<p class="empty">先添加一个桌游。</p>`;
    return;
  }
  state.selectedId = game.id;
  els.detailView.innerHTML = `
    <div class="quick-card">
      <div class="detail-cover">
        ${game.cover ? `<img src="${game.cover}" alt="${escapeHtml(game.name)}封面" />` : `<span>${escapeHtml(game.name.slice(0, 2))}</span>`}
      </div>
      <div>
        <h2>${escapeHtml(game.name)}</h2>
        <div class="game-meta">
          <span class="pill">${game.minPlayers}-${game.maxPlayers}人</span>
          <span class="pill">${game.duration}分钟</span>
          <span class="pill heavy">${escapeHtml(game.complexity)}</span>
          <span class="pill">${daysSince(game.lastPlayed)}天未玩</span>
        </div>
      </div>
      ${renderRuleSection("容易忘的规则", "forgets", game.forgets)}
      ${renderRuleSection("常见争议", "disputes", game.disputes)}
      ${renderRuleSection("开局准备", "setup", game.setup)}
      ${renderRuleSection("计分提醒", "scoring", game.scoring)}
      <form class="add-rule" id="ruleForm">
        <select id="ruleTypeInput">
          <option value="forgets">容易忘的规则</option>
          <option value="disputes">常见争议</option>
          <option value="setup">开局准备</option>
          <option value="scoring">计分提醒</option>
        </select>
        <textarea id="ruleTextInput" rows="3" placeholder="补充一条聚会前要看的提醒" required></textarea>
        <button class="primary" type="submit">加入规则卡片</button>
      </form>
      <div class="detail-actions">
        <button id="playedTodayBtn" type="button">标记今天玩过</button>
        <button id="deleteGameBtn" type="button">删除桌游</button>
      </div>
    </div>
  `;
}

function renderRuleSection(title, key, items) {
  return `
    <section class="rule-section">
      <h3>${title}</h3>
      <ul class="rule-list">
        ${
          items
            .map(
              (item, index) => `
                <li>
                  <span>${escapeHtml(item)}</span>
                  <button type="button" title="删除" data-rule-key="${key}" data-rule-index="${index}">×</button>
                </li>
              `
            )
            .join("") || `<li><span>暂无内容。</span></li>`
        }
      </ul>
    </section>
  `;
}

/* ================= 规则接力教练台 ================= */

function statusBadge(item, unlockInfo) {
  if (item.status === "confirmed") return `<span class="status-badge st-ok">已确认</span>`;
  if (item.status === "skipped") return `<span class="status-badge st-skip">已跳过</span>`;
  if (item.deferred) return `<span class="status-badge st-defer">补讲区</span>`;
  if (unlockInfo && unlockInfo.unlocked) return `<span class="status-badge st-go">可讲解</span>`;
  return `<span class="status-badge st-wait">待解锁</span>`;
}

function renderRelay() {
  const game = currentGame();
  if (!game) {
    els.relayPanel.innerHTML = `<p class="empty">先添加一个桌游，再安排讲解接力。</p>`;
    return;
  }
  const relay = game.relay;
  const plan = activePlan(game);
  const stats = RC.analyze(relay);
  const draftOwners = Object.keys(game.drafts);
  els.relayPanel.innerHTML = `
    <div class="relay-head">
      <div>
        <p class="eyebrow">规则接力教练台</p>
        <h2>${escapeHtml(game.name)} · 讲解接力</h2>
      </div>
      <div class="relay-stats">
        <div><span>确认进度</span><strong id="relayProgress">${stats.confirmed}/${stats.total}</strong></div>
        <div><span>预计用时</span><strong id="relayUsed">${stats.usedMinutes}/${relay.budgetMinutes}分</strong></div>
        <div><span>当前可讲</span><strong id="relayTeachable">${stats.teachable}项</strong></div>
      </div>
    </div>
    ${ui.notice ? `<div class="notice" id="relayNotice">${escapeHtml(ui.notice)}</div>` : ""}
    ${ui.editingDraft ? renderDraftBanner(game) : ""}
    <div class="relay-grid">
      <div class="relay-main">
        ${renderRelayToolbar(game, relay)}
        ${ui.proposal ? renderProposal() : ""}
        ${renderTrack(game, plan)}
        ${renderDeferredZone(game, plan)}
        ${renderItemForm(game, plan)}
      </div>
      <aside class="relay-side">
        ${renderReplanBox(game, relay)}
        ${renderCollabBox(game, draftOwners)}
      </aside>
    </div>
  `;
}

function renderDraftBanner(game) {
  return `
    <div class="draft-banner" id="draftBanner">
      正在编辑「${escapeHtml(state.editorName)}」的草稿 —— 结构修改只保存在草稿里，合并后才进入正式计划；确认/跳过等进度操作请在正式计划中进行。
      <div class="draft-banner-actions">
        <button type="button" id="draftSaveBtn">保存草稿版本</button>
        <button type="button" id="draftExitBtn">退出草稿</button>
        <button type="button" id="draftDiscardBtn" class="danger">放弃草稿</button>
      </div>
    </div>
  `;
}

function renderRelayToolbar(game, relay) {
  const lastUndo = relay.undoStack[relay.undoStack.length - 1];
  const undoEnabled = relay.undoStack.length && !ui.editingDraft;
  return `
    <div class="relay-toolbar">
      <label class="inline-field">
        讲解预算（分钟）
        <input id="budgetInput" type="number" min="1" value="${activePlan(game).budgetMinutes}" />
      </label>
      <button type="button" id="saveBudgetBtn">保存预算</button>
      <div class="member-chips">
        <span class="chips-label">讲解人：</span>
        ${activePlan(game).members
          .map(
            (member) => `
              <span class="chip">${escapeHtml(member)}
                <button type="button" data-remove-member="${escapeHtml(member)}" title="移除">×</button>
              </span>`
          )
          .join("")}
        <input id="memberNameInput" type="text" placeholder="新讲解人" />
        <button type="button" id="memberAddBtn">添加</button>
      </div>
      <button type="button" id="undoBtn" ${undoEnabled ? "" : "disabled"}>
        撤销${lastUndo ? `：${escapeHtml(lastUndo.label)}` : ""}
      </button>
    </div>
  `;
}

function renderProposal() {
  const p = ui.proposal;
  return `
    <div class="proposal" id="proposalBox">
      <h3>重排方案（仅未确认项变动，锁定与进度不动）</h3>
      <p class="proposal-summary">预算 ${p.budget} 分钟 · 锁定/已确认占 ${p.fixedTime} 分钟 · 方案预计总用时 ${p.usedMinutes} 分钟</p>
      <ul>
        ${p.changes.map((line) => `<li>${escapeHtml(line)}</li>`).join("") || "<li>顺序与人员无需调整。</li>"}
      </ul>
      ${p.warnings.map((line) => `<p class="warning">${escapeHtml(line)}</p>`).join("")}
      <div class="proposal-actions">
        <button type="button" class="primary" id="applyProposalBtn">应用方案</button>
        <button type="button" id="discardProposalBtn">放弃方案</button>
      </div>
    </div>
  `;
}

function renderTrack(game, plan) {
  const unlock = RC.analyze(plan).unlock;
  const mainItems = plan.items.filter((item) => !item.deferred);
  const rows = mainItems
    .map((item) => {
      const index = plan.items.indexOf(item);
      const info = unlock.get(item.id);
      const blocked = item.status === "pending" && !info.unlocked;
      const prereqTitles = item.prereqs
        .map((pid) => plan.items.find((o) => o.id === pid)?.title || "（缺失）")
        .join("、");
      return `
        <li class="relay-item st-${item.status}${item.locked ? " is-locked" : ""}${blocked ? " is-blocked" : ""}" data-item-id="${item.id}">
          <span class="relay-order">${plan.items.filter((o) => !o.deferred).indexOf(item) + 1}</span>
          <div class="relay-item-body">
            <div class="relay-item-head">
              <strong>${escapeHtml(item.title)}</strong>
              ${item.kind !== "normal" ? `<span class="kind-badge">${RC.KIND_LABEL[item.kind]}</span>` : ""}
              ${item.locked ? `<span class="lock-badge" title="锁定项：重排时不动">🔒锁定</span>` : ""}
              ${item.optional ? `<span class="opt-badge">可选</span>` : ""}
              ${statusBadge(item, info)}
            </div>
            <div class="relay-item-meta">
              <span>👤 ${escapeHtml(item.teacher || "（未指定）")}</span>
              <span>⏱ ${item.minutes} 分钟</span>
              ${prereqTitles ? `<span>前置：${escapeHtml(prereqTitles)}</span>` : ""}
            </div>
            ${
              item.points.length
                ? `<div class="points">${item.points.map((point) => `<span class="point-chip">${escapeHtml(point)}</span>`).join("")}</div>`
                : ""
            }
            ${item.skipReason ? `<div class="skip-reason">跳过原因：${escapeHtml(item.skipReason)}</div>` : ""}
            ${blocked ? `<div class="blockers">需先完成：${escapeHtml(info.blockers.join("、"))}</div>` : ""}
            ${renderItemActions(item, info, game)}
            ${ui.editFor === item.id ? renderItemEditForm(plan, item) : ""}
            ${ui.skipFor === item.id ? renderSkipForm(item) : ""}
          </div>
        </li>
      `;
    })
    .join("");
  return `<ol class="relay-track" id="relayTrack">${rows || `<p class="empty">还没有讲解关卡，用下方表单添加。</p>`}</ol>`;
}

function renderItemActions(item, info, game) {
  if (ui.editingDraft) {
    return `
      <div class="relay-item-actions">
        <button type="button" data-action="edit-open" data-item-id="${item.id}">编辑</button>
        <button type="button" data-action="move-up" data-item-id="${item.id}">上移</button>
        <button type="button" data-action="move-down" data-item-id="${item.id}">下移</button>
        <button type="button" data-action="toggle-lock" data-item-id="${item.id}">${item.locked ? "解锁" : "锁定"}</button>
        <button type="button" data-action="delete" data-item-id="${item.id}">删除</button>
      </div>
    `;
  }
  const canConfirm = item.status === "pending" && info.unlocked && !item.deferred;
  return `
    <div class="relay-item-actions">
      ${
        item.status === "pending"
          ? `<button type="button" class="primary" data-action="confirm" data-item-id="${item.id}" ${canConfirm ? "" : "disabled"}>确认讲解</button>
             <button type="button" data-action="skip-open" data-item-id="${item.id}">跳过</button>`
          : ""
      }
      <button type="button" data-action="edit-open" data-item-id="${item.id}">编辑</button>
      <button type="button" data-action="move-up" data-item-id="${item.id}">上移</button>
      <button type="button" data-action="move-down" data-item-id="${item.id}">下移</button>
      <button type="button" data-action="toggle-lock" data-item-id="${item.id}">${item.locked ? "解锁" : "锁定"}</button>
      <button type="button" data-action="delete" data-item-id="${item.id}">删除</button>
    </div>
  `;
}

function renderItemEditForm(plan, item) {
  const others = plan.items.filter((o) => o.id !== item.id);
  return `
    <form class="item-edit-form" data-item-id="${item.id}">
      <div class="split">
        <label>标题<input name="title" required value="${escapeHtml(item.title)}" /></label>
        <label>讲解人
          <select name="teacher">
            ${plan.members.map((m) => `<option value="${escapeHtml(m)}" ${m === item.teacher ? "selected" : ""}>${escapeHtml(m)}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="split">
        <label>时长（分钟）<input name="minutes" type="number" min="1" required value="${item.minutes}" /></label>
        <label>类型
          <select name="kind">
            <option value="normal" ${item.kind === "normal" ? "selected" : ""}>普通</option>
            <option value="inserted" ${item.kind === "inserted" ? "selected" : ""}>插讲</option>
            <option value="supplementary" ${item.kind === "supplementary" ? "selected" : ""}>补讲</option>
          </select>
        </label>
      </div>
      <label>必讲点（每行一条）<textarea name="points" rows="3">${escapeHtml(item.points.join("\n"))}</textarea></label>
      <fieldset class="prereq-picker">
        <legend>前置关卡</legend>
        ${
          others
            .map(
              (o) => `
                <label class="prereq-option">
                  <input type="checkbox" name="prereq" value="${o.id}" ${item.prereqs.includes(o.id) ? "checked" : ""} />
                  ${escapeHtml(o.title)}
                </label>`
            )
            .join("") || "<span>暂无其他关卡</span>"
        }
      </fieldset>
      <label class="prereq-option"><input type="checkbox" name="optional" ${item.optional ? "checked" : ""} /> 可选关卡（压缩时间时优先跳过）</label>
      <div class="form-actions">
        <button type="submit" class="primary">保存关卡</button>
        <button type="button" data-action="edit-cancel">取消</button>
      </div>
    </form>
  `;
}

function renderSkipForm(item) {
  return `
    <form class="skip-form" data-item-id="${item.id}">
      <label>跳过原因（必填）<input name="reason" required placeholder="例：时间不够，下次补讲" /></label>
      <div class="form-actions">
        <button type="submit" class="primary">确定跳过</button>
        <button type="button" data-action="skip-cancel">取消</button>
      </div>
    </form>
  `;
}

function renderDeferredZone(game, plan) {
  const deferred = plan.items.filter((item) => item.deferred && item.status === "pending");
  if (!deferred.length) return "";
  const unlock = RC.analyze(plan).unlock;
  return `
    <div class="deferred-zone" id="deferredZone">
      <h3>补讲 / 暂缓区（不占主流程预算）</h3>
      <ul>
        ${deferred
          .map((item) => {
            const info = unlock.get(item.id);
            const blocked = !info.unlocked;
            return `
              <li data-item-id="${item.id}">
                <div>
                  <strong>${escapeHtml(item.title)}</strong>
                  <span class="relay-item-meta">👤 ${escapeHtml(item.teacher)} · ⏱ ${item.minutes} 分钟</span>
                  ${blocked ? `<div class="blockers">需先完成：${escapeHtml(info.blockers.join("、"))}</div>` : ""}
                </div>
                <div class="relay-item-actions">
                  ${ui.editingDraft ? "" : `<button type="button" class="primary" data-action="confirm" data-item-id="${item.id}" ${blocked ? "disabled" : ""}>确认讲解</button>`}
                  <button type="button" data-action="undefer" data-item-id="${item.id}">移回主流程</button>
                </div>
              </li>
            `;
          })
          .join("")}
      </ul>
    </div>
  `;
}

function renderItemForm(game, plan) {
  return `
    <form class="item-add-form" id="itemAddForm">
      <h3>${ui.editingDraft ? "向草稿添加关卡" : "新增讲解关卡"}</h3>
      <div class="split">
        <label>标题<input id="itemTitleInput" required placeholder="例：终局计分" /></label>
        <label>讲解人
          <select id="itemTeacherInput">
            ${plan.members.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="split">
        <label>时长（分钟）<input id="itemMinutesInput" type="number" min="1" value="5" required /></label>
        <label>方式
          <select id="itemKindInput">
            <option value="normal">普通（追加到末尾）</option>
            <option value="inserted">插讲（插到指定位置）</option>
            <option value="supplementary">补讲（进入补讲区）</option>
          </select>
        </label>
      </div>
      <label>插入位置（插讲时生效）
        <select id="itemPositionInput">
          ${plan.items.map((o) => `<option value="${o.id}">在「${escapeHtml(o.title)}」之后</option>`).join("")}
        </select>
      </label>
      <label>必讲点（每行一条）<textarea id="itemPointsInput" rows="2" placeholder="例：计分项先讲即时分"></textarea></label>
      <fieldset class="prereq-picker">
        <legend>前置关卡</legend>
        ${
          plan.items
            .map(
              (o) => `
                <label class="prereq-option">
                  <input type="checkbox" name="newPrereq" value="${o.id}" />
                  ${escapeHtml(o.title)}
                </label>`
            )
            .join("") || "<span>暂无关卡</span>"
        }
      </fieldset>
      <label class="prereq-option"><input id="itemOptionalInput" type="checkbox" /> 可选关卡（压缩时间时优先跳过）</label>
      <button class="primary" type="submit">加入接力</button>
    </form>
  `;
}

function renderReplanBox(game, relay) {
  const memberOptions = relay.members.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
  return `
    <section class="replan-box">
      <h3>重排助手</h3>
      <p class="hint">换人或压缩时间时，只重排未确认关卡；锁定项与完成进度保持不动。超预算会给出可行方案。</p>
      ${ui.editingDraft ? `<p class="hint">草稿模式下请直接编辑结构，重排助手仅作用于正式计划。</p>` : ""}
      <label>换人：把
        <select id="replanFrom">${memberOptions}</select>
      </label>
      <label>的未确认关卡交给
        <select id="replanTo">${memberOptions}</select>
      </label>
      <label>压缩时间：新预算（分钟）
        <input id="replanBudget" type="number" min="1" value="${relay.budgetMinutes}" />
      </label>
      <button type="button" id="replanBtn" ${ui.editingDraft ? "disabled" : ""}>生成重排方案</button>
    </section>
  `;
}

function renderCollabBox(game, draftOwners) {
  const rows = draftOwners
    .map((owner) => {
      const draft = game.drafts[owner];
      const open = ui.diffFor === owner;
      const merging = ui.mergeConfirm === owner;
      const historyOpen = ui.historyFor === owner;
      return `
        <div class="draft-row" data-owner="${escapeHtml(owner)}">
          <div class="draft-row-head">
            <strong>${escapeHtml(owner)}</strong>
            <span>更新于 ${formatTime(draft.updatedAt)}</span>
          </div>
          <div class="draft-row-actions">
            <button type="button" data-draft-edit="${escapeHtml(owner)}">编辑</button>
            <button type="button" data-draft-diff="${escapeHtml(owner)}">${open ? "收起差异" : "对比差异"}</button>
            <button type="button" data-draft-merge="${escapeHtml(owner)}">合并</button>
            <button type="button" data-draft-history="${escapeHtml(owner)}">历史(${draft.history.length})</button>
            <button type="button" data-draft-delete="${escapeHtml(owner)}">删除</button>
          </div>
          ${open ? renderDiff(game, owner) : ""}
          ${merging ? `<div class="merge-confirm"><p>确认把「${escapeHtml(owner)}」的草稿合并进正式计划？已确认/锁定关卡会保留，合并前正式计划不会被覆盖。</p><button type="button" class="primary" data-merge-confirm="${escapeHtml(owner)}">确认合并</button><button type="button" data-merge-cancel>取消</button></div>` : ""}
          ${historyOpen ? renderDraftHistory(draft) : ""}
        </div>
      `;
    })
    .join("");
  return `
    <section class="collab-box">
      <h3>多人协作与版本</h3>
      <p class="hint">每个人改自己的草稿，合并前互不影响；可对比差异、撤销合并、恢复历史草稿。</p>
      <label>当前身份
        <input id="editorNameInput" type="text" value="${escapeHtml(state.editorName)}" />
      </label>
      <button type="button" id="draftStartBtn">${game.drafts[state.editorName] ? (ui.editingDraft ? "正在编辑我的草稿" : "继续编辑我的草稿") : "以该身份起草"}</button>
      <div class="draft-list">${rows || `<p class="empty">还没有草稿。</p>`}</div>
    </section>
  `;
}

function renderDiff(game, owner) {
  const diff = RC.diffPlans(game.relay, game.drafts[owner]);
  const lines = [];
  diff.added.forEach((item) => lines.push(`＋ 新增关卡「${item.title}」（${item.teacher} · ${item.minutes}分）`));
  diff.removed.forEach((item) => lines.push(`－ 删除关卡「${item.title}」`));
  diff.changed.forEach((entry) => lines.push(`✎ 「${entry.title}」：${entry.fields.join("；")}`));
  if (diff.orderChanged) lines.push("⇅ 讲解顺序有调整");
  if (diff.budgetChanged) lines.push(`预算 ${diff.liveBudget} → ${diff.draftBudget} 分钟`);
  diff.membersAdded.forEach((m) => lines.push(`＋ 讲解人「${m}」`));
  diff.membersRemoved.forEach((m) => lines.push(`－ 讲解人「${m}」`));
  return `
    <div class="diff-box" id="diffBox">
      <h4>与正式计划的差异</h4>
      <ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("") || "<li>没有差异。</li>"}</ul>
    </div>
  `;
}

function renderDraftHistory(draft) {
  return `
    <div class="history-box">
      <h4>草稿历史版本</h4>
      <ul>
        ${draft.history
          .map(
            (rev, index) => `
              <li>
                <span>${escapeHtml(rev.label)} · ${formatTime(rev.at)}</span>
                <button type="button" data-history-restore="${index}">恢复此版本</button>
              </li>`
          )
          .join("") || "<li>还没有保存过版本。</li>"}
      </ul>
    </div>
  `;
}

function renderImportReport() {
  if (!ui.importReport) {
    els.importReport.innerHTML = "";
    return;
  }
  const report = ui.importReport;
  els.importReport.innerHTML = `
    <div class="import-report ${report.ok ? "ok" : "bad"}" id="importReportBox">
      <div class="import-report-head">
        <strong>${report.ok ? "导入成功" : "导入失败：原数据未改动"}</strong>
        <button type="button" id="importReportClose">×</button>
      </div>
      ${report.ok ? `<p>${escapeHtml(report.message)}</p>` : `<ul>${report.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>`}
    </div>
  `;
}

function renderAll() {
  saveState();
  renderSummary();
  renderList();
  renderDetail();
  renderRelay();
  renderImportReport();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) {
      resolve("");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

async function addGame(event) {
  event.preventDefault();
  const minPlayers = Number(els.minPlayersInput.value);
  const maxPlayers = Math.max(minPlayers, Number(els.maxPlayersInput.value));
  const cover = await readFileAsDataUrl(els.coverInput.files[0]);
  const game = {
    id: crypto.randomUUID(),
    name: els.nameInput.value.trim(),
    minPlayers,
    maxPlayers,
    duration: Number(els.durationInput.value),
    complexity: els.complexityInput.value,
    lastPlayed: els.lastPlayedInput.value,
    cover,
    forgets: ["本局开始前先补充容易忘的规则。"],
    disputes: [],
    setup: ["整理组件并按人数调整初始设置。"],
    scoring: ["确认终局计分项和即时得分项。"]
  };
  RC.normalizeGame(game);
  state.games.unshift(game);
  state.selectedId = game.id;
  els.gameForm.reset();
  setDefaultDate();
  renderAll();
}

function setDefaultDate() {
  const date = new Date();
  date.setMonth(date.getMonth() - 2);
  els.lastPlayedInput.value = date.toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* ================= 接力计划操作 ================= */

function mutateStructure(game, fn, undoLabel) {
  /* 草稿模式改草稿，正式模式改正式计划（先存撤销快照）。 */
  if (ui.editingDraft && game.drafts[state.editorName]) {
    const draft = game.drafts[state.editorName];
    fn(draft);
    draft.updatedAt = nowStamp();
  } else {
    pushUndo(game.relay, undoLabel);
    fn(game.relay);
  }
}

function removeItemEverywhere(plan, itemId) {
  plan.items = plan.items.filter((item) => item.id !== itemId);
  plan.items.forEach((item) => {
    item.prereqs = item.prereqs.filter((pid) => pid !== itemId);
  });
}

function handleRelayClick(event) {
  const game = currentGame();
  if (!game) return;
  const relay = game.relay;
  const plan = activePlan(game);
  const target = event.target;

  const actionBtn = target.closest("[data-action]");
  if (actionBtn) {
    const itemId = actionBtn.dataset.itemId;
    const item = plan.items.find((o) => o.id === itemId);
    const action = actionBtn.dataset.action;

    if (action === "confirm" && item) {
      const info = RC.analyze(relay).unlock.get(item.id);
      if (!info.unlocked) {
        ui.notice = `「${item.title}」还未解锁，需先完成：${info.blockers.join("、")}`;
      } else {
        pushUndo(relay, `确认「${item.title}」`);
        item.status = "confirmed";
        ui.notice = item.deferred ? `已完成补讲「${item.title}」。` : `已确认「${item.title}」，下一关已解锁。`;
      }
    }
    if (action === "skip-open") ui.skipFor = itemId;
    if (action === "skip-cancel") ui.skipFor = null;
    if (action === "edit-open") ui.editFor = ui.editFor === itemId ? null : itemId;
    if (action === "edit-cancel") ui.editFor = null;
    if (action === "delete" && item) {
      mutateStructure(game, (p) => removeItemEverywhere(p, itemId), `删除「${item.title}」`);
      ui.notice = `已删除关卡「${item.title}」。`;
    }
    if ((action === "move-up" || action === "move-down") && item) {
      const index = plan.items.indexOf(item);
      const swap = action === "move-up" ? index - 1 : index + 1;
      if (swap >= 0 && swap < plan.items.length) {
        mutateStructure(
          game,
          (p) => {
            const i = p.items.indexOf(item);
            [p.items[i], p.items[i + (action === "move-up" ? -1 : 1)]] = [p.items[i + (action === "move-up" ? -1 : 1)], p.items[i]];
          },
          `移动「${item.title}」`
        );
      }
    }
    if (action === "toggle-lock" && item) {
      mutateStructure(game, () => {
        item.locked = !item.locked;
      }, `${item.locked ? "解锁" : "锁定"}「${item.title}」`);
      ui.notice = item.locked ? `已锁定「${item.title}」，重排时保持不动。` : `已解锁「${item.title}」。`;
    }
    if (action === "undefer" && item) {
      mutateStructure(game, () => {
        item.deferred = false;
      }, `「${item.title}」移回主流程`);
      ui.notice = `「${item.title}」已移回主流程。`;
    }
    renderAll();
    return;
  }

  if (target.closest("#saveBudgetBtn")) {
    const value = Number(document.querySelector("#budgetInput").value);
    if (value > 0) {
      mutateStructure(game, (p) => {
        p.budgetMinutes = value;
      }, `预算改为 ${value} 分钟`);
      ui.notice = `讲解预算已设为 ${value} 分钟。`;
    }
    renderAll();
    return;
  }

  if (target.closest("#memberAddBtn")) {
    const name = document.querySelector("#memberNameInput").value.trim();
    if (name && !plan.members.includes(name)) {
      mutateStructure(game, (p) => {
        p.members.push(name);
      }, `添加讲解人 ${name}`);
      ui.notice = `已添加讲解人「${name}」。`;
    }
    renderAll();
    return;
  }

  const removeMemberBtn = target.closest("[data-remove-member]");
  if (removeMemberBtn) {
    const name = removeMemberBtn.dataset.removeMember;
    const usedInLive = relay.items.some((item) => item.teacher === name);
    const usedInDrafts = Object.values(game.drafts).some((draft) => draft.items.some((item) => item.teacher === name));
    if (usedInLive || usedInDrafts) {
      ui.notice = `「${name}」仍负责部分关卡，请先用重排助手换人再移除。`;
    } else {
      mutateStructure(game, (p) => {
        p.members = p.members.filter((m) => m !== name);
      }, `移除讲解人 ${name}`);
      ui.notice = `已移除讲解人「${name}」。`;
    }
    renderAll();
    return;
  }

  if (target.closest("#undoBtn")) {
    const last = relay.undoStack.pop();
    if (last) {
      relay.items = last.items;
      relay.budgetMinutes = last.budgetMinutes;
      relay.members = last.members;
      ui.notice = `已撤销：${last.label}`;
      ui.editingDraft = false;
    }
    renderAll();
    return;
  }

  if (target.closest("#replanBtn")) {
    const from = document.querySelector("#replanFrom").value;
    const to = document.querySelector("#replanTo").value;
    const budget = Number(document.querySelector("#replanBudget").value);
    const teacherMap = from && to && from !== to ? { [from]: to } : {};
    ui.proposal = RC.buildReplan(relay, { budget, teacherMap });
    ui.notice = "";
    renderAll();
    return;
  }

  if (target.closest("#applyProposalBtn")) {
    if (ui.proposal) {
      pushUndo(relay, "应用重排方案");
      relay.items = ui.proposal.newItems;
      relay.budgetMinutes = ui.proposal.budget;
      ui.notice = `已应用重排方案：预计用时 ${ui.proposal.usedMinutes}/${ui.proposal.budget} 分钟。`;
      ui.proposal = null;
    }
    renderAll();
    return;
  }

  if (target.closest("#discardProposalBtn")) {
    ui.proposal = null;
    renderAll();
    return;
  }

  if (target.closest("#draftStartBtn")) {
    if (!game.drafts[state.editorName]) {
      game.drafts[state.editorName] = {
        items: RC.clone(relay.items),
        budgetMinutes: relay.budgetMinutes,
        members: [...relay.members],
        updatedAt: nowStamp(),
        history: [
          {
            at: nowStamp(),
            label: "初始版本（基于正式计划）",
            snapshot: { items: RC.clone(relay.items), budgetMinutes: relay.budgetMinutes, members: [...relay.members] }
          }
        ]
      };
    }
    ui.editingDraft = true;
    ui.notice = `已切换到「${state.editorName}」的草稿。`;
    renderAll();
    return;
  }

  if (target.closest("#draftSaveBtn")) {
    const draft = game.drafts[state.editorName];
    if (draft) {
      draft.history.push({
        at: nowStamp(),
        label: `版本 ${draft.history.length + 1}`,
        snapshot: { items: RC.clone(draft.items), budgetMinutes: draft.budgetMinutes, members: [...draft.members] }
      });
      draft.updatedAt = nowStamp();
      ui.notice = `已保存「${state.editorName}」的草稿版本。`;
    }
    renderAll();
    return;
  }

  if (target.closest("#draftExitBtn")) {
    ui.editingDraft = false;
    ui.notice = "已退出草稿，回到正式计划。";
    renderAll();
    return;
  }

  if (target.closest("#draftDiscardBtn")) {
    if (window.confirm(`确定放弃「${state.editorName}」的草稿？此操作不可恢复。`)) {
      delete game.drafts[state.editorName];
      ui.editingDraft = false;
      ui.notice = "已放弃草稿。";
    }
    renderAll();
    return;
  }

  const draftEditBtn = target.closest("[data-draft-edit]");
  if (draftEditBtn) {
    state.editorName = draftEditBtn.dataset.draftEdit;
    ui.editingDraft = true;
    ui.notice = `已切换到「${state.editorName}」的草稿。`;
    renderAll();
    return;
  }

  const draftDiffBtn = target.closest("[data-draft-diff]");
  if (draftDiffBtn) {
    const owner = draftDiffBtn.dataset.draftDiff;
    ui.diffFor = ui.diffFor === owner ? null : owner;
    renderAll();
    return;
  }

  const draftMergeBtn = target.closest("[data-draft-merge]");
  if (draftMergeBtn) {
    const owner = draftMergeBtn.dataset.draftMerge;
    ui.mergeConfirm = owner;
    ui.diffFor = owner;
    renderAll();
    return;
  }

  const mergeConfirmBtn = target.closest("[data-merge-confirm]");
  if (mergeConfirmBtn) {
    const owner = mergeConfirmBtn.dataset.mergeConfirm;
    const draft = game.drafts[owner];
    if (draft) {
      pushUndo(relay, `合并「${owner}」的草稿`);
      const merged = RC.mergePlans(relay, draft);
      relay.items = merged.items;
      relay.budgetMinutes = merged.budgetMinutes;
      relay.members = merged.members;
      ui.notice = [`已合并「${owner}」的草稿，草稿本身仍保留。`, ...merged.warnings].join(" ");
      ui.mergeConfirm = null;
      ui.diffFor = null;
      if (owner === state.editorName) ui.editingDraft = false;
    }
    renderAll();
    return;
  }

  if (target.closest("[data-merge-cancel]")) {
    ui.mergeConfirm = null;
    renderAll();
    return;
  }

  const draftHistoryBtn = target.closest("[data-draft-history]");
  if (draftHistoryBtn) {
    const owner = draftHistoryBtn.dataset.draftHistory;
    ui.historyFor = ui.historyFor === owner ? null : owner;
    renderAll();
    return;
  }

  const historyRestoreBtn = target.closest("[data-history-restore]");
  if (historyRestoreBtn) {
    const owner = target.closest("[data-owner]").dataset.owner;
    const draft = game.drafts[owner];
    const rev = draft?.history[Number(historyRestoreBtn.dataset.historyRestore)];
    if (draft && rev) {
      draft.history.push({
        at: nowStamp(),
        label: "恢复前自动保存",
        snapshot: { items: RC.clone(draft.items), budgetMinutes: draft.budgetMinutes, members: [...draft.members] }
      });
      draft.items = RC.clone(rev.snapshot.items);
      draft.budgetMinutes = rev.snapshot.budgetMinutes;
      draft.members = [...rev.snapshot.members];
      draft.updatedAt = nowStamp();
      ui.notice = `已把「${owner}」的草稿恢复到「${rev.label}」。`;
    }
    renderAll();
    return;
  }

  const draftDeleteBtn = target.closest("[data-draft-delete]");
  if (draftDeleteBtn) {
    const owner = draftDeleteBtn.dataset.draftDelete;
    if (window.confirm(`确定删除「${owner}」的草稿？`)) {
      delete game.drafts[owner];
      if (owner === state.editorName) ui.editingDraft = false;
      ui.notice = `已删除「${owner}」的草稿。`;
    }
    renderAll();
    return;
  }
}

function handleRelaySubmit(event) {
  const game = currentGame();
  if (!game) return;
  const plan = activePlan(game);

  if (event.target.id === "itemAddForm") {
    event.preventDefault();
    const title = document.querySelector("#itemTitleInput").value.trim();
    const teacher = document.querySelector("#itemTeacherInput").value;
    const minutes = Number(document.querySelector("#itemMinutesInput").value);
    const kind = document.querySelector("#itemKindInput").value;
    const position = document.querySelector("#itemPositionInput").value;
    const points = document.querySelector("#itemPointsInput").value.split("\n").map((s) => s.trim()).filter(Boolean);
    const prereqs = [...event.target.querySelectorAll("[name=newPrereq]:checked")].map((input) => input.value);
    const optional = document.querySelector("#itemOptionalInput").checked;
    if (!title || !teacher || minutes <= 0) return;
    const item = RC.makeItem({
      title,
      teacher,
      minutes,
      points,
      prereqs,
      optional,
      kind,
      deferred: kind === "supplementary"
    });
    /* 先在副本上试插，确认不会形成循环前置再真正修改。 */
    const testItems = RC.clone(plan.items);
    if (kind === "inserted" && position) {
      const at = testItems.findIndex((o) => o.id === position);
      testItems.splice(at >= 0 ? at + 1 : testItems.length, 0, item);
    } else {
      testItems.push(item);
    }
    if (RC.detectCycle(testItems)) {
      ui.notice = "添加失败：该前置设置会形成循环前置。";
      renderAll();
      return;
    }
    mutateStructure(game, (p) => {
      if (kind === "inserted" && position) {
        const at = p.items.findIndex((o) => o.id === position);
        p.items.splice(at >= 0 ? at + 1 : p.items.length, 0, item);
      } else {
        p.items.push(item);
      }
      ui.notice = kind === "supplementary" ? `「${title}」已加入补讲区。` : `「${title}」已加入接力。`;
    }, `新增关卡「${title}」`);
    renderAll();
    return;
  }

  if (event.target.classList.contains("item-edit-form")) {
    event.preventDefault();
    const itemId = event.target.dataset.itemId;
    const form = event.target.elements;
    const next = {
      title: form.title.value.trim(),
      teacher: form.teacher.value,
      minutes: Number(form.minutes.value),
      kind: form.kind.value,
      points: form.points.value.split("\n").map((s) => s.trim()).filter(Boolean),
      prereqs: [...event.target.querySelectorAll("[name=prereq]:checked")].map((input) => input.value),
      optional: form.optional.checked
    };
    if (!next.title || next.minutes <= 0) return;
    /* 先在副本上验证不会形成循环前置。 */
    const testItems = RC.clone(plan.items);
    const testItem = testItems.find((o) => o.id === itemId);
    if (testItem) Object.assign(testItem, next);
    if (testItem && RC.detectCycle(testItems)) {
      ui.notice = "保存失败：该前置设置会形成循环前置。";
      renderAll();
      return;
    }
    mutateStructure(game, (p) => {
      const item = p.items.find((o) => o.id === itemId);
      if (!item) return;
      Object.assign(item, next);
      if (next.kind === "supplementary") item.deferred = true;
      ui.notice = `已保存「${next.title}」。`;
      ui.editFor = null;
    }, `编辑「${next.title}」`);
    renderAll();
    return;
  }

  if (event.target.classList.contains("skip-form")) {
    event.preventDefault();
    const itemId = event.target.dataset.itemId;
    const reason = event.target.elements.reason.value.trim();
    if (!reason) return;
    const item = game.relay.items.find((o) => o.id === itemId);
    if (item) {
      pushUndo(game.relay, `跳过「${item.title}」`);
      item.status = "skipped";
      item.skipReason = reason;
      ui.notice = `已跳过「${item.title}」（${reason}）。`;
      ui.skipFor = null;
    }
    renderAll();
    return;
  }
}

/* ================= 导入 / 导出 ================= */

function handleExport() {
  const payload = RC.exportPayload(state);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "桌游接力教练台-导出.json";
  link.click();
  URL.revokeObjectURL(link.href);
  ui.importReport = { ok: true, message: `已导出 ${state.games.length} 款桌游（含接力计划与草稿）。` };
  renderAll();
}

async function handleImport(file) {
  if (!file) return;
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    ui.importReport = { ok: false, errors: ["文件不是有效的 JSON，导入已取消，原数据未改动。"] };
    renderAll();
    return;
  }
  const result = RC.validateImport(payload);
  if (!result.ok) {
    ui.importReport = { ok: false, errors: result.errors };
  } else {
    state = result.value;
    state.games.forEach((game) => RC.normalizeGame(game));
    ui.editingDraft = false;
    ui.proposal = null;
    ui.diffFor = null;
    ui.mergeConfirm = null;
    ui.historyFor = null;
    ui.skipFor = null;
    ui.editFor = null;
    ui.importReport = { ok: true, message: `成功导入 ${state.games.length} 款桌游，接力计划与草稿已就位。` };
  }
  renderAll();
}

/* ================= 事件绑定 ================= */

els.searchInput.addEventListener("input", renderAll);
els.playerFilter.addEventListener("change", renderAll);
els.complexityFilter.addEventListener("change", renderAll);
els.sortMode.addEventListener("change", renderAll);
els.gameForm.addEventListener("submit", addGame);
els.exportBtn.addEventListener("click", handleExport);
els.importFile.addEventListener("change", (event) => {
  handleImport(event.target.files[0]);
  event.target.value = "";
});

els.importReport.addEventListener("click", (event) => {
  if (event.target.closest("#importReportClose")) {
    ui.importReport = null;
    renderAll();
  }
});

els.gameList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-game-id]");
  if (!card) return;
  state.selectedId = card.dataset.gameId;
  ui.editingDraft = false;
  ui.proposal = null;
  ui.diffFor = null;
  ui.mergeConfirm = null;
  ui.historyFor = null;
  ui.skipFor = null;
  ui.editFor = null;
  ui.notice = "";
  renderAll();
});

els.detailView.addEventListener("submit", (event) => {
  if (event.target.id !== "ruleForm") return;
  event.preventDefault();
  const game = currentGame();
  if (!game) return;
  const key = document.querySelector("#ruleTypeInput").value;
  const text = document.querySelector("#ruleTextInput").value.trim();
  if (!text) return;
  game[key].push(text);
  renderAll();
});

els.detailView.addEventListener("click", (event) => {
  const ruleButton = event.target.closest("[data-rule-key]");
  const playedButton = event.target.closest("#playedTodayBtn");
  const deleteButton = event.target.closest("#deleteGameBtn");
  const game = currentGame();
  if (!game) return;

  if (ruleButton) {
    const key = ruleButton.dataset.ruleKey;
    const index = Number(ruleButton.dataset.ruleIndex);
    game[key].splice(index, 1);
    renderAll();
  }

  if (playedButton) {
    game.lastPlayed = new Date().toISOString().slice(0, 10);
    renderAll();
  }

  if (deleteButton) {
    state.games = state.games.filter((item) => item.id !== game.id);
    state.selectedId = state.games[0]?.id || "";
    renderAll();
  }
});

els.relayPanel.addEventListener("click", handleRelayClick);
els.relayPanel.addEventListener("submit", handleRelaySubmit);
els.relayPanel.addEventListener("change", (event) => {
  if (event.target.id === "editorNameInput") {
    const name = event.target.value.trim();
    if (name) {
      state.editorName = name;
      ui.editingDraft = false;
      renderAll();
    }
  }
});

/* 其他标签页写入时同步本页状态（草稿、进度等即时可见）。 */
window.addEventListener("storage", (event) => {
  if (event.key !== storageKey || !event.newValue) return;
  if (event.newValue === lastWritten) return;
  state = loadState();
  state.games.forEach((game) => RC.normalizeGame(game));
  if (typeof state.editorName !== "string" || !state.editorName.trim()) state.editorName = "主理人";
  if (!state.games.some((game) => game.id === state.selectedId)) {
    state.selectedId = state.games[0]?.id || "";
  }
  baseline = RC.clone(state);
  lastWritten = event.newValue;
  renderAll();
});

setDefaultDate();
renderAll();
