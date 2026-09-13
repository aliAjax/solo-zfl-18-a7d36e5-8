/* 规则接力教练台 —— 纯逻辑层（无 DOM 依赖）。
   页面通过 window.RelayCore 使用；测试可在 Node 中 require。 */
(function (global) {
  "use strict";

  const KINDS = ["normal", "inserted", "supplementary"];
  const STATUSES = ["pending", "confirmed", "skipped"];
  const KIND_LABEL = { normal: "普通", inserted: "插讲", supplementary: "补讲" };

  function uid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  /* ---------- 关卡与计划结构 ---------- */

  function makeItem(fields) {
    return {
      id: fields.id || uid(),
      title: String(fields.title || ""),
      points: Array.isArray(fields.points) ? fields.points.map(String) : [],
      teacher: String(fields.teacher || ""),
      minutes: Number(fields.minutes) || 0,
      prereqs: Array.isArray(fields.prereqs) ? fields.prereqs.map(String) : [],
      optional: Boolean(fields.optional),
      locked: Boolean(fields.locked),
      deferred: Boolean(fields.deferred),
      kind: KINDS.includes(fields.kind) ? fields.kind : "normal",
      status: STATUSES.includes(fields.status) ? fields.status : "pending",
      skipReason: typeof fields.skipReason === "string" ? fields.skipReason : ""
    };
  }

  function emptyRelay() {
    return { budgetMinutes: 20, members: ["主理人"], items: [], undoStack: [] };
  }

  /* 从桌游的四类规则卡片生成默认接力计划（老数据迁移用）。 */
  function seedRelay(game) {
    const members = ["主理人", "助教"];
    const sections = [
      ["开局准备", game.setup, members[0], 5],
      ["易忘规则", game.forgets, members[0], 8],
      ["争议裁决", game.disputes, members[1], 5],
      ["计分与结束", game.scoring, members[1], 5]
    ].filter(([, points]) => Array.isArray(points) && points.length);
    const items = [];
    sections.forEach(([title, points, teacher, minutes]) => {
      items.push(
        makeItem({
          title,
          points: [...points],
          teacher,
          minutes,
          prereqs: items.length ? [items[items.length - 1].id] : []
        })
      );
    });
    const budget = items.reduce((sum, item) => sum + item.minutes, 0) + 5;
    return { budgetMinutes: budget, members, items, undoStack: [] };
  }

  /* 兼容旧存档：补齐 relay / drafts 结构。 */
  function normalizeGame(game) {
    if (!game.relay || typeof game.relay !== "object" || !Array.isArray(game.relay.items)) {
      game.relay = seedRelay(game);
    }
    const relay = game.relay;
    if (!Array.isArray(relay.members) || !relay.members.length) relay.members = ["主理人"];
    if (!Number.isFinite(Number(relay.budgetMinutes)) || relay.budgetMinutes <= 0) relay.budgetMinutes = 20;
    if (!Array.isArray(relay.undoStack)) relay.undoStack = [];
    relay.items = relay.items.map((item) => makeItem(item));
    if (!game.drafts || typeof game.drafts !== "object") game.drafts = {};
    Object.keys(game.drafts).forEach((owner) => {
      const draft = game.drafts[owner];
      if (!draft || typeof draft !== "object") {
        delete game.drafts[owner];
        return;
      }
      draft.items = Array.isArray(draft.items) ? draft.items.map((item) => makeItem(item)) : [];
      if (!Array.isArray(draft.members) || !draft.members.length) draft.members = [...relay.members];
      if (!Number.isFinite(Number(draft.budgetMinutes)) || draft.budgetMinutes <= 0) {
        draft.budgetMinutes = relay.budgetMinutes;
      }
      if (!Array.isArray(draft.history)) draft.history = [];
    });
    return game;
  }

  /* ---------- 解锁与进度 ---------- */

  /* 已确认、已跳过、已转补讲都视为“已了结”，不再阻塞后续关卡。 */
  function isResolved(item) {
    return item.status === "confirmed" || item.status === "skipped" || item.deferred;
  }

  /* 计算每个关卡的解锁状态与阻塞来源。 */
  function analyze(relay) {
    const byId = new Map(relay.items.map((item) => [item.id, item]));
    const unlock = new Map();
    relay.items.forEach((item) => {
      const blockers = [];
      item.prereqs.forEach((pid) => {
        const pre = byId.get(pid);
        if (!pre) {
          blockers.push("（前置已缺失）");
        } else if (!isResolved(pre)) {
          blockers.push(pre.title);
        }
      });
      unlock.set(item.id, { unlocked: blockers.length === 0, blockers });
    });
    const active = relay.items.filter((item) => item.status !== "skipped" && !item.deferred);
    const usedMinutes = active.reduce((sum, item) => sum + item.minutes, 0);
    return {
      unlock,
      total: relay.items.length,
      confirmed: relay.items.filter((item) => item.status === "confirmed").length,
      skipped: relay.items.filter((item) => item.status === "skipped").length,
      deferred: relay.items.filter((item) => item.deferred && item.status === "pending").length,
      teachable: relay.items.filter(
        (item) => item.status === "pending" && !item.deferred && unlock.get(item.id).unlocked
      ).length,
      usedMinutes
    };
  }

  /* ---------- 图算法 ---------- */

  /* 检测前置关卡循环，返回构成环的关卡 id 数组（无环返回 null）。 */
  function detectCycle(items) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const mark = new Map(); // 1=在栈中 2=已完成
    const stack = [];
    let cycle = null;
    function dfs(id) {
      if (cycle) return;
      mark.set(id, 1);
      stack.push(id);
      for (const pid of byId.get(id).prereqs) {
        if (!byId.has(pid)) continue;
        const state = mark.get(pid) || 0;
        if (state === 0) {
          dfs(pid);
        } else if (state === 1) {
          cycle = stack.slice(stack.indexOf(pid)).concat(pid);
          return;
        }
      }
      stack.pop();
      mark.set(id, 2);
    }
    for (const item of items) {
      if (cycle) break;
      if (!mark.get(item.id)) dfs(item.id);
    }
    return cycle;
  }

  /* 未确认关卡按前置依赖拓扑排序（同级保持原顺序）。 */
  function topoSortMovable(movableItems) {
    const inList = new Map(movableItems.map((item, index) => [item.id, { item, index }]));
    const indegree = new Map(movableItems.map((item) => [item.id, 0]));
    movableItems.forEach((item) => {
      item.prereqs.forEach((pid) => {
        if (inList.has(pid)) indegree.set(item.id, indegree.get(item.id) + 1);
      });
    });
    const ready = movableItems.filter((item) => indegree.get(item.id) === 0);
    const ordered = [];
    while (ready.length) {
      ready.sort((a, b) => inList.get(a.id).index - inList.get(b.id).index);
      const next = ready.shift();
      ordered.push(next);
      movableItems.forEach((item) => {
        if (item.prereqs.includes(next.id)) {
          indegree.set(item.id, indegree.get(item.id) - 1);
          if (indegree.get(item.id) === 0) ready.push(item);
        }
      });
    }
    /* 有环时把剩余项按原顺序追加，保证不死循环（导入校验会拦环，这里兜底）。 */
    movableItems.forEach((item) => {
      if (!ordered.includes(item)) ordered.push(item);
    });
    return ordered;
  }

  /* ---------- 重排（换人 / 压缩时间） ---------- */

  /* 只重排未确认且未锁定的关卡；已确认、已跳过、锁定项原地不动。
     超预算时：可选关卡建议跳过，必讲关卡转入补讲区，保证给出可行方案。 */
  function buildReplan(relay, options) {
    const newBudget = Number(options && options.budget) > 0 ? Number(options.budget) : relay.budgetMinutes;
    const teacherMap = (options && options.teacherMap) || {};
    const items = relay.items;
    const fixedIdx = new Set();
    const movable = [];
    items.forEach((item, index) => {
      if (item.locked || item.status !== "pending") {
        fixedIdx.add(index);
      } else {
        movable.push({ ...item, teacher: teacherMap[item.teacher] || item.teacher });
      }
    });

    const ordered = topoSortMovable(movable);
    const fixedTime = items.reduce(
      (sum, item, index) =>
        fixedIdx.has(index) && item.status !== "skipped" && !item.deferred ? sum + item.minutes : sum,
      0
    );
    let remaining = newBudget - fixedTime;
    const keep = [];
    const toSkip = [];
    const toDefer = [];
    ordered.forEach((item) => {
      if (item.deferred) {
        toDefer.push(item);
      } else if (item.minutes <= remaining) {
        keep.push(item);
        remaining -= item.minutes;
      } else if (item.optional) {
        toSkip.push({ ...item, status: "skipped", skipReason: "压缩时间：预算不足，按可选项跳过" });
      } else {
        toDefer.push({ ...item, deferred: true });
      }
    });

    const fill = [...keep, ...toSkip, ...toDefer];
    const newItems = items.map((item, index) => (fixedIdx.has(index) ? item : fill.shift()));
    const changes = [];
    Object.keys(teacherMap).forEach((from) => {
      const moved = movable.filter((item) => items.find((o) => o.id === item.id && o.teacher === from));
      if (moved.length) changes.push(`将 ${from} 的 ${moved.length} 个未确认关卡交给 ${teacherMap[from]}`);
    });
    const keptTitles = keep.map((item) => item.title);
    if (keptTitles.length) changes.push(`未确认关卡重排为：${keptTitles.join(" → ")}`);
    toSkip.forEach((item) => changes.push(`建议跳过「${item.title}」（可选，省 ${item.minutes} 分钟）`));
    toDefer.forEach((item) => {
      const wasDeferred = items.find((o) => o.id === item.id)?.deferred;
      if (!wasDeferred) changes.push(`「${item.title}」必讲但超预算，转入补讲区`);
    });
    const warnings = [];
    if (fixedTime > newBudget) {
      warnings.push(
        `已确认/锁定关卡已占 ${fixedTime} 分钟，超出预算 ${fixedTime - newBudget} 分钟；其余关卡已全部转出，建议提高预算或调整锁定。`
      );
    }
    const usedMinutes = fixedTime + keep.reduce((sum, item) => sum + item.minutes, 0);
    return {
      budget: newBudget,
      fixedTime,
      usedMinutes,
      keep,
      toSkip,
      toDefer,
      changes,
      warnings,
      newItems
    };
  }

  /* ---------- 草稿：比较 / 合并 ---------- */

  function diffPlans(live, draft) {
    const liveById = new Map(live.items.map((item) => [item.id, item]));
    const draftById = new Map(draft.items.map((item) => [item.id, item]));
    const added = draft.items.filter((item) => !liveById.has(item.id));
    const removed = live.items.filter((item) => !draftById.has(item.id));
    const changed = [];
    draft.items.forEach((d) => {
      const l = liveById.get(d.id);
      if (!l) return;
      const fields = [];
      if (l.title !== d.title) fields.push(`标题「${l.title}」→「${d.title}」`);
      if (l.teacher !== d.teacher) fields.push(`讲解人 ${l.teacher || "（空）"} → ${d.teacher || "（空）"}`);
      if (l.minutes !== d.minutes) fields.push(`时长 ${l.minutes} → ${d.minutes} 分钟`);
      if (JSON.stringify(l.prereqs) !== JSON.stringify(d.prereqs)) fields.push("前置关卡调整");
      if (JSON.stringify(l.points) !== JSON.stringify(d.points)) fields.push("必讲点调整");
      if (l.optional !== d.optional) fields.push(d.optional ? "改为可选" : "改为必讲");
      if (l.kind !== d.kind) fields.push(`类型 ${KIND_LABEL[l.kind]} → ${KIND_LABEL[d.kind]}`);
      if (l.deferred !== d.deferred) fields.push(d.deferred ? "转入补讲区" : "移回主流程");
      if (fields.length) changed.push({ id: d.id, title: d.title || l.title, fields });
    });
    const liveOrder = live.items.map((item) => item.id).filter((id) => draftById.has(id));
    const draftOrder = draft.items.map((item) => item.id).filter((id) => liveById.has(id));
    return {
      added,
      removed,
      changed,
      orderChanged: JSON.stringify(liveOrder) !== JSON.stringify(draftOrder),
      budgetChanged: live.budgetMinutes !== draft.budgetMinutes,
      liveBudget: live.budgetMinutes,
      draftBudget: draft.budgetMinutes,
      membersAdded: draft.members.filter((m) => !live.members.includes(m)),
      membersRemoved: live.members.filter((m) => !draft.members.includes(m))
    };
  }

  /* 合并草稿到正式计划：草稿提供结构，正式计划保留进度（确认/跳过）与锁定。
     草稿删掉但正式计划已确认/跳过的关卡会被保留，绝不静默丢进度。 */
  function mergePlans(live, draft) {
    const liveById = new Map(live.items.map((item) => [item.id, item]));
    const draftIds = new Set(draft.items.map((item) => item.id));
    const warnings = [];
    const merged = draft.items.map((d) => {
      const l = liveById.get(d.id);
      if (!l) return { ...d, status: "pending", skipReason: "" };
      return {
        ...d,
        status: l.status,
        skipReason: l.skipReason,
        locked: l.locked,
        deferred: l.deferred
      };
    });
    live.items.forEach((l, index) => {
      if (draftIds.has(l.id)) return;
      if (l.status !== "pending" || l.locked) {
        merged.splice(Math.min(index, merged.length), 0, { ...l });
        warnings.push(`「${l.title}」在正式计划中已确认/锁定，已自动保留`);
      }
    });
    return {
      items: merged,
      budgetMinutes: draft.budgetMinutes,
      members: [...draft.members],
      warnings
    };
  }

  /* ---------- 导入校验（整单失败不改原数据） ---------- */

  function validateItems(items, members, label, errors) {
    const seenIds = new Map();
    const seenTitles = new Map();
    items.forEach((item, index) => {
      const name = item && item.title ? `「${item.title}」` : `第 ${index + 1} 关`;
      if (!item || typeof item !== "object") {
        errors.push(`${label}第 ${index + 1} 关数据不是有效对象`);
        return;
      }
      if (!item.title || !String(item.title).trim()) errors.push(`${label}第 ${index + 1} 关缺少标题`);
      if (item.id) {
        if (seenIds.has(item.id)) errors.push(`${label}重复关卡：id「${item.id}」被「${seenIds.get(item.id)}」和${name}同时使用`);
        seenIds.set(item.id, item.title || name);
      }
      if (item.title) {
        const count = (seenTitles.get(item.title) || 0) + 1;
        seenTitles.set(item.title, count);
        if (count === 2) errors.push(`${label}重复关卡：「${item.title}」出现多次`);
      }
      if (!item.teacher || !String(item.teacher).trim()) {
        errors.push(`${label}缺失讲解人：关卡${name}未指定讲解人`);
      } else if (!members.includes(item.teacher)) {
        errors.push(`${label}缺失讲解人：关卡${name}的讲解人「${item.teacher}」不在讲解人名单中`);
      }
      if (!Number.isFinite(Number(item.minutes)) || Number(item.minutes) <= 0) {
        errors.push(`${label}时间冲突：关卡${name}的时长必须为正数`);
      }
      if (!Array.isArray(item.prereqs || [])) {
        errors.push(`${label}关卡${name}的前置关卡格式不正确`);
      }
    });
    const ids = new Set(items.map((item) => item && item.id).filter(Boolean));
    items.forEach((item) => {
      if (!item || !Array.isArray(item.prereqs)) return;
      item.prereqs.forEach((pid) => {
        if (!ids.has(pid)) {
          errors.push(`${label}失效引用：关卡「${item.title || item.id}」的前置关卡「${pid}」不存在`);
        }
      });
    });
    const normalized = items.map((item) => makeItem(item));
    const cycle = detectCycle(normalized);
    if (cycle) {
      const byId = new Map(normalized.map((item) => [item.id, item]));
      const path = cycle.map((id) => `「${byId.get(id)?.title || id}」`).join(" → ");
      errors.push(`${label}循环前置：${path}`);
    }
    return normalized;
  }

  function validateGame(game, index, errors) {
    const label = game && game.name ? `「${game.name}」` : `第 ${index + 1} 款桌游`;
    if (!game || typeof game !== "object") {
      errors.push(`第 ${index + 1} 款桌游数据不是有效对象`);
      return null;
    }
    if (!game.name || !String(game.name).trim()) errors.push(`第 ${index + 1} 款桌游缺少名称`);
    ["minPlayers", "maxPlayers", "duration"].forEach((field) => {
      if (!Number.isFinite(Number(game[field])) || Number(game[field]) <= 0) {
        errors.push(`${label}的 ${field} 必须为正数`);
      }
    });
    ["forgets", "disputes", "setup", "scoring"].forEach((field) => {
      if (game[field] !== undefined && !Array.isArray(game[field])) {
        errors.push(`${label}的规则字段 ${field} 必须是数组`);
      }
    });
    const normalized = {
      id: game.id || uid(),
      name: String(game.name || "").trim(),
      minPlayers: Number(game.minPlayers) || 2,
      maxPlayers: Number(game.maxPlayers) || 4,
      duration: Number(game.duration) || 60,
      complexity: ["轻", "中", "重"].includes(game.complexity) ? game.complexity : "中",
      lastPlayed: typeof game.lastPlayed === "string" ? game.lastPlayed : "2026-01-01",
      cover: typeof game.cover === "string" ? game.cover : "",
      forgets: Array.isArray(game.forgets) ? game.forgets.map(String) : [],
      disputes: Array.isArray(game.disputes) ? game.disputes.map(String) : [],
      setup: Array.isArray(game.setup) ? game.setup.map(String) : [],
      scoring: Array.isArray(game.scoring) ? game.scoring.map(String) : [],
      relay: null,
      drafts: {}
    };
    if (game.relay !== undefined) {
      const relay = game.relay;
      if (!relay || typeof relay !== "object") {
        errors.push(`${label}的接力计划格式不正确`);
      } else {
        if (!Array.isArray(relay.members) || !relay.members.length || relay.members.some((m) => !m || !String(m).trim())) {
          errors.push(`${label}缺失讲解人名单（members 必须是非空数组）`);
        }
        const members = Array.isArray(relay.members) ? relay.members.map(String) : [];
        if (!Number.isFinite(Number(relay.budgetMinutes)) || Number(relay.budgetMinutes) <= 0) {
          errors.push(`${label}时间冲突：讲解预算必须为正数`);
        }
        if (!Array.isArray(relay.items)) {
          errors.push(`${label}的接力关卡 items 必须是数组`);
        } else {
          const items = validateItems(relay.items, members, `${label}接力计划：`, errors);
          const active = items.filter((item) => item.status !== "skipped" && !item.deferred);
          const total = active.reduce((sum, item) => sum + item.minutes, 0);
          if (Number(relay.budgetMinutes) > 0 && total > Number(relay.budgetMinutes)) {
            errors.push(`${label}时间冲突：预计讲解 ${total} 分钟，超过预算 ${relay.budgetMinutes} 分钟`);
          }
          normalized.relay = {
            budgetMinutes: Number(relay.budgetMinutes) || 20,
            members,
            items,
            undoStack: []
          };
        }
      }
    }
    if (game.drafts !== undefined) {
      if (!game.drafts || typeof game.drafts !== "object" || Array.isArray(game.drafts)) {
        errors.push(`${label}的草稿 drafts 必须是对象`);
      } else {
        Object.entries(game.drafts).forEach(([owner, draft]) => {
          if (!draft || typeof draft !== "object" || !Array.isArray(draft.items)) {
            errors.push(`${label}「${owner}」的草稿格式不正确`);
            return;
          }
          const members = Array.isArray(draft.members) && draft.members.length
            ? draft.members.map(String)
            : normalized.relay
              ? normalized.relay.members
              : [];
          const items = validateItems(draft.items, members, `${label}「${owner}」的草稿：`, errors);
          normalized.drafts[owner] = {
            items,
            members,
            budgetMinutes: Number(draft.budgetMinutes) > 0 ? Number(draft.budgetMinutes) : (normalized.relay?.budgetMinutes || 20),
            updatedAt: typeof draft.updatedAt === "string" ? draft.updatedAt : "",
            history: []
          };
        });
      }
    }
    return normalized;
  }

  /* 校验整个导入文件。任何错误都整单拒绝，调用方保证不写原数据。 */
  function validateImport(payload) {
    const errors = [];
    const root = payload && typeof payload === "object" && payload.state ? payload.state : payload;
    if (!root || typeof root !== "object" || !Array.isArray(root.games)) {
      return { ok: false, errors: ["文件格式不正确：未找到 games 数组"] };
    }
    if (!root.games.length) errors.push("导入内容为空：games 数组没有桌游");
    const games = root.games.map((game, index) => validateGame(game, index, errors)).filter(Boolean);
    if (errors.length) return { ok: false, errors };
    games.forEach((game) => {
      if (!game.relay) game.relay = seedRelay(game);
    });
    const selectedId = games.some((game) => game.id === root.selectedId)
      ? root.selectedId
      : games[0]?.id || "";
    return {
      ok: true,
      value: {
        selectedId,
        editorName: typeof root.editorName === "string" && root.editorName.trim() ? root.editorName : "主理人",
        games
      }
    };
  }

  function exportPayload(state) {
    return {
      app: "boardgame-relay-coach",
      version: 2,
      exportedAt: new Date().toISOString(),
      state
    };
  }

  const RelayCore = {
    KIND_LABEL,
    uid,
    clone,
    makeItem,
    emptyRelay,
    seedRelay,
    normalizeGame,
    isResolved,
    analyze,
    detectCycle,
    topoSortMovable,
    buildReplan,
    diffPlans,
    mergePlans,
    validateImport,
    exportPayload
  };

  if (typeof module !== "undefined" && module.exports) module.exports = RelayCore;
  global.RelayCore = RelayCore;
})(typeof window !== "undefined" ? window : globalThis);
