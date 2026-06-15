const STORAGE_KEY = "batch-tracking-tool-v1";
const THEME_KEY = "batch-tracking-theme-v1";
const EMS_PLACEHOLDER = "#ems_number#";
const CLOUD_SQL = `create table if not exists public.tracking_tool_state (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.tracking_tool_state enable row level security;

grant select, insert, update on public.tracking_tool_state to anon;
grant select, insert, update on public.tracking_tool_state to authenticated;

drop policy if exists "tracking_tool_state_read" on public.tracking_tool_state;
drop policy if exists "tracking_tool_state_insert" on public.tracking_tool_state;
drop policy if exists "tracking_tool_state_update" on public.tracking_tool_state;

create policy "tracking_tool_state_read"
on public.tracking_tool_state for select
using (true);

create policy "tracking_tool_state_insert"
on public.tracking_tool_state for insert
with check (true);

create policy "tracking_tool_state_update"
on public.tracking_tool_state for update
using (true)
with check (true);`;

const defaultStages = [
  { key: "info", name: "信息收到", type: "普通", template: "CHINA: Shipment Information Received" },
  { key: "origin", name: "中国仓处理", type: "普通", template: "CHINA: Processed at origin facility" },
  { key: "inspect", name: "检查核验", type: "普通", template: "CHINA: 检验检查中" },
  { key: "customs-send", name: "送交清关", type: "送交清关", template: "CHINA: 送交海关，等待清关，中国邮政单号{ems}" },
  { key: "flight-ready", name: "等待航班", type: "普通", template: "{destination}: 到达机场，等待航班" },
  { key: "flight-departed", name: "航班起飞", type: "普通", template: "CHINA: Flight departed" },
  { key: "flight-arrived", name: "到达目的国", type: "普通", template: "{destination}: Flight arrived，Customs clearance in progress" },
  { key: "local-carrier", name: "交本地承运商", type: "普通", template: "{destination}: Handover to local courier" },
  { key: "delivery", name: "派送中", type: "派送", template: "{destination}: In transit to next facility" },
  { key: "signed", name: "已签收", type: "签收", template: "{destination}: Delivered" },
  { key: "exception", name: "异常", type: "异常", template: "{destination}: Delivery exception, waiting for further processing" },
];

let state = loadState();
let selectedBatchId = state.batches[0]?.id ?? null;
let pendingMerge = null;
let draggedBatchId = null;
let cloudConfig = null;
let isApplyingRemote = false;
let cloudSaveTimer = null;
let lastCloudVersion = "";
let cloudSaveInFlight = false;
let needsCloudSyncAfterFlight = false;
let localRevision = 0;
let lastSyncedRevision = 0;
let lastLocalChangeAt = 0;
let editingEventId = null;
let localSaveTimer = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const stageSelects = ["#batch-stage", "#detail-stage"];
const elements = {
  batchForm: $("#batch-form"),
  batchName: $("#batch-name"),
  batchCount: $("#batch-count"),
  batchDestination: $("#batch-destination"),
  batchStage: $("#batch-stage"),
  batchTime: $("#batch-time"),
  batchNumbers: $("#batch-numbers"),
  batchList: $("#batch-list"),
  detail: $("#batch-detail"),
  emptyDetail: $("#empty-detail"),
  detailName: $("#detail-name"),
  detailNameInput: $("#detail-name-input"),
  detailMeta: $("#detail-meta"),
  detailStage: $("#detail-stage"),
  detailTime: $("#detail-time"),
  detailType: $("#detail-type"),
  eventContent: $("#event-content"),
  timeline: $("#timeline"),
  pushOutput: $("#push-output"),
  numberCount: $("#number-count"),
  detailNumbers: $("#detail-numbers"),
  searchInput: $("#search-input"),
  templateList: $("#template-list"),
  importArea: $("#import-area"),
  jsonArea: $("#json-area"),
  trashList: $("#trash-list"),
  backupList: $("#backup-list"),
  themeToggle: $("#theme-toggle"),
  cloudStatus: $("#cloud-status"),
  mergeModal: $("#merge-modal"),
  mergeSummary: $("#merge-summary"),
  mergeSourceName: $("#merge-source-name"),
  mergeSourceMeta: $("#merge-source-meta"),
  mergeTargetName: $("#merge-target-name"),
  mergeTargetMeta: $("#merge-target-meta"),
  mergeWarning: $("#merge-warning"),
  toast: $("#toast"),
};

loadOptionalCloudConfig().finally(() => {
  cloudConfig = loadCloudConfig();
  boot();
});

function loadOptionalCloudConfig() {
  if (window.TRACKING_CLOUD_CONFIG?.url && window.TRACKING_CLOUD_CONFIG?.key) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "config.js";
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.head.append(script);
  });
}

function boot() {
  initTheme();
  fillStageSelects();
  updateBatchCountFromNumbers();
  elements.batchTime.value = toInputDateTime(new Date());
  bindEvents();
  render();
  startCloudSync();
}

function bindEvents() {
  elements.batchForm.addEventListener("submit", addBatch);
  elements.searchInput.addEventListener("input", renderBatchList);
  elements.batchNumbers.addEventListener("input", updateBatchCountFromNumbers);
  elements.batchStage.addEventListener("change", () => {
    const stage = getStage(elements.batchStage.value);
    elements.batchDestination.value ||= "US";
    elements.batchTime.value ||= toInputDateTime(new Date());
    if (stage) {
      showToast(`默认模板：${stage.template}`);
    }
  });

  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });

  $("#add-event-btn").addEventListener("click", addEventToSelectedBatch);
  $("#mark-pushed-btn").addEventListener("click", markSelectedBatchPushed);
  $("#copy-push-btn").addEventListener("click", copyPushOutput);
  $("#save-numbers-btn").addEventListener("click", saveDetailNumbers);
  $("#save-batch-name-btn").addEventListener("click", saveSelectedBatchName);
  $("#delete-batch-btn").addEventListener("click", deleteSelectedBatch);
  $("#duplicate-batch-btn").addEventListener("click", duplicateSelectedBatch);
  $("#split-batch-btn").addEventListener("click", splitSelectedBatch);
  $("#export-csv-btn").addEventListener("click", downloadCsv);
  $("#add-template-btn").addEventListener("click", addTemplate);
  $("#import-btn").addEventListener("click", importCsv);
  $("#download-json-btn").addEventListener("click", downloadJson);
  $("#copy-json-btn").addEventListener("click", copyJson);
  $("#restore-json-btn").addEventListener("click", restoreJson);
  $("#reset-demo-btn").addEventListener("click", resetDemo);
  $("#create-backup-btn").addEventListener("click", () => {
    createBackup("手动快照");
    saveState();
    render();
    showToast("快照已保存");
  });
  $("#theme-toggle").addEventListener("click", toggleTheme);
  $("#cancel-merge-btn").addEventListener("click", closeMergeModal);
  $("#confirm-merge-btn").addEventListener("click", confirmMergeBatches);
  elements.mergeModal.addEventListener("click", (event) => {
    if (event.target === elements.mergeModal) closeMergeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.mergeModal.hidden) closeMergeModal();
  });
  elements.detailStage.addEventListener("change", syncEventEditorFromStage);
  elements.detailTime.addEventListener("change", syncEventEditorFromStage);
  elements.detailNumbers.addEventListener("input", updateSelectedBatchNumbersFromTextarea);
  elements.detailNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveSelectedBatchName();
    }
  });
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    return normalizeState({
      stages: structuredClone(defaultStages),
      batches: [],
    });
  }

  try {
    const parsed = JSON.parse(saved);
    return normalizeState(parsed);
  } catch {
    return normalizeState({
      stages: structuredClone(defaultStages),
      batches: [],
    });
  }
}

function saveState() {
  localRevision += 1;
  lastLocalChangeAt = Date.now();
  state.batches.forEach(syncBatchDerivedFields);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  queueCloudSync();
}

function queueSaveState() {
  clearTimeout(localSaveTimer);
  localSaveTimer = setTimeout(saveState, 900);
}

function render() {
  fillStageSelects();
  renderStats();
  renderBatchList();
  renderDetail();
  renderTemplates();
  renderSafety();
}

function fillStageSelects() {
  stageSelects.forEach((selector) => {
    const select = $(selector);
    const value = select.value;
    select.innerHTML = state.stages
      .map((stage) => `<option value="${escapeAttr(stage.key)}">${escapeHtml(stage.name)}</option>`)
      .join("");
    if (value && state.stages.some((stage) => stage.key === value)) {
      select.value = value;
    }
  });
}

function renderStats() {
  $("#stat-total").textContent = state.batches.length;
  $("#stat-orders").textContent = state.batches.reduce((total, batch) => total + getBatchTicketCount(batch), 0).toLocaleString("zh-CN");
  $("#stat-pending").textContent = state.batches
    .reduce((total, batch) => total + batch.events.filter((event) => !event.pushed).length, 0)
    .toLocaleString("zh-CN");
}

function renderBatchList() {
  const query = elements.searchInput.value.trim().toLowerCase();
  const batches = state.batches.filter((batch) => {
    const text = [
      batch.name,
      batch.destination,
      getStage(batch.stageKey)?.name,
      batch.numbers.join(" "),
      batch.events.map((event) => event.content).join(" "),
    ]
      .join(" ")
      .toLowerCase();
    return !query || text.includes(query);
  });

  if (!batches.length) {
    elements.batchList.innerHTML = `<div class="empty-state"><p>没有匹配批次</p></div>`;
    return;
  }

  elements.batchList.innerHTML = batches
    .sort((a, b) => newestTime(b).localeCompare(newestTime(a)))
    .map((batch) => {
      const stage = getStage(batch.stageKey);
      const latest = latestEvent(batch);
      const pending = batch.events.filter((event) => !event.pushed).length;
      return `
        <button class="batch-card ${batch.id === selectedBatchId ? "active" : ""}" type="button" draggable="true" data-batch-id="${escapeAttr(batch.id)}" title="可拖动到另一个批次上合并">
          <strong>${escapeHtml(batch.name)}</strong>
          <div class="badge-row">
            <span class="badge">${escapeHtml(stage?.name ?? "未设置")}</span>
            <span class="badge">${getBatchTicketCount(batch).toLocaleString("zh-CN")} 票</span>
            <span class="badge ${pending ? "warn" : "ok"}">${pending ? `${pending} 条待推送` : "已推送"}</span>
          </div>
          <p class="batch-latest">最新状态：${escapeHtml(latest?.content ?? "暂无轨迹")} · ${latest ? (latest.pushed ? "已推送" : "待推送") : "未推送"}</p>
          <p>${escapeHtml(batch.destination || "未填目的地")} · 最新 ${formatDisplayTime(newestTime(batch))}</p>
        </button>
      `;
    })
    .join("");

  $$(".batch-card").forEach((card) => {
    card.addEventListener("click", () => {
      selectedBatchId = card.dataset.batchId;
      render();
    });
    card.addEventListener("dragstart", handleBatchDragStart);
    card.addEventListener("dragend", handleBatchDragEnd);
    card.addEventListener("dragover", handleBatchDragOver);
    card.addEventListener("dragleave", handleBatchDragLeave);
    card.addEventListener("drop", handleBatchDrop);
  });
}

function renderDetail() {
  const batch = getSelectedBatch();
  elements.emptyDetail.hidden = Boolean(batch);
  elements.detail.hidden = !batch;

  if (!batch) {
    return;
  }

  const stage = getStage(batch.stageKey);
  elements.detailName.textContent = batch.name;
  elements.detailNameInput.value = batch.name;
  elements.detailMeta.textContent = `${getBatchTicketCount(batch).toLocaleString("zh-CN")} 票 · ${batch.destination || "未填目的地"} · 当前节点：${stage?.name ?? "未设置"}`;
  elements.detailStage.value = batch.stageKey;
  elements.detailTime.value = toInputDateTime(newestTime(batch));
  elements.detailType.value = stage?.type ?? "普通";
  elements.eventContent.value = renderTemplate(stage?.template ?? "", batch);
  elements.numberCount.textContent = getBatchTicketCount(batch).toLocaleString("zh-CN");
  elements.detailNumbers.value = batch.numbers.join("\n");

  renderTimeline(batch);
  renderPushOutput(batch);
}

function renderTimeline(batch) {
  const events = [...batch.events].sort((a, b) => b.time.localeCompare(a.time));
  if (!events.length) {
    elements.timeline.innerHTML = `<div class="empty-state"><p>还没有轨迹，选择节点后加入轨迹</p></div>`;
    return;
  }

  elements.timeline.innerHTML = events
    .map(
      (event) => {
        if (event.id === editingEventId) {
          return `
      <article class="timeline-item editing">
        <time>${formatDisplayTime(event.time)}</time>
        <div class="timeline-edit-form" data-event-id="${escapeAttr(event.id)}">
          <label>
            节点
            <select data-field="stageKey">${renderStageOptions(event.stageKey)}</select>
          </label>
          <label>
            时间
            <input data-field="time" type="datetime-local" value="${escapeAttr(toInputDateTime(event.time))}" />
          </label>
          <label>
            类型
            <select data-field="type">${renderTypeOptions(event.type || "普通")}</select>
          </label>
          <label class="timeline-edit-content">
            内容
            <textarea data-field="content" rows="3">${escapeHtml(event.content)}</textarea>
          </label>
        </div>
        <div class="timeline-actions">
          <button class="mini-button" type="button" data-action="save-edit" data-event-id="${escapeAttr(event.id)}">保存</button>
          <button class="mini-button" type="button" data-action="cancel-edit" data-event-id="${escapeAttr(event.id)}">取消</button>
        </div>
      </article>
    `;
        }

        return `
      <article class="timeline-item">
        <time>${formatDisplayTime(event.time)}</time>
        <p>
          <strong>${escapeHtml(getStage(event.stageKey)?.name ?? event.stageKey)}</strong>
          <br />
          ${escapeHtml(event.content)}
          <span class="badge ${event.pushed ? "ok" : "warn"}">${event.pushed ? "已推送" : "待推送"}</span>
        </p>
        <div class="timeline-actions">
          <button class="mini-button" type="button" data-action="edit" data-event-id="${escapeAttr(event.id)}">编辑</button>
          <button class="mini-button" type="button" data-action="toggle" data-event-id="${escapeAttr(event.id)}">${event.pushed ? "撤回" : "已推"}</button>
          <button class="mini-button" type="button" data-action="remove" data-event-id="${escapeAttr(event.id)}">删</button>
        </div>
      </article>
    `
      }
    )
    .join("");

  $$(".timeline-actions button").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.action === "toggle") {
        toggleEventPushed(batch.id, button.dataset.eventId);
      } else if (button.dataset.action === "remove") {
        removeEvent(batch.id, button.dataset.eventId);
      } else if (button.dataset.action === "edit") {
        editingEventId = button.dataset.eventId;
        renderTimeline(batch);
      } else if (button.dataset.action === "cancel-edit") {
        editingEventId = null;
        renderTimeline(batch);
      } else if (button.dataset.action === "save-edit") {
        saveEventEdit(batch.id, button.dataset.eventId);
      }
    });
  });
}

function renderPushOutput(batch) {
  const source = [...batch.events].sort((a, b) => a.time.localeCompare(b.time));
  elements.pushOutput.value = source
    .map((event) => `${formatSystemTime(event.time)}\t${event.content}\t${event.type || "普通"}`)
    .join("\n");
}

function renderStageOptions(selectedKey) {
  return state.stages
    .map((stage) => `<option value="${escapeAttr(stage.key)}" ${stage.key === selectedKey ? "selected" : ""}>${escapeHtml(stage.name)}</option>`)
    .join("");
}

function renderTypeOptions(selectedType) {
  return ["普通", "送交清关", "派送", "签收", "异常"]
    .map((type) => `<option value="${escapeAttr(type)}" ${type === selectedType ? "selected" : ""}>${escapeHtml(type)}</option>`)
    .join("");
}

function renderTemplates() {
  elements.templateList.innerHTML = state.stages
    .map(
      (stage) => `
      <div class="template-row" data-stage-key="${escapeAttr(stage.key)}">
        <label>
          节点名称
          <input data-field="name" value="${escapeAttr(stage.name)}" />
        </label>
        <label>
          文案模板
          <input data-field="template" value="${escapeAttr(stage.template)}" />
        </label>
        <label>
          类型
          <select data-field="type">
            ${["普通", "送交清关", "派送", "签收", "异常"].map((type) => `<option value="${type}" ${stage.type === type ? "selected" : ""}>${type}</option>`).join("")}
          </select>
        </label>
        <button class="mini-button" type="button" data-action="remove-template">删除</button>
      </div>
    `
    )
    .join("");

  $$(".template-row").forEach((row) => {
    row.querySelectorAll("input, select").forEach((input) => {
      input.addEventListener("change", () => updateTemplate(row.dataset.stageKey, input.dataset.field, input.value));
    });
    row.querySelector("[data-action='remove-template']").addEventListener("click", () => removeTemplate(row.dataset.stageKey));
  });
}

function renderSafety() {
  if (!elements.trashList || !elements.backupList) return;

  state = normalizeState(state);
  const trashedBatches = state.trash.batches || [];
  elements.trashList.innerHTML = trashedBatches.length
    ? trashedBatches
        .map(
          (item) => `
          <article class="safety-item">
            <div>
              <strong>${escapeHtml(item.data.name)}</strong>
              <p>${getBatchTicketCount(item.data).toLocaleString("zh-CN")} 票 · 删除于 ${formatDisplayTime(item.deletedAt)}</p>
            </div>
            <div class="safety-actions">
              <button class="mini-button" type="button" data-action="restore-batch" data-trash-id="${escapeAttr(item.id)}">恢复</button>
              <button class="mini-button danger-mini" type="button" data-action="delete-trash" data-trash-id="${escapeAttr(item.id)}">彻底删除</button>
            </div>
          </article>
        `
        )
        .join("")
    : `<div class="empty-state"><p>回收站为空</p></div>`;

  const backups = state.backups || [];
  elements.backupList.innerHTML = backups.length
    ? backups
        .map(
          (backup) => `
          <article class="safety-item">
            <div>
              <strong>${escapeHtml(backup.reason)}</strong>
              <p>${formatDisplayTime(backup.createdAt)} · ${backup.snapshot.batches.length} 个批次</p>
            </div>
            <div class="safety-actions">
              <button class="mini-button" type="button" data-action="restore-backup" data-backup-id="${escapeAttr(backup.id)}">恢复快照</button>
              <button class="mini-button" type="button" data-action="download-backup" data-backup-id="${escapeAttr(backup.id)}">下载</button>
            </div>
          </article>
        `
        )
        .join("")
    : `<div class="empty-state"><p>暂无快照</p></div>`;

  elements.trashList.querySelectorAll("[data-action='restore-batch']").forEach((button) => {
    button.addEventListener("click", () => restoreTrashedBatch(button.dataset.trashId));
  });
  elements.trashList.querySelectorAll("[data-action='delete-trash']").forEach((button) => {
    button.addEventListener("click", () => deleteTrashedBatch(button.dataset.trashId));
  });
  elements.backupList.querySelectorAll("[data-action='restore-backup']").forEach((button) => {
    button.addEventListener("click", () => restoreBackup(button.dataset.backupId));
  });
  elements.backupList.querySelectorAll("[data-action='download-backup']").forEach((button) => {
    button.addEventListener("click", () => downloadBackup(button.dataset.backupId));
  });
}

function addBatch(event) {
  event.preventDefault();
  const stage = getStage(elements.batchStage.value);
  const numbers = parseLines(elements.batchNumbers.value);
  if (!numbers.length) {
    showToast("请先输入单号 / 转运号，票数会自动计算");
    elements.batchNumbers.focus();
    return;
  }

  const batch = {
    id: makeId(),
    name: elements.batchName.value.trim(),
    count: numbers.length,
    destination: cleanUpper(elements.batchDestination.value || "US"),
    origin: "CHINA",
    stageKey: elements.batchStage.value,
    createdAt: elements.batchTime.value,
    numbers,
    events: [
      makeEvent(
        elements.batchStage.value,
        elements.batchTime.value,
        stage?.type ?? "普通",
        renderTemplate(stage?.template ?? "", {
          destination: cleanUpper(elements.batchDestination.value || "US"),
          origin: "CHINA",
        }),
        false
      ),
    ],
  };

  state.batches.unshift(batch);
  selectedBatchId = batch.id;
  saveState();
  elements.batchForm.reset();
  elements.batchCount.value = 0;
  elements.batchDestination.value = "US";
  elements.batchTime.value = toInputDateTime(new Date());
  render();
  showToast("批次已保存");
}

function updateBatchCountFromNumbers() {
  elements.batchCount.value = parseLines(elements.batchNumbers.value).length;
}

function addEventToSelectedBatch() {
  const batch = getSelectedBatch();
  if (!batch) return;

  const stageKey = elements.detailStage.value;
  const stage = getStage(stageKey);
  const time = elements.detailTime.value || toInputDateTime(new Date());
  const content = elements.eventContent.value.trim() || renderTemplate(stage?.template ?? "", batch);
  const type = elements.detailType.value || stage?.type || "普通";

  const duplicate = batch.events.some((event) => event.stageKey === stageKey && event.time === time && event.content === content);
  if (duplicate) {
    showToast("这条轨迹已经存在");
    return;
  }

  batch.stageKey = stageKey;
  batch.events.push(makeEvent(stageKey, time, type, content, false));
  sortBatchEvents(batch);
  syncBatchDerivedFields(batch);
  saveState();
  render();
  showToast("轨迹已加入待推送");
}

function syncEventEditorFromStage() {
  const batch = getSelectedBatch();
  const stage = getStage(elements.detailStage.value);
  if (!batch || !stage) return;

  elements.detailType.value = stage.type;
  elements.eventContent.value = renderTemplate(stage.template, batch);
}

function markSelectedBatchPushed() {
  const batch = getSelectedBatch();
  if (!batch) return;

  batch.events.forEach((event) => {
    event.pushed = true;
  });
  syncBatchDerivedFields(batch);
  saveState();
  render();
  showToast("当前批次已全部标记为已推送");
}

function saveSelectedBatchName() {
  const batch = getSelectedBatch();
  if (!batch) return;

  const name = elements.detailNameInput.value.trim();
  if (!name) {
    showToast("批次名称不能为空");
    elements.detailNameInput.focus();
    return;
  }

  batch.name = name;
  saveState();
  render();
  showToast("批次名称已更新");
}

function copyPushOutput() {
  const text = elements.pushOutput.value;
  if (!text.trim()) {
    showToast("没有可复制内容");
    return;
  }

  navigator.clipboard.writeText(text).then(
    () => showToast("推送内容已复制"),
    () => showToast("复制失败，请手动复制")
  );
}

function saveDetailNumbers() {
  const batch = getSelectedBatch();
  if (!batch) return;

  batch.numbers = parseLines(elements.detailNumbers.value);
  batch.count = batch.numbers.length;
  syncBatchDerivedFields(batch);
  saveState();
  render();
  showToast("单号已保存");
}

function updateSelectedBatchNumbersFromTextarea() {
  const batch = getSelectedBatch();
  if (!batch) return;

  batch.numbers = parseLines(elements.detailNumbers.value);
  batch.count = batch.numbers.length;
  syncBatchDerivedFields(batch);
  elements.numberCount.textContent = getBatchTicketCount(batch).toLocaleString("zh-CN");
  queueSaveState();
  renderStats();
}

function deleteSelectedBatch() {
  const batch = getSelectedBatch();
  if (!batch) return;

  if (!confirm(`确定把「${batch.name}」移入回收站吗？可在“导入导出 > 回收站”恢复。`)) return;
  createBackup(`移入回收站前：${batch.name}`);
  state.trash.batches.unshift({
    id: makeId(),
    deletedAt: toInputDateTime(new Date()),
    data: structuredClone(batch),
  });
  state.batches = state.batches.filter((item) => item.id !== batch.id);
  selectedBatchId = state.batches[0]?.id ?? null;
  saveState();
  render();
  showToast("批次已移入回收站");
}

function duplicateSelectedBatch() {
  const batch = getSelectedBatch();
  if (!batch) return;

  const copy = structuredClone(batch);
  copy.id = makeId();
  copy.name = `${batch.name} 副本`;
  copy.events = copy.events.map((event) => ({ ...event, id: makeId(), pushed: false }));
  syncBatchDerivedFields(copy);
  state.batches.unshift(copy);
  selectedBatchId = copy.id;
  saveState();
  render();
  showToast("批次已复制");
}

function splitSelectedBatch() {
  const batch = getSelectedBatch();
  if (!batch) {
    showToast("请先选择要拆分的批次");
    return;
  }

  const ticketCount = getBatchTicketCount(batch);
  const countText = prompt("要拆出多少票？", Math.floor(ticketCount / 2).toString());
  const splitCount = Number(countText);
  if (!splitCount || splitCount <= 0 || splitCount >= ticketCount) {
    showToast("拆分数量需要小于原批次票数");
    return;
  }

  const hasNumbers = batch.numbers.length > 0;
  const splitNumbers = hasNumbers ? batch.numbers.splice(0, Math.min(splitCount, batch.numbers.length)) : [];
  if (!hasNumbers) {
    batch.count = ticketCount - splitCount;
  }
  const newBatch = structuredClone(batch);
  newBatch.id = makeId();
  newBatch.name = `${batch.name} 子批`;
  newBatch.count = splitCount;
  newBatch.numbers = splitNumbers;
  newBatch.events = newBatch.events.map((event) => ({ ...event, id: makeId(), pushed: false }));
  syncBatchDerivedFields(batch);
  syncBatchDerivedFields(newBatch);
  state.batches.unshift(newBatch);
  selectedBatchId = newBatch.id;
  saveState();
  render();
  showToast("子批已创建，可单独推进状态");
}

function handleBatchDragStart(event) {
  draggedBatchId = event.currentTarget.dataset.batchId;
  event.currentTarget.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedBatchId);
}

function handleBatchDragEnd(event) {
  event.currentTarget.classList.remove("dragging");
  $$(".batch-card.drop-target").forEach((card) => card.classList.remove("drop-target"));
  draggedBatchId = null;
}

function handleBatchDragOver(event) {
  const targetId = event.currentTarget.dataset.batchId;
  const sourceId = event.dataTransfer.getData("text/plain") || draggedBatchId;
  if (!sourceId || sourceId === targetId) return;
  event.preventDefault();
  event.currentTarget.classList.add("drop-target");
  event.dataTransfer.dropEffect = "move";
}

function handleBatchDragLeave(event) {
  event.currentTarget.classList.remove("drop-target");
}

function handleBatchDrop(event) {
  event.preventDefault();
  const sourceId = event.dataTransfer.getData("text/plain") || draggedBatchId;
  const targetId = event.currentTarget.dataset.batchId;
  event.currentTarget.classList.remove("drop-target");

  if (!sourceId || !targetId || sourceId === targetId) {
    return;
  }

  openMergeModal(sourceId, targetId);
}

function openMergeModal(sourceId, targetId) {
  const source = state.batches.find((batch) => batch.id === sourceId);
  const target = state.batches.find((batch) => batch.id === targetId);
  if (!source || !target) return;

  pendingMerge = { sourceId, targetId };
  elements.mergeSourceName.textContent = source.name;
  elements.mergeSourceMeta.textContent = `${getBatchTicketCount(source).toLocaleString("zh-CN")} 票 · ${getStage(source.stageKey)?.name ?? "未设置"}`;
  elements.mergeTargetName.textContent = target.name;
  elements.mergeTargetMeta.textContent = `${getBatchTicketCount(target).toLocaleString("zh-CN")} 票 · ${getStage(target.stageKey)?.name ?? "未设置"}`;
  elements.mergeSummary.textContent = `合并后将保留「${target.name}」，并删除「${source.name}」。`;

  const stageWarning =
    source.stageKey !== target.stageKey
      ? `两个批次当前节点不同：${getStage(source.stageKey)?.name ?? source.stageKey} / ${getStage(target.stageKey)?.name ?? target.stageKey}。合并后会以时间最新的轨迹作为当前节点。`
      : "两个批次当前节点一致，适合合并回一个批次维护。";
  elements.mergeWarning.textContent = stageWarning;
  elements.mergeModal.hidden = false;
}

function closeMergeModal() {
  pendingMerge = null;
  elements.mergeModal.hidden = true;
}

function confirmMergeBatches() {
  if (!pendingMerge) return;

  const source = state.batches.find((batch) => batch.id === pendingMerge.sourceId);
  const target = state.batches.find((batch) => batch.id === pendingMerge.targetId);
  if (!source || !target) {
    closeMergeModal();
    showToast("批次不存在，无法合并");
    return;
  }

  createBackup(`合并批次前：${source.name} -> ${target.name}`);
  target.numbers = uniqueValues([...target.numbers, ...source.numbers]);
  target.events = uniqueEvents([...target.events, ...source.events]);
  sortBatchEvents(target);

  const newestEvent = [...target.events].sort((a, b) => b.time.localeCompare(a.time))[0];
  if (newestEvent) {
    target.stageKey = newestEvent.stageKey;
  }

  target.name = mergeBatchName(target.name, source.name);
  syncBatchDerivedFields(target);
  state.batches = state.batches.filter((batch) => batch.id !== source.id);
  selectedBatchId = target.id;
  closeMergeModal();
  saveState();
  render();
  showToast("批次已合并");
}

function toggleEventPushed(batchId, eventId) {
  const batch = state.batches.find((item) => item.id === batchId);
  const event = batch?.events.find((item) => item.id === eventId);
  if (!event) return;

  event.pushed = !event.pushed;
  syncBatchDerivedFields(batch);
  saveState();
  render();
}

function saveEventEdit(batchId, eventId) {
  const batch = state.batches.find((item) => item.id === batchId);
  const event = batch?.events.find((item) => item.id === eventId);
  const form = elements.timeline.querySelector(`.timeline-edit-form[data-event-id="${cssEscape(eventId)}"]`);
  if (!batch || !event || !form) return;

  const stageKey = form.querySelector("[data-field='stageKey']").value;
  const stage = getStage(stageKey);
  const content = form.querySelector("[data-field='content']").value.trim();
  if (!content) {
    showToast("轨迹内容不能为空");
    form.querySelector("[data-field='content']").focus();
    return;
  }

  event.stageKey = stageKey;
  event.time = normalizeInputTime(form.querySelector("[data-field='time']").value) || toInputDateTime(new Date());
  event.type = form.querySelector("[data-field='type']").value || stage?.type || "普通";
  event.content = content;
  sortBatchEvents(batch);
  syncBatchDerivedFields(batch);
  editingEventId = null;
  saveState();
  render();
  showToast("轨迹已更新");
}

function removeEvent(batchId, eventId) {
  const batch = state.batches.find((item) => item.id === batchId);
  if (!batch) return;

  createBackup(`删除轨迹前：${batch.name}`);
  batch.events = batch.events.filter((event) => event.id !== eventId);
  syncBatchDerivedFields(batch);
  saveState();
  render();
  showToast("轨迹已删除，已自动留快照");
}

function updateTemplate(stageKey, field, value) {
  const stage = getStage(stageKey);
  if (!stage || !["name", "template", "type"].includes(field)) return;

  stage[field] = value.trim();
  saveState();
  render();
  showToast("模板已更新");
}

function addTemplate() {
  const key = `custom-${Date.now()}`;
  state.stages.push({
    key,
    name: "新节点",
    type: "普通",
    template: "{destination}: 新轨迹内容",
  });
  saveState();
  render();
  showToast("已新增模板");
}

function removeTemplate(stageKey) {
  if (state.stages.length <= 1) {
    showToast("至少保留一个模板");
    return;
  }

  state.stages = state.stages.filter((stage) => stage.key !== stageKey);
  state.batches.forEach((batch) => {
    if (batch.stageKey === stageKey) {
      batch.stageKey = state.stages[0].key;
    }
  });
  saveState();
  render();
}

function importCsv() {
  const rows = parseCsv(elements.importArea.value);
  if (!rows.length) {
    showToast("没有可导入内容");
    return;
  }

  const header = rows[0].map((cell) => cell.trim());
  const dataRows = header.includes("批次名称") ? rows.slice(1) : rows;
  const headerMap = new Map(header.map((name, index) => [name, index]));
  const getCell = (row, names, fallbackIndex) => {
    for (const name of names) {
      if (headerMap.has(name)) return row[headerMap.get(name)] ?? "";
    }
    return row[fallbackIndex] ?? "";
  };

  const imported = dataRows
    .filter((row) => row.some((cell) => cell.trim()))
    .map((row) => {
      const name = getCell(row, ["批次名称", "批次", "batch"], 0).trim();
      const count = Number(getCell(row, ["票数", "数量", "count"], 1)) || 0;
      const destination = cleanUpper(getCell(row, ["目的地", "国家", "destination"], 2) || "US");
      const stageName = getCell(row, ["当前节点", "状态", "stage"], 3).trim();
      const stage = findStageByName(stageName) || state.stages[0];
      const time = normalizeInputTime(getCell(row, ["时间", "节点时间", "time"], 4)) || toInputDateTime(new Date());
      const numbers = parseLines(getCell(row, ["单号", "转运号", "numbers"], 5).replaceAll(";", "\n"));
      return {
        id: makeId(),
        name: name || `导入批次 ${new Date().toLocaleString("zh-CN")}`,
        count: numbers.length || count,
        destination,
        origin: "CHINA",
        stageKey: stage.key,
        createdAt: time,
        numbers,
        events: [makeEvent(stage.key, time, stage.type, renderTemplate(stage.template, { destination, origin: "CHINA" }), false)],
      };
    });

  createBackup(`CSV 导入前：${imported.length} 个批次`);
  state.batches = [...imported, ...state.batches];
  selectedBatchId = imported[0]?.id ?? selectedBatchId;
  saveState();
  render();
  showToast(`已导入 ${imported.length} 个批次`);
}

function downloadCsv() {
  const rows = [["批次名称", "票数", "目的地", "节点时间", "轨迹内容", "类型", "是否已推送", "单号"]];
  state.batches.forEach((batch) => {
    batch.events
      .sort((a, b) => a.time.localeCompare(b.time))
      .forEach((event) => {
        rows.push([
          batch.name,
          getBatchTicketCount(batch),
          batch.destination,
          formatSystemTime(event.time),
          event.content,
          event.type || "普通",
          event.pushed ? "是" : "否",
          batch.numbers.join(";"),
        ]);
      });
  });
  downloadFile(`批次轨迹_${fileDate()}.csv`, "\ufeff" + toCsv(rows), "text/csv;charset=utf-8");
}

function downloadJson() {
  downloadFile(`批次轨迹备份_${fileDate()}.json`, JSON.stringify(state, null, 2), "application/json;charset=utf-8");
}

function copyJson() {
  const json = JSON.stringify(state, null, 2);
  elements.jsonArea.value = json;
  navigator.clipboard.writeText(json).then(
    () => showToast("JSON已复制"),
    () => showToast("JSON已生成，可手动复制")
  );
}

function restoreJson() {
  try {
    const parsed = JSON.parse(elements.jsonArea.value);
    const parsedState = normalizeState(parsed);
    if (!Array.isArray(parsedState.batches) || !Array.isArray(parsedState.stages)) {
      throw new Error("invalid");
    }
    createBackup("JSON 恢复前");
    state = parsedState;
    selectedBatchId = state.batches[0]?.id ?? null;
    saveState();
    render();
    showToast("JSON已恢复");
  } catch {
    showToast("JSON格式不正确");
  }
}

function resetDemo() {
  if (!confirm("确定清空所有批次、轨迹和单号吗？")) return;
  createBackup("清空全部数据前");
  state = {
    stages: structuredClone(defaultStages),
    batches: [],
    trash: state.trash,
    backups: state.backups,
  };
  selectedBatchId = state.batches[0]?.id ?? null;
  saveState();
  render();
  showToast("数据已清空");
}

function initTheme() {
  const savedTheme = localStorage.getItem(THEME_KEY);
  const theme = savedTheme || "light";
  document.body.classList.toggle("dark-theme", theme === "dark");
  elements.themeToggle.textContent = theme === "dark" ? "浅色" : "深色";
}

function toggleTheme() {
  const isDark = document.body.classList.toggle("dark-theme");
  localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
  elements.themeToggle.textContent = isDark ? "浅色" : "深色";
}

function loadCloudConfig() {
  const config = window.TRACKING_CLOUD_CONFIG || {};
  return {
    url: String(config.url || "").trim().replace(/\/+$/, ""),
    key: String(config.key || "").trim(),
    table: String(config.table || "tracking_tool_state").trim(),
    recordId: String(config.recordId || "main").trim(),
    pullIntervalMs: Number(config.pullIntervalMs || 15000),
    enabled: Boolean(config.url && config.key),
  };
}

function startCloudSync() {
  if (!cloudConfig.enabled) {
    updateCloudStatus("本地保存", "");
    return;
  }

  updateCloudStatus("正在连接云端", "warn");
  loadFromCloud({ silent: true, confirmOverwrite: false }).finally(() => {
    queueCloudSync();
  });

  const interval = Math.max(5000, cloudConfig.pullIntervalMs || 15000);
  setInterval(() => {
    if (hasUnsyncedLocalChanges()) {
      updateCloudStatus("本地修改待上传", "warn");
      return;
    }
    loadFromCloud({ silent: true, confirmOverwrite: false, onlyIfNewer: true });
  }, interval);
}

function queueCloudSync() {
  if (isApplyingRemote || !cloudConfig.enabled) return;
  if (cloudSaveInFlight) {
    needsCloudSyncAfterFlight = true;
    return;
  }
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => syncToCloudNow(true), 900);
}

async function syncToCloudNow(silent = false) {
  if (!ensureCloudConfig()) return;
  if (cloudSaveInFlight) {
    needsCloudSyncAfterFlight = true;
    return;
  }

  const revisionToSync = localRevision;
  const payload = structuredClone(state);
  const updatedAt = new Date().toISOString();
  cloudSaveInFlight = true;
  needsCloudSyncAfterFlight = false;
  updateCloudStatus("正在上传", "warn");
  try {
    const response = await fetch(`${cloudConfig.url}/rest/v1/${encodeURIComponent(cloudConfig.table)}?on_conflict=id`, {
      method: "POST",
      headers: cloudHeaders({ prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        id: cloudConfig.recordId,
        payload,
        updated_at: updatedAt,
      }),
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    lastCloudVersion = updatedAt;
    lastSyncedRevision = Math.max(lastSyncedRevision, revisionToSync);
    updateCloudStatus("云端已同步", "ok");
    if (!silent) showToast("当前数据已上传到云端");
  } catch (error) {
    updateCloudStatus("同步失败", "error");
    showToast(`云同步失败：${formatError(error)}`);
  } finally {
    cloudSaveInFlight = false;
    if (needsCloudSyncAfterFlight || localRevision > lastSyncedRevision) {
      queueCloudSync();
    }
  }
}

async function loadFromCloud(options = {}) {
  if (!ensureCloudConfig()) return;
  const { silent = false, confirmOverwrite = false, onlyIfNewer = false } = options;
  if (confirmOverwrite && !confirm("从云端读取会覆盖当前浏览器本地数据，确定继续？")) return;
  if (!confirmOverwrite && hasUnsyncedLocalChanges()) {
    updateCloudStatus("本地修改待上传", "warn");
    return;
  }

  updateCloudStatus("正在读取", "warn");
  try {
    const url = `${cloudConfig.url}/rest/v1/${encodeURIComponent(cloudConfig.table)}?id=eq.${encodeURIComponent(cloudConfig.recordId)}&select=payload,updated_at`;
    const response = await fetch(url, {
      method: "GET",
      headers: cloudHeaders(),
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const rows = await response.json();
    if (!rows.length || !rows[0].payload) {
      if (!confirmOverwrite && hasUnsyncedLocalChanges()) {
        updateCloudStatus("本地修改待上传", "warn");
        return;
      }
      isApplyingRemote = true;
      state = normalizeState({});
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      selectedBatchId = null;
      isApplyingRemote = false;
      render();
      updateCloudStatus("云端为空", "ok");
      queueCloudSync();
      return;
    }

    const remoteState = normalizeState(rows[0].payload);
    const remoteVersion = rows[0].updated_at || "";
    if (!confirmOverwrite && hasUnsyncedLocalChanges()) {
      updateCloudStatus("本地修改待上传", "warn");
      return;
    }
    if (onlyIfNewer && remoteVersion && remoteVersion === lastCloudVersion) {
      updateCloudStatus("云端已同步", "ok");
      return;
    }

    isApplyingRemote = true;
    state = remoteState;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    selectedBatchId = state.batches[0]?.id ?? null;
    lastCloudVersion = remoteVersion;
    lastSyncedRevision = localRevision;
    isApplyingRemote = false;
    render();
    updateCloudStatus("已读取云端", "ok");
    if (!silent) showToast("已从云端恢复数据");
  } catch (error) {
    isApplyingRemote = false;
    updateCloudStatus("读取失败", "error");
    showToast(`云端读取失败：${formatError(error)}`);
  }
}

function hasUnsyncedLocalChanges() {
  return cloudSaveInFlight || localRevision > lastSyncedRevision || Date.now() - lastLocalChangeAt < 1500;
}

function ensureCloudConfig() {
  if (!cloudConfig.enabled) {
    updateCloudStatus("本地保存", "");
    return false;
  }
  return true;
}

function cloudHeaders(extra = {}) {
  const headers = {
    apikey: cloudConfig.key,
    Authorization: `Bearer ${cloudConfig.key}`,
    "Content-Type": "application/json",
  };
  if (extra.prefer) headers.Prefer = extra.prefer;
  return headers;
}

function updateCloudStatus(text, tone = "") {
  elements.cloudStatus.textContent = text;
  elements.cloudStatus.classList.remove("ok", "warn", "error");
  if (tone) elements.cloudStatus.classList.add(tone);
}

function switchView(viewName) {
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === viewName));
  $$(".view").forEach((view) => view.classList.remove("active-view"));
  $(`#view-${viewName}`).classList.add("active-view");
}

function makeEvent(stageKey, time, type, content, pushed) {
  return {
    id: makeId(),
    stageKey,
    time: normalizeInputTime(time) || toInputDateTime(new Date()),
    type,
    content,
    pushed: Boolean(pushed),
  };
}

function makeId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeState(value) {
  const normalized = {
    stages: Array.isArray(value?.stages) && value.stages.length ? value.stages : structuredClone(defaultStages),
    batches: Array.isArray(value?.batches) ? value.batches : [],
    trash: {
      batches: Array.isArray(value?.trash?.batches) ? value.trash.batches : [],
    },
    backups: Array.isArray(value?.backups) ? value.backups : [],
  };
  normalized.batches.forEach(syncBatchDerivedFields);
  normalized.trash.batches.forEach((item) => {
    if (item?.data) syncBatchDerivedFields(item.data);
  });
  return normalized;
}

function createBackup(reason) {
  state.backups ||= [];
  const snapshot = {
    stages: structuredClone(state.stages),
    batches: structuredClone(state.batches),
    trash: structuredClone(state.trash || { batches: [] }),
  };
  state.backups.unshift({
    id: makeId(),
    reason,
    createdAt: toInputDateTime(new Date()),
    snapshot,
  });
  state.backups = state.backups.slice(0, 20);
}

function restoreTrashedBatch(trashId) {
  const item = state.trash.batches.find((entry) => entry.id === trashId);
  if (!item) return;

  createBackup(`恢复回收站批次前：${item.data.name}`);
  const restored = structuredClone(item.data);
  restored.id = state.batches.some((batch) => batch.id === restored.id) ? makeId() : restored.id;
  state.batches.unshift(restored);
  state.trash.batches = state.trash.batches.filter((entry) => entry.id !== trashId);
  selectedBatchId = restored.id;
  saveState();
  render();
  showToast("批次已恢复");
}

function deleteTrashedBatch(trashId) {
  const item = state.trash.batches.find((entry) => entry.id === trashId);
  if (!item) return;
  if (!confirm(`确定彻底删除「${item.data.name}」吗？这个操作不能从回收站恢复。`)) return;

  createBackup(`彻底删除回收站批次前：${item.data.name}`);
  state.trash.batches = state.trash.batches.filter((entry) => entry.id !== trashId);
  saveState();
  render();
  showToast("批次已彻底删除");
}

function restoreBackup(backupId) {
  const backup = state.backups.find((item) => item.id === backupId);
  if (!backup) return;
  if (!confirm(`确定恢复「${backup.reason}」这份快照吗？当前状态会先自动再留一份快照。`)) return;

  createBackup("恢复快照前");
  const currentBackups = state.backups;
  state = normalizeState({
    ...backup.snapshot,
    backups: currentBackups,
  });
  selectedBatchId = state.batches[0]?.id ?? null;
  saveState();
  render();
  showToast("快照已恢复");
}

function downloadBackup(backupId) {
  const backup = state.backups.find((item) => item.id === backupId);
  if (!backup) return;

  downloadFile(`自动快照_${fileDate()}.json`, JSON.stringify(backup.snapshot, null, 2), "application/json;charset=utf-8");
}

function renderTemplate(template, batch) {
  return String(template)
    .replaceAll("{origin}", batch.origin || "CHINA")
    .replaceAll("{destination}", batch.destination || "US")
    .replaceAll("{ems}", EMS_PLACEHOLDER);
}

function getSelectedBatch() {
  return state.batches.find((batch) => batch.id === selectedBatchId) ?? null;
}

function getStage(key) {
  return state.stages.find((stage) => stage.key === key);
}

function getBatchTicketCount(batch) {
  if (!batch) return 0;
  if (Array.isArray(batch.numbers) && batch.numbers.length) return batch.numbers.length;
  return Number(batch.count || 0);
}

function latestEvent(batch) {
  return [...(batch?.events || [])].sort((a, b) => b.time.localeCompare(a.time))[0] || null;
}

function syncBatchDerivedFields(batch) {
  if (!batch) return batch;
  batch.numbers = Array.isArray(batch.numbers) ? batch.numbers.map((value) => String(value || "").trim()).filter(Boolean) : [];
  batch.count = getBatchTicketCount(batch);
  const newestEvent = latestEvent(batch);
  if (newestEvent) {
    batch.stageKey = newestEvent.stageKey;
  }
  return batch;
}

function findStageByName(name) {
  const normalized = name.toLowerCase();
  return state.stages.find((stage) => stage.name.toLowerCase() === normalized || stage.key.toLowerCase() === normalized);
}

function sortBatchEvents(batch) {
  batch.events.sort((a, b) => a.time.localeCompare(b.time));
}

function uniqueValues(values) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function uniqueEvents(events) {
  const seen = new Set();
  const result = [];
  events.forEach((event) => {
    const key = [event.stageKey, event.time, event.content, event.type].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ ...event, id: event.id || makeId() });
  });
  return result;
}

function mergeBatchName(targetName, sourceName) {
  if (targetName.includes("合并")) return targetName;
  const commonDate = targetName.match(/\d{4}-\d{2}-\d{2}/)?.[0] || sourceName.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (commonDate) return `${commonDate} 合并批次`;
  return `${targetName} 合并`;
}

function newestTime(batch) {
  const times = [batch.createdAt, ...batch.events.map((event) => event.time)].filter(Boolean);
  return times.sort().at(-1) || toInputDateTime(new Date());
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function parseLines(text) {
  return text
    .split(/[\r\n,，;；\t]+/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  rows.push(row);
  return rows.filter((item) => item.some((cellValue) => cellValue.trim()));
}

function toCsv(rows) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = String(cell ?? "");
          if (/[",\n\r]/.test(value)) {
            return `"${value.replaceAll('"', '""')}"`;
          }
          return value;
        })
        .join(",")
    )
    .join("\r\n");
}

function normalizeInputTime(value) {
  if (!value) return "";
  const trimmed = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) return trimmed.slice(0, 16);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed)) return trimmed.replace(" ", "T").slice(0, 16);
  const date = new Date(trimmed);
  if (!Number.isNaN(date.getTime())) return toInputDateTime(date);
  return "";
}

function toInputDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDisplayTime(value) {
  return normalizeInputTime(value).replace("T", " ");
}

function formatSystemTime(value) {
  const base = normalizeInputTime(value).replace("T", " ");
  return base.length === 16 ? `${base}:00` : base;
}

function cleanUpper(value) {
  return String(value || "").trim().toUpperCase();
}

function formatError(error) {
  return String(error?.message || error || "未知错误").slice(0, 140);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function fileDate() {
  const date = new Date();
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

let toastTimer = null;
function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2200);
}
