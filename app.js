const STORAGE_KEY = "batch-tracking-tool-v1";
const STORAGE_HISTORY_KEY = "batch-tracking-tool-history-v1";
const THEME_KEY = "batch-tracking-theme-v1";
const EMS_PLACEHOLDER = "#ems_number#";
const CLOUD_SNAPSHOT_PREFIX = "snapshot:";
const CLOUD_META_STAGES_ID = "meta:stages";
const CLOUD_BATCH_PREFIX = "batch:";
const CLOUD_TRASH_PREFIX = "trash:";
const MAX_LOCAL_HISTORY = 25;
const MAX_CLOUD_SNAPSHOT_FETCH = 20;
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
let currentDropIntent = null;
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
let deferredCloudPull = false;
let lastCommittedState = structuredClone(state);

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
  signedUpdateInput: $("#signed-update-input"),
  signedUpdateSummary: $("#signed-update-summary"),
  signedUpdateOutput: $("#signed-update-output"),
  signedUpdateCount: $("#signed-update-count"),
  signedUpdateHistory: $("#signed-update-history"),
  filterSignedUpdateBtn: $("#filter-signed-update-btn"),
  markSignedUpdateBtn: $("#mark-signed-update-btn"),
  copyNewSignedBtn: $("#copy-new-signed-btn"),
  timeline: $("#timeline"),
  pushOutput: $("#push-output"),
  numberCount: $("#number-count"),
  detailNumbers: $("#detail-numbers"),
  searchInput: $("#search-input"),
  locateNumbersInput: $("#locate-numbers-input"),
  locateSummary: $("#locate-summary"),
  locateResults: $("#locate-results"),
  locateBatchesBtn: $("#locate-batches-btn"),
  templateList: $("#template-list"),
  importArea: $("#import-area"),
  jsonArea: $("#json-area"),
  trashList: $("#trash-list"),
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
  pushLocalHistorySnapshot(state);
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
  $("#export-selected-batch-btn").addEventListener("click", downloadSelectedBatchCsv);
  elements.locateBatchesBtn.addEventListener("click", locateBatchesByNumbers);
  elements.locateNumbersInput.addEventListener("input", updateLocateSummaryPreview);
  elements.filterSignedUpdateBtn.addEventListener("click", updateSignedUpdatePreview);
  elements.markSignedUpdateBtn.addEventListener("click", markSignedUpdateNumbers);
  elements.copyNewSignedBtn.addEventListener("click", copyNewSignedNumbers);
  elements.signedUpdateInput.addEventListener("input", updateSignedUpdatePreview);
  $("#delete-batch-btn").addEventListener("click", deleteSelectedBatch);
  $("#duplicate-batch-btn").addEventListener("click", duplicateSelectedBatch);
  $("#split-batch-btn").addEventListener("click", splitSelectedBatch);
  $("#add-template-btn").addEventListener("click", addTemplate);
  $("#import-btn").addEventListener("click", importCsv);
  $("#download-json-btn").addEventListener("click", downloadJson);
  $("#copy-json-btn").addEventListener("click", copyJson);
  $("#restore-json-btn").addEventListener("click", restoreJson);
  $("#reset-demo-btn").addEventListener("click", resetDemo);
  $("#theme-toggle").addEventListener("click", toggleTheme);
  $("#cancel-merge-btn").addEventListener("click", closeMergeModal);
  $("#confirm-merge-btn").addEventListener("click", confirmMergeBatches);
  elements.mergeModal.addEventListener("click", (event) => {
    if (event.target === elements.mergeModal) closeMergeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.mergeModal.hidden) closeMergeModal();
  });
  document.addEventListener("focusout", retryDeferredCloudPull);
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

function persistStateLocally() {
  pushLocalHistorySnapshot(state);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function markStateChanged() {
  localRevision += 1;
  lastLocalChangeAt = Date.now();
}

function saveState() {
  markStateChanged();
  state.batches.forEach(syncBatchDerivedFields);
  persistBatchOrder();
  persistStateLocally();
  queueCloudSync();
}

function saveTemplateState() {
  markStateChanged();
  persistBatchOrder();
  persistStateLocally();
  queueCloudSync(250);
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
  updateLocateSummaryPreview();
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
    .map((batch) => {
      const stage = getStage(batch.stageKey);
      const latest = latestEvent(batch);
      const pending = batch.events.filter((event) => !event.pushed).length;
      return `
        <button class="batch-card ${batch.id === selectedBatchId ? "active" : ""}" type="button" draggable="true" data-batch-id="${escapeAttr(batch.id)}" title="上半/下半调整顺序，中间区域合并">
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
  elements.detailTime.value = toInputDateTime(new Date());
  elements.detailType.value = stage?.type ?? "普通";
  elements.eventContent.value = renderTemplate(stage?.template ?? "", batch);
  elements.numberCount.textContent = getBatchTicketCount(batch).toLocaleString("zh-CN");
  elements.detailNumbers.value = batch.numbers.join("\n");

  renderTimeline(batch);
  renderPushOutput(batch);
  renderSignedUpdate(batch);
}

function updateLocateSummaryPreview() {
  if (!elements.locateSummary || !elements.locateResults) return;
  const numbers = parseLines(elements.locateNumbersInput.value || "");
  elements.locateSummary.textContent = numbers.length ? `已输入 ${numbers.length} 条单号，点击“定位批次”开始查找` : "待定位";
  if (!numbers.length) {
    elements.locateResults.innerHTML = "";
  }
}

function locateBatchesByNumbers() {
  const numbers = uniqueValues(parseLines(elements.locateNumbersInput.value));
  if (!numbers.length) {
    showToast("请先输入要定位的单号");
    elements.locateNumbersInput.focus();
    return;
  }

  const batchMatches = state.batches
    .map((batch) => {
      const matchedNumbers = numbers.filter((number) => batch.numbers.includes(number));
      return matchedNumbers.length ? { batch, matchedNumbers } : null;
    })
    .filter(Boolean);

  const matchedSet = new Set(batchMatches.flatMap((item) => item.matchedNumbers));
  const unmatchedNumbers = numbers.filter((number) => !matchedSet.has(number));

  renderLocateResults(batchMatches, unmatchedNumbers, numbers.length);

  if (batchMatches.length === 1) {
    selectedBatchId = batchMatches[0].batch.id;
    render();
  }
}

function renderLocateResults(batchMatches, unmatchedNumbers, totalCount) {
  const matchedCount = batchMatches.reduce((sum, item) => sum + item.matchedNumbers.length, 0);
  elements.locateSummary.textContent = `共输入 ${totalCount} 条，匹配到 ${matchedCount} 条，涉及 ${batchMatches.length} 个批次，未匹配 ${unmatchedNumbers.length} 条`;

  const matchedHtml = batchMatches
    .map(({ batch, matchedNumbers }) => {
      const stage = getStage(batch.stageKey);
      return `
        <button class="locator-result" type="button" data-locate-batch-id="${escapeAttr(batch.id)}">
          <strong>${escapeHtml(batch.name)}</strong>
          <p>${escapeHtml(stage?.name ?? "未设置")} · 命中 ${matchedNumbers.length} 条</p>
          <p>${escapeHtml(matchedNumbers.slice(0, 8).join("、"))}${matchedNumbers.length > 8 ? " ..." : ""}</p>
        </button>
      `;
    })
    .join("");

  const unmatchedHtml = unmatchedNumbers.length
    ? `
        <div class="locator-result unmatched">
          <strong>未匹配到批次</strong>
          <p>${escapeHtml(unmatchedNumbers.join("、"))}</p>
        </div>
      `
    : "";

  elements.locateResults.innerHTML =
    matchedHtml || unmatchedHtml
      ? `${matchedHtml}${unmatchedHtml}`
      : `<div class="empty-state"><p>没有找到对应批次</p></div>`;

  elements.locateResults.querySelectorAll("[data-locate-batch-id]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedBatchId = button.dataset.locateBatchId;
      render();
    });
  });
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
          <button class="mini-button" type="button" data-action="toggle" data-event-id="${escapeAttr(event.id)}">${event.pushed ? "撤回" : "推送"}</button>
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
  const source = [...batch.events].filter((event) => event.pushed).sort((a, b) => a.time.localeCompare(b.time));
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
  if (!elements.trashList) return;

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

  elements.trashList.querySelectorAll("[data-action='restore-batch']").forEach((button) => {
    button.addEventListener("click", () => restoreTrashedBatch(button.dataset.trashId));
  });
  elements.trashList.querySelectorAll("[data-action='delete-trash']").forEach((button) => {
    button.addEventListener("click", () => deleteTrashedBatch(button.dataset.trashId));
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

function renderSignedUpdate(batch) {
  const signed = uniqueValues(batch.signedNumbers || []);
  elements.signedUpdateCount.textContent = signed.length.toLocaleString("zh-CN");
  elements.signedUpdateHistory.value = signed.join("\n");
  updateSignedUpdatePreview();
}

function updateSignedUpdatePreview() {
  const batch = getSelectedBatch();
  if (!batch) {
    elements.signedUpdateSummary.textContent = "请选择一个批次";
    elements.signedUpdateOutput.value = "";
    return { input: [], ready: [], duplicate: [], missing: [] };
  }

  const result = getSignedUpdateCandidates(batch, parseLines(elements.signedUpdateInput.value));
  elements.signedUpdateSummary.textContent = result.input.length
    ? `输入 ${result.input.length} 单，可标记 ${result.ready.length}，已标记 ${result.duplicate.length}，非本批次 ${result.missing.length}`
    : "待筛选";
  elements.signedUpdateOutput.value = result.ready.join("\n");
  return result;
}

function markSignedUpdateNumbers() {
  const batch = getSelectedBatch();
  if (!batch) return;

  const { ready, missing } = updateSignedUpdatePreview();
  if (!ready.length) {
    showToast(missing.length ? "输入单号不在当前批次，未执行标记" : "没有新的签收单号可标记");
    return;
  }

  batch.signedNumbers = uniqueValues([...(batch.signedNumbers || []), ...ready]);
  const signedSet = new Set(ready);
  batch.numbers = batch.numbers.filter((number) => !signedSet.has(number));
  batch.count = batch.numbers.length;
  saveState();
  render();
  showToast(`已标记 ${ready.length} 单签收`);
}

function copyNewSignedNumbers() {
  const { ready } = updateSignedUpdatePreview();
  const text = ready.join("\n");
  if (!text.trim()) {
    showToast("没有可复制的未标记单号");
    return;
  }

  navigator.clipboard.writeText(text).then(
    () => showToast("未标记签收单号已复制"),
    () => showToast("复制失败，请手动复制")
  );
}

function syncEventEditorFromStage() {
  const batch = getSelectedBatch();
  const stage = getStage(elements.detailStage.value);
  if (!batch || !stage) return;

  elements.detailTime.value = toInputDateTime(new Date());
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
  currentDropIntent = null;
  event.currentTarget.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedBatchId);
}

function handleBatchDragEnd(event) {
  event.currentTarget.classList.remove("dragging");
  clearBatchDropStyles();
  draggedBatchId = null;
  currentDropIntent = null;
}

function handleBatchDragOver(event) {
  const targetId = event.currentTarget.dataset.batchId;
  const sourceId = event.dataTransfer.getData("text/plain") || draggedBatchId;
  if (!sourceId || sourceId === targetId) return;
  event.preventDefault();
  const intent = getBatchDropIntent(event);
  currentDropIntent = { sourceId, targetId, intent };
  updateBatchDropStyles(targetId, intent);
  event.dataTransfer.dropEffect = "move";
}

function handleBatchDragLeave(event) {
  const related = event.relatedTarget;
  if (related && event.currentTarget.contains(related)) return;
  clearBatchDropStyles();
}

function handleBatchDrop(event) {
  event.preventDefault();
  const sourceId = event.dataTransfer.getData("text/plain") || draggedBatchId;
  const targetId = event.currentTarget.dataset.batchId;
  const intent = currentDropIntent?.targetId === targetId ? currentDropIntent.intent : getBatchDropIntent(event);
  clearBatchDropStyles();

  if (!sourceId || !targetId || sourceId === targetId) {
    return;
  }

  if (intent === "merge") {
    openMergeModal(sourceId, targetId);
    return;
  }

  reorderBatches(sourceId, targetId, intent);
}

function getBatchDropIntent(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  const offsetY = event.clientY - rect.top;
  const ratio = rect.height ? offsetY / rect.height : 0.5;
  if (ratio < 0.3) return "before";
  if (ratio > 0.7) return "after";
  return "merge";
}

function updateBatchDropStyles(targetId, intent) {
  clearBatchDropStyles();
  const selector = `[data-batch-id="${escapeAttr(targetId)}"]`;
  const card = elements.batchList.querySelector(selector);
  if (!card) return;
  if (intent === "merge") card.classList.add("drop-target");
  if (intent === "before") card.classList.add("reorder-before");
  if (intent === "after") card.classList.add("reorder-after");
}

function clearBatchDropStyles() {
  $$(".batch-card.drop-target, .batch-card.reorder-before, .batch-card.reorder-after").forEach((card) => {
    card.classList.remove("drop-target", "reorder-before", "reorder-after");
  });
}

function reorderBatches(sourceId, targetId, intent) {
  const sourceIndex = state.batches.findIndex((batch) => batch.id === sourceId);
  const targetIndex = state.batches.findIndex((batch) => batch.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;

  const [source] = state.batches.splice(sourceIndex, 1);
  let insertIndex = state.batches.findIndex((batch) => batch.id === targetId);
  if (insertIndex < 0) {
    state.batches.splice(sourceIndex, 0, source);
    return;
  }
  if (intent === "after") {
    insertIndex += 1;
  }
  state.batches.splice(insertIndex, 0, source);
  persistBatchOrder();
  saveState();
  render();
  showToast("批次顺序已更新");
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
  persistBatchOrder();
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

  batch.events = batch.events.filter((event) => event.id !== eventId);
  syncBatchDerivedFields(batch);
  saveState();
  render();
  showToast("轨迹已删除");
}

function updateTemplate(stageKey, field, value) {
  const stage = getStage(stageKey);
  if (!stage || !["name", "template", "type"].includes(field)) return;

  stage[field] = value.trim();
  saveTemplateState();
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
  saveTemplateState();
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

  state.batches = [...imported, ...state.batches];
  selectedBatchId = imported[0]?.id ?? selectedBatchId;
  saveState();
  render();
  showToast(`已导入 ${imported.length} 个批次`);
}

function downloadSelectedBatchCsv() {
  const batch = getSelectedBatch();
  if (!batch) {
    showToast("请先选择一个批次");
    return;
  }

  const numbers = Array.isArray(batch.numbers) ? batch.numbers.filter(Boolean) : [];
  if (!numbers.length) {
    showToast("当前批次没有可导出的单号");
    return;
  }

  const latest = latestEvent(batch);
  const latestContent = latest?.content || "";
  const latestTime = latest?.time ? formatSystemTime(latest.time) : "";
  const rows = [["单号", "当前最新轨迹", "时间"]];

  numbers.forEach((number) => {
    rows.push([number, latestContent, latestTime]);
  });

  downloadFile(`${sanitizeFilename(batch.name || "批次")}_推送明细_${fileDate()}.csv`, "\ufeff" + toCsv(rows), "text/csv;charset=utf-8");
  showToast(`已导出 ${numbers.length} 条单号`);
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
  state = {
    stages: structuredClone(defaultStages),
    batches: [],
    trash: state.trash,
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

function cloneStateForCommit(value) {
  return structuredClone(normalizeState(value || {}));
}

function batchCloudId(batchId) {
  return `${CLOUD_BATCH_PREFIX}${batchId}`;
}

function trashCloudId(trashId) {
  return `${CLOUD_TRASH_PREFIX}${trashId}`;
}

function stableJson(value) {
  return JSON.stringify(value ?? null);
}

function buildCloudRowsFromState(value) {
  const normalized = cloneStateForCommit(value);
  const rows = new Map();

  rows.set(CLOUD_META_STAGES_ID, normalized.stages.map((stage) => structuredClone(stage)));
  normalized.batches.forEach((batch) => {
    rows.set(batchCloudId(batch.id), structuredClone(batch));
  });
  normalized.trash.batches.forEach((item) => {
    rows.set(trashCloudId(item.id), structuredClone(item));
  });

  return rows;
}

function computeStateDiff(previousValue, nextValue) {
  const previousRows = buildCloudRowsFromState(previousValue);
  const nextRows = buildCloudRowsFromState(nextValue);
  const upserts = [];
  const deletes = [];

  nextRows.forEach((payload, id) => {
    if (stableJson(previousRows.get(id)) !== stableJson(payload)) {
      upserts.push({ id, payload });
    }
  });

  previousRows.forEach((_, id) => {
    if (!nextRows.has(id)) {
      deletes.push(id);
    }
  });

  return { upserts, deletes };
}

function buildStateFromCollaborativeRows(rows) {
  const stagesRow = rows.find((row) => row.id === CLOUD_META_STAGES_ID);
  const collaborativeState = {
    stages: Array.isArray(stagesRow?.payload) ? stagesRow.payload : structuredClone(defaultStages),
    batches: rows
      .filter((row) => row.id.startsWith(CLOUD_BATCH_PREFIX))
      .map((row) => structuredClone(row.payload)),
    trash: {
      batches: rows
        .filter((row) => row.id.startsWith(CLOUD_TRASH_PREFIX))
        .map((row) => structuredClone(row.payload)),
    },
  };

  return normalizeState(collaborativeState);
}

async function fetchCollaborativeRows() {
  const url = `${cloudConfig.url}/rest/v1/${encodeURIComponent(cloudConfig.table)}?select=id,payload,updated_at&limit=1000`;
  const response = await fetch(url, {
    method: "GET",
    headers: cloudHeaders(),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const rows = await response.json();
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    return row.id === CLOUD_META_STAGES_ID || row.id.startsWith(CLOUD_BATCH_PREFIX) || row.id.startsWith(CLOUD_TRASH_PREFIX);
  });
}

async function migrateLegacyRowToCollaborative(legacyPayload) {
  const normalized = normalizeState(legacyPayload || {});
  const rows = Array.from(buildCloudRowsFromState(normalized).entries()).map(([id, payload]) => ({
    id,
    payload,
    updated_at: new Date().toISOString(),
  }));

  if (!rows.length) return normalized;

  const response = await fetch(`${cloudConfig.url}/rest/v1/${encodeURIComponent(cloudConfig.table)}?on_conflict=id`, {
    method: "POST",
    headers: cloudHeaders({ prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(rows),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return normalized;
}

async function deleteCloudRows(ids) {
  if (!ids.length) return;
  const encodedIds = ids.map((id) => `"${String(id).replaceAll('"', '\\"')}"`).join(",");
  const url = `${cloudConfig.url}/rest/v1/${encodeURIComponent(cloudConfig.table)}?id=in.(${encodeURIComponent(encodedIds)})`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: cloudHeaders({ prefer: "return=minimal" }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }
}

async function syncCollaborativeDiff(diff, updatedAt) {
  if (diff.upserts.length) {
    const response = await fetch(`${cloudConfig.url}/rest/v1/${encodeURIComponent(cloudConfig.table)}?on_conflict=id`, {
      method: "POST",
      headers: cloudHeaders({ prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(
        diff.upserts.map((item) => ({
          id: item.id,
          payload: item.payload,
          updated_at: updatedAt,
        }))
      ),
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }
  }

  await deleteCloudRows(diff.deletes);
}

function summarizeState(value) {
  const normalized = normalizeState(value || {});
  const activeBatches = normalized.batches || [];
  const trashBatches = normalized.trash?.batches || [];
  const activeNumbers = activeBatches.reduce((sum, batch) => sum + getBatchTicketCount(batch), 0);
  const trashNumbers = trashBatches.reduce((sum, item) => sum + getBatchTicketCount(item.data), 0);
  const signedNumbers = activeBatches.reduce((sum, batch) => sum + uniqueValues(batch.signedNumbers || []).length, 0);
  const events = activeBatches.reduce((sum, batch) => sum + (batch.events?.length || 0), 0);

  return {
    batches: activeBatches.length,
    trashBatches: trashBatches.length,
    activeNumbers,
    trashNumbers,
    signedNumbers,
    events,
    totalNumbers: activeNumbers + trashNumbers,
    score: activeNumbers + trashNumbers + signedNumbers * 5 + activeBatches.length * 20 + trashBatches.length * 10 + events * 2,
  };
}

function isStateSignificantlySmaller(candidate, baseline) {
  const next = summarizeState(candidate);
  const prev = summarizeState(baseline);
  if (!prev.score) return false;

  const batchDrop = prev.batches - next.batches;
  const numberDrop = prev.totalNumbers - next.totalNumbers;
  const signedDrop = prev.signedNumbers - next.signedNumbers;
  const eventDrop = prev.events - next.events;

  return (
    next.score < prev.score * 0.65 &&
    (batchDrop >= 2 || numberDrop >= 200 || signedDrop >= 20 || eventDrop >= 10)
  );
}

function makeSnapshotRecordId(timestamp = new Date().toISOString()) {
  return `${CLOUD_SNAPSHOT_PREFIX}${timestamp}:${Math.random().toString(36).slice(2, 8)}`;
}

function pushLocalHistorySnapshot(value) {
  try {
    const history = loadLocalHistory();
    history.push({
      savedAt: new Date().toISOString(),
      summary: summarizeState(value),
      state: structuredClone(value),
    });
    localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(history.slice(-MAX_LOCAL_HISTORY)));
  } catch {
    // Ignore history write failures to avoid blocking the main save path.
  }
}

function loadLocalHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function fetchRecentCloudSnapshots(limit = MAX_CLOUD_SNAPSHOT_FETCH) {
  const url = `${cloudConfig.url}/rest/v1/${encodeURIComponent(cloudConfig.table)}?id=like.${encodeURIComponent(`${CLOUD_SNAPSHOT_PREFIX}%`)}&select=id,payload,updated_at&order=updated_at.desc&limit=${Math.max(1, limit)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: cloudHeaders(),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

function pickBestRecoveryCandidate(items) {
  const candidates = items
    .filter(Boolean)
    .map((item) => ({
      ...item,
      payload: normalizeState(item.payload || item.state || {}),
    }))
    .filter((item) => hasMeaningfulSavedData(item.payload));

  candidates.sort((a, b) => summarizeState(b.payload).score - summarizeState(a.payload).score);
  return candidates[0] || null;
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
    if (shouldDeferRemoteApply()) {
      updateCloudStatus("本地修改待上传", "warn");
      deferredCloudPull = true;
      return;
    }
    loadFromCloud({ silent: true, confirmOverwrite: false, onlyIfNewer: true });
  }, interval);
}

function queueCloudSync(delay = 900) {
  if (isApplyingRemote || !cloudConfig.enabled) return;
  if (cloudSaveInFlight) {
    needsCloudSyncAfterFlight = true;
    return;
  }
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => syncToCloudNow(true), delay);
}

async function syncToCloudNow(silent = false) {
  if (!ensureCloudConfig()) return;
  if (cloudSaveInFlight) {
    needsCloudSyncAfterFlight = true;
    return;
  }

  const diff = computeStateDiff(lastCommittedState, state);
  if (!diff.upserts.length && !diff.deletes.length) {
    lastSyncedRevision = Math.max(lastSyncedRevision, localRevision);
    retryDeferredCloudPull();
    return;
  }

  const revisionToSync = localRevision;
  const updatedAt = new Date().toISOString();
  cloudSaveInFlight = true;
  needsCloudSyncAfterFlight = false;
  updateCloudStatus("正在上传", "warn");
  try {
    await syncCollaborativeDiff(diff, updatedAt);
    lastCloudVersion = updatedAt;
    lastSyncedRevision = Math.max(lastSyncedRevision, revisionToSync);
    lastCommittedState = cloneStateForCommit(state);
    updateCloudStatus("云端已同步", "ok");
    if (!silent) showToast("当前数据已上传到云端");
  } catch (error) {
    updateCloudStatus("同步失败", "error");
    showToast(`云同步失败：${formatError(error)}`);
  } finally {
    cloudSaveInFlight = false;
    if (needsCloudSyncAfterFlight || localRevision > lastSyncedRevision) {
      queueCloudSync();
    } else {
      retryDeferredCloudPull();
    }
  }
}

async function loadFromCloud(options = {}) {
  if (!ensureCloudConfig()) return;
  const { silent = false, confirmOverwrite = false, onlyIfNewer = false } = options;
  if (confirmOverwrite && !confirm("从云端读取会覆盖当前浏览器本地数据，确定继续？")) return;
  if (!confirmOverwrite && shouldDeferRemoteApply()) {
    updateCloudStatus("本地修改待上传", "warn");
    deferredCloudPull = true;
    return;
  }

  updateCloudStatus("正在读取", "warn");
  try {
    let rows = await fetchCollaborativeRows();
    const hasCollaborativeRows = rows.length > 0;
    const hasBatchRows = rows.some((row) => row.id.startsWith(CLOUD_BATCH_PREFIX));
    const hasTrashRows = rows.some((row) => row.id.startsWith(CLOUD_TRASH_PREFIX));
    let remoteState = rows.length ? buildStateFromCollaborativeRows(rows) : null;
    let remoteVersion = rows.reduce((latest, row) => (row.updated_at > latest ? row.updated_at : latest), "");

    if (!confirmOverwrite && onlyIfNewer && remoteVersion && remoteVersion === lastCloudVersion) {
      updateCloudStatus("浜戠宸插悓姝?", "ok");
      return;
    }

    if (!confirmOverwrite && hasCollaborativeRows && !hasBatchRows && !hasTrashRows && hasMeaningfulSavedData(state)) {
      updateCloudStatus("浜戠鏁版嵁璇诲彇涓嶅畬鏁达紝宸叉殏缂撹鐩?", "warn");
      deferredCloudPull = true;
      queueCloudSync();
      return;
    }

    if (!remoteState) {
      const legacyUrl = `${cloudConfig.url}/rest/v1/${encodeURIComponent(cloudConfig.table)}?id=eq.${encodeURIComponent(cloudConfig.recordId)}&select=payload,updated_at`;
      const legacyResponse = await fetch(legacyUrl, {
        method: "GET",
        headers: cloudHeaders(),
      });

      if (!legacyResponse.ok) {
        throw new Error(await legacyResponse.text());
      }

      const legacyRows = await legacyResponse.json();
      if (legacyRows.length && legacyRows[0].payload) {
        remoteState = await migrateLegacyRowToCollaborative(legacyRows[0].payload);
        remoteVersion = legacyRows[0].updated_at || new Date().toISOString();
      }
    }

    if (!remoteState) {
      if (!confirmOverwrite && hasMeaningfulSavedData(state)) {
        updateCloudStatus("云端为空，保留本地", "warn");
        deferredCloudPull = false;
        queueCloudSync();
        return;
      }

      isApplyingRemote = true;
      state = normalizeState({});
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      selectedBatchId = null;
      lastCommittedState = cloneStateForCommit(state);
      isApplyingRemote = false;
      render();
      updateCloudStatus("云端为空", "ok");
      return;
    }

    if (!confirmOverwrite && isStateSignificantlySmaller(remoteState, state)) {
      const localCandidate = pickBestRecoveryCandidate(loadLocalHistory());
      let cloudCandidate = null;

      try {
        cloudCandidate = pickBestRecoveryCandidate(await fetchRecentCloudSnapshots());
      } catch {
        cloudCandidate = null;
      }

      const bestCandidate = pickBestRecoveryCandidate([localCandidate, cloudCandidate]);
      if (bestCandidate && !isStateSignificantlySmaller(bestCandidate.payload, remoteState)) {
        state = normalizeState(bestCandidate.payload);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        keepSelectedBatchIfPossible();
        deferredCloudPull = false;
        render();
        updateCloudStatus("检测到云端数据变少，已保留较完整版本", "warn");
        queueCloudSync();
        showToast("检测到疑似旧数据覆盖，已自动保留更完整的历史版本");
        return;
      }

      updateCloudStatus("检测到云端数据变少，已暂停覆盖", "warn");
      deferredCloudPull = true;
      showToast("检测到云端数据明显变少，已阻止自动覆盖当前数据");
      return;
    }

    if (!confirmOverwrite && !hasMeaningfulSavedData(remoteState) && hasMeaningfulSavedData(state)) {
      updateCloudStatus("云端为空，保留本地", "warn");
      deferredCloudPull = false;
      queueCloudSync();
      return;
    }
    if (!confirmOverwrite && shouldDeferRemoteApply()) {
      updateCloudStatus("本地修改待上传", "warn");
      deferredCloudPull = true;
      return;
    }
    if (onlyIfNewer && remoteVersion && remoteVersion === lastCloudVersion) {
      updateCloudStatus("云端已同步", "ok");
      return;
    }

    isApplyingRemote = true;
    state = remoteState;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    keepSelectedBatchIfPossible();
    lastCloudVersion = remoteVersion;
    lastSyncedRevision = localRevision;
    lastCommittedState = cloneStateForCommit(state);
    deferredCloudPull = false;
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

function shouldDeferRemoteApply() {
  return hasUnsyncedLocalChanges() || isUserEditing();
}

function hasMeaningfulSavedData(value) {
  return Boolean(value?.batches?.length || value?.trash?.batches?.length);
}

function isUserEditing() {
  if (editingEventId) return true;
  const active = document.activeElement;
  if (!active) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
}

function keepSelectedBatchIfPossible() {
  if (!state.batches.some((batch) => batch.id === selectedBatchId)) {
    selectedBatchId = state.batches[0]?.id ?? null;
  }
}

function retryDeferredCloudPull() {
  if (!deferredCloudPull || shouldDeferRemoteApply()) return;
  deferredCloudPull = false;
  loadFromCloud({ silent: true, confirmOverwrite: false, onlyIfNewer: true });
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
  const stages = Array.isArray(value?.stages) && value.stages.length ? value.stages : structuredClone(defaultStages);
  defaultStages.forEach((stage) => {
    if (!stages.some((item) => item.key === stage.key)) {
      stages.push(structuredClone(stage));
    }
  });

  const normalized = {
    stages,
    batches: Array.isArray(value?.batches) ? value.batches : [],
    trash: {
      batches: Array.isArray(value?.trash?.batches) ? value.trash.batches : [],
    },
  };
  normalized.batches.forEach(syncBatchDerivedFields);
  normalized.trash.batches.forEach((item) => {
    if (item?.data) syncBatchDerivedFields(item.data);
  });
  normalized.batches = sortBatchesForDisplay(normalized.batches);
  return normalized;
}

function sortBatchesForDisplay(batches) {
  const hasManualOrder = batches.some((batch) => Number.isFinite(batch.order));
  const ordered = hasManualOrder
    ? [...batches].sort((a, b) => {
        const aOrder = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
        const bOrder = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
        return aOrder - bOrder || newestTime(b).localeCompare(newestTime(a));
      })
    : [...batches].sort((a, b) => newestTime(b).localeCompare(newestTime(a)));

  ordered.forEach((batch, index) => {
    batch.order = index;
  });
  return ordered;
}

function persistBatchOrder() {
  state.batches.forEach((batch, index) => {
    batch.order = index;
  });
}

function restoreTrashedBatch(trashId) {
  const item = state.trash.batches.find((entry) => entry.id === trashId);
  if (!item) return;

  const restored = structuredClone(item.data);
  restored.id = state.batches.some((batch) => batch.id === restored.id) ? makeId() : restored.id;
  state.batches.unshift(restored);
  state.trash.batches = state.trash.batches.filter((entry) => entry.id !== trashId);
  persistBatchOrder();
  selectedBatchId = restored.id;
  saveState();
  render();
  showToast("批次已恢复");
}

function deleteTrashedBatch(trashId) {
  const item = state.trash.batches.find((entry) => entry.id === trashId);
  if (!item) return;
  if (!confirm(`确定彻底删除「${item.data.name}」吗？这个操作不能从回收站恢复。`)) return;

  state.trash.batches = state.trash.batches.filter((entry) => entry.id !== trashId);
  saveState();
  render();
  showToast("批次已彻底删除");
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
  batch.signedNumbers = uniqueValues(batch.signedNumbers || []);
  if (batch.signedNumbers.length && batch.numbers.length) {
    const signedSet = new Set(batch.signedNumbers);
    batch.numbers = batch.numbers.filter((number) => !signedSet.has(number));
  }
  batch.count = getBatchTicketCount(batch);
  batch.events = Array.isArray(batch.events) ? batch.events : [];
  const newestEvent = latestEvent(batch);
  if (newestEvent) {
    batch.stageKey = newestEvent.stageKey;
  }
  return batch;
}

function getSignedUpdateCandidates(batch, numbers) {
  const requested = uniqueValues(numbers);
  const signedNumbers = new Set(uniqueValues(batch?.signedNumbers || []));
  const batchNumbers = new Set(uniqueValues(batch?.numbers || []));
  const result = {
    input: requested,
    ready: [],
    duplicate: [],
    missing: [],
  };

  requested.forEach((number) => {
    if (!batchNumbers.has(number) && !signedNumbers.has(number)) {
      result.missing.push(number);
    } else if (signedNumbers.has(number)) {
      result.duplicate.push(number);
    } else {
      result.ready.push(number);
    }
  });
  return result;
}

function findStageByName(name) {
  const normalized = name.toLowerCase();
  return state.stages.find((stage) => stage.name.toLowerCase() === normalized || stage.key.toLowerCase() === normalized);
}

function sortBatchEvents(batch) {
  batch.events.sort((a, b) => a.time.localeCompare(b.time));
}

function uniqueValues(values) {
  return Array.from(new Set(values.map(normalizeTrackingNumber).filter(Boolean)));
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

function normalizeTrackingNumber(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function parseLines(text) {
  return text
    .split(/[\r\n,，;；\t]+/)
    .map(normalizeTrackingNumber)
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

function sanitizeFilename(value) {
  return String(value || "批次").replace(/[\\/:*?"<>|]+/g, "_").trim() || "批次";
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
