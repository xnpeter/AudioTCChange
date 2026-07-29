import {
  fpsValueEquivalent,
  ixmlRateToFpsValue,
  parseFps,
} from "./timecode.js";
import { recordKey } from "./grouping.js";
import { scanWave } from "./wave.js";
import {
  ixmlFpsMetadataForValue,
  readIxmlChunkBytes,
  restoreFpsMetadata,
  verifyFpsMetadata,
  writeFpsMetadata,
} from "./wave-fps-metadata.js";

function bytesEqual(a, b) {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function createFpsWriteController({
  els,
  getRecords,
  getSelectedRecordKeys,
  getPreviews,
  setPreviews,
  setActiveOffset,
  getLastUndoBatch,
  setLastUndoBatch,
  recordFps,
  recordFpsDisplay,
  fpsSelectLabel,
  samplesToTimecode,
  showConfirmDialog,
  refreshRecordsFromHandles,
  setChangedTimeReferences,
  setState,
  updateWriteProgress,
  renderRows,
  log,
}) {
  function writableWavRecords() {
    return getRecords().filter(record =>
      !record._meta &&
      !record._video &&
      typeof record.fileHandle?.createWritable === "function"
    );
  }

  function selectedWritableRecords() {
    const selected = getSelectedRecordKeys();
    return writableWavRecords().filter(record => selected.has(recordKey(record)));
  }

  function scopedRecords() {
    return els.fpsScopeSelected.checked ? selectedWritableRecords() : writableWavRecords();
  }

  function setApplyMode(isFpsPreview) {
    els.applyBtn.textContent = isFpsPreview ? "写入帧率元数据" : "写入";
    els.applyBtn.title = isFpsPreview ? "写入 iXML 帧率元数据" : "写入";
  }

  function previewIsFpsMetadata() {
    return getPreviews().some(preview => preview.operation === "fps-metadata");
  }

  function metadataFpsLabel(value) {
    const option = Array.from(els.fpsMetadataTarget.options).find(item => item.value === value);
    return option ? `${option.textContent} FPS` : fpsSelectLabel(value);
  }

  function currentFpsSummary(records) {
    const counts = new Map();
    let missing = 0;
    for (const record of records) {
      const value = ixmlRateToFpsValue(record.ixmlInfo);
      if (!value) {
        missing += 1;
        continue;
      }
      const label = metadataFpsLabel(value);
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    return {
      counts: Array.from(counts.entries()).sort((a, b) => b[1] - a[1]),
      missing,
    };
  }

  function renderDialogSummary() {
    const records = scopedRecords();
    const { counts, missing } = currentFpsSummary(records);
    els.fpsMetadataSummary.textContent = "";
    for (const [label, count] of counts) {
      const row = document.createElement("div");
      row.className = "fps-summary-row";
      const name = document.createElement("span");
      name.textContent = `${label} · iXML`;
      const value = document.createElement("span");
      value.textContent = `${count} 个`;
      row.append(name, value);
      els.fpsMetadataSummary.appendChild(row);
    }
    if (missing) {
      const row = document.createElement("div");
      row.className = "fps-summary-row";
      const name = document.createElement("span");
      name.textContent = "未写入帧率 metadata";
      const value = document.createElement("span");
      value.textContent = `${missing} 个`;
      row.append(name, value);
      els.fpsMetadataSummary.appendChild(row);
    }
    if (!records.length) {
      const empty = document.createElement("div");
      empty.textContent = "当前范围内没有可写入的 WAV";
      els.fpsMetadataSummary.appendChild(empty);
    }
    renderExample(records);
  }

  function renderExample(records = scopedRecords()) {
    const record = records[0];
    if (!record) {
      els.fpsMetadataExample.textContent = "没有可预览的 WAV";
      return;
    }
    const oldFps = recordFps(record);
    const targetFps = parseFps(els.fpsMetadataTarget.value);
    const oldTc = samplesToTimecode(record.oldTimeReference, record.sampleRate, oldFps, { wrapDay: true });
    const newTc = samplesToTimecode(record.oldTimeReference, record.sampleRate, targetFps, { wrapDay: true });
    els.fpsMetadataExample.textContent =
      `${oldTc} → ${newTc} · TimeReference ${record.oldTimeReference} samples（不变）`;
  }

  function closeDialog() {
    els.fpsMetadataOverlay.classList.remove("show");
    els.fpsMetadataOverlay.setAttribute("aria-hidden", "true");
    els.fpsMetadataBtn.focus();
  }

  function openDialog() {
    const all = writableWavRecords();
    if (!all.length) throw new Error("列表中没有可直接写入的 WAV 文件");
    const selected = selectedWritableRecords();
    els.fpsScopeSelected.disabled = selected.length === 0;
    els.fpsScopeSelectedLabel.textContent = `已选中的 WAV（${selected.length} 个）`;
    els.fpsScopeAllLabel.textContent = `列表中的全部 WAV（${all.length} 个）`;
    els.fpsScopeSelected.checked = selected.length > 0;
    els.fpsScopeAll.checked = selected.length === 0;
    els.fpsMetadataTarget.value = els.fpsInput.value;
    els.fpsMissingIxmlSkip.checked = true;
    renderDialogSummary();
    els.fpsMetadataOverlay.classList.add("show");
    els.fpsMetadataOverlay.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => els.fpsMetadataTarget.focus());
  }

  function generatePreview() {
    const records = scopedRecords();
    if (!records.length) throw new Error("当前范围内没有可写入的 WAV 文件");
    const targetValue = els.fpsMetadataTarget.value;
    const targetFps = parseFps(targetValue);
    const targetLabel = metadataFpsLabel(targetValue);
    const targetMetadata = ixmlFpsMetadataForValue(targetValue);
    const createIxml = els.fpsMissingIxmlCreate.checked;
    const nextPreviews = records.map(record => {
      const oldValue = ixmlRateToFpsValue(record.ixmlInfo) || "";
      const oldFlag = record.ixmlInfo?.timecodeFlag?.value?.trim().toUpperCase() || "";
      const alreadyMatches = Boolean(
        record.ixmlInfo?.timecodeRate &&
        record.ixmlInfo?.timecodeFlag &&
        oldValue &&
        fpsValueEquivalent(oldValue, targetValue) &&
        oldFlag === targetMetadata.timecodeFlag
      );
      const missingIxml = !record.ixmlInfo;
      const willWrite = !alreadyMatches && (!missingIxml || createIxml);
      const action = alreadyMatches
        ? "unchanged"
        : missingIxml && !createIxml
          ? "skip-missing-ixml"
          : missingIxml
            ? "create-ixml"
            : "update-ixml";
      return {
        ...record,
        operation: "fps-metadata",
        fps: targetFps,
        oldFps: recordFps(record),
        fpsValue: targetValue,
        fpsTargetValue: targetValue,
        fpsTargetLabel: targetLabel,
        fpsOldValue: oldValue,
        fpsOldDisplay: recordFpsDisplay(record),
        fpsDisplay: `${recordFpsDisplay(record)} → ${targetLabel}`,
        fpsSource: "FPS预览",
        fpsAction: action,
        fpsWillWrite: willWrite,
        createIxml: missingIxml && createIxml,
        sampleOffset: 0n,
        newTimeReference: record.oldTimeReference,
      };
    });

    setPreviews(nextPreviews);
    setActiveOffset(null);
    setChangedTimeReferences(new Map());
    setApplyMode(true);
    const writeCount = nextPreviews.filter(preview => preview.fpsWillWrite).length;
    els.applyBtn.disabled = writeCount === 0;
    renderRows();
    closeDialog();
    setState(writeCount ? "可写入FPS" : "无需更改", writeCount ? "warn" : "ok");
    const skipped = nextPreviews.filter(preview => preview.fpsAction === "skip-missing-ixml").length;
    els.statusLine.textContent = writeCount
      ? `${writeCount} 个 WAV 将写入 ${targetLabel}${skipped ? `；${skipped} 个无 iXML 文件将跳过` : ""}`
      : "当前范围内没有需要写入的帧率元数据";
    log(`FPS Preview OK: ${writeCount}/${nextPreviews.length} writable, target ${targetLabel}, create iXML ${createIxml ? "yes" : "no"}`);
  }

  async function applyChanges() {
    const previews = getPreviews().filter(preview => preview.operation === "fps-metadata");
    const writable = previews.filter(preview => preview.fpsWillWrite);
    if (!writable.length) throw new Error("没有需要写入的帧率元数据");
    const targetLabel = writable[0].fpsTargetLabel;
    const createCount = writable.filter(preview => preview.createIxml).length;
    const confirmed = await showConfirmDialog({
      title: "写入帧率元数据？",
      copy: [
        `将把 <strong>${writable.length} 个 WAV</strong> 的 iXML 帧率修改为 <strong>${targetLabel}</strong>。`,
        createCount ? `其中 <strong>${createCount} 个文件</strong>将创建新的 iXML SPEED。` : "",
        "TimeReference、音频采样率、音频内容和文件时长均保持不变。",
      ].filter(Boolean).join("<br>"),
      confirmText: "写入帧率元数据",
      danger: true,
    });
    if (!confirmed) return;

    setState("FPS写入中", "warn");
    els.applyBtn.disabled = true;
    els.undoBtn.disabled = true;
    els.statusLine.textContent = "Writing FPS metadata...";
    updateWriteProgress("正在写入帧率元数据…", "", 0, writable.length);
    els.progressOverlay.classList.add("show");
    const undoItems = [];

    try {
      for (let i = 0; i < writable.length; i++) {
        const preview = writable[i];
        updateWriteProgress("正在写入帧率元数据…", preview.name, i, writable.length);
        const undoItem = await writeFpsMetadata(preview, preview.fpsTargetValue, {
          createIxml: preview.createIxml,
        });
        undoItems.push(undoItem);
        updateWriteProgress("正在写入帧率元数据…", preview.name, i + 1, writable.length);
      }

      updateWriteProgress("正在校验…", "校验 FPS 与 TimeReference", writable.length, writable.length);
      for (const preview of writable) {
        const fresh = await scanWave(preview.fileHandle);
        verifyFpsMetadata(fresh, preview.fpsTargetValue, preview.oldTimeReference, preview.name, {
          sampleRate: preview.sampleRate,
          dataSize: preview.dataSize,
        });
      }

      setLastUndoBatch({ type: "fps-metadata", items: undoItems });
      setPreviews([]);
      setActiveOffset(null);
      setChangedTimeReferences(new Map());
      setApplyMode(false);
      await refreshRecordsFromHandles();
      renderRows();
      els.undoBtn.disabled = false;
      setState("FPS已更改");
      els.statusLine.textContent = `帧率元数据写入完成：${writable.length} 个 WAV → ${targetLabel}`;
      log(`FPS Write OK: ${writable.length} files -> ${targetLabel}`);
      els.toast.textContent = `✅ 帧率元数据写入完成 — ${writable.length} 个文件`;
      els.toast.classList.add("show");
      setTimeout(() => els.toast.classList.remove("show"), 4500);
    } catch (error) {
      if (undoItems.length) {
        setLastUndoBatch({ type: "fps-metadata", items: undoItems });
        els.undoBtn.disabled = false;
        await refreshRecordsFromHandles();
        renderRows();
      }
      throw error;
    } finally {
      els.progressOverlay.classList.remove("show");
      updateWriteProgress("正在写入…", "", 0, 1);
      els.undoBtn.disabled = !getLastUndoBatch();
    }
  }

  async function undoLastWrite() {
    const batch = getLastUndoBatch();
    if (batch?.type !== "fps-metadata") throw new Error("没有可撤销的帧率元数据写入");
    const items = batch.items;
    setState("撤销FPS中", "warn");
    els.applyBtn.disabled = true;
    els.undoBtn.disabled = true;
    updateWriteProgress("正在撤销帧率元数据…", "", 0, items.length);
    els.progressOverlay.classList.add("show");

    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        updateWriteProgress("正在撤销帧率元数据…", item.name, i, items.length);
        await restoreFpsMetadata(item);
        updateWriteProgress("正在撤销帧率元数据…", item.name, i + 1, items.length);
      }
      updateWriteProgress("正在校验…", "校验原始 iXML", items.length, items.length);
      for (const item of items) {
        const fresh = await scanWave(item.fileHandle);
        if (fresh.oldTimeReference !== item.oldTimeReference) {
          throw new Error(`${item.name}: 撤销后 TimeReference 不一致`);
        }
        if (item.originalIxmlBytes === null) {
          if (fresh.ixmlInfo) throw new Error(`${item.name}: 新建 iXML 未能移除`);
        } else {
          const currentBytes = await readIxmlChunkBytes(fresh);
          if (!bytesEqual(currentBytes, item.originalIxmlBytes)) {
            throw new Error(`${item.name}: 原始 iXML 恢复校验失败`);
          }
        }
      }

      setLastUndoBatch(null);
      setPreviews([]);
      setActiveOffset(null);
      setChangedTimeReferences(new Map());
      setApplyMode(false);
      await refreshRecordsFromHandles();
      renderRows();
      setState("FPS已撤销");
      els.statusLine.textContent = "已撤销上一次帧率元数据写入";
      log(`FPS Undo OK: ${items.length} files`);
      els.toast.textContent = "↩ 帧率元数据撤销完成";
      els.toast.classList.add("show");
      setTimeout(() => els.toast.classList.remove("show"), 3500);
    } finally {
      els.progressOverlay.classList.remove("show");
      updateWriteProgress("正在写入…", "", 0, 1);
      els.undoBtn.disabled = !getLastUndoBatch();
    }
  }

  function resetPreviewMode() {
    setApplyMode(false);
  }

  function bindEvents({ guarded }) {
    els.fpsMetadataBtn.addEventListener("click", () => guarded(openDialog));
    els.fpsMetadataCancelBtn.addEventListener("click", closeDialog);
    els.fpsMetadataPreviewBtn.addEventListener("click", () => guarded(generatePreview));
    els.fpsScopeSelected.addEventListener("change", renderDialogSummary);
    els.fpsScopeAll.addEventListener("change", renderDialogSummary);
    els.fpsMetadataTarget.addEventListener("change", () => renderExample());
    els.fpsMissingIxmlSkip.addEventListener("change", () => renderExample());
    els.fpsMissingIxmlCreate.addEventListener("change", () => renderExample());
    els.fpsMetadataOverlay.addEventListener("click", event => {
      if (event.target === els.fpsMetadataOverlay) closeDialog();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && els.fpsMetadataOverlay.classList.contains("show")) closeDialog();
    });
  }

  return {
    applyChanges,
    bindEvents,
    openDialog,
    previewIsFpsMetadata,
    resetPreviewMode,
    undoLastWrite,
  };
}
