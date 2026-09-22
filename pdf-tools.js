/**
 * PDF LAB — Client-side Working PDF Tools
 * 100% Local-only processing, 0 external network requests
 * Tools:
 *  - merge-pdf (รวม PDF)
 *  - split-pdf (แยก PDF)
 *  - organize-pdf (จัดหน้า PDF)
 *  - pdf-to-image (PDF → รูปภาพ)
 *  - page-number (ใส่เลขหน้า)
 *  - ocr-pdf (OCR PDF)
 */

(function() {
  'use strict';

  // --- Shared Utilities Access ---
  const utils = () => window.__APP_UTILS__ || {};
  const showToast = (msg, type) => (utils().showToast ? utils().showToast(msg, type) : console.log(msg));
  const downloadBlob = (blob, name) => (utils().downloadBlob ? utils().downloadBlob(blob, name) : null);
  const formatFileSize = (bytes) => (utils().formatFileSize ? utils().formatFileSize(bytes) : `${bytes} B`);
  const showProgressModal = () => utils().showProgressModal && utils().showProgressModal();
  const hideProgressModal = () => utils().hideProgressModal && utils().hideProgressModal();
  const updateProgress = (cur, tot, msg) => utils().updateProgress && utils().updateProgress(cur, tot, msg);

  // --- Helper: Read PDF and detect encryption/password ---
  async function loadPdfDocument(fileOrBlob) {
    let buffer;
    if (fileOrBlob instanceof ArrayBuffer) {
      buffer = fileOrBlob;
    } else {
      buffer = await fileOrBlob.arrayBuffer();
    }

    try {
      if (!window.PDFLib || !window.PDFLib.PDFDocument) {
        throw new Error('ไลบรารี PDF-Lib ไม่พร้อมใช้งาน');
      }
      const pdfDoc = await window.PDFLib.PDFDocument.load(buffer, { ignoreEncryption: false });
      return { buffer, pdfDoc, pageCount: pdfDoc.getPageCount() };
    } catch (err) {
      const msg = (err.message || '').toLowerCase();
      if (msg.includes('encrypt') || msg.includes('password') || err.name === 'EncryptedPDFError') {
        throw new Error('ไฟล์นี้มีการเข้ารหัสด้วยรหัสผ่าน ไม่สามารถประมวลผลได้');
      }
      throw new Error('ไม่สามารถเปิดไฟล์ PDF นี้ได้ ไฟล์อาจเสียหายหรือไม่สมบูรณ์');
    }
  }

  // --- Helper: Render PDF Page to Canvas / DataURL ---
  async function renderPdfThumbnail(buffer, pageNum = 1, scale = 0.35) {
    if (!window.pdfjsLib) {
      throw new Error('PDF.js renderer not loaded');
    }
    const loadingTask = window.pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    canvas.width = 0;
    canvas.height = 0;
    return dataUrl;
  }

  // --- Helper: Render Full Page to Canvas ---
  async function renderPdfPageFull(buffer, pageNum = 1, scale = 2.0) {
    if (!window.pdfjsLib) throw new Error('PDF.js not loaded');
    const loadingTask = window.pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  }

  // --- Helper: Get Image Dimensions from Object URL ---
  function getImageDimensions(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error('Image failed to load'));
      img.src = url;
    });
  }

  // --- Helper: Parse Range String (e.g. "1-3, 5, 8-10") ---
  function parsePageRange(rangeStr, maxPages) {
    const selected = new Set();
    if (!rangeStr || !rangeStr.trim()) return selected;
    const parts = rangeStr.split(',');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (trimmed.includes('-')) {
        const [startStr, endStr] = trimmed.split('-');
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        if (!isNaN(start) && !isNaN(end)) {
          const from = Math.max(1, Math.min(start, end));
          const to = Math.min(maxPages, Math.max(start, end));
          for (let i = from; i <= to; i++) selected.add(i);
        }
      } else {
        const p = parseInt(trimmed, 10);
        if (!isNaN(p) && p >= 1 && p <= maxPages) {
          selected.add(p);
        }
      }
    }
    return selected;
  }

  // ==========================================================================
  // TOOL 2: รวม PDF (Merge PDF)
  // ==========================================================================
  const mergeState = {
    files: [], // Array of { id, file, name, size, pageCount, buffer, coverDataUrl }
    pages: [], // Array of { id, fileId, fileName, originalPageNum, rotation, dataUrl }
    sortable: null,
    hasCustomPageDrag: false,
    viewMode: 'cover' // 'cover' | 'all-pages' (Default: 'cover')
  };

  function initMergeTool() {
    const fileInput = document.getElementById('fileInputMerge');
    const dropZone = document.getElementById('mergeDropZone');
    const btnSelect = document.getElementById('btnSelectMergePdf');
    const btnAddMore = document.getElementById('btnAddMoreMergePdf');
    const btnClear = document.getElementById('btnClearMergePdf');
    const btnExecute = document.getElementById('btnExecuteMerge');
    const btnCover = document.getElementById('btnMergeViewCover');
    const btnAll = document.getElementById('btnMergeViewAllPages');

    if (!fileInput || !dropZone) return;

    btnSelect?.addEventListener('click', () => fileInput.click());
    btnAddMore?.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('click', (e) => {
      if (e.target.closest('#btnSelectMergePdf')) return;
      fileInput.click();
    });

    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) await handleMergeFiles(files);
      fileInput.value = '';
    });

    setupDropZoneEvents(dropZone, async (files) => {
      await handleMergeFiles(files);
    });

    btnCover?.addEventListener('click', () => setMergeViewMode('cover'));
    btnAll?.addEventListener('click', () => setMergeViewMode('all-pages'));

    btnClear?.addEventListener('click', () => {
      mergeState.files = [];
      mergeState.pages = [];
      mergeState.hasCustomPageDrag = false;
      renderMergeUI();
      showToast('ล้างรายการไฟล์ PDF ทั้งหมดแล้ว', 'info');
    });

    btnExecute?.addEventListener('click', executeMerge);
  }

  function setMergeViewMode(mode) {
    if (mergeState.viewMode === mode) return;
    mergeState.viewMode = mode;
    // When switching to all-pages mode without previous custom drag, sync order from files
    if (mode === 'all-pages' && !mergeState.hasCustomPageDrag) {
      syncMergeState();
    }
    renderMergeUI();
  }

  async function handleMergeFiles(files) {
    const pdfFiles = files.filter(f => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf');
    if (pdfFiles.length === 0) {
      showToast('กรุณาเลือกไฟล์เอกสาร PDF เท่านั้น', 'error');
      return;
    }

    showProgressModal();
    updateProgress(0, pdfFiles.length, 'กำลังตรวจสอบไฟล์ PDF...');

    let loaded = 0;
    for (let i = 0; i < pdfFiles.length; i++) {
      const file = pdfFiles[i];
      updateProgress(i + 1, pdfFiles.length, `กำลังอ่าน "${file.name}"...`);
      try {
        const loadedPdf = await loadPdfDocument(file);
        const fileId = 'merge_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        const fileObj = {
          id: fileId,
          file,
          name: file.name,
          size: file.size,
          pageCount: loadedPdf.pageCount,
          buffer: loadedPdf.buffer,
          coverDataUrl: null
        };
        mergeState.files.push(fileObj);

        // Generate individual page records for Visual Page Workspace
        for (let p = 1; p <= loadedPdf.pageCount; p++) {
          mergeState.pages.push({
            id: 'page_' + fileId + '_' + p,
            fileId: fileId,
            fileName: file.name,
            originalPageNum: p,
            rotation: 0,
            dataUrl: null
          });
        }
        loaded++;
      } catch (err) {
        console.warn('Merge PDF Load Error:', err);
        showToast(err.message || `ไม่สามารถเปิด "${file.name}" ได้`, 'error');
      }
    }

    hideProgressModal();
    if (loaded > 0) {
      renderMergeUI();
      showToast(`เพิ่มไฟล์ PDF สำเร็จ ${loaded} ไฟล์`, 'success');
    }
  }

  function syncMergeState() {
    const fileMap = new Map(mergeState.files.map(f => [f.id, f]));
    
    // 1. Remove pages whose fileId is no longer in mergeState.files
    mergeState.pages = mergeState.pages.filter(p => fileMap.has(p.fileId));

    // 2. If there are files with no pages in mergeState.pages (e.g. injected externally), add them
    mergeState.files.forEach(f => {
      const existing = mergeState.pages.filter(p => p.fileId === f.id);
      if (existing.length === 0 && f.pageCount > 0) {
        for (let p = 1; p <= f.pageCount; p++) {
          mergeState.pages.push({
            id: 'page_' + f.id + '_' + p,
            fileId: f.id,
            fileName: f.name,
            originalPageNum: p,
            rotation: 0,
            dataUrl: null
          });
        }
      }
    });

    // 3. If no custom dragging occurred at the page level, sort pages by current file order
    if (!mergeState.hasCustomPageDrag) {
      const fileOrderMap = new Map();
      mergeState.files.forEach((f, idx) => fileOrderMap.set(f.id, idx));
      mergeState.pages.sort((a, b) => {
        const orderA = fileOrderMap.has(a.fileId) ? fileOrderMap.get(a.fileId) : 999;
        const orderB = fileOrderMap.has(b.fileId) ? fileOrderMap.get(b.fileId) : 999;
        if (orderA !== orderB) return orderA - orderB;
        return a.originalPageNum - b.originalPageNum;
      });
    }

    // 4. Keep each file's pageCount property strictly synced with remaining pages in mergeState.pages
    mergeState.files.forEach(f => {
      const remainingCount = mergeState.pages.filter(p => p.fileId === f.id).length;
      f.pageCount = remainingCount;
    });
  }

  function renderMergeUI() {
    syncMergeState();

    const uploadScreen = document.getElementById('mergeUploadScreen');
    const workspaceScreen = document.getElementById('mergeWorkspaceScreen');
    const fileListEl = document.getElementById('mergeFileList');
    const countBadge = document.getElementById('mergeFileCount');
    const summaryFiles = document.getElementById('mergeSummaryFiles');
    const summaryPages = document.getElementById('mergeSummaryPages');
    const btnCover = document.getElementById('btnMergeViewCover');
    const btnAll = document.getElementById('btnMergeViewAllPages');
    const reorderText = document.getElementById('mergeReorderText');

    if (!uploadScreen || !workspaceScreen) return;

    if (mergeState.files.length === 0) {
      uploadScreen.classList.remove('hidden');
      workspaceScreen.classList.add('hidden');
      if (fileListEl) fileListEl.innerHTML = '';
      return;
    }

    uploadScreen.classList.add('hidden');
    workspaceScreen.classList.remove('hidden');

    // Update segmented control buttons state
    if (btnCover && btnAll) {
      const isCover = mergeState.viewMode === 'cover';
      btnCover.classList.toggle('active', isCover);
      btnCover.setAttribute('aria-pressed', String(isCover));
      btnAll.classList.toggle('active', !isCover);
      btnAll.setAttribute('aria-pressed', String(!isCover));
    }

    if (reorderText) {
      reorderText.textContent = mergeState.viewMode === 'cover'
        ? 'ลากการ์ดเพื่อจัดลำดับไฟล์ PDF'
        : 'ลากการ์ดเพื่อจัดลำดับหน้าที่จะรวม';
    }

    const totalPages = mergeState.pages.length;
    if (countBadge) countBadge.textContent = `${mergeState.files.length} ไฟล์ • ${totalPages} หน้า`;
    if (summaryFiles) summaryFiles.textContent = `${mergeState.files.length} ไฟล์`;
    if (summaryPages) summaryPages.textContent = `${totalPages} หน้า`;

    if (!fileListEl) return;
    fileListEl.innerHTML = '';

    // Toggle grid classes for sizing
    fileListEl.classList.toggle('merge-grid-cover', mergeState.viewMode === 'cover');
    fileListEl.classList.toggle('merge-grid-all-pages', mergeState.viewMode === 'all-pages');

    if (mergeState.viewMode === 'cover') {
      renderMergeCoverCards(fileListEl);
    } else {
      renderMergeAllPageCards(fileListEl);
    }
  }

  function renderMergeCoverCards(fileListEl) {
    mergeState.files.forEach((fileObj, idx) => {
      const card = document.createElement('div');
      card.className = 'merge-page-card merge-file-cover-card';
      card.dataset.fileId = fileObj.id;

      card.innerHTML = `
        <div class="merge-card-header">
          <div class="merge-card-header-left">
            <span class="merge-page-badge">#${idx + 1}</span>
            <span class="merge-cover-filename-short" title="${escapeHtml(fileObj.name)}">${escapeHtml(fileObj.name)}</span>
          </div>
          <div class="merge-card-actions">
            <button type="button" class="btn-merge-action btn-merge-delete" title="ลบไฟล์นี้" aria-label="ลบไฟล์ ${escapeHtml(fileObj.name)}">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>

        <div class="merge-card-thumb-frame">
          <div class="merge-thumb-skeleton">กำลังโหลด...</div>
        </div>

        <div class="merge-card-footer">
          <span class="merge-file-tag" title="${fileObj.pageCount} หน้า">${fileObj.pageCount} หน้า</span>
          <span class="merge-file-page-tag">${formatFileSize(fileObj.size)}</span>
        </div>
      `;

      // Delete entire file action
      const btnDelete = card.querySelector('.btn-merge-delete');
      btnDelete.addEventListener('click', (e) => {
        e.stopPropagation();
        const fIdx = mergeState.files.findIndex(f => f.id === fileObj.id);
        if (fIdx !== -1) {
          mergeState.files.splice(fIdx, 1);
          mergeState.pages = mergeState.pages.filter(p => p.fileId !== fileObj.id);
          renderMergeUI();
        }
      });

      fileListEl.appendChild(card);

      // Render cover thumbnail (Page 1)
      const thumbFrame = card.querySelector('.merge-card-thumb-frame');
      if (fileObj.coverDataUrl) {
        thumbFrame.innerHTML = `<img src="${fileObj.coverDataUrl}" alt="${escapeHtml(fileObj.name)}" class="merge-card-thumb-img">`;
      } else if (fileObj.buffer) {
        renderPdfThumbnail(fileObj.buffer, 1, 0.5).then(url => {
          fileObj.coverDataUrl = url;
          if (thumbFrame) {
            thumbFrame.innerHTML = `<img src="${url}" alt="${escapeHtml(fileObj.name)}" class="merge-card-thumb-img">`;
          }
        }).catch(() => {
          if (thumbFrame) {
            thumbFrame.innerHTML = `<span class="preview-err">หน้า 1</span>`;
          }
        });
      }
    });

    // Setup SortableJS for files reordering
    if (window.Sortable) {
      if (mergeState.sortable) mergeState.sortable.destroy();
      mergeState.sortable = new window.Sortable(fileListEl, {
        animation: 150,
        ghostClass: 'sortable-ghost',
        filter: '.btn-merge-action, svg, path',
        preventOnFilter: false,
        onEnd: function(evt) {
          if (evt.oldIndex !== evt.newIndex) {
            const [moved] = mergeState.files.splice(evt.oldIndex, 1);
            mergeState.files.splice(evt.newIndex, 0, moved);
            if (!mergeState.hasCustomPageDrag) {
              syncMergeState();
            }
            renderMergeUI();
          }
        }
      });
    }
  }

  function renderMergeAllPageCards(fileListEl) {
    const fileBufferMap = new Map(mergeState.files.map(f => [f.id, f.buffer]));

    mergeState.pages.forEach((pageItem, idx) => {
      const card = document.createElement('div');
      card.className = 'merge-page-card';
      card.dataset.id = pageItem.id;
      card.dataset.fileId = pageItem.fileId;

      card.innerHTML = `
        <div class="merge-card-header">
          <div class="merge-card-header-left">
            <span class="merge-page-badge">#${idx + 1}</span>
            <span class="merge-orig-page">หน้าเดิม ${pageItem.originalPageNum}</span>
          </div>
          <div class="merge-card-actions">
            <button type="button" class="btn-merge-action btn-merge-rotate" title="หมุนหน้า 90°" aria-label="หมุนหน้า 90°">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
              </svg>
            </button>
            <button type="button" class="btn-merge-action btn-merge-delete" title="ลบหน้านี้" aria-label="ลบหน้านี้">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>

        <div class="merge-card-thumb-frame">
          <div class="merge-thumb-skeleton">กำลังโหลด...</div>
        </div>

        <div class="merge-card-footer">
          <span class="merge-file-tag" title="${escapeHtml(pageItem.fileName)}">${escapeHtml(pageItem.fileName)}</span>
          <span class="merge-file-page-tag">หน้า ${pageItem.originalPageNum}</span>
        </div>
      `;

      // Rotate action
      const btnRotate = card.querySelector('.btn-merge-rotate');
      btnRotate.addEventListener('click', (e) => {
        e.stopPropagation();
        pageItem.rotation = (pageItem.rotation + 90) % 360;
        const img = card.querySelector('.merge-card-thumb-img');
        if (img) img.style.transform = `rotate(${pageItem.rotation}deg)`;
      });

      // Delete action
      const btnDelete = card.querySelector('.btn-merge-delete');
      btnDelete.addEventListener('click', (e) => {
        e.stopPropagation();
        const pIdx = mergeState.pages.findIndex(p => p.id === pageItem.id);
        if (pIdx !== -1) {
          mergeState.pages.splice(pIdx, 1);
          const remainingForFile = mergeState.pages.filter(p => p.fileId === pageItem.fileId);
          if (remainingForFile.length === 0) {
            const fIdx = mergeState.files.findIndex(f => f.id === pageItem.fileId);
            if (fIdx !== -1) mergeState.files.splice(fIdx, 1);
          }
          renderMergeUI();
        }
      });

      fileListEl.appendChild(card);

      // Render or display thumbnail
      const thumbFrame = card.querySelector('.merge-card-thumb-frame');
      if (pageItem.dataUrl) {
        thumbFrame.innerHTML = `<img src="${pageItem.dataUrl}" alt="หน้า ${idx + 1}" class="merge-card-thumb-img" style="transform: rotate(${pageItem.rotation}deg);">`;
      } else {
        const buf = fileBufferMap.get(pageItem.fileId);
        if (buf) {
          renderPdfThumbnail(buf, pageItem.originalPageNum, 0.35).then(url => {
            pageItem.dataUrl = url;
            if (thumbFrame) {
              thumbFrame.innerHTML = `<img src="${url}" alt="หน้า ${idx + 1}" class="merge-card-thumb-img" style="transform: rotate(${pageItem.rotation}deg);">`;
            }
          }).catch(() => {
            if (thumbFrame) {
              thumbFrame.innerHTML = `<span class="preview-err">หน้า ${pageItem.originalPageNum}</span>`;
            }
          });
        }
      }
    });

    // Setup SortableJS for drag reorder
    if (window.Sortable) {
      if (mergeState.sortable) mergeState.sortable.destroy();
      mergeState.sortable = new window.Sortable(fileListEl, {
        animation: 150,
        ghostClass: 'sortable-ghost',
        filter: '.btn-merge-action, svg, path',
        preventOnFilter: false,
        onEnd: function(evt) {
          if (evt.oldIndex !== evt.newIndex) {
            const [moved] = mergeState.pages.splice(evt.oldIndex, 1);
            mergeState.pages.splice(evt.newIndex, 0, moved);
            mergeState.hasCustomPageDrag = true;
            renderMergeUI();
          }
        }
      });
    }
  }

  async function executeMerge() {
    syncMergeState();

    if (mergeState.files.length < 1) {
      showToast('กรุณาเพิ่มไฟล์ PDF ก่อนทำการรวม', 'error');
      return;
    }

    const filenameInput = document.getElementById('mergeOutputFilename');
    let rawName = (filenameInput?.value || 'merged').trim();
    if (rawName.toLowerCase().endsWith('.pdf')) rawName = rawName.slice(0, -4);
    const filename = `${rawName || 'merged'}.pdf`;

    showProgressModal();
    try {
      const mergedPdf = await window.PDFLib.PDFDocument.create();

      // Pre-load all source PDF documents
      const loadedDocs = new Map();
      for (const item of mergeState.files) {
        if (!loadedDocs.has(item.id)) {
          const doc = await window.PDFLib.PDFDocument.load(item.buffer);
          loadedDocs.set(item.id, doc);
        }
      }

      if (mergeState.viewMode === 'cover') {
        // Mode 1: Cover Mode - iterate files in order
        let totalPages = 0;
        for (const f of mergeState.files) {
          totalPages += f.pageCount;
        }

        let copiedCount = 0;
        for (let fIdx = 0; fIdx < mergeState.files.length; fIdx++) {
          const fileItem = mergeState.files[fIdx];
          const srcDoc = loadedDocs.get(fileItem.id);
          if (!srcDoc) continue;

          // Find pages belonging to this file from mergeState.pages
          const filePages = mergeState.pages.filter(p => p.fileId === fileItem.id);
          const pagesToCopy = filePages.length > 0 ? filePages : Array.from({ length: fileItem.pageCount }, (_, i) => ({
            originalPageNum: i + 1,
            rotation: 0
          }));

          for (const p of pagesToCopy) {
            copiedCount++;
            updateProgress(copiedCount, totalPages, `กำลังรวมหน้า ${copiedCount} จาก ${totalPages}...`);
            const [copiedPage] = await mergedPdf.copyPages(srcDoc, [p.originalPageNum - 1]);
            if (p.rotation) {
              const curRot = copiedPage.getRotation().angle;
              copiedPage.setRotation(window.PDFLib.degrees((curRot + p.rotation) % 360));
            }
            mergedPdf.addPage(copiedPage);
          }
          if (fIdx % 2 === 0) await new Promise(r => setTimeout(r, 0));
        }
      } else {
        // Mode 2: All Pages Mode - iterate pages in user's custom page order
        const totalPages = mergeState.pages.length;
        for (let i = 0; i < totalPages; i++) {
          const pageItem = mergeState.pages[i];
          updateProgress(i + 1, totalPages, `กำลังรวมหน้า ${i + 1} จาก ${totalPages}...`);
          const srcDoc = loadedDocs.get(pageItem.fileId);
          if (srcDoc) {
            const [copiedPage] = await mergedPdf.copyPages(srcDoc, [pageItem.originalPageNum - 1]);
            if (pageItem.rotation) {
              const curRot = copiedPage.getRotation().angle;
              copiedPage.setRotation(window.PDFLib.degrees((curRot + pageItem.rotation) % 360));
            }
            mergedPdf.addPage(copiedPage);
          }
          if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
        }
      }

      updateProgress(mergedPdf.getPageCount(), mergedPdf.getPageCount(), 'กำลังจัดทำไฟล์ PDF รวม...');
      const mergedBytes = await mergedPdf.save();
      downloadBlob(new Blob([mergedBytes], { type: 'application/pdf' }), filename);
      hideProgressModal();
      showToast(`รวม PDF สำเร็จ (${mergedPdf.getPageCount()} หน้า) กำลังเริ่มดาวน์โหลด...`, 'success');
    } catch (err) {
      console.warn('Merge execution error:', err);
      hideProgressModal();
      showToast('เกิดข้อผิดพลาดในการรวมไฟล์: ' + err.message, 'error');
    }
  }

  // ==========================================================================
  // ==========================================================================
  // TOOL 3: แยก PDF (Split / Extract PDF)
  // ==========================================================================
  const splitState = {
    file: null,
    buffer: null,
    totalPages: 0,
    selectedPages: new Set(),
    splitMode: 'select', // 'all-pages' | 'select' | 'ranges'
    ranges: [{ start: 1, end: 1 }],
    combineRanges: false
  };

  function initSplitTool() {
    const fileInput = document.getElementById('fileInputSplit');
    const dropZone = document.getElementById('splitDropZone');
    const btnSelect = document.getElementById('btnSelectSplitPdf');
    const btnClear = document.getElementById('btnClearSplitPdf');
    const btnSelectAll = document.getElementById('btnSplitSelectAll');
    const btnDeselectAll = document.getElementById('btnSplitDeselectAll');
    const btnApplyRange = document.getElementById('btnSplitApplyRange');
    const rangeInput = document.getElementById('splitRangeInput');
    const btnExecute = document.getElementById('btnExecuteSplit');

    const btnModeAllPages = document.getElementById('btnSplitModeAllPages');
    const btnModeSelect = document.getElementById('btnSplitModeSelect');
    const btnModeRanges = document.getElementById('btnSplitModeRanges');
    const btnAddRange = document.getElementById('btnAddSplitRange');
    const combineCheckbox = document.getElementById('splitCombineRanges');
    const filenameInput = document.getElementById('splitOutputFilename');

    if (!fileInput || !dropZone) return;

    btnSelect?.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('click', (e) => {
      if (e.target.closest('#btnSelectSplitPdf')) return;
      fileInput.click();
    });

    fileInput.addEventListener('change', async (e) => {
      const file = (e.target.files || [])[0];
      if (file) await handleSplitFile(file);
      fileInput.value = '';
    });

    setupDropZoneEvents(dropZone, async (files) => {
      if (files[0]) await handleSplitFile(files[0]);
    });

    btnClear?.addEventListener('click', () => {
      splitThumbnailCache.clear();
      splitState.file = null;
      splitState.buffer = null;
      splitState.totalPages = 0;
      splitState.selectedPages.clear();
      splitState.ranges = [{ start: 1, end: 1 }];
      splitState.combineRanges = false;
      splitState.splitMode = 'select';
      const cb = document.getElementById('splitCombineRanges');
      if (cb) cb.checked = false;
      renderSplitUI();
      setSplitMode('select');
    });

    btnSelectAll?.addEventListener('click', () => {
      for (let i = 1; i <= splitState.totalPages; i++) splitState.selectedPages.add(i);
      updateSplitSelections();
    });

    btnDeselectAll?.addEventListener('click', () => {
      splitState.selectedPages.clear();
      updateSplitSelections();
    });

    btnApplyRange?.addEventListener('click', () => {
      const rangeVal = rangeInput?.value || '';
      const parsed = parsePageRange(rangeVal, splitState.totalPages);
      if (parsed.size === 0) {
        showToast('กรุณาระบุช่วงหน้าที่ถูกต้อง เช่น 1-3, 5', 'error');
        return;
      }
      splitState.selectedPages = parsed;
      updateSplitSelections();
      showToast(`เลือกแล้ว ${parsed.size} หน้า`, 'info');
    });

    btnModeAllPages?.addEventListener('click', () => setSplitMode('all-pages'));
    btnModeSelect?.addEventListener('click', () => setSplitMode('select'));
    btnModeRanges?.addEventListener('click', () => setSplitMode('ranges'));

    btnAddRange?.addEventListener('click', () => addRangeRow());

    combineCheckbox?.addEventListener('change', (e) => {
      splitState.combineRanges = e.target.checked;
      checkRangeOverlap();
      updateSplitModeUI();
      if (splitState.splitMode === 'ranges') renderRangesPreview();
    });

    filenameInput?.addEventListener('input', () => {
      filenameInput.dataset.autoName = 'custom';
    });

    btnExecute?.addEventListener('click', executeSplit);
  }

  const splitThumbnailCache = new Map();

  function getCachedThumbnail(pageNum) {
    if (splitThumbnailCache.has(pageNum)) {
      return Promise.resolve(splitThumbnailCache.get(pageNum));
    }
    return renderPdfThumbnail(splitState.buffer, pageNum, 0.35).then(dataUrl => {
      splitThumbnailCache.set(pageNum, dataUrl);
      return dataUrl;
    });
  }

  function setSplitMode(mode) {
    if (!['all-pages', 'select', 'ranges'].includes(mode)) return;
    splitState.splitMode = mode;

    const btnAllPages = document.getElementById('btnSplitModeAllPages');
    const btnSelect = document.getElementById('btnSplitModeSelect');
    const btnRanges = document.getElementById('btnSplitModeRanges');

    btnAllPages?.classList.toggle('active', mode === 'all-pages');
    btnAllPages?.setAttribute('aria-pressed', String(mode === 'all-pages'));
    btnSelect?.classList.toggle('active', mode === 'select');
    btnSelect?.setAttribute('aria-pressed', String(mode === 'select'));
    btnRanges?.classList.toggle('active', mode === 'ranges');
    btnRanges?.setAttribute('aria-pressed', String(mode === 'ranges'));

    const banner = document.getElementById('splitAllPagesBanner');
    const rangesBanner = document.getElementById('splitRangesBanner');
    const workspaceHint = document.getElementById('splitWorkspaceHint');

    if (banner) banner.classList.toggle('hidden', mode !== 'all-pages');
    if (rangesBanner) rangesBanner.classList.toggle('hidden', mode !== 'ranges');

    if (workspaceHint) {
      if (mode === 'all-pages') {
        workspaceHint.textContent = 'แสดงตัวอย่างทุกหน้า (แยกออกเป็นไฟล์ละ 1 หน้า)';
      } else if (mode === 'select') {
        workspaceHint.textContent = 'คลิกที่หน้าเพื่อเลือกหรือยกเลิกการเลือก';
      } else if (mode === 'ranges') {
        workspaceHint.textContent = 'แสดงตัวอย่างหน้าตามช่วงที่กำหนดในแถบด้านขวา';
      }
    }

    const panelAllPages = document.getElementById('splitPanelAllPages');
    const panelSelect = document.getElementById('splitPanelSelect');
    const panelRanges = document.getElementById('splitPanelRanges');

    if (panelAllPages) panelAllPages.classList.toggle('hidden', mode !== 'all-pages');
    if (panelSelect) panelSelect.classList.toggle('hidden', mode !== 'select');
    if (panelRanges) panelRanges.classList.toggle('hidden', mode !== 'ranges');

    const grid = document.getElementById('splitThumbnailGrid');
    const rangesPreview = document.getElementById('splitRangesPreview');

    // In ranges mode, keep all pages thumbnail grid visible with live range highlighting
    if (grid) grid.classList.remove('hidden');
    if (rangesPreview) rangesPreview.classList.add('hidden');

    if (mode === 'ranges') {
      renderRangeRows();
      renderRangesPreview();
    }

    updateSplitModeUI();
    updateSplitGridHighlights();
  }

  function updateSplitModeUI() {
    const title = document.getElementById('splitSettingsTitle');
    const summaryLabel = document.getElementById('splitSummaryLabel');
    const summaryVal = document.getElementById('splitSummarySelected');
    const filenameLabel = document.getElementById('splitOutputFilenameLabel');
    const filenameInput = document.getElementById('splitOutputFilename');
    const extSpan = document.getElementById('splitOutputExt');
    const btnText = document.getElementById('btnExecuteSplitText');
    const allPagesTotal = document.getElementById('splitAllPagesTotal');
    const rangesCount = document.getElementById('splitRangesCount');
    const rangesFilePages = document.getElementById('splitRangesFilePages');
    const rangesTotalPages = document.getElementById('splitRangesTotalPages');
    const btnExecute = document.getElementById('btnExecuteSplit');

    if (allPagesTotal) allPagesTotal.textContent = `${splitState.totalPages} หน้า`;
    if (rangesFilePages) rangesFilePages.textContent = `${splitState.totalPages} หน้า`;
    if (rangesCount) rangesCount.textContent = `${splitState.ranges.length} ช่วง`;

    const baseName = splitState.file ? splitState.file.name.replace(/\.[^/.]+$/, '') : 'document';
    const isCustom = filenameInput?.dataset.autoName === 'custom';

    if (splitState.splitMode === 'all-pages') {
      if (btnExecute) btnExecute.disabled = false;
      if (title) title.textContent = 'แยกทุกหน้าเป็นไฟล์';
      if (summaryLabel) summaryLabel.textContent = 'จำนวนหน้าทั้งหมด:';
      if (summaryVal) summaryVal.textContent = `${splitState.totalPages} หน้า (${splitState.totalPages} ไฟล์)`;
      if (filenameLabel) filenameLabel.textContent = 'ชื่อไฟล์ ZIP';
      if (extSpan) extSpan.textContent = '.zip';
      if (btnText) btnText.textContent = 'แยกทุกหน้าเป็น ZIP';
      if (filenameInput && !isCustom) {
        filenameInput.value = `${baseName}-split-pages`;
      }
    } else if (splitState.splitMode === 'select') {
      if (btnExecute) btnExecute.disabled = splitState.selectedPages.size === 0;
      if (title) title.textContent = 'แยกหน้าที่เลือก';
      if (summaryLabel) summaryLabel.textContent = 'หน้าที่เลือก:';
      if (summaryVal) summaryVal.textContent = `เลือกแล้ว ${splitState.selectedPages.size} จาก ${splitState.totalPages} หน้า`;
      if (filenameLabel) filenameLabel.textContent = 'ชื่อไฟล์ปลายทาง';
      if (extSpan) extSpan.textContent = '.pdf';
      if (btnText) btnText.textContent = 'แยก PDF';
      if (filenameInput && !isCustom) {
        filenameInput.value = 'selected-pages';
      }
    } else if (splitState.splitMode === 'ranges') {
      if (title) title.textContent = 'แยกเป็นช่วง';

      // Calculate total included pages
      let totalPagesIncluded = 0;
      if (splitState.combineRanges) {
        const uniquePages = new Set();
        splitState.ranges.forEach(r => {
          const v = validateRange(r);
          if (v.valid) {
            for (let p = r.start; p <= r.end; p++) uniquePages.add(p);
          }
        });
        totalPagesIncluded = uniquePages.size;
      } else {
        splitState.ranges.forEach(r => {
          const v = validateRange(r);
          if (v.valid) totalPagesIncluded += (r.end - r.start + 1);
        });
      }
      if (rangesTotalPages) rangesTotalPages.textContent = `${totalPagesIncluded} หน้า`;

      const validRanges = splitState.ranges.filter(r => validateRange(r).valid);
      const rangeSlug = validRanges.length > 0
        ? validRanges.map(r => `${r.start}-${r.end}`).join('-')
        : '';
      const defaultRangeName = rangeSlug ? `range-${rangeSlug}` : `${baseName}-ranges`;

      if (splitState.combineRanges) {
        if (filenameLabel) filenameLabel.textContent = 'ชื่อไฟล์ปลายทาง';
        if (extSpan) extSpan.textContent = '.pdf';
        if (btnText) btnText.textContent = 'แยก PDF';
        if (filenameInput && !isCustom) {
          filenameInput.value = defaultRangeName;
        }
      } else {
        const isSingle = splitState.ranges.length === 1;
        if (filenameLabel) filenameLabel.textContent = isSingle ? 'ชื่อไฟล์ปลายทาง' : 'ชื่อไฟล์ ZIP';
        if (extSpan) extSpan.textContent = isSingle ? '.pdf' : '.zip';
        if (btnText) btnText.textContent = 'แยก PDF';
        if (filenameInput && !isCustom) {
          filenameInput.value = defaultRangeName;
        }
      }

      // Disabled if any range is invalid
      const anyInvalid = splitState.ranges.length === 0 || splitState.ranges.some(r => !validateRange(r).valid);
      if (btnExecute) {
        btnExecute.disabled = anyInvalid;
      }
    }
  }

  function validateRange(range) {
    const start = parseInt(range.start, 10);
    const end = parseInt(range.end, 10);

    if (isNaN(start) || isNaN(end)) {
      return { valid: false, error: 'กรุณาระบุเลขหน้าที่ถูกต้อง' };
    }
    if (start < 1) {
      return { valid: false, error: 'หน้าเริ่มต้นต้องไม่น้อยกว่า 1' };
    }
    if (end < 1) {
      return { valid: false, error: 'หน้าสิ้นสุดต้องไม่น้อยกว่า 1' };
    }
    if (start > splitState.totalPages) {
      return { valid: false, error: `หน้า ${start} ไม่มีอยู่ในไฟล์นี้` };
    }
    if (end > splitState.totalPages) {
      return { valid: false, error: `หน้า ${end} ไม่มีอยู่ในไฟล์นี้` };
    }
    if (start > end) {
      return { valid: false, error: 'หน้าสิ้นสุดต้องมากกว่าหรือเท่ากับหน้าเริ่มต้น' };
    }
    return { valid: true, error: '', count: end - start + 1 };
  }

  function checkRangeOverlap() {
    const warningEl = document.getElementById('splitOverlapWarning');
    if (!warningEl) return false;

    const pageCounts = new Map();
    let hasOverlap = false;

    for (const r of splitState.ranges) {
      const v = validateRange(r);
      if (!v.valid) continue;
      for (let p = r.start; p <= r.end; p++) {
        const count = (pageCounts.get(p) || 0) + 1;
        pageCounts.set(p, count);
        if (count > 1) {
          hasOverlap = true;
        }
      }
    }

    if (hasOverlap) {
      warningEl.classList.remove('hidden');
      const textSpan = warningEl.querySelector('span');
      if (textSpan) {
        if (splitState.combineRanges) {
          textSpan.textContent = '⚠️ มีช่วงที่ซ้อนกัน ระบบจะไม่เพิ่มหน้าซ้ำในไฟล์ผลลัพธ์ (รวมแบบ Deduplicate)';
        } else {
          textSpan.textContent = 'ℹ️ มีช่วงที่ซ้อนกัน แต่ละไฟล์จะคงหน้าที่ระบุไว้ตามช่วง';
        }
      }
    } else {
      warningEl.classList.add('hidden');
    }

    return hasOverlap;
  }

  function renderRangeRows() {
    const container = document.getElementById('splitRangeRows');
    if (!container) return;

    container.innerHTML = '';
    const canDelete = splitState.ranges.length > 1;

    splitState.ranges.forEach((range, idx) => {
      const validation = validateRange(range);
      const row = document.createElement('div');
      row.className = 'range-row' + (validation.valid ? '' : ' has-error');
      row.dataset.index = String(idx);

      row.innerHTML = `
        <div class="range-row-header">
          <span class="range-row-num">ช่วงที่ ${idx + 1}</span>
          ${canDelete ? `
            <button type="button" class="btn btn-ghost btn-sm btn-range-remove" data-index="${idx}" aria-label="ลบช่วงที่ ${idx + 1}" title="ลบช่วงนี้">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              <span>ลบ</span>
            </button>
          ` : ''}
        </div>
        <div class="range-inputs">
          <div class="range-field">
            <label class="range-label" for="rangeStart_${idx}">จากหน้า</label>
            <input type="number" id="rangeStart_${idx}" class="input-text range-start-input" min="1" max="${splitState.totalPages}" value="${range.start}">
          </div>
          <span class="range-sep">ถึงหน้า</span>
          <div class="range-field">
            <label class="range-label sr-only" for="rangeEnd_${idx}">ถึงหน้า</label>
            <input type="number" id="rangeEnd_${idx}" class="input-text range-end-input" min="1" max="${splitState.totalPages}" value="${range.end}">
          </div>
        </div>
        <div class="range-row-meta">
          <span class="range-page-count-badge">
            ${validation.valid ? `จำนวน ${range.end - range.start + 1} หน้า` : ''}
          </span>
        </div>
        <div class="range-row-error ${validation.valid ? 'hidden' : ''}" id="rangeError_${idx}" role="alert">
          ${validation.error}
        </div>
      `;

      const startInput = row.querySelector('.range-start-input');
      const endInput = row.querySelector('.range-end-input');

      const onInputChange = () => {
        const sVal = parseInt(startInput.value, 10);
        const eVal = parseInt(endInput.value, 10);
        range.start = isNaN(sVal) ? 0 : sVal;
        range.end = isNaN(eVal) ? 0 : eVal;

        const val = validateRange(range);
        const errEl = row.querySelector('.range-row-error');
        const countBadge = row.querySelector('.range-page-count-badge');
        if (val.valid) {
          row.classList.remove('has-error');
          if (errEl) {
            errEl.textContent = '';
            errEl.classList.add('hidden');
          }
          if (countBadge) {
            countBadge.textContent = `จำนวน ${range.end - range.start + 1} หน้า`;
          }
        } else {
          row.classList.add('has-error');
          if (errEl) {
            errEl.textContent = val.error;
            errEl.classList.remove('hidden');
          }
          if (countBadge) {
            countBadge.textContent = '';
          }
        }
        checkRangeOverlap();
        updateSplitModeUI();
        updateSplitGridHighlights();
        renderRangesPreview();
      };

      startInput?.addEventListener('input', onInputChange);
      endInput?.addEventListener('input', onInputChange);

      const btnRemove = row.querySelector('.btn-range-remove');
      btnRemove?.addEventListener('click', () => {
        removeRangeRow(idx);
      });

      container.appendChild(row);
    });

    checkRangeOverlap();
    updateSplitModeUI();
    updateSplitGridHighlights();
  }

  function addRangeRow() {
    let nextStart = 1;
    if (splitState.ranges.length > 0) {
      const last = splitState.ranges[splitState.ranges.length - 1];
      const lastEnd = parseInt(last.end, 10) || 1;
      if (lastEnd < splitState.totalPages) {
        nextStart = lastEnd + 1;
      } else {
        nextStart = 1;
      }
    }
    const nextEnd = Math.min(splitState.totalPages, nextStart);
    splitState.ranges.push({ start: nextStart, end: nextEnd });
    renderRangeRows();
    renderRangesPreview();
    updateSplitModeUI();
    updateSplitGridHighlights();
  }

  function removeRangeRow(index) {
    if (splitState.ranges.length <= 1) return;
    splitState.ranges.splice(index, 1);
    renderRangeRows();
    renderRangesPreview();
    updateSplitModeUI();
    updateSplitGridHighlights();
  }

  function renderRangesPreview() {
    const container = document.getElementById('splitRangesPreview');
    if (!container) return;

    if (!splitState.file || splitState.totalPages < 1) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = '';

    splitState.ranges.forEach((range, idx) => {
      const v = validateRange(range);
      const groupEl = document.createElement('div');
      groupEl.className = 'split-range-group' + (v.valid ? '' : ' has-error');
      groupEl.dataset.rangeIndex = String(idx);

      const headerEl = document.createElement('div');
      headerEl.className = 'split-range-group-header';
      headerEl.innerHTML = `
        <div class="split-range-group-title">
          <span class="range-group-badge">ช่วงที่ ${idx + 1}</span>
          ${v.valid ? `<span class="range-group-pages">(หน้า ${range.start}${range.start === range.end ? '' : `–${range.end}`})</span>` : ''}
        </div>
        <span class="range-group-count">${v.valid ? `จำนวน ${range.end - range.start + 1} หน้า` : 'ระบุช่วงไม่ถูกต้อง'}</span>
      `;
      groupEl.appendChild(headerEl);

      if (!v.valid) {
        const errorBox = document.createElement('div');
        errorBox.className = 'split-range-group-error-box';
        errorBox.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>${v.error}</span>
        `;
        groupEl.appendChild(errorBox);
      } else {
        const gridEl = document.createElement('div');
        gridEl.className = 'thumbnail-grid split-range-group-grid';

        for (let p = range.start; p <= range.end; p++) {
          const card = document.createElement('div');
          card.className = 'thumb-card split-page-card';
          card.dataset.page = String(p);

          card.innerHTML = `
            <div class="card-preview-area split-preview-area">
              <div class="page-loading-skeleton">กำลังโหลด...</div>
            </div>
            <div class="split-card-footer">
              <span class="page-badge">หน้า ${p}</span>
            </div>
          `;

          gridEl.appendChild(card);

          getCachedThumbnail(p).then(dataUrl => {
            const previewArea = card.querySelector('.card-preview-area');
            if (previewArea) {
              previewArea.innerHTML = `<img src="${dataUrl}" alt="หน้า ${p}" class="card-preview-img">`;
            }
          }).catch(() => {
            const previewArea = card.querySelector('.card-preview-area');
            if (previewArea) previewArea.innerHTML = `<span class="preview-err">หน้า ${p}</span>`;
          });
        }
        groupEl.appendChild(gridEl);
      }

      container.appendChild(groupEl);
    });
  }

  async function handleSplitFile(file) {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      showToast('กรุณาเลือกไฟล์ PDF เท่านั้น', 'error');
      return;
    }

    showProgressModal();
    updateProgress(0, 1, 'กำลังตรวจสอบไฟล์ PDF...');

    try {
      const loaded = await loadPdfDocument(file);
      splitState.file = file;
      splitState.buffer = loaded.buffer;
      splitState.totalPages = loaded.pageCount;
      splitState.selectedPages.clear();
      splitState.splitMode = 'select'; // Preserve backward compatibility by default
      splitState.ranges = [{ start: 1, end: Math.min(loaded.pageCount, 1) }];
      splitState.combineRanges = false;

      const combineCb = document.getElementById('splitCombineRanges');
      if (combineCb) combineCb.checked = false;

      const filenameInput = document.getElementById('splitOutputFilename');
      if (filenameInput) {
        delete filenameInput.dataset.autoName;
        filenameInput.value = 'selected-pages';
      }

      for (let i = 1; i <= loaded.pageCount; i++) {
        splitState.selectedPages.add(i);
      }

      hideProgressModal();
      await renderSplitUI();
      setSplitMode('select');
      showToast(`โหลด PDF สำเร็จ (${loaded.pageCount} หน้า)`, 'success');
    } catch (err) {
      hideProgressModal();
      showToast(err.message || 'ไม่สามารถเปิดไฟล์ PDF นี้ได้', 'error');
    }
  }

  async function renderSplitUI() {
    const uploadScreen = document.getElementById('splitUploadScreen');
    const workspaceScreen = document.getElementById('splitWorkspaceScreen');
    const grid = document.getElementById('splitThumbnailGrid');
    const badge = document.getElementById('splitFileBadge');
    const origName = document.getElementById('splitOriginalName');
    const origName1 = document.getElementById('splitOriginalName1');
    const origName3 = document.getElementById('splitOriginalName3');
    const totalAll = document.getElementById('splitAllPagesTotal');

    if (!uploadScreen || !workspaceScreen) return;

    if (!splitState.file) {
      uploadScreen.classList.remove('hidden');
      workspaceScreen.classList.add('hidden');
      if (grid) grid.innerHTML = '';
      return;
    }

    uploadScreen.classList.add('hidden');
    workspaceScreen.classList.remove('hidden');

    if (badge) badge.textContent = `${splitState.totalPages} หน้า`;
    if (origName) origName.textContent = splitState.file.name;
    if (origName1) origName1.textContent = splitState.file.name;
    if (origName3) origName3.textContent = splitState.file.name;
    if (totalAll) totalAll.textContent = `${splitState.totalPages} หน้า`;

    updateSplitSelections();

    if (grid) {
      grid.innerHTML = '';
      for (let i = 1; i <= splitState.totalPages; i++) {
        const card = document.createElement('div');
        card.className = 'thumb-card page-card-selectable split-page-card' + (splitState.selectedPages.has(i) ? ' selected' : '');
        card.dataset.page = String(i);
        card.setAttribute('role', 'checkbox');
        card.setAttribute('aria-checked', String(splitState.selectedPages.has(i)));
        card.setAttribute('tabindex', '0');

        card.innerHTML = `
          <div class="split-card-header">
            <div class="page-select-checkbox" aria-label="เลือกหน้า ${i}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <span class="range-badge-pill hidden"></span>
          </div>
          <div class="card-preview-area split-preview-area">
            <div class="page-loading-skeleton">กำลังโหลด...</div>
          </div>
          <div class="split-card-footer">
            <span class="page-badge">หน้า ${i}</span>
          </div>
        `;

        const toggle = () => {
          if (splitState.splitMode === 'select') {
            if (splitState.selectedPages.has(i)) {
              splitState.selectedPages.delete(i);
            } else {
              splitState.selectedPages.add(i);
            }
            updateSplitSelections();
          }
        };

        card.addEventListener('click', toggle);
        card.addEventListener('keydown', (e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            toggle();
          }
        });

        grid.appendChild(card);

        renderPdfThumbnail(splitState.buffer, i, 0.35).then(dataUrl => {
          splitThumbnailCache.set(i, dataUrl);
          const previewArea = card.querySelector('.card-preview-area');
          if (previewArea) {
            previewArea.innerHTML = `<img src="${dataUrl}" alt="หน้า ${i}" class="card-preview-img">`;
          }
        }).catch(() => {
          const previewArea = card.querySelector('.card-preview-area');
          if (previewArea) previewArea.innerHTML = `<span class="preview-err">หน้า ${i}</span>`;
        });
      }
    }
  }

  function updateSplitSelections() {
    const summarySelected = document.getElementById('splitSummarySelected');
    if (summarySelected && splitState.splitMode === 'select') {
      summarySelected.textContent = `เลือกแล้ว ${splitState.selectedPages.size} จาก ${splitState.totalPages} หน้า`;
    }
    updateSplitGridHighlights();
  }

  function updateSplitGridHighlights() {
    const grid = document.getElementById('splitThumbnailGrid');
    if (!grid) return;

    grid.classList.toggle('split-grid-all-pages', splitState.splitMode === 'all-pages');
    grid.classList.toggle('split-grid-select', splitState.splitMode === 'select');
    grid.classList.toggle('split-grid-ranges', splitState.splitMode === 'ranges');

    const cards = grid.querySelectorAll('.split-page-card');

    if (splitState.splitMode === 'all-pages') {
      cards.forEach(card => {
        card.classList.remove('selected', 'in-range', 'out-of-range');
        card.setAttribute('aria-checked', 'false');
        const badge = card.querySelector('.range-badge-pill');
        if (badge) badge.classList.add('hidden');
      });
    } else if (splitState.splitMode === 'select') {
      cards.forEach(card => {
        const pageNum = parseInt(card.dataset.page, 10);
        const isSelected = splitState.selectedPages.has(pageNum);
        card.classList.remove('in-range', 'out-of-range');
        card.classList.toggle('selected', isSelected);
        card.setAttribute('aria-checked', String(isSelected));
        const badge = card.querySelector('.range-badge-pill');
        if (badge) badge.classList.add('hidden');
      });
    } else if (splitState.splitMode === 'ranges') {
      const pageToRanges = new Map();
      splitState.ranges.forEach((range, idx) => {
        const v = validateRange(range);
        if (v.valid) {
          for (let p = range.start; p <= range.end; p++) {
            if (!pageToRanges.has(p)) pageToRanges.set(p, []);
            pageToRanges.get(p).push(idx + 1);
          }
        }
      });

      cards.forEach(card => {
        const pageNum = parseInt(card.dataset.page, 10);
        const inRanges = pageToRanges.get(pageNum);
        const badge = card.querySelector('.range-badge-pill');

        if (inRanges && inRanges.length > 0) {
          card.classList.add('in-range');
          card.classList.remove('out-of-range', 'selected');
          if (badge) {
            badge.textContent = inRanges.length === 1 ? `ช่วงที่ ${inRanges[0]}` : `ช่วงที่ ${inRanges.join(', ')}`;
            badge.className = 'range-badge-pill in-range-badge';
          }
        } else {
          card.classList.add('out-of-range');
          card.classList.remove('in-range', 'selected');
          if (badge) {
            badge.textContent = 'ไม่ได้อยู่ในช่วง';
            badge.className = 'range-badge-pill out-of-range-badge';
          }
        }
      });
    }
  }

  async function executeSplit() {
    if (!splitState.file) {
      showToast('กรุณาเลือกไฟล์ PDF ก่อนดำเนินการ', 'error');
      return;
    }

    if (splitState.splitMode === 'all-pages') {
      await executeSplitAllPages();
    } else if (splitState.splitMode === 'ranges') {
      await executeSplitRanges();
    } else {
      await executeSplitSelect();
    }
  }

  async function executeSplitAllPages() {
    if (!splitState.file || splitState.totalPages < 1) {
      showToast('ไม่พบหน้าในเอกสาร PDF', 'error');
      return;
    }

    if (!window.JSZip) {
      showToast('ไลบรารี JSZip ไม่พร้อมใช้งาน', 'error');
      return;
    }

    const baseName = splitState.file.name.replace(/\.[^/.]+$/, '');
    const filenameInput = document.getElementById('splitOutputFilename');
    let rawName = (filenameInput?.value || `${baseName}-split-pages`).trim();
    if (rawName.toLowerCase().endsWith('.zip')) rawName = rawName.slice(0, -4);
    const zipFilename = `${rawName || `${baseName}-split-pages`}.zip`;

    showProgressModal();
    const total = splitState.totalPages;
    updateProgress(0, total, 'กำลังเตรียมแยกหน้าเอกสาร...');

    try {
      const zip = new window.JSZip();
      const srcDoc = await window.PDFLib.PDFDocument.load(splitState.buffer);

      for (let i = 1; i <= total; i++) {
        updateProgress(i, total, `กำลังสร้างไฟล์หน้า ${i} จาก ${total}...`);
        const pageDoc = await window.PDFLib.PDFDocument.create();
        const [copiedPage] = await pageDoc.copyPages(srcDoc, [i - 1]);
        pageDoc.addPage(copiedPage);
        const pdfBytes = await pageDoc.save();
        zip.file(`page-${i}.pdf`, pdfBytes);
        await new Promise(r => setTimeout(r, 0));
      }

      updateProgress(total, total, 'กำลังรวมไฟล์เป็น ZIP...');
      const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      downloadBlob(zipBlob, zipFilename);
      hideProgressModal();
      showToast(`แยกทุกหน้าเป็นไฟล์สำเร็จ (${total} ไฟล์) กำลังดาวน์โหลด ZIP...`, 'success');
    } catch (err) {
      console.warn('Split all-pages execution error:', err);
      hideProgressModal();
      showToast('เกิดข้อผิดพลาดในการแยก PDF: ' + err.message, 'error');
    }
  }

  async function executeSplitRanges() {
    if (!splitState.file || splitState.ranges.length === 0) {
      showToast('กรุณาระบุช่วงหน้าที่ต้องการแยกอย่างน้อย 1 ช่วง', 'error');
      return;
    }

    // Validate all ranges first
    for (let i = 0; i < splitState.ranges.length; i++) {
      const v = validateRange(splitState.ranges[i]);
      if (!v.valid) {
        showToast(v.error, 'error');
        const input = document.getElementById(`rangeStart_${i}`);
        input?.focus();
        return;
      }
    }

    const baseName = splitState.file.name.replace(/\.[^/.]+$/, '');
    const filenameInput = document.getElementById('splitOutputFilename');

    showProgressModal();
    updateProgress(0, 1, 'กำลังเตรียมแยกหน้าตามช่วง...');

    try {
      const srcDoc = await window.PDFLib.PDFDocument.load(splitState.buffer);

      const validRanges = splitState.ranges.filter(r => validateRange(r).valid);
      const rangeSlug = validRanges.length > 0
        ? validRanges.map(r => `${r.start}-${r.end}`).join('-')
        : '';
      const defaultRangeName = rangeSlug ? `range-${rangeSlug}` : `${baseName}-ranges`;

      if (splitState.combineRanges) {
        // Combined mode: Deduplicate overlapping pages in sequence
        let rawName = (filenameInput?.value || defaultRangeName).trim();
        if (rawName.toLowerCase().endsWith('.pdf')) rawName = rawName.slice(0, -4);
        const outPdfName = `${rawName || defaultRangeName}.pdf`;

        const seenPages = new Set();
        const orderedPages = [];
        for (const r of splitState.ranges) {
          for (let p = r.start; p <= r.end; p++) {
            if (!seenPages.has(p)) {
              seenPages.add(p);
              orderedPages.push(p);
            }
          }
        }

        updateProgress(1, 2, `กำลังรวม ${orderedPages.length} หน้าในไฟล์เดียว...`);
        const combinedDoc = await window.PDFLib.PDFDocument.create();
        const indices = orderedPages.map(p => p - 1);
        const copiedPages = await combinedDoc.copyPages(srcDoc, indices);
        copiedPages.forEach(p => combinedDoc.addPage(p));

        const pdfBytes = await combinedDoc.save();
        downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }), outPdfName);
        hideProgressModal();
        showToast(`แยกและรวมช่วงสำเร็จ (${copiedPages.length} หน้า) กำลังดาวน์โหลด...`, 'success');
      } else {
        // Separate files mode: Overlaps ARE preserved
        const isSingle = splitState.ranges.length === 1;

        if (isSingle) {
          const r = splitState.ranges[0];
          let rawName = (filenameInput?.value || `range-${r.start}-${r.end}`).trim();
          if (rawName.toLowerCase().endsWith('.pdf')) rawName = rawName.slice(0, -4);
          const outPdfName = `${rawName || `range-${r.start}-${r.end}`}.pdf`;

          updateProgress(1, 1, 'กำลังสร้างไฟล์ PDF...');
          const rangeDoc = await window.PDFLib.PDFDocument.create();
          const indices = [];
          for (let p = r.start; p <= r.end; p++) indices.push(p - 1);
          const copiedPages = await rangeDoc.copyPages(srcDoc, indices);
          copiedPages.forEach(p => rangeDoc.addPage(p));

          const pdfBytes = await rangeDoc.save();
          downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }), outPdfName);
          hideProgressModal();
          showToast(`แยกช่วง PDF สำเร็จ (${copiedPages.length} หน้า) กำลังดาวน์โหลด...`, 'success');
        } else {
          // Multiple ranges -> Bundle into ZIP
          if (!window.JSZip) {
            showToast('ไลบรารี JSZip ไม่พร้อมใช้งาน', 'error');
            hideProgressModal();
            return;
          }

          let rawName = (filenameInput?.value || defaultRangeName).trim();
          if (rawName.toLowerCase().endsWith('.zip')) rawName = rawName.slice(0, -4);
          const zipName = `${rawName || defaultRangeName}.zip`;

          const zip = new window.JSZip();
          const totalRanges = splitState.ranges.length;

          for (let idx = 0; idx < totalRanges; idx++) {
            const r = splitState.ranges[idx];
            updateProgress(idx + 1, totalRanges, `กำลังสร้างช่วงที่ ${idx + 1} (หน้า ${r.start}-${r.end})...`);
            const rangeDoc = await window.PDFLib.PDFDocument.create();
            const indices = [];
            for (let p = r.start; p <= r.end; p++) indices.push(p - 1);
            const copiedPages = await rangeDoc.copyPages(srcDoc, indices);
            copiedPages.forEach(p => rangeDoc.addPage(p));

            const pdfBytes = await rangeDoc.save();
            const countIdenticalBefore = splitState.ranges.filter((x, i) => i < idx && x.start === r.start && x.end === r.end).length;
            const itemFname = `range-${r.start}-${r.end}${countIdenticalBefore ? `-${countIdenticalBefore + 1}` : ''}.pdf`;
            zip.file(itemFname, pdfBytes);
            await new Promise(res => setTimeout(res, 0));
          }

          updateProgress(totalRanges, totalRanges, 'กำลังรวมช่วงทั้งหมดเป็น ZIP...');
          const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
          downloadBlob(zipBlob, zipName);
          hideProgressModal();
          showToast(`แยกช่วง PDF สำเร็จ (${totalRanges} ไฟล์) กำลังดาวน์โหลด ZIP...`, 'success');
        }
      }
    } catch (err) {
      console.warn('Split ranges execution error:', err);
      hideProgressModal();
      showToast('เกิดข้อผิดพลาดในการแยกช่วง PDF: ' + err.message, 'error');
    }
  }

  async function executeSplitSelect() {
    if (!splitState.file || splitState.selectedPages.size === 0) {
      showToast('กรุณาเลือกหน้าที่ต้องการแยกอย่างน้อย 1 หน้า', 'error');
      return;
    }

    const filenameInput = document.getElementById('splitOutputFilename');
    let rawName = (filenameInput?.value || 'selected-pages').trim();
    if (rawName.toLowerCase().endsWith('.pdf')) rawName = rawName.slice(0, -4);
    const filename = `${rawName || 'selected-pages'}.pdf`;

    showProgressModal();
    updateProgress(0, 1, 'กำลังแยกหน้าเอกสาร...');

    try {
      const splitPdf = await window.PDFLib.PDFDocument.create();
      const srcDoc = await window.PDFLib.PDFDocument.load(splitState.buffer);

      const sortedPages = Array.from(splitState.selectedPages).sort((a, b) => a - b);
      const indices = sortedPages.map(p => p - 1); // 0-based

      const copiedPages = await splitPdf.copyPages(srcDoc, indices);
      copiedPages.forEach(p => splitPdf.addPage(p));

      updateProgress(1, 1, 'กำลังสร้างไฟล์ PDF ใหม่...');
      const pdfBytes = await splitPdf.save();
      downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }), filename);
      hideProgressModal();
      showToast(`แยก PDF สำเร็จ (${copiedPages.length} หน้า) กำลังเริ่มดาวน์โหลด...`, 'success');
    } catch (err) {
      console.warn('Split execution error:', err);
      hideProgressModal();
      showToast('เกิดข้อผิดพลาดในการแยก PDF: ' + err.message, 'error');
    }
  }

  // ==========================================================================
  // TOOL 4: จัดหน้า PDF (Organize PDF)
  // ==========================================================================
  const organizeState = {
    file: null,
    buffer: null,
    pages: [], // Array of { id, originalIndex, rotation, dataUrl }
    sortable: null
  };

  function initOrganizeTool() {
    const fileInput = document.getElementById('fileInputOrganize');
    const dropZone = document.getElementById('organizeDropZone');
    const btnSelect = document.getElementById('btnSelectOrganizePdf');
    const btnClear = document.getElementById('btnClearOrganizePdf');
    const btnRotateAll = document.getElementById('btnOrganizeRotateAll');
    const btnReset = document.getElementById('btnOrganizeReset');
    const btnExecute = document.getElementById('btnExecuteOrganize');

    if (!fileInput || !dropZone) return;

    btnSelect?.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('click', (e) => {
      if (e.target.closest('#btnSelectOrganizePdf')) return;
      fileInput.click();
    });

    fileInput.addEventListener('change', async (e) => {
      const file = (e.target.files || [])[0];
      if (file) await handleOrganizeFile(file);
      fileInput.value = '';
    });

    setupDropZoneEvents(dropZone, async (files) => {
      if (files[0]) await handleOrganizeFile(files[0]);
    });

    btnClear?.addEventListener('click', () => {
      organizeState.file = null;
      organizeState.buffer = null;
      organizeState.pages = [];
      renderOrganizeUI();
    });

    btnRotateAll?.addEventListener('click', () => {
      organizeState.pages.forEach(p => {
        p.rotation = (p.rotation + 90) % 360;
      });
      renderOrganizeCards(false);
      showToast('หมุนทุกหน้า 90° เรียบร้อย', 'success');
    });

    btnReset?.addEventListener('click', () => {
      organizeState.pages.sort((a, b) => a.originalIndex - b.originalIndex);
      organizeState.pages.forEach(p => p.rotation = 0);
      renderOrganizeCards(true);
      showToast('รีเซ็ตลำดับและการหมุนกลับสู่ค่าเริ่มต้น', 'info');
    });

    btnExecute?.addEventListener('click', executeOrganize);
  }

  async function handleOrganizeFile(file) {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      showToast('กรุณาเลือกไฟล์ PDF เท่านั้น', 'error');
      return;
    }

    showProgressModal();
    updateProgress(0, 1, 'กำลังตรวจสอบไฟล์ PDF...');

    try {
      const loaded = await loadPdfDocument(file);
      organizeState.file = file;
      organizeState.buffer = loaded.buffer;
      organizeState.pages = [];

      for (let i = 0; i < loaded.pageCount; i++) {
        organizeState.pages.push({
          id: 'org_page_' + i + '_' + Math.random().toString(36).substr(2, 5),
          originalIndex: i,
          rotation: 0,
          dataUrl: null
        });
      }

      hideProgressModal();
      renderOrganizeUI();
      showToast(`โหลด PDF สำหรับจัดหน้าสำเร็จ (${loaded.pageCount} หน้า)`, 'success');
    } catch (err) {
      hideProgressModal();
      showToast(err.message || 'ไม่สามารถเปิดไฟล์ PDF นี้ได้', 'error');
    }
  }

  function renderOrganizeUI() {
    const uploadScreen = document.getElementById('organizeUploadScreen');
    const workspaceScreen = document.getElementById('organizeWorkspaceScreen');
    const badge = document.getElementById('organizeFileBadge');

    if (!uploadScreen || !workspaceScreen) return;

    if (!organizeState.file) {
      uploadScreen.classList.remove('hidden');
      workspaceScreen.classList.add('hidden');
      const grid = document.getElementById('organizeThumbnailGrid');
      if (grid) grid.innerHTML = '';
      return;
    }

    uploadScreen.classList.add('hidden');
    workspaceScreen.classList.remove('hidden');

    if (badge) badge.textContent = `${organizeState.pages.length} หน้า`;
    renderOrganizeCards(true);
  }

  function renderOrganizeCards(fullRebuild = true) {
    const grid = document.getElementById('organizeThumbnailGrid');
    const summaryPages = document.getElementById('organizeSummaryPages');
    const badge = document.getElementById('organizeFileBadge');

    if (badge) badge.textContent = `${organizeState.pages.length} หน้า`;
    if (summaryPages) summaryPages.textContent = `${organizeState.pages.length} หน้า`;

    if (!grid) return;

    if (!fullRebuild) {
      grid.querySelectorAll('.thumb-card').forEach((card, idx) => {
        const id = card.dataset.id;
        const pageItem = organizeState.pages.find(p => p.id === id);
        if (pageItem) {
          const badgeEl = card.querySelector('.page-badge');
          if (badgeEl) badgeEl.textContent = `#${idx + 1}`;
          const img = card.querySelector('.card-preview-img');
          if (img) img.style.transform = `rotate(${pageItem.rotation}deg)`;
        }
      });
      return;
    }

    grid.innerHTML = '';
    organizeState.pages.forEach((pageItem, idx) => {
      const card = document.createElement('div');
      card.className = 'thumb-card organize-page-card';
      card.dataset.id = pageItem.id;

      card.innerHTML = `
        <div class="card-top-bar">
          <div class="card-top-bar-left">
            <span class="page-badge">#${idx + 1}</span>
            <span class="card-orig-tag">หน้าเดิม ${pageItem.originalIndex + 1}</span>
          </div>
          <div class="card-quick-actions">
            <button type="button" class="card-action-btn btn-rotate-page" title="หมุนหน้า 90°" aria-label="หมุน">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
            </button>
            <button type="button" class="card-action-btn delete-btn btn-delete-page" title="ลบหน้านี้ออก" aria-label="ลบ">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </div>
        <div class="card-preview-area organize-preview-area">
          <div class="page-loading-skeleton">กำลังโหลด...</div>
        </div>
      `;

      card.querySelector('.btn-rotate-page').addEventListener('click', (e) => {
        e.stopPropagation();
        pageItem.rotation = (pageItem.rotation + 90) % 360;
        const img = card.querySelector('.card-preview-img');
        if (img) img.style.transform = `rotate(${pageItem.rotation}deg)`;
      });

      card.querySelector('.btn-delete-page').addEventListener('click', (e) => {
        e.stopPropagation();
        const index = organizeState.pages.findIndex(p => p.id === pageItem.id);
        if (index !== -1) {
          organizeState.pages.splice(index, 1);
          renderOrganizeCards(true);
        }
      });

      grid.appendChild(card);

      if (pageItem.dataUrl) {
        const previewArea = card.querySelector('.card-preview-area');
        if (previewArea) {
          previewArea.innerHTML = `<img src="${pageItem.dataUrl}" alt="หน้า ${pageItem.originalIndex + 1}" class="card-preview-img" style="transform: rotate(${pageItem.rotation}deg)">`;
        }
      } else {
        renderPdfThumbnail(organizeState.buffer, pageItem.originalIndex + 1, 0.35).then(url => {
          pageItem.dataUrl = url;
          const previewArea = card.querySelector('.card-preview-area');
          if (previewArea) {
            previewArea.innerHTML = `<img src="${url}" alt="หน้า ${pageItem.originalIndex + 1}" class="card-preview-img" style="transform: rotate(${pageItem.rotation}deg)">`;
          }
        }).catch(() => {
          const previewArea = card.querySelector('.card-preview-area');
          if (previewArea) previewArea.innerHTML = `<span class="preview-err">หน้า ${pageItem.originalIndex + 1}</span>`;
        });
      }
    });

    if (window.Sortable) {
      if (organizeState.sortable) organizeState.sortable.destroy();
      organizeState.sortable = new window.Sortable(grid, {
        animation: 150,
        ghostClass: 'sortable-ghost',
        filter: 'button, svg, path',
        preventOnFilter: false,
        onEnd: function(evt) {
          if (evt.oldIndex !== evt.newIndex) {
            const [moved] = organizeState.pages.splice(evt.oldIndex, 1);
            organizeState.pages.splice(evt.newIndex, 0, moved);
            renderOrganizeCards(false);
          }
        }
      });
    }
  }

  async function executeOrganize() {
    if (!organizeState.file || organizeState.pages.length === 0) {
      showToast('กรุณาเลือกไฟล์ PDF และต้องมีหน้าอย่างน้อย 1 หน้า', 'error');
      return;
    }

    const filenameInput = document.getElementById('organizeOutputFilename');
    let rawName = (filenameInput?.value || 'organized').trim();
    if (rawName.toLowerCase().endsWith('.pdf')) rawName = rawName.slice(0, -4);
    const filename = `${rawName || 'organized'}.pdf`;

    showProgressModal();
    const total = organizeState.pages.length;
    updateProgress(0, total, 'กำลังจัดเรียงและหมุนหน้า PDF...');

    try {
      const orgDoc = await window.PDFLib.PDFDocument.create();
      const srcDoc = await window.PDFLib.PDFDocument.load(organizeState.buffer);

      for (let i = 0; i < total; i++) {
        const item = organizeState.pages[i];
        updateProgress(i + 1, total, `กำลังจัดหน้า ${i + 1} จาก ${total}...`);
        const [copiedPage] = await orgDoc.copyPages(srcDoc, [item.originalIndex]);
        const origAngle = copiedPage.getRotation().angle;
        copiedPage.setRotation(window.PDFLib.degrees((origAngle + item.rotation) % 360));
        orgDoc.addPage(copiedPage);
        await new Promise(r => setTimeout(r, 0));
      }

      updateProgress(total, total, 'กำลังบันทึกไฟล์เอกสาร...');
      const pdfBytes = await orgDoc.save();
      downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }), filename);
      hideProgressModal();
      showToast(`จัดหน้า PDF สำเร็จ (${total} หน้า) กำลังเริ่มดาวน์โหลด...`, 'success');
    } catch (err) {
      console.warn('Organize execution error:', err);
      hideProgressModal();
      showToast('เกิดข้อผิดพลาดในการบันทึก PDF: ' + err.message, 'error');
    }
  }

  // ==========================================================================
  // TOOL 5: PDF → รูปภาพ (PDF to Images)
  // ==========================================================================
  const pdfToImgState = {
    file: null,
    buffer: null,
    totalPages: 0,
    selectedPages: new Set()
  };

  function initPdfToImgTool() {
    const fileInput = document.getElementById('fileInputPdfToImg');
    const dropZone = document.getElementById('pdfToImgDropZone');
    const btnSelect = document.getElementById('btnSelectPdfToImg');
    const btnClear = document.getElementById('btnClearPdfToImg');
    const btnSelectAll = document.getElementById('btnPdfToImgSelectAll');
    const btnDeselectAll = document.getElementById('btnPdfToImgDeselectAll');
    const btnExecute = document.getElementById('btnExecutePdfToImg');

    if (!fileInput || !dropZone) return;

    btnSelect?.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('click', (e) => {
      if (e.target.closest('#btnSelectPdfToImg')) return;
      fileInput.click();
    });

    fileInput.addEventListener('change', async (e) => {
      const file = (e.target.files || [])[0];
      if (file) await handlePdfToImgFile(file);
      fileInput.value = '';
    });

    setupDropZoneEvents(dropZone, async (files) => {
      if (files[0]) await handlePdfToImgFile(files[0]);
    });

    btnClear?.addEventListener('click', () => {
      pdfToImgState.file = null;
      pdfToImgState.buffer = null;
      pdfToImgState.totalPages = 0;
      pdfToImgState.selectedPages.clear();
      renderPdfToImgUI();
    });

    btnSelectAll?.addEventListener('click', () => {
      for (let i = 1; i <= pdfToImgState.totalPages; i++) pdfToImgState.selectedPages.add(i);
      updatePdfToImgSelections();
    });

    btnDeselectAll?.addEventListener('click', () => {
      pdfToImgState.selectedPages.clear();
      updatePdfToImgSelections();
    });

    document.querySelectorAll('input[name="pdfToImgFormat"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const qualityGroup = document.getElementById('groupImgQuality');
        if (qualityGroup) {
          qualityGroup.style.display = e.target.value === 'image/png' ? 'none' : 'block';
        }
      });
    });

    btnExecute?.addEventListener('click', executePdfToImg);
  }

  async function handlePdfToImgFile(file) {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      showToast('กรุณาเลือกไฟล์ PDF เท่านั้น', 'error');
      return;
    }

    showProgressModal();
    updateProgress(0, 1, 'กำลังตรวจสอบไฟล์ PDF...');

    try {
      const loaded = await loadPdfDocument(file);
      pdfToImgState.file = file;
      pdfToImgState.buffer = loaded.buffer;
      pdfToImgState.totalPages = loaded.pageCount;
      pdfToImgState.selectedPages.clear();

      for (let i = 1; i <= loaded.pageCount; i++) {
        pdfToImgState.selectedPages.add(i);
      }

      hideProgressModal();
      renderPdfToImgUI();
      showToast(`โหลด PDF สำเร็จ (${loaded.pageCount} หน้า)`, 'success');
    } catch (err) {
      hideProgressModal();
      showToast(err.message || 'ไม่สามารถเปิดไฟล์ PDF นี้ได้', 'error');
    }
  }

  function renderPdfToImgUI() {
    const uploadScreen = document.getElementById('pdfToImgUploadScreen');
    const workspaceScreen = document.getElementById('pdfToImgWorkspaceScreen');
    const grid = document.getElementById('pdfToImgThumbnailGrid');
    const badge = document.getElementById('pdfToImgFileBadge');

    if (!uploadScreen || !workspaceScreen) return;

    if (!pdfToImgState.file) {
      uploadScreen.classList.remove('hidden');
      workspaceScreen.classList.add('hidden');
      if (grid) grid.innerHTML = '';
      return;
    }

    uploadScreen.classList.add('hidden');
    workspaceScreen.classList.remove('hidden');

    if (badge) badge.textContent = `${pdfToImgState.totalPages} หน้า`;
    updatePdfToImgSelections();

    if (grid) {
      grid.innerHTML = '';
      for (let i = 1; i <= pdfToImgState.totalPages; i++) {
        const card = document.createElement('div');
        card.className = 'thumb-card page-card-selectable' + (pdfToImgState.selectedPages.has(i) ? ' selected' : '');
        card.dataset.page = String(i);
        card.setAttribute('role', 'checkbox');
        card.setAttribute('aria-checked', String(pdfToImgState.selectedPages.has(i)));
        card.setAttribute('tabindex', '0');

        card.innerHTML = `
          <div class="card-header">
            <span class="page-badge">หน้า ${i}</span>
            <div class="page-select-checkbox">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
          </div>
          <div class="card-preview-area">
            <div class="page-loading-skeleton">กำลังโหลด...</div>
          </div>
        `;

        const toggle = () => {
          if (pdfToImgState.selectedPages.has(i)) {
            pdfToImgState.selectedPages.delete(i);
          } else {
            pdfToImgState.selectedPages.add(i);
          }
          updatePdfToImgSelections();
        };

        card.addEventListener('click', toggle);
        card.addEventListener('keydown', (e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            toggle();
          }
        });

        grid.appendChild(card);

        renderPdfThumbnail(pdfToImgState.buffer, i, 0.35).then(url => {
          const previewArea = card.querySelector('.card-preview-area');
          if (previewArea) previewArea.innerHTML = `<img src="${url}" alt="หน้า ${i}" class="card-preview-img">`;
        }).catch(() => {
          const previewArea = card.querySelector('.card-preview-area');
          if (previewArea) previewArea.innerHTML = `<span class="preview-err">หน้า ${i}</span>`;
        });
      }
    }
  }

  function updatePdfToImgSelections() {
    const summarySelected = document.getElementById('pdfToImgSummarySelected');
    if (summarySelected) {
      summarySelected.textContent = `${pdfToImgState.selectedPages.size} หน้า`;
    }

    const cards = document.querySelectorAll('#pdfToImgThumbnailGrid .page-card-selectable');
    cards.forEach(card => {
      const pageNum = parseInt(card.dataset.page, 10);
      const isSelected = pdfToImgState.selectedPages.has(pageNum);
      card.classList.toggle('selected', isSelected);
      card.setAttribute('aria-checked', String(isSelected));
    });
  }

  async function executePdfToImg() {
    if (!pdfToImgState.file || pdfToImgState.selectedPages.size === 0) {
      showToast('กรุณาเลือกหน้าที่ต้องการแปลงเป็นรูปภาพอย่างน้อย 1 หน้า', 'error');
      return;
    }

    const formatRadio = document.querySelector('input[name="pdfToImgFormat"]:checked');
    const mimeType = formatRadio ? formatRadio.value : 'image/jpeg';
    const isPng = mimeType === 'image/png';
    const ext = isPng ? 'png' : 'jpg';

    const qualitySelect = document.getElementById('pdfToImgQuality');
    const quality = isPng ? 1.0 : parseFloat(qualitySelect?.value || '0.9');

    const filenameInput = document.getElementById('pdfToImgOutputFilename');
    let baseName = (filenameInput?.value || 'pdf-images').trim();

    const sortedPages = Array.from(pdfToImgState.selectedPages).sort((a, b) => a - b);
    const totalSelected = sortedPages.length;

    showProgressModal();
    updateProgress(0, totalSelected, 'กำลังเตรียมแปลงหน้า PDF เป็นรูปภาพ...');

    try {
      if (totalSelected === 1) {
        const pageNum = sortedPages[0];
        updateProgress(1, 1, `กำลังเรนเดอร์หน้า ${pageNum}...`);
        const canvas = await renderPdfPageFull(pdfToImgState.buffer, pageNum, 2.0);
        const blob = await new Promise(res => canvas.toBlob(res, mimeType, quality));
        canvas.width = 0;
        canvas.height = 0;

        downloadBlob(blob, `${baseName}-page-${pageNum}.${ext}`);
        hideProgressModal();
        showToast('แปลงรูปภาพสำเร็จ กำลังดาวน์โหลด...', 'success');
      } else {
        if (!window.JSZip) {
          throw new Error('ไลบรารี JSZip ไม่พร้อมใช้งาน');
        }
        const zip = new window.JSZip();

        for (let idx = 0; idx < totalSelected; idx++) {
          const pageNum = sortedPages[idx];
          updateProgress(idx + 1, totalSelected, `กำลังเรนเดอร์ภาพหน้า ${pageNum} (${idx + 1}/${totalSelected})...`);
          const canvas = await renderPdfPageFull(pdfToImgState.buffer, pageNum, 2.0);
          const blob = await new Promise(res => canvas.toBlob(res, mimeType, quality));
          canvas.width = 0;
          canvas.height = 0;

          const imgFilename = `${baseName}_page_${String(pageNum).padStart(3, '0')}.${ext}`;
          zip.file(imgFilename, blob);
          await new Promise(r => setTimeout(r, 0));
        }

        updateProgress(totalSelected, totalSelected, 'กำลังบีบอัดเป็นไฟล์ ZIP...');
        const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        downloadBlob(zipBlob, `${baseName}.zip`);
        hideProgressModal();
        showToast(`แปลง ${totalSelected} หน้าเป็นรูปภาพใน ZIP สำเร็จ กำลังเริ่มดาวน์โหลด...`, 'success');
      }
    } catch (err) {
      console.warn('PDF to Image error:', err);
      hideProgressModal();
      showToast('เกิดข้อผิดพลาดในการแปลงภาพ: ' + err.message, 'error');
    }
  }

  // ==========================================================================
  // TOOL 6: ใส่เลขหน้า (Page Numbering)
  // ==========================================================================
  const pageNumState = {
    file: null,
    buffer: null,
    totalPages: 0,
    position: 'bottom-center',
    startNum: 1,
    format: 'plain'
  };

  function initPageNumTool() {
    const fileInput = document.getElementById('fileInputPageNum');
    const dropZone = document.getElementById('pageNumDropZone');
    const btnSelect = document.getElementById('btnSelectPageNum');
    const btnClear = document.getElementById('btnClearPageNum');
    const btnExecute = document.getElementById('btnExecutePageNum');
    const startInput = document.getElementById('pageNumStart');
    const formatSelect = document.getElementById('pageNumFormat');

    if (!fileInput || !dropZone) return;

    btnSelect?.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('click', (e) => {
      if (e.target.closest('#btnSelectPageNum')) return;
      fileInput.click();
    });

    fileInput.addEventListener('change', async (e) => {
      const file = (e.target.files || [])[0];
      if (file) await handlePageNumFile(file);
      fileInput.value = '';
    });

    setupDropZoneEvents(dropZone, async (files) => {
      if (files[0]) await handlePageNumFile(files[0]);
    });

    btnClear?.addEventListener('click', () => {
      pageNumState.file = null;
      pageNumState.buffer = null;
      pageNumState.totalPages = 0;
      renderPageNumUI();
    });

    document.querySelectorAll('.pos-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.pos-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        pageNumState.position = btn.dataset.pos || 'bottom-center';
        updatePageNumOverlays();
      });
    });

    startInput?.addEventListener('input', (e) => {
      pageNumState.startNum = parseInt(e.target.value, 10) || 1;
      updatePageNumOverlays();
    });

    formatSelect?.addEventListener('change', (e) => {
      pageNumState.format = e.target.value || 'plain';
      updatePageNumOverlays();
    });

    btnExecute?.addEventListener('click', executePageNum);
  }

  async function handlePageNumFile(file) {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      showToast('กรุณาเลือกไฟล์ PDF เท่านั้น', 'error');
      return;
    }

    showProgressModal();
    updateProgress(0, 1, 'กำลังตรวจสอบไฟล์ PDF...');

    try {
      const loaded = await loadPdfDocument(file);
      pageNumState.file = file;
      pageNumState.buffer = loaded.buffer;
      pageNumState.totalPages = loaded.pageCount;

      hideProgressModal();
      renderPageNumUI();
      showToast(`โหลด PDF สำเร็จ (${loaded.pageCount} หน้า)`, 'success');
    } catch (err) {
      hideProgressModal();
      showToast(err.message || 'ไม่สามารถเปิดไฟล์ PDF นี้ได้', 'error');
    }
  }

  function renderPageNumUI() {
    const uploadScreen = document.getElementById('pageNumUploadScreen');
    const workspaceScreen = document.getElementById('pageNumWorkspaceScreen');
    const grid = document.getElementById('pageNumThumbnailGrid');
    const badge = document.getElementById('pageNumFileBadge');

    if (!uploadScreen || !workspaceScreen) return;

    if (!pageNumState.file) {
      uploadScreen.classList.remove('hidden');
      workspaceScreen.classList.add('hidden');
      if (grid) grid.innerHTML = '';
      return;
    }

    uploadScreen.classList.add('hidden');
    workspaceScreen.classList.remove('hidden');

    if (badge) badge.textContent = `${pageNumState.totalPages} หน้า`;

    if (grid) {
      grid.innerHTML = '';
      for (let i = 1; i <= pageNumState.totalPages; i++) {
        const card = document.createElement('div');
        card.className = 'thumb-card page-num-card';
        card.dataset.page = String(i);

        card.innerHTML = `
          <div class="card-header">
            <span class="page-badge">หน้า ${i}</span>
          </div>
          <div class="card-preview-area page-preview-relative">
            <div class="page-loading-skeleton">กำลังโหลด...</div>
            <div class="page-number-preview-overlay pos-${pageNumState.position}">
              <span class="overlay-num">${getPageNumberText(i)}</span>
            </div>
          </div>
        `;

        grid.appendChild(card);

        renderPdfThumbnail(pageNumState.buffer, i, 0.35).then(url => {
          const previewArea = card.querySelector('.card-preview-area');
          if (previewArea) {
            const skeleton = previewArea.querySelector('.page-loading-skeleton');
            if (skeleton) skeleton.remove();
            const img = document.createElement('img');
            img.src = url;
            img.alt = `หน้า ${i}`;
            img.className = 'card-preview-img';
            previewArea.insertBefore(img, previewArea.firstChild);
          }
        }).catch(() => {
          const previewArea = card.querySelector('.card-preview-area');
          if (previewArea) previewArea.innerHTML = `<span class="preview-err">หน้า ${i}</span>`;
        });
      }
    }
  }

  function getPageNumberText(pageIndex1Based) {
    const currentNum = pageNumState.startNum + pageIndex1Based - 1;
    if (pageNumState.format === 'thai-prefix') {
      return `หน้า ${currentNum}`;
    } else if (pageNumState.format === 'page-total') {
      return `${currentNum} / ${pageNumState.totalPages}`;
    }
    return `${currentNum}`;
  }

  function updatePageNumOverlays() {
    const overlays = document.querySelectorAll('#pageNumThumbnailGrid .page-number-preview-overlay');
    overlays.forEach(overlay => {
      overlay.className = `page-number-preview-overlay pos-${pageNumState.position}`;
      const card = overlay.closest('.page-num-card');
      if (card) {
        const pageNum = parseInt(card.dataset.page, 10) || 1;
        const numSpan = overlay.querySelector('.overlay-num');
        if (numSpan) numSpan.textContent = getPageNumberText(pageNum);
      }
    });
  }

  async function executePageNum() {
    if (!pageNumState.file || pageNumState.totalPages === 0) {
      showToast('กรุณาเลือกไฟล์ PDF ก่อนดำเนินการ', 'error');
      return;
    }

    const filenameInput = document.getElementById('pageNumOutputFilename');
    let rawName = (filenameInput?.value || 'numbered').trim();
    if (rawName.toLowerCase().endsWith('.pdf')) rawName = rawName.slice(0, -4);
    const filename = `${rawName || 'numbered'}.pdf`;

    showProgressModal();
    const total = pageNumState.totalPages;
    updateProgress(0, total, 'กำลังใส่เลขหน้าเอกสาร PDF...');

    try {
      const pdfDoc = await window.PDFLib.PDFDocument.load(pageNumState.buffer);
      const font = await pdfDoc.embedFont(window.PDFLib.StandardFonts.Helvetica);

      // Helper function to render text to PNG bytes via offscreen canvas
      async function renderTextToPngBytes(text, fontSize) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const dpr = 2; // high resolution for crisp print
        const fontStr = `${fontSize * dpr}px 'Prompt', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
        ctx.font = fontStr;
        const metrics = ctx.measureText(text);
        const actualWidth = Math.ceil(metrics.width);
        const actualHeight = Math.ceil(fontSize * 1.5 * dpr);
        canvas.width = actualWidth + 10;
        canvas.height = actualHeight + 10;
        
        ctx.font = fontStr;
        ctx.fillStyle = '#333333';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 5, canvas.height / 2);

        const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
        const ab = await blob.arrayBuffer();
        return {
          bytes: new Uint8Array(ab),
          width: canvas.width / dpr,
          height: canvas.height / dpr
        };
      }

      for (let i = 0; i < total; i++) {
        const page = pdfDoc.getPage(i);
        const { width, height } = page.getSize();
        const numText = getPageNumberText(i + 1);

        const fontSize = 11;
        const margin = 24;

        // Check if text has non-ASCII characters (e.g. Thai)
        const hasNonAscii = /[^\x00-\x7F]/.test(numText);

        if (hasNonAscii) {
          const rendered = await renderTextToPngBytes(numText, fontSize);
          const embeddedImage = await pdfDoc.embedPng(rendered.bytes);

          let x = margin;
          let y = margin;

          if (pageNumState.position.includes('left')) {
            x = margin;
          } else if (pageNumState.position.includes('center')) {
            x = (width - rendered.width) / 2;
          } else if (pageNumState.position.includes('right')) {
            x = width - margin - rendered.width;
          }

          if (pageNumState.position.includes('top')) {
            y = height - margin - rendered.height;
          } else {
            y = margin;
          }

          page.drawImage(embeddedImage, {
            x,
            y,
            width: rendered.width,
            height: rendered.height
          });
        } else {
          const textWidth = font.widthOfTextAtSize(numText, fontSize);
          const textHeight = font.heightAtSize(fontSize);

          let x = margin;
          let y = margin;

          if (pageNumState.position.includes('left')) {
            x = margin;
          } else if (pageNumState.position.includes('center')) {
            x = (width - textWidth) / 2;
          } else if (pageNumState.position.includes('right')) {
            x = width - margin - textWidth;
          }

          if (pageNumState.position.includes('top')) {
            y = height - margin - textHeight;
          } else {
            y = margin;
          }

          page.drawText(numText, {
            x,
            y,
            size: fontSize,
            font,
            color: window.PDFLib.rgb(0.2, 0.2, 0.2)
          });
        }

        updateProgress(i + 1, total, `ใส่เลขหน้าที่ ${i + 1} จาก ${total}...`);
        await new Promise(r => setTimeout(r, 0));
      }

      updateProgress(total, total, 'กำลังบันทึกเอกสาร PDF...');
      const pdfBytes = await pdfDoc.save();
      downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }), filename);
      hideProgressModal();
      showToast(`ใส่เลขหน้าสำเร็จ (${total} หน้า) กำลังเริ่มดาวน์โหลด...`, 'success');
    } catch (err) {
      console.warn('Page numbering execution error:', err);
      hideProgressModal();
      showToast('เกิดข้อผิดพลาดในการใส่เลขหน้า: ' + err.message, 'error');
    }
  }

  // ==========================================================================
  // TOOL 7: OCR PDF & IMAGE (Tesseract.js Local Client-Side OCR & Searchable PDF)
  // ==========================================================================
  const ocrState = {
    mode: 'pdf', // 'pdf' or 'images'
    files: [],
    file: null, // primary file for backwards compatibility
    buffer: null,
    isPdf: true,
    pages: [], // array of { id, pageNum, file, previewUrl, width, height, text, confidence, pdfBytes, hasExistingText }
    totalPages: 0,
    extractedText: '',
    overallConfidence: 0,
    isProcessing: false,
    cancelRequested: false,
    activeWorker: null,
    searchablePdfBytes: null,
    outputFilename: ''
  };

  function initOcrTool() {
    const fileInput = document.getElementById('fileInputOcr');
    const dropZone = document.getElementById('ocrDropZone');
    const btnSelect = document.getElementById('btnSelectOcrFile');
    const btnClear = document.getElementById('btnClearOcr');
    const btnExecute = document.getElementById('btnExecuteOcr');
    const btnCancel = document.getElementById('btnCancelOcr');
    const btnCopy = document.getElementById('btnOcrCopy');
    const btnDownloadTxt = document.getElementById('btnOcrDownloadTxt');
    const btnDownloadPdf = document.getElementById('btnOcrDownloadPdf');
    const filenameInput = document.getElementById('ocrOutputFilename');

    if (!fileInput || !dropZone) return;

    if (window.location.protocol === 'file:') {
      const warningBanner = document.createElement('div');
      warningBanner.className = 'ocr-file-warning';
      warningBanner.style.cssText = 'background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.35); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; color: #ef4444; font-size: 0.875rem; line-height: 1.5; text-align: left;';
      warningBanner.innerHTML = '⚠️ <strong>แจ้งเตือน:</strong> กำลังเปิดผ่านโปรโตคอล <code>file://</code> ซึ่งเบราว์เซอร์ (Chrome / Edge) บล็อก Web Worker & WebAssembly เพื่อความปลอดภัย กรุณาเปิดผ่าน Web Server ในเครื่อง (เช่น รันคำสั่ง <code>npm start</code> หรือเปิดด้วย VS Code Live Server)';
      const uploadCard = document.querySelector('#ocrUploadScreen .upload-card');
      if (uploadCard && !uploadCard.querySelector('.ocr-file-warning')) {
        uploadCard.insertBefore(warningBanner, uploadCard.firstChild);
      }
    }

    btnSelect?.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('click', (e) => {
      if (e.target.closest('#btnSelectOcrFile')) return;
      fileInput.click();
    });

    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) await handleOcrFiles(files);
      fileInput.value = '';
    });

    setupDropZoneEvents(dropZone, async (files) => {
      if (files && files.length > 0) await handleOcrFiles(files);
    });

    btnClear?.addEventListener('click', () => {
      clearOcrState();
      renderOcrUI();
    });

    btnCancel?.addEventListener('click', cancelOcr);

    filenameInput?.addEventListener('input', (e) => {
      ocrState.outputFilename = e.target.value.trim();
    });

    btnCopy?.addEventListener('click', () => {
      const textarea = document.getElementById('ocrExtractedText');
      if (textarea && textarea.value) {
        if (!ocrState.extractedText || (ocrState.pages && ocrState.pages.length > 0 && ocrState.pages.every(p => p.qualityStatus === 'LOW'))) {
          showToast('ไม่พบข้อความที่อ่านได้อย่างมั่นใจสำหรับคัดลอก', 'info');
          return;
        }
        navigator.clipboard.writeText(ocrState.extractedText).then(() => {
          showToast('คัดลอกข้อความลงคลิปบอร์ดแล้ว', 'success');
        }).catch(() => {
          textarea.select();
          document.execCommand('copy');
          showToast('คัดลอกข้อความแล้ว', 'success');
        });
      }
    });

    btnDownloadTxt?.addEventListener('click', () => {
      if (!ocrState.extractedText || (ocrState.pages && ocrState.pages.length > 0 && ocrState.pages.every(p => p.qualityStatus === 'LOW'))) {
        showToast('ไม่พบข้อความที่อ่านได้อย่างมั่นใจสำหรับดาวน์โหลด', 'info');
        return;
      }
      const blob = new Blob([ocrState.extractedText], { type: 'text/plain;charset=utf-8' });
      let baseName = ocrState.outputFilename ? ocrState.outputFilename.replace(/\.pdf$/i, '') : 'ocr-extracted-text';
      downloadBlob(blob, `${baseName}.txt`);
      showToast('ดาวน์โหลดไฟล์ .txt สำเร็จ', 'success');
    });

    btnDownloadPdf?.addEventListener('click', async () => {
      await downloadSearchablePdf();
    });

    btnExecute?.addEventListener('click', executeOcr);
  }

  function clearOcrState() {
    if (ocrState.pages) {
      ocrState.pages.forEach(p => {
        if (p.previewUrl && p.previewUrl.startsWith('blob:')) {
          try { URL.revokeObjectURL(p.previewUrl); } catch (_) {}
        }
      });
    }
    ocrState.files = [];
    ocrState.file = null;
    ocrState.buffer = null;
    ocrState.pages = [];
    ocrState.totalPages = 0;
    ocrState.extractedText = '';
    ocrState.overallConfidence = 0;
    ocrState.isProcessing = false;
    ocrState.cancelRequested = false;
    ocrState.searchablePdfBytes = null;
    ocrState.outputFilename = '';
  }

  // --- HEIC Client-side Decoder ---
  async function decodeHeicIfNecessary(file) {
    const ext = (file.name || '').substring((file.name || '').lastIndexOf('.')).toLowerCase();
    const isHeic = ext === '.heic' || ext === '.heif' || file.type === 'image/heic' || file.type === 'image/heif';
    if (!isHeic) return file;

    if (!window.heic2any) {
      throw new Error(`เบราว์เซอร์ไม่รองรับ HEIC และไม่พบโมดูลถอดรหัสในเครื่องสำหรับไฟล์ "${file.name}"`);
    }

    try {
      const converted = await window.heic2any({
        blob: file,
        toType: 'image/jpeg',
        quality: 0.92
      });
      const jpegBlob = Array.isArray(converted) ? converted[0] : converted;
      const newName = file.name.replace(/\.(heic|heif)$/i, '.jpg');
      return new File([jpegBlob], newName, { type: 'image/jpeg' });
    } catch (err) {
      throw new Error(`ไม่สามารถถอดรหัสไฟล์ภาพ HEIC "${file.name}": ไฟล์อาจเสียหายหรือไม่สมบูรณ์`);
    }
  }

  // --- Helper: Load image file to HTMLCanvasElement ---
  function loadImageToCanvas(fileOrBlob) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(fileOrBlob);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(canvas);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`ไม่สามารถโหลดรูปภาพ "${fileOrBlob.name || 'image'}": รูปแบบไฟล์ไม่ถูกต้องหรือรูปภาพเสียหาย`));
      };
      img.src = url;
    });
  }

  // --- Image Preprocessing for OCR Accuracy ---
  function preprocessImageForOcr(sourceCanvas) {
    const width = sourceCanvas.width;
    const height = sourceCanvas.height;
    if (!width || !height) return sourceCanvas;

    // Normalize resolution for optimal OCR (2000-2800px on long edge)
    let targetWidth = width;
    let targetHeight = height;
    const maxDim = Math.max(width, height);
    if (maxDim > 2800) {
      const scale = 2800 / maxDim;
      targetWidth = Math.round(width * scale);
      targetHeight = Math.round(height * scale);
    } else if (maxDim < 700) {
      const scale = Math.min(2.5, 1400 / maxDim);
      targetWidth = Math.round(width * scale);
      targetHeight = Math.round(height * scale);
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);

    const imgData = ctx.getImageData(0, 0, targetWidth, targetHeight);
    const data = imgData.data;
    const totalPixels = targetWidth * targetHeight;

    // 1. Grayscale & compute histogram
    const histogram = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) {
      const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      data[i] = gray;
      data[i + 1] = gray;
      data[i + 2] = gray;
      histogram[gray]++;
    }

    // 2. Contrast stretching (2nd to 98th percentile)
    const lowBoundCount = totalPixels * 0.02;
    const highBoundCount = totalPixels * 0.98;
    let count = 0;
    let minGray = 0;
    let maxGray = 255;
    for (let i = 0; i < 256; i++) {
      count += histogram[i];
      if (count >= lowBoundCount && minGray === 0) minGray = i;
      if (count >= highBoundCount) {
        maxGray = i;
        break;
      }
    }

    const range = maxGray - minGray;
    if (range > 20) {
      for (let i = 0; i < data.length; i += 4) {
        let val = data[i];
        if (val <= minGray) {
          val = 0;
        } else if (val >= maxGray) {
          val = 255;
        } else {
          val = Math.round(((val - minGray) / range) * 255);
        }
        data[i] = val;
        data[i + 1] = val;
        data[i + 2] = val;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }

  // --- Main OCR File / Files Handler ---
  async function handleOcrFiles(fileList) {
    const rawFiles = Array.from(fileList || []);
    if (rawFiles.length === 0) return;

    clearOcrState();
    showProgressModal();
    updateProgress(0, 1, 'กำลังตรวจสอบไฟล์เอกสาร...');

    try {
      const isFirstPdf = rawFiles[0].name.toLowerCase().endsWith('.pdf') || rawFiles[0].type === 'application/pdf';

      if (isFirstPdf) {
        // PDF Mode
        const pdfFile = rawFiles[0];
        updateProgress(0, 1, 'กำลังเปิดเอกสาร PDF และตรวจสอบข้อความ...');
        const loaded = await loadPdfDocument(pdfFile);
        ocrState.mode = 'pdf';
        ocrState.isPdf = true;
        ocrState.file = pdfFile;
        ocrState.files = [pdfFile];
        ocrState.buffer = loaded.buffer;
        ocrState.totalPages = loaded.pageCount;

        // Inspect existing text in PDF
        const loadingTask = window.pdfjsLib.getDocument({ data: new Uint8Array(loaded.buffer.slice(0)) });
        const pdfDoc = await loadingTask.promise;
        const pages = [];

        for (let i = 1; i <= loaded.pageCount; i++) {
          const page = await pdfDoc.getPage(i);
          let hasExistingText = false;
          let initialText = '';
          try {
            const textContent = await page.getTextContent();
            if (textContent.items && textContent.items.length > 0) {
              const joined = textContent.items.map(it => it.str).join(' ').trim();
              if (joined.length > 10) {
                hasExistingText = true;
                initialText = joined;
              }
            }
          } catch (_) {}
          page.cleanup();

          pages.push({
            id: `ocr-p-${i}`,
            pageNum: i,
            isPdfPage: true,
            hasExistingText,
            text: initialText,
            confidence: null,
            pdfBytes: null
          });
        }
        await pdfDoc.destroy();
        loadingTask.destroy();

        ocrState.pages = pages;
        const defaultName = pdfFile.name.replace(/\.pdf$/i, '') + '-ocr.pdf';
        ocrState.outputFilename = defaultName;
        const filenameInput = document.getElementById('ocrOutputFilename');
        if (filenameInput) filenameInput.value = defaultName;

        hideProgressModal();
        renderOcrUI();
        showToast(`โหลดเอกสาร PDF สำเร็จ (${ocrState.totalPages} หน้า)`, 'success');
      } else {
        // Images Mode
        updateProgress(0, 1, 'กำลังเตรียมรูปภาพและถอดรหัสในเครื่อง...');
        const pages = [];
        const processedFiles = [];

        for (let idx = 0; idx < rawFiles.length; idx++) {
          const raw = rawFiles[idx];
          const isImg = raw.type.startsWith('image/') || /\.(jpg|jpeg|png|webp|bmp|heic|heif)$/i.test(raw.name);
          if (!isImg) continue;

          updateProgress(idx, rawFiles.length, `กำลังเตรียมรูปภาพ (${idx + 1}/${rawFiles.length})...`);
          const readyFile = await decodeHeicIfNecessary(raw);
          processedFiles.push(readyFile);
          const previewUrl = URL.createObjectURL(readyFile);

          pages.push({
            id: `ocr-img-${idx + 1}`,
            pageNum: idx + 1,
            isPdfPage: false,
            file: readyFile,
            previewUrl,
            hasExistingText: false,
            text: '',
            confidence: null,
            pdfBytes: null
          });
        }

        if (pages.length === 0) {
          throw new Error('ไม่พบไฟล์รูปภาพที่รองรับ (JPG, PNG, WebP, BMP, HEIC)');
        }

        ocrState.mode = 'images';
        ocrState.isPdf = false;
        ocrState.files = processedFiles;
        ocrState.file = processedFiles[0];
        ocrState.pages = pages;
        ocrState.totalPages = pages.length;

        const firstBaseName = processedFiles[0].name.substring(0, processedFiles[0].name.lastIndexOf('.')) || 'image';
        const defaultName = (pages.length > 1 ? `${firstBaseName}-batch` : firstBaseName) + '-ocr.pdf';
        ocrState.outputFilename = defaultName;
        const filenameInput = document.getElementById('ocrOutputFilename');
        if (filenameInput) filenameInput.value = defaultName;

        hideProgressModal();
        renderOcrUI();
        showToast(`โหลดรูปภาพสำหรับ OCR สำเร็จ (${pages.length} ภาพ)`, 'success');
      }
    } catch (err) {
      hideProgressModal();
      clearOcrState();
      renderOcrUI();
      console.warn('handleOcrFiles error:', err);
      showToast(err.message || 'ไม่สามารถเปิดเอกสารได้', 'error');
    }
  }

  // Wrapper for backwards compatibility
  async function handleOcrFile(file) {
    await handleOcrFiles([file]);
  }

  function renderOcrUI() {
    const uploadScreen = document.getElementById('ocrUploadScreen');
    const workspaceScreen = document.getElementById('ocrWorkspaceScreen');
    const grid = document.getElementById('ocrThumbnailGrid');
    const badge = document.getElementById('ocrFileBadge');
    const statusBadge = document.getElementById('ocrStatusBadge');
    const confBadge = document.getElementById('ocrConfidenceBadge');
    const resultsBox = document.getElementById('ocrResultsBox');
    const progressCard = document.getElementById('ocrProgressCard');
    const textArea = document.getElementById('ocrExtractedText');
    const pageContainer = document.getElementById('ocrPageTextContainer');

    if (!uploadScreen || !workspaceScreen) return;

    if (!ocrState.totalPages || ocrState.totalPages === 0) {
      uploadScreen.classList.remove('hidden');
      workspaceScreen.classList.add('hidden');
      if (grid) grid.innerHTML = '';
      if (resultsBox) resultsBox.classList.add('hidden');
      if (progressCard) progressCard.classList.add('hidden');
      if (confBadge) confBadge.classList.add('hidden');
      return;
    }

    uploadScreen.classList.add('hidden');
    workspaceScreen.classList.remove('hidden');

    if (badge) badge.textContent = `${ocrState.totalPages} หน้า`;
    if (statusBadge) statusBadge.textContent = ocrState.overallConfidence > 0 ? '✓ สแกนแล้ว' : 'พร้อมทำ OCR';
    if (confBadge) {
      if (ocrState.overallConfidence > 0) {
        confBadge.textContent = `ความแม่นยำรวม ${ocrState.overallConfidence}%`;
        confBadge.classList.remove('hidden');
      } else {
        confBadge.classList.add('hidden');
      }
    }

    if (!ocrState.extractedText && resultsBox) {
      resultsBox.classList.add('hidden');
    }
    if (!ocrState.isProcessing && progressCard) {
      progressCard.classList.add('hidden');
    }

    if (grid) {
      grid.innerHTML = '';
      ocrState.pages.forEach((pageItem, idx) => {
        const card = document.createElement('div');
        card.className = 'thumb-card';
        card.id = `ocrCard-${pageItem.pageNum}`;

        const confLabel = pageItem.confidence != null ? `ความแม่นยำ ${pageItem.confidence}%` : (pageItem.hasExistingText ? 'มีข้อความอยู่แล้ว' : '');

        card.innerHTML = `
          <div class="card-header">
            <span class="page-badge">หน้า ${pageItem.pageNum}</span>
          </div>
          <div class="card-preview-area">
            <div class="page-loading-skeleton">กำลังโหลดตัวอย่าง...</div>
          </div>
          ${confLabel ? `<div class="ocr-card-confidence">${confLabel}</div>` : ''}
        `;
        grid.appendChild(card);

        const previewArea = card.querySelector('.card-preview-area');
        if (ocrState.isPdf) {
          renderPdfThumbnail(ocrState.buffer, pageItem.pageNum, 0.35).then(url => {
            if (previewArea) previewArea.innerHTML = `<img src="${url}" alt="หน้า ${pageItem.pageNum}" class="card-preview-img">`;
          }).catch(() => {
            if (previewArea) previewArea.innerHTML = `<span class="preview-err">หน้า ${pageItem.pageNum}</span>`;
          });
        } else if (pageItem.previewUrl) {
          if (previewArea) previewArea.innerHTML = `<img src="${pageItem.previewUrl}" alt="รูปภาพหน้า ${pageItem.pageNum}" class="card-preview-img">`;
        }
      });
    }

    if (textArea) textArea.value = ocrState.extractedText || '';
    renderPageTextReviews();
  }

  function renderPageTextReviews() {
    const pageContainer = document.getElementById('ocrPageTextContainer');
    if (!pageContainer) return;

    if (!ocrState.pages || ocrState.pages.length <= 1) {
      pageContainer.innerHTML = '';
      pageContainer.classList.add('hidden');
      return;
    }

    pageContainer.innerHTML = '';
    pageContainer.classList.remove('hidden');

    ocrState.pages.forEach(p => {
      const item = document.createElement('div');
      item.className = 'ocr-page-item';

      if (p.qualityStatus === 'LOW' || (!p.text && p.confidence === 0)) {
        item.innerHTML = `
          <div class="ocr-page-item-header">
            <span>หน้า ${p.pageNum}</span>
            <span class="ocr-page-item-confidence text-muted" style="background: rgba(239, 68, 68, 0.1); color: var(--color-danger, #ef4444);">คุณภาพต่ำ</span>
          </div>
          <div class="ocr-page-item-text text-muted" style="font-style: italic; opacity: 0.85;">ไม่พบข้อความที่อ่านได้อย่างมั่นใจ (ระบบซ่อนข้อความที่มีความน่าเชื่อถือต่ำเพื่อป้องกันข้อความผิดพลาด)</div>
        `;
      } else if (p.qualityStatus === 'FAIR') {
        item.innerHTML = `
          <div class="ocr-page-item-header">
            <span>หน้า ${p.pageNum}</span>
            <span class="ocr-page-item-confidence">${p.confidence != null ? 'ความแม่นยำ: ' + p.confidence + '% (ปานกลาง)' : ''}</span>
          </div>
          <div class="ocr-page-item-notice">⚠️ หน้านี้มีข้อความที่ OCR อ่านได้ไม่มั่นใจ ระบบจึงซ่อนข้อความที่มีความน่าเชื่อถือต่ำเพื่อป้องกันข้อความผิดพลาด</div>
          <div class="ocr-page-item-text">${escapeHtml(p.text)}</div>
        `;
      } else {
        item.innerHTML = `
          <div class="ocr-page-item-header">
            <span>หน้า ${p.pageNum}</span>
            <span class="ocr-page-item-confidence">${p.confidence != null ? 'ความแม่นยำ: ' + p.confidence + '%' : ''}</span>
          </div>
          <div class="ocr-page-item-text">${escapeHtml(p.text)}</div>
        `;
      }
      pageContainer.appendChild(item);
    });
  }

  function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
  }

  // --- Helper: Resolve OCR Asset URL relative to current page base ---
  function getOcrAssetUrl(relativePath) {
    try {
      let base = window.location.href;
      const urlObj = new URL(base);
      if (!urlObj.pathname.endsWith('/') && !/\.[a-zA-Z0-9]+([?#].*)?$/.test(urlObj.pathname)) {
        urlObj.pathname += '/';
      }
      return new URL(relativePath, urlObj.href).href;
    } catch (_) {
      return relativePath;
    }
  }

  // --- Helper: Format OCR Error Details for User ---
  function formatOcrError(err) {
    if (!err) return 'ไม่สามารถโหลด OCR Engine ในเครื่องได้';
    if (typeof err === 'string' && err.trim()) return err.trim();
    if (window.location.protocol === 'file:') {
      return 'เบราว์เซอร์บล็อก Web Worker และ WebAssembly บนโปรโตคอล file:// โดยตรง กรุณาเปิดผ่าน Web Server ในเครื่อง (เช่น VS Code Live Server หรือ npx serve) หรือใช้งานผ่านเว็บไซต์';
    }
    if (err.message && typeof err.message === 'string' && err.message.trim()) {
      return err.message.trim();
    }
    if (err.error && err.error.message) {
      return err.error.message.trim();
    }
    if (err.type === 'error' || (typeof Event !== 'undefined' && err instanceof Event)) {
      return 'Web Worker ไม่สามารถดาวน์โหลดหรือเริ่มต้นสคริปต์ OCR ได้ (ตรวจสอบการเชื่อมต่อไฟล์ vendor/tesseract)';
    }
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json;
    } catch (_) {}
    return String(err);
  }

  // --- Worker Factory with SIMD Detection & Dual Fallbacks ---
  async function createTesseractWorker(selectedLang, onProgress) {
    if (window.location.protocol === 'file:') {
      throw new Error('เบราว์เซอร์ (Chrome/Edge) กำหนดนโยบายความปลอดภัยไม่อนุญาตให้รัน Web Worker / WebAssembly ผ่านโปรโตคอล file:// กรุณารันผ่าน Web Server ในเครื่อง (เช่น VS Code Live Server หรือ npx serve)');
    }

    const isSimdSupported = typeof WebAssembly === 'object' && typeof WebAssembly.validate === 'function' &&
      WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 26, 11]));

    const workerUrl = getOcrAssetUrl('vendor/tesseract/worker.min.js');
    const langUrl = getOcrAssetUrl('vendor/tesseract/lang-data');
    const primaryCore = isSimdSupported
      ? 'vendor/tesseract/tesseract-core-simd-lstm.wasm.js'
      : 'vendor/tesseract/tesseract-core-lstm.wasm.js';

    async function trySpawn(coreRelPath, useBlobUrl) {
      const coreUrl = getOcrAssetUrl(coreRelPath);
      return await window.Tesseract.createWorker(selectedLang, 1, {
        workerPath: workerUrl,
        corePath: coreUrl,
        langPath: langUrl,
        workerBlobURL: useBlobUrl,
        logger: onProgress
      });
    }

    // 1. Try primary core with workerBlobURL: true
    try {
      return await trySpawn(primaryCore, true);
    } catch (err1) {
      console.warn('OCR Worker spawn (primary, blobURL:true) failed, trying blobURL:false...', err1);
      // 2. Try primary core with workerBlobURL: false
      try {
        return await trySpawn(primaryCore, false);
      } catch (err2) {
        console.warn('OCR Worker spawn (primary, blobURL:false) failed...', err2);
        // 3. Fallback to standard LSTM core if SIMD failed
        if (isSimdSupported) {
          console.warn('Falling back to standard non-SIMD LSTM core...');
          try {
            return await trySpawn('vendor/tesseract/tesseract-core-lstm.wasm.js', true);
          } catch (err3) {
            return await trySpawn('vendor/tesseract/tesseract-core-lstm.wasm.js', false);
          }
        }
        throw err2;
      }
    }
  }

  // --- OCR Quality Gate & Noise Suppression Engine ---
  function evaluateOcrQuality(tessData) {
    if (!tessData) {
      return {
        status: 'LOW',
        text: '',
        confidence: 0,
        keptLines: [],
        suppressedWords: [],
        suppressedLinesCount: 0
      };
    }

    const rawLines = tessData.lines || [];
    const keptLines = [];
    const suppressedLines = [];
    const suppressedWords = [];

    let totalWordConf = 0;
    let totalWordCount = 0;

    function getScript(s) {
      if (/^[=_\-+*#~`!?:;\\/|\^]+$/.test(s)) return 'SYM';
      if (/^[0-9.,:%]+$/.test(s)) return 'NUM';
      if (/[\u0E00-\u0E7F]/.test(s)) return 'THAI';
      if (/[a-zA-Z]/.test(s)) return 'LATIN';
      return 'OTHER';
    }

    function isNoiseLine(line, avgWordConf, tokens) {
      const lineConf = line.confidence != null ? line.confidence : 0;
      const lineText = (line.text || '').trim();
      if (!lineText) return true;

      const totalChars = tokens.reduce((acc, t) => acc + t.text.length, 0);
      const maxTokenLen = Math.max(...tokens.map(t => t.text.length));
      const avgTokenLen = totalChars / tokens.length;
      const shortTokens = tokens.filter(t => t.text.length <= 2).length;
      const shortRatio = shortTokens / tokens.length;

      // Single or double character line with no substance (e.g. circle recognized as 'ว' or '-')
      if (tokens.length <= 2 && maxTokenLen <= 2 && avgWordConf < 75) {
        return true;
      }

      // Count repeated symbols (e.g. = = = =, - - - -)
      let consecutiveSymbols = 0;
      let maxConsecutiveSymbols = 0;
      for (let i = 0; i < tokens.length - 1; i++) {
        const isSym1 = /^[=_\-+*#~`!?:;\\/|\^]+$/.test(tokens[i].text);
        const isSym2 = /^[=_\-+*#~`!?:;\\/|\^]+$/.test(tokens[i + 1].text);
        if (isSym1 && isSym2 && tokens[i].text === tokens[i + 1].text) {
          consecutiveSymbols++;
          maxConsecutiveSymbols = Math.max(maxConsecutiveSymbols, consecutiveSymbols);
        } else {
          consecutiveSymbols = 0;
        }
      }

      // Check valid Thai text
      const thaiConsonantsAndVowels = tokens
        .filter(t => /[\u0E01-\u0E4E]/.test(t.text))
        .reduce((sum, t) => sum + (t.text.match(/[\u0E01-\u0E4E]/g) || []).length, 0);
      const thaiTokens = tokens.filter(t => /[\u0E00-\u0E7F]/.test(t.text));
      const avgThaiConf = thaiTokens.length > 0 
        ? Math.round(thaiTokens.reduce((s, t) => s + t.conf, 0) / thaiTokens.length)
        : 0;
      const hasValidThai = (thaiConsonantsAndVowels >= 5 && avgThaiConf >= 60);

      // Check valid Latin / Number anchor words
      const anchorTokens = tokens.filter(t => {
        if (t.conf < 75) return false;
        if (/^[a-zA-Z0-9]+$/.test(t.text)) {
          if (t.text.length >= 6 && t.conf >= 80) return true;
          if (t.text.length >= 4 && t.conf >= 75) return true;
          if (t.text.length >= 3 && t.conf >= 85) return true;
        }
        return false;
      });

      const hasAnchorWord = (
        anchorTokens.some(t => t.text.length >= 6) ||
        anchorTokens.length >= 2 ||
        (tokens.length <= 3 && anchorTokens.length >= 1 && avgWordConf >= 80)
      );

      // Check repeated symbols
      if (maxConsecutiveSymbols >= 1 && !hasAnchorWord) {
        return true;
      }

      // Mixed math / comparison symbols in low/moderate confidence line without valid Thai
      const hasMixedSymbols = tokens.some(t => /^[=_\-+*#~`!?:;\\/|<>\^]+$/.test(t.text));
      if (hasMixedSymbols && (lineConf < 75 || avgWordConf < 75) && !hasValidThai) {
        return true;
      }

      // Pure digit noise check (e.g. "85 7 8 2 1" mixed with Thai zero "๐")
      const numTokens = tokens.filter(t => /^[0-9\u0E50-\u0E59.,]+$/.test(t.text)).length;
      const isDigitNoise = (tokens.length >= 4 && numTokens >= tokens.length * 0.55 && shortRatio >= 0.70 && !hasValidThai && !hasAnchorWord);
      if (isDigitNoise) {
        return true;
      }

      // Protection: if line has valid Thai or strong anchor words AND good confidence:
      if ((hasValidThai || hasAnchorWord) && (avgWordConf >= 60 || lineConf >= 60) && maxConsecutiveSymbols < 1) {
        return false;
      }

      // Pure Latin / formula line check
      const isAllLatinOrMath = tokens.every(t => /[a-zA-Z0-9\s.,/()\-:;"'@#$%&*+=]/.test(t.text));
      if (isAllLatinOrMath && (avgWordConf >= 75 || lineConf >= 75) && totalChars >= 5) {
        return false;
      }

      // High fragmentation / short average token length without valid content
      if (avgTokenLen < 3.2 && !hasAnchorWord && !hasValidThai) {
        return true;
      }

      if (tokens.length >= 4 && shortRatio >= 0.60 && !hasAnchorWord && !hasValidThai) {
        return true;
      }

      // Mixed Thai + Latin character soup without coherent Thai or Latin
      if (tokens.length >= 5 && shortRatio >= 0.50 && !hasAnchorWord && !hasValidThai) {
        return true;
      }

      if (lineConf < 50 && !hasAnchorWord && !hasValidThai) return true;
      if (avgWordConf < 50 && !hasAnchorWord && !hasValidThai) return true;

      return false;
    }

    for (const rawLine of rawLines) {
      const rawText = (rawLine.text || '').trim();
      if (!rawText) continue;

      const lineWords = (rawLine.words || []).filter(w => (w.text || '').trim());
      if (lineWords.length === 0) continue;

      let sumConf = 0;
      const tokens = [];
      for (const w of lineWords) {
        const c = w.confidence != null ? w.confidence : 0;
        sumConf += c;
        tokens.push({
          rawWord: w,
          text: (w.text || '').trim(),
          conf: c
        });
      }

      const avgWordConf = Math.round(sumConf / tokens.length);
      const isNoise = isNoiseLine(rawLine, avgWordConf, tokens);

      if (isNoise) {
        suppressedLines.push({ text: rawText, conf: rawLine.confidence, avgWordConf });
        for (const t of tokens) {
          suppressedWords.push(t.rawWord);
        }
      } else {
        const keptTokens = [];
        for (const t of tokens) {
          // Token-level filtering: keep token if confident or contextual
          if (t.conf >= 45 || (avgWordConf >= 75 && t.conf >= 30) || /[\u0E00-\u0E7F]/.test(t.text)) {
            keptTokens.push(t);
            totalWordConf += t.conf;
            totalWordCount++;
          } else {
            suppressedWords.push(t.rawWord);
          }
        }

        if (keptTokens.length > 0) {
          let lineStr = keptTokens.map(t => t.text).join(' ').trim();
          if (/[\u0E00-\u0E7F]/.test(lineStr)) {
            lineStr = lineStr.replace(/([\u0E00-\u0E7F])\s+(?=[\u0E00-\u0E7F])/g, '$1');
          }
          keptLines.push({
            text: lineStr,
            conf: Math.max(rawLine.confidence || 0, avgWordConf),
            tokens: keptTokens
          });
        }
      }
    }

    const calculatedConfidence = totalWordCount > 0
      ? Math.round(totalWordConf / totalWordCount)
      : Math.round(tessData.confidence || 0);

    let totalKeptChars = 0;
    for (const kl of keptLines) {
      totalKeptChars += kl.text.replace(/\s+/g, '').length;
    }

    let status = 'LOW';
    // A document page with <= 2 total characters is an artifact (e.g. circle recognized as 'ว' or speckle)
    if (totalKeptChars <= 2 || keptLines.length === 0) {
      status = 'LOW';
    } else {
      if (suppressedLines.length === 0 && calculatedConfidence >= 70) {
        status = 'GOOD';
      } else {
        status = 'FAIR';
      }
    }

    const finalText = status === 'LOW' ? '' : keptLines.map(l => l.text).join('\n').trim();

    return {
      status,
      text: finalText,
      confidence: status === 'LOW' ? 0 : calculatedConfidence,
      keptLines,
      suppressedWords,
      suppressedLinesCount: suppressedLines.length
    };
  }

  // --- Sanitize Tesseract PDF text layer by removing suppressed noise tokens ---
  async function sanitizeTesseractPdfStream(rawPdfBytes, wordsToSuppress) {
    if (!rawPdfBytes || !wordsToSuppress || wordsToSuppress.length === 0) return rawPdfBytes;
    if (!window.PDFLib || !window.PDFLib.PDFDocument) return rawPdfBytes;

    try {
      const pdfDoc = await window.PDFLib.PDFDocument.load(rawPdfBytes);
      const pages = pdfDoc.getPages();
      if (pages.length === 0) return rawPdfBytes;
      const page0 = pages[0];
      const contentsRef = page0.node.get(window.PDFLib.PDFName.of('Contents'));
      if (!contentsRef) return rawPdfBytes;
      const contentsStream = pdfDoc.context.lookup(contentsRef);
      if (!contentsStream || typeof contentsStream.getContents !== 'function') return rawPdfBytes;

      const compressed = contentsStream.getContents();
      
      // Inflate stream using native DecompressionStream
      const ds = new DecompressionStream('deflate');
      const writer = ds.writable.getWriter();
      writer.write(compressed);
      writer.close();
      const reader = ds.readable.getReader();
      const chunks = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      let total = 0; chunks.forEach(ch => total += ch.length);
      const uncompressed = new Uint8Array(total);
      let offset = 0;
      chunks.forEach(ch => { uncompressed.set(ch, offset); offset += ch.length; });

      let textOps = new TextDecoder('latin1').decode(uncompressed);

      function textToPdfHex(str) {
        let hex = '';
        for (let i = 0; i < str.length; i++) {
          hex += str.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
        }
        return hex;
      }

      for (const w of wordsToSuppress) {
        const rawWd = (w.text || '').trim();
        if (!rawWd) continue;
        const hex = textToPdfHex(rawWd);
        if (hex) {
          const re = new RegExp('<' + hex + '(?:0020)?>', 'gi');
          textOps = textOps.replace(re, '<>');
        }
      }

      const newStream = pdfDoc.context.flateStream(new TextEncoder().encode(textOps));
      page0.node.set(window.PDFLib.PDFName.of('Contents'), pdfDoc.context.register(newStream));

      return await pdfDoc.save();
    } catch (err) {
      console.warn('sanitizeTesseractPdfStream error:', err);
      return rawPdfBytes;
    }
  }

  // --- Cancel OCR Execution ---
  async function cancelOcr() {
    if (!ocrState.isProcessing) return;
    ocrState.cancelRequested = true;
    if (ocrState.activeWorker) {
      try {
        await ocrState.activeWorker.terminate();
      } catch (_) {}
      ocrState.activeWorker = null;
    }
    ocrState.isProcessing = false;

    const progressCard = document.getElementById('ocrProgressCard');
    const btnExecute = document.getElementById('btnExecuteOcr');
    if (progressCard) progressCard.classList.add('hidden');
    if (btnExecute) btnExecute.disabled = false;

    showToast('ยกเลิกการทำ OCR แล้ว', 'info');
  }

  // --- Execute OCR Core Pipeline ---
  async function executeOcr() {
    if (!ocrState.pages || ocrState.pages.length === 0) {
      showToast('กรุณาเลือกไฟล์เอกสารหรือรูปภาพก่อนทำ OCR', 'error');
      return;
    }

    if (!window.Tesseract) {
      showToast('ไลบรารี Tesseract.js ไม่พร้อมใช้งาน กรุณารีเฟรชหน้าเว็บ', 'error');
      return;
    }

    if (ocrState.isProcessing) return;

    const langSelect = document.getElementById('ocrLanguage');
    const selectedLang = langSelect ? langSelect.value : 'tha+eng';
    const shouldPreprocess = document.getElementById('ocrPreprocess')?.checked ?? false;
    const shouldMakeSearchable = document.getElementById('ocrSearchablePdf')?.checked ?? true;

    const progressCard = document.getElementById('ocrProgressCard');
    const progressStatus = document.getElementById('ocrProgressStatus');
    const progressBarFill = document.getElementById('ocrProgressBarFill');
    const progressPercent = document.getElementById('ocrProgressPercent');
    const progressPages = document.getElementById('ocrProgressPages');
    const btnExecute = document.getElementById('btnExecuteOcr');
    const resultsBox = document.getElementById('ocrResultsBox');
    const textarea = document.getElementById('ocrExtractedText');
    const confSummary = document.getElementById('ocrConfidenceSummary');

    if (progressCard) progressCard.classList.remove('hidden');
    if (btnExecute) btnExecute.disabled = true;

    ocrState.isProcessing = true;
    ocrState.cancelRequested = false;

    let worker = null;
    let pdfDoc = null;
    let loadingTask = null;

    try {
      if (progressStatus) progressStatus.textContent = 'กำลังโหลด OCR Engine ในเครื่อง (Local WASM)...';
      if (progressBarFill) progressBarFill.style.width = '5%';
      if (progressPercent) progressPercent.textContent = '5%';
      if (progressPages) progressPages.textContent = `0 / ${ocrState.totalPages} หน้า`;

      worker = await createTesseractWorker(selectedLang, (m) => {
        if (ocrState.cancelRequested) return;
        if (m.status === 'recognizing text' && m.progress != null) {
          const cur = (ocrState._currentStep || 0) + m.progress;
          const pct = Math.min(99, Math.round((cur / ocrState.totalPages) * 100));
          if (progressBarFill) progressBarFill.style.width = `${pct}%`;
          if (progressPercent) progressPercent.textContent = `${pct}%`;
        }
      });
      ocrState.activeWorker = worker;

      if (ocrState.cancelRequested) {
        await worker.terminate();
        ocrState.activeWorker = null;
        return;
      }

      if (ocrState.isPdf) {
        loadingTask = window.pdfjsLib.getDocument({ data: new Uint8Array(ocrState.buffer.slice(0)) });
        pdfDoc = await loadingTask.promise;
      }

      let allText = '';
      let totalConfidenceSum = 0;
      let scoredPagesCount = 0;

      for (let i = 0; i < ocrState.totalPages; i++) {
        if (ocrState.cancelRequested) break;

        const pageNum = i + 1;
        const pageItem = ocrState.pages[i];
        ocrState._currentStep = i;

        if (progressStatus) progressStatus.textContent = `กำลังอ่านข้อความหน้า ${pageNum} จาก ${ocrState.totalPages}...`;
        if (progressPages) progressPages.textContent = `${pageNum} / ${ocrState.totalPages} หน้า`;
        const stepBasePct = Math.round((i / ocrState.totalPages) * 100);
        if (progressBarFill) progressBarFill.style.width = `${stepBasePct}%`;
        if (progressPercent) progressPercent.textContent = `${stepBasePct}%`;

        // Acquire canvas for this page
        let originalCanvas = null;
        if (ocrState.isPdf) {
          const pdfPage = await pdfDoc.getPage(pageNum);
          const viewport = pdfPage.getViewport({ scale: 2.0 });
          originalCanvas = document.createElement('canvas');
          originalCanvas.width = viewport.width;
          originalCanvas.height = viewport.height;
          const ctx = originalCanvas.getContext('2d');
          await pdfPage.render({ canvasContext: ctx, viewport }).promise;
          pdfPage.cleanup();
        } else {
          originalCanvas = await loadImageToCanvas(pageItem.file);
        }

        if (ocrState.cancelRequested) {
          originalCanvas.width = 0; originalCanvas.height = 0;
          break;
        }

        // Apply preprocessing if toggled
        let ocrInputCanvas = originalCanvas;
        let preprocessedCanvas = null;
        if (shouldPreprocess) {
          preprocessedCanvas = preprocessImageForOcr(originalCanvas);
          ocrInputCanvas = preprocessedCanvas;
        }

        // Run recognition: request text and invisible PDF layer
        const ret = await worker.recognize(ocrInputCanvas, {
          pdfTitle: `PDF LAB - Page ${pageNum}`,
          pdfTextOnly: true
        }, {
          text: true,
          blocks: true,
          pdf: true
        });

        // Apply OCR Output Quality Gate
        const quality = evaluateOcrQuality(ret.data);
        const pagePdf = ret.data ? ret.data.pdf : null;

        pageItem.qualityStatus = quality.status;
        pageItem.text = quality.text;
        pageItem.confidence = quality.confidence;
        pageItem.suppressedLinesCount = quality.suppressedLinesCount;
        pageItem.tessData = ret.data;

        if (quality.status === 'LOW') {
          // Do NOT inject low-confidence garbage into invisible text layer
          pageItem.pdfBytes = null;
        } else if (quality.status === 'FAIR') {
          if (quality.suppressedWords && quality.suppressedWords.length > 0 && pagePdf) {
            pageItem.pdfBytes = await sanitizeTesseractPdfStream(pagePdf, quality.suppressedWords);
          } else {
            pageItem.pdfBytes = pagePdf;
          }
        } else {
          pageItem.pdfBytes = pagePdf;
        }

        if (quality.status !== 'LOW' && quality.confidence > 0) {
          totalConfidenceSum += quality.confidence;
          scoredPagesCount++;
        }

        if (ocrState.totalPages > 1) {
          if (quality.status === 'LOW') {
            allText += `\n--- [ หน้า ${pageNum} ] ---\n(ไม่พบข้อความที่อ่านได้อย่างมั่นใจ ระบบซ่อนข้อความที่มีความน่าเชื่อถือต่ำ)\n`;
          } else {
            allText += `\n--- [ หน้า ${pageNum} ] ---\n` + (quality.text || '(ไม่พบข้อความ)') + '\n';
          }
        } else {
          allText += quality.text;
        }

        // Update card in UI with confidence badge
        const cardEl = document.getElementById(`ocrCard-${pageNum}`);
        if (cardEl) {
          let confEl = cardEl.querySelector('.ocr-card-confidence');
          if (!confEl) {
            confEl = document.createElement('div');
            confEl.className = 'ocr-card-confidence';
            cardEl.appendChild(confEl);
          }
          if (quality.status === 'LOW') {
            confEl.className = 'ocr-card-confidence ocr-conf-low';
            confEl.textContent = 'คุณภาพต่ำ (ไม่พบข้อความที่มั่นใจ)';
          } else if (quality.status === 'FAIR') {
            confEl.className = 'ocr-card-confidence ocr-conf-fair';
            confEl.textContent = `ความแม่นยำ ${quality.confidence}% (ปานกลาง)`;
          } else {
            confEl.className = 'ocr-card-confidence ocr-conf-good';
            confEl.textContent = `ความแม่นยำ ${quality.confidence}%`;
          }
        }

        // Release memory for this page
        originalCanvas.width = 0; originalCanvas.height = 0;
        if (preprocessedCanvas) {
          preprocessedCanvas.width = 0; preprocessedCanvas.height = 0;
        }
        await new Promise(r => setTimeout(r, 0));
      }

      if (ocrState.cancelRequested) {
        if (worker) {
          try { await worker.terminate(); } catch (_) {}
          ocrState.activeWorker = null;
        }
        if (pdfDoc) {
          try { await pdfDoc.destroy(); loadingTask.destroy(); } catch (_) {}
        }
        return;
      }

      // Cleanup worker and PDF.js tasks
      await worker.terminate();
      worker = null;
      ocrState.activeWorker = null;

      if (pdfDoc) {
        await pdfDoc.destroy();
        loadingTask.destroy();
        pdfDoc = null;
        loadingTask = null;
      }

      // Build Searchable PDF in memory if requested
      if (shouldMakeSearchable) {
        if (progressStatus) progressStatus.textContent = 'กำลังผสาน Searchable PDF (Invisible Text Layer)...';
        ocrState.searchablePdfBytes = await buildSearchablePdf();
      }

      // Calculate confidence stats
      const avgConfidence = scoredPagesCount > 0 ? Math.round(totalConfidenceSum / scoredPagesCount) : 0;
      const allPagesLow = ocrState.pages.length > 0 && ocrState.pages.every(p => p.qualityStatus === 'LOW');
      const somePagesFair = ocrState.pages.some(p => p.qualityStatus === 'FAIR');

      ocrState.overallConfidence = avgConfidence;
      ocrState.extractedText = allText.trim();

      if (textarea) {
        if (allPagesLow || !ocrState.extractedText) {
          textarea.value = 'หน้านี้มีข้อความที่ OCR อ่านได้ไม่มั่นใจ\nระบบจึงซ่อนข้อความที่มีความน่าเชื่อถือต่ำเพื่อป้องกันข้อความผิดพลาด';
        } else {
          textarea.value = ocrState.extractedText;
        }
      }
      if (confSummary) {
        if (allPagesLow) {
          confSummary.textContent = `อ่านแล้ว ${ocrState.totalPages} / ${ocrState.totalPages} หน้า • คุณภาพต่ำ (ระบบซ่อนข้อความความน่าเชื่อถือต่ำ)`;
        } else if (somePagesFair) {
          confSummary.textContent = `อ่านแล้ว ${ocrState.totalPages} / ${ocrState.totalPages} หน้า • ความแม่นยำรวม ${avgConfidence}% (ระบบซ่อนข้อความที่ไม่มั่นใจบางส่วน)`;
        } else {
          confSummary.textContent = `อ่านแล้ว ${ocrState.totalPages} / ${ocrState.totalPages} หน้า • ความแม่นยำรวม ${avgConfidence}%`;
        }
      }
      if (resultsBox) resultsBox.classList.remove('hidden');

      const confBadge = document.getElementById('ocrConfidenceBadge');
      if (confBadge) {
        if (allPagesLow) {
          confBadge.textContent = 'คุณภาพ OCR: ต่ำ';
          confBadge.className = 'badge-status badge-warning';
        } else if (somePagesFair) {
          confBadge.textContent = `ความแม่นยำรวม ${avgConfidence}% (ปานกลาง)`;
          confBadge.className = 'badge-status badge-info';
        } else {
          confBadge.textContent = `ความแม่นยำรวม ${avgConfidence}%`;
          confBadge.className = 'badge-status badge-success';
        }
        confBadge.classList.remove('hidden');
      }
      const statusBadge = document.getElementById('ocrStatusBadge');
      if (statusBadge) statusBadge.textContent = '✓ สแกนแล้ว';

      renderPageTextReviews();

      if (progressStatus) progressStatus.textContent = '✓ ประมวลผล OCR เสร็จสมบูรณ์!';
      if (progressBarFill) progressBarFill.style.width = '100%';
      if (progressPercent) progressPercent.textContent = '100%';
      if (progressPages) progressPages.textContent = `${ocrState.totalPages} / ${ocrState.totalPages} หน้า`;

      showToast('ทำ OCR เสร็จสมบูรณ์แล้ว!', 'success');
    } catch (err) {
      console.error('OCR processing error details:', err, err?.stack);
      if (worker) {
        try { await worker.terminate(); } catch (_) {}
      }
      ocrState.activeWorker = null;
      if (pdfDoc) {
        try { await pdfDoc.destroy(); loadingTask.destroy(); } catch (_) {}
      }
      const errMessage = formatOcrError(err);
      if (progressStatus) progressStatus.textContent = '❌ ' + errMessage;
      showToast('เกิดข้อผิดพลาดในการทำ OCR: ' + errMessage, 'error');
    } finally {
      ocrState.isProcessing = false;
      if (btnExecute) btnExecute.disabled = false;
    }
  }

  // --- Build Searchable PDF using PDFLib ---
  async function buildSearchablePdf() {
    if (!window.PDFLib || !window.PDFLib.PDFDocument) {
      throw new Error('ไลบรารี PDF-Lib ไม่พร้อมใช้งาน');
    }

    if (ocrState.isPdf) {
      // PDF Overlay Strategy: load original PDF, embed text-only layer onto each page
      const targetDoc = await window.PDFLib.PDFDocument.load(ocrState.buffer);
      const targetPages = targetDoc.getPages();

      for (let i = 0; i < targetPages.length; i++) {
        const pageItem = ocrState.pages[i];
        if (pageItem && pageItem.pdfBytes) {
          try {
            const textDoc = await window.PDFLib.PDFDocument.load(pageItem.pdfBytes);
            const [embeddedText] = await targetDoc.embedPdf(textDoc, [0]);
            const targetPage = targetPages[i];
            targetPage.drawPage(embeddedText, {
              x: 0,
              y: 0,
              width: targetPage.getWidth(),
              height: targetPage.getHeight()
            });
          } catch (overlayErr) {
            console.warn(`Failed to overlay text on page ${i + 1}:`, overlayErr);
          }
        }
      }
      return await targetDoc.save();
    } else {
      // Image Strategy: create new PDF, embed original image + invisible text layer
      const targetDoc = await window.PDFLib.PDFDocument.create();

      for (let i = 0; i < ocrState.pages.length; i++) {
        const pageItem = ocrState.pages[i];
        const imgBuffer = await pageItem.file.arrayBuffer();

        let embeddedImg = null;
        const isPng = pageItem.file.type === 'image/png' || /\.png$/i.test(pageItem.file.name);
        try {
          if (isPng) {
            embeddedImg = await targetDoc.embedPng(imgBuffer);
          } else {
            embeddedImg = await targetDoc.embedJpg(imgBuffer);
          }
        } catch (embedErr) {
          // Fallback through canvas to JPEG if direct embedding fails
          const c = await loadImageToCanvas(pageItem.file);
          const jpgBlob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
          const fallbackBuffer = await jpgBlob.arrayBuffer();
          embeddedImg = await targetDoc.embedJpg(fallbackBuffer);
          c.width = 0; c.height = 0;
        }

        const imgWidth = embeddedImg.width;
        const imgHeight = embeddedImg.height;
        const page = targetDoc.addPage([imgWidth, imgHeight]);
        page.drawImage(embeddedImg, { x: 0, y: 0, width: imgWidth, height: imgHeight });

        if (pageItem.pdfBytes) {
          try {
            const textDoc = await window.PDFLib.PDFDocument.load(pageItem.pdfBytes);
            const [embeddedText] = await targetDoc.embedPdf(textDoc, [0]);
            page.drawPage(embeddedText, { x: 0, y: 0, width: imgWidth, height: imgHeight });
          } catch (overlayErr) {
            console.warn(`Failed to overlay text on image page ${i + 1}:`, overlayErr);
          }
        }
      }
      return await targetDoc.save();
    }
  }

  // --- Download Searchable PDF ---
  async function downloadSearchablePdf() {
    if (!ocrState.pages || ocrState.pages.length === 0) {
      showToast('กรุณาทำ OCR ก่อนดาวน์โหลด PDF', 'error');
      return;
    }

    showProgressModal();
    updateProgress(0, 1, 'กำลังเตรียม Searchable PDF...');

    try {
      let pdfBytes = ocrState.searchablePdfBytes;
      if (!pdfBytes) {
        updateProgress(0, 1, 'กำลังสร้างไฟล์ Searchable PDF...');
        pdfBytes = await buildSearchablePdf();
        ocrState.searchablePdfBytes = pdfBytes;
      }

      let filename = ocrState.outputFilename || 'document-ocr.pdf';
      if (!filename.toLowerCase().endsWith('.pdf')) filename += '.pdf';

      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      downloadBlob(blob, filename);

      hideProgressModal();
      showToast(`ดาวน์โหลด Searchable PDF "${filename}" สำเร็จ!`, 'success');
    } catch (err) {
      console.warn('downloadSearchablePdf error:', err);
      hideProgressModal();
      showToast('เกิดข้อผิดพลาดในการสร้าง PDF: ' + err.message, 'error');
    }
  }

  // ==========================================================================
  // TOOL 8: บีบอัด PDF (Compress PDF) — 2-PANE WORKSPACE DESIGN SYSTEM
  // ==========================================================================
  const compressPdfState = {
    files: [], // Array of { id, file, name, size, pageCount, buffer, thumbUrl, compressedBlob, compressedSize, isCompressed, hasText }
    level: 'balanced', // 'high' | 'balanced' | 'small'
    isProcessing: false,
    activeFileIndex: 0,
    activePage: 1,
    zoomScale: 1.0,
    fitMode: true,
    mobileView: 'original', // 'original' | 'compressed'
    originalDoc: null,
    compressedDoc: null,
    renderedThumbs: new Map() // pageNum -> dataUrl
  };

  // Compression presets for Local Image Recompression:
  // high: ~150 DPI (scale 2.083), quality 0.85
  // balanced: ~120 DPI (scale 1.666), quality 0.72
  // small: ~90 DPI (scale 1.25), quality 0.55
  const COMPRESS_PDF_PRESETS = {
    high: { scale: 150 / 72, quality: 0.85, label: 'คุณภาพสูง (150 DPI / 85%)' },
    balanced: { scale: 120 / 72, quality: 0.72, label: 'สมดุล (120 DPI / 72%)' },
    small: { scale: 90 / 72, quality: 0.55, label: 'ขนาดเล็ก (90 DPI / 55%)' }
  };

  // PDF.js Memory Lifecycle Manager: Safe destruction of previous documents & URLs
  async function cleanupWorkbenchPdfJsDocs() {
    if (compressPdfState.originalDoc) {
      try {
        await compressPdfState.originalDoc.destroy();
      } catch (_) {}
      compressPdfState.originalDoc = null;
    }
    if (compressPdfState.compressedDoc) {
      try {
        await compressPdfState.compressedDoc.destroy();
      } catch (_) {}
      compressPdfState.compressedDoc = null;
    }
    compressPdfState.renderedThumbs.clear();

    const canvasOrig = document.getElementById('compressPdfCanvasOriginal');
    if (canvasOrig) {
      canvasOrig.width = 0;
      canvasOrig.height = 0;
    }
    const canvasComp = document.getElementById('compressPdfCanvasCompressed');
    if (canvasComp) {
      canvasComp.width = 0;
      canvasComp.height = 0;
    }
  }

  function initCompressPdfTool() {
    const fileInput = document.getElementById('fileInputCompressPdf');
    const btnSelect = document.getElementById('btnSelectCompressPdf');
    const dropZone = document.getElementById('compressPdfDropZone');
    const btnAddMore = document.getElementById('btnAddMoreCompressPdf');
    const btnClear = document.getElementById('btnClearCompressPdf');
    const btnExecute = document.getElementById('btnExecuteCompressPdf');
    const btnDownloadAll = document.getElementById('btnDownloadAllCompressPdf');
    const btnDownloadActive = document.getElementById('btnDownloadActiveCompressPdf');

    // Page navigation & Zoom buttons
    const btnPrevPage = document.getElementById('btnCompressPdfPrevPage');
    const btnNextPage = document.getElementById('btnCompressPdfNextPage');
    const btnZoomOut = document.getElementById('btnCompressPdfZoomOut');
    const btnZoomIn = document.getElementById('btnCompressPdfZoomIn');
    const btnZoomFit = document.getElementById('btnCompressPdfZoomFit');

    // Mobile View Toggle buttons
    const btnToggleOrig = document.getElementById('btnToggleViewOriginal');
    const btnToggleComp = document.getElementById('btnToggleViewCompressed');

    btnSelect?.addEventListener('click', () => fileInput?.click());
    btnAddMore?.addEventListener('click', () => fileInput?.click());

    dropZone?.addEventListener('click', (e) => {
      if (e.target.closest('#btnSelectCompressPdf')) return;
      fileInput?.click();
    });

    dropZone?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput?.click();
      }
    });

    setupDropZoneEvents(dropZone, handleCompressPdfFiles);

    fileInput?.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleCompressPdfFiles(Array.from(e.target.files));
        fileInput.value = '';
      }
    });

    btnClear?.addEventListener('click', async () => {
      await cleanupWorkbenchPdfJsDocs();
      compressPdfState.files.forEach(f => {
        if (f.thumbUrl && f.thumbUrl.startsWith('blob:')) URL.revokeObjectURL(f.thumbUrl);
      });
      compressPdfState.files = [];
      compressPdfState.activeFileIndex = 0;
      compressPdfState.activePage = 1;
      compressPdfState.zoomScale = 1.0;
      compressPdfState.fitMode = true;
      renderCompressPdfUI();
      showToast('ล้างรายการไฟล์ทั้งหมดแล้ว', 'info');
    });

    // Level selector radio changes
    document.querySelectorAll('input[name="compressPdfLevel"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        compressPdfState.level = e.target.value;
        document.querySelectorAll('.compression-level-selector .level-card').forEach(card => {
          const input = card.querySelector('input[type="radio"]');
          card.classList.toggle('selected', input && input.checked);
        });

        const smallWarning = document.getElementById('compressPdfSmallWarning');
        if (smallWarning) {
          smallWarning.classList.toggle('hidden', compressPdfState.level !== 'small');
        }
      });
    });

    btnExecute?.addEventListener('click', executeCompressPdf);
    btnDownloadAll?.addEventListener('click', downloadAllCompressPdf);

    // Download active file compressed PDF
    btnDownloadActive?.addEventListener('click', () => {
      const activeItem = compressPdfState.files[compressPdfState.activeFileIndex];
      if (activeItem && activeItem.compressedBlob) {
        const outName = activeItem.name.replace(/\.pdf$/i, '') + '-compressed.pdf';
        downloadBlob(activeItem.compressedBlob, outName);
        showToast(`ดาวน์โหลด "${outName}" เรียบร้อย`, 'success');
      }
    });

    // Navigation & Zoom Event Listeners
    btnPrevPage?.addEventListener('click', () => {
      if (compressPdfState.activePage > 1) {
        compressPdfState.activePage--;
        renderActivePagePreview();
      }
    });

    btnNextPage?.addEventListener('click', () => {
      const activeItem = compressPdfState.files[compressPdfState.activeFileIndex];
      const maxPages = activeItem ? activeItem.pageCount : 1;
      if (compressPdfState.activePage < maxPages) {
        compressPdfState.activePage++;
        renderActivePagePreview();
      }
    });

    btnZoomOut?.addEventListener('click', () => {
      compressPdfState.fitMode = false;
      compressPdfState.zoomScale = Math.max(0.3, compressPdfState.zoomScale - 0.15);
      renderActivePagePreview();
    });

    btnZoomIn?.addEventListener('click', () => {
      compressPdfState.fitMode = false;
      compressPdfState.zoomScale = Math.min(3.0, compressPdfState.zoomScale + 0.15);
      renderActivePagePreview();
    });

    btnZoomFit?.addEventListener('click', () => {
      compressPdfState.fitMode = true;
      renderActivePagePreview();
    });

    // Mobile View Toggle Listeners
    btnToggleOrig?.addEventListener('click', () => {
      compressPdfState.mobileView = 'original';
      btnToggleOrig.classList.add('active');
      btnToggleComp?.classList.remove('active');
      updateMobilePanesVisibility();
    });

    btnToggleComp?.addEventListener('click', () => {
      compressPdfState.mobileView = 'compressed';
      btnToggleComp.classList.add('active');
      btnToggleOrig?.classList.remove('active');
      updateMobilePanesVisibility();
    });

    // Keyboard Arrow navigation for Workbench Stage
    const stage = document.getElementById('compressPdfStage');
    stage?.addEventListener('keydown', (e) => {
      const activeItem = compressPdfState.files[compressPdfState.activeFileIndex];
      if (!activeItem) return;
      if (e.key === 'ArrowLeft' && compressPdfState.activePage > 1) {
        e.preventDefault();
        compressPdfState.activePage--;
        renderActivePagePreview();
      } else if (e.key === 'ArrowRight' && compressPdfState.activePage < activeItem.pageCount) {
        e.preventDefault();
        compressPdfState.activePage++;
        renderActivePagePreview();
      }
    });

    // Window resize observer to update Fit zoom mode dynamically
    window.addEventListener('resize', () => {
      if (compressPdfState.files.length > 0 && compressPdfState.fitMode) {
        renderActivePagePreview();
      }
    });
  }

  function updateMobilePanesVisibility() {
    const origPane = document.getElementById('compressPdfViewerOriginal');
    const compPane = document.getElementById('compressPdfViewerCompressed');
    if (!origPane || !compPane) return;

    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
      if (compressPdfState.mobileView === 'original') {
        origPane.classList.remove('mobile-hidden');
        compPane.classList.add('mobile-hidden');
      } else {
        origPane.classList.add('mobile-hidden');
        compPane.classList.remove('mobile-hidden');
      }
    } else {
      origPane.classList.remove('mobile-hidden');
      compPane.classList.remove('mobile-hidden');
    }
  }

  async function handleCompressPdfFiles(files) {
    const pdfFiles = files.filter(f => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf');
    if (pdfFiles.length === 0) {
      showToast('กรุณาเลือกไฟล์เอกสาร PDF เท่านั้น', 'error');
      return;
    }

    showProgressModal();
    updateProgress(0, pdfFiles.length, 'กำลังตรวจสอบไฟล์ PDF...');

    let loaded = 0;
    for (let i = 0; i < pdfFiles.length; i++) {
      const file = pdfFiles[i];
      updateProgress(i + 1, pdfFiles.length, `กำลังอ่าน "${file.name}"...`);
      try {
        const loadedPdf = await loadPdfDocument(file);
        let thumbUrl = null;
        try {
          thumbUrl = await renderPdfThumbnail(loadedPdf.buffer, 1, 0.3);
        } catch (_) {}

        compressPdfState.files.push({
          id: 'comp_pdf_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
          file,
          name: file.name,
          size: file.size,
          pageCount: loadedPdf.pageCount,
          buffer: loadedPdf.buffer,
          thumbUrl,
          compressedBlob: null,
          compressedSize: null,
          isCompressed: false
        });
        loaded++;
      } catch (err) {
        console.warn('Compress PDF Load Error:', err);
        showToast(err.message || `ไม่สามารถเปิด "${file.name}" ได้`, 'error');
      }
    }

    hideProgressModal();
    if (loaded > 0) {
      await switchActiveFile(compressPdfState.files.length - loaded);
      renderCompressPdfUI();
      showToast(`เพิ่มไฟล์ PDF สำเร็จ ${loaded} ไฟล์`, 'success');
    }
  }

  async function switchActiveFile(index) {
    if (index < 0 || index >= compressPdfState.files.length) return;
    compressPdfState.activeFileIndex = index;
    compressPdfState.activePage = 1;
    await cleanupWorkbenchPdfJsDocs();

    const activeItem = compressPdfState.files[index];
    if (activeItem && activeItem.buffer) {
      try {
        const origTask = window.pdfjsLib.getDocument({ data: new Uint8Array(activeItem.buffer.slice(0)) });
        compressPdfState.originalDoc = await origTask.promise;
      } catch (err) {
        console.warn('Failed to load originalDoc in PDF.js:', err);
      }

      if (activeItem.isCompressed && activeItem.compressedBlob) {
        try {
          const compAb = await activeItem.compressedBlob.arrayBuffer();
          const compTask = window.pdfjsLib.getDocument({ data: new Uint8Array(compAb) });
          compressPdfState.compressedDoc = await compTask.promise;
        } catch (err) {
          console.warn('Failed to load compressedDoc in PDF.js:', err);
        }
      }
    }
    await renderActivePagePreview();
  }

  async function renderActivePagePreview() {
    const activeItem = compressPdfState.files[compressPdfState.activeFileIndex];
    if (!activeItem) return;

    const pageIndicator = document.getElementById('compressPdfPageIndicator');
    const zoomLabel = document.getElementById('compressPdfZoomLabel');
    const btnPrevPage = document.getElementById('btnCompressPdfPrevPage');
    const btnNextPage = document.getElementById('btnCompressPdfNextPage');
    const btnZoomFit = document.getElementById('btnCompressPdfZoomFit');

    const curPage = compressPdfState.activePage;
    const totalPages = activeItem.pageCount || 1;

    if (pageIndicator) pageIndicator.textContent = `หน้า ${curPage} / ${totalPages}`;
    if (btnPrevPage) btnPrevPage.disabled = curPage <= 1;
    if (btnNextPage) btnNextPage.disabled = curPage >= totalPages;

    const canvasOrig = document.getElementById('compressPdfCanvasOriginal');
    const canvasComp = document.getElementById('compressPdfCanvasCompressed');
    const placeholder = document.getElementById('compressPdfEmptyPlaceholder');
    const origMeta = document.getElementById('compressPdfOriginalMeta');
    const compMeta = document.getElementById('compressPdfCompressedMeta');
    const stage = document.getElementById('compressPdfStage');

    if (origMeta) origMeta.textContent = `${formatFileSize(activeItem.size)}`;

    if (!compressPdfState.originalDoc && activeItem.buffer) {
      try {
        const origTask = window.pdfjsLib.getDocument({ data: new Uint8Array(activeItem.buffer.slice(0)) });
        compressPdfState.originalDoc = await origTask.promise;
      } catch (_) {}
    }

    if (!compressPdfState.originalDoc) return;

    try {
      const pageOrig = await compressPdfState.originalDoc.getPage(curPage);
      const vp1 = pageOrig.getViewport({ scale: 1.0 });

      // Calculate Scale dynamically based on available Stage container dimensions
      let renderScale = compressPdfState.zoomScale;
      if (compressPdfState.fitMode && stage) {
        const isDualPane = window.innerWidth > 768;
        const availableW = Math.max(160, (stage.clientWidth - (isDualPane ? 90 : 36)) / (isDualPane ? 2 : 1));
        const availableH = Math.max(160, stage.clientHeight - 120);
        const scaleW = availableW / vp1.width;
        const scaleH = availableH / vp1.height;
        renderScale = Math.min(scaleW, scaleH, 1.8);
        renderScale = Math.max(0.2, renderScale);
        compressPdfState.zoomScale = renderScale;
      }

      if (btnZoomFit) btnZoomFit.classList.toggle('active', compressPdfState.fitMode);
      if (zoomLabel) zoomLabel.textContent = `${Math.round(renderScale * 100)}%`;

      const frameOrig = document.getElementById('compressPdfCanvasFrameOriginal');
      const frameComp = document.getElementById('compressPdfCanvasFrameCompressed');

      // Render Original Canvas
      if (canvasOrig) {
        const vpOrig = pageOrig.getViewport({ scale: renderScale });
        canvasOrig.width = Math.round(vpOrig.width);
        canvasOrig.height = Math.round(vpOrig.height);
        const ctxOrig = canvasOrig.getContext('2d');
        await pageOrig.render({ canvasContext: ctxOrig, viewport: vpOrig }).promise;

        if (frameOrig) {
          frameOrig.style.width = `${Math.round(vpOrig.width)}px`;
          frameOrig.style.height = `${Math.round(vpOrig.height)}px`;
        }
        if (frameComp && (!activeItem.isCompressed || !compressPdfState.compressedDoc)) {
          frameComp.style.width = `${Math.round(vpOrig.width)}px`;
          frameComp.style.height = `${Math.round(vpOrig.height)}px`;
        }
      }

      // Render Compressed Canvas (if available from actual output Blob)
      if (activeItem.isCompressed && activeItem.compressedBlob) {
        if (!compressPdfState.compressedDoc) {
          const compAb = await activeItem.compressedBlob.arrayBuffer();
          const compTask = window.pdfjsLib.getDocument({ data: new Uint8Array(compAb) });
          compressPdfState.compressedDoc = await compTask.promise;
        }

        if (compressPdfState.compressedDoc && canvasComp) {
          const pageComp = await compressPdfState.compressedDoc.getPage(curPage);
          const vpComp = pageComp.getViewport({ scale: renderScale });
          canvasComp.width = Math.round(vpComp.width);
          canvasComp.height = Math.round(vpComp.height);
          const ctxComp = canvasComp.getContext('2d');
          await pageComp.render({ canvasContext: ctxComp, viewport: vpComp }).promise;
          canvasComp.classList.remove('hidden');
          if (placeholder) placeholder.classList.add('hidden');

          if (frameComp) {
            frameComp.style.width = `${Math.round(vpComp.width)}px`;
            frameComp.style.height = `${Math.round(vpComp.height)}px`;
          }
        }

        if (compMeta) {
          const compSize = activeItem.compressedSize;
          const origSize = activeItem.size;
          const pct = Math.round(((origSize - compSize) / origSize) * 100);
          compMeta.textContent = compSize < origSize 
            ? `${formatFileSize(compSize)} (↓${pct}%)` 
            : `${formatFileSize(compSize)}`;
        }
      } else {
        if (canvasComp) canvasComp.classList.add('hidden');
        if (placeholder) placeholder.classList.remove('hidden');
        if (compMeta) compMeta.textContent = '-';
      }

      updateMobilePanesVisibility();
      updateThumbnailSelection();
    } catch (err) {
      console.warn('renderActivePagePreview error:', err);
    }
  }

  function updateThumbnailSelection() {
    const thumbStrip = document.getElementById('compressPdfThumbStrip');
    if (!thumbStrip) return;
    const curPage = compressPdfState.activePage;
    thumbStrip.querySelectorAll('.workbench-thumb-item').forEach(item => {
      const p = parseInt(item.dataset.page, 10);
      item.classList.toggle('active', p === curPage);
      if (p === curPage) {
        item.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    });
  }

  async function renderThumbnailStrip() {
    const thumbStrip = document.getElementById('compressPdfThumbStrip');
    if (!thumbStrip) return;
    thumbStrip.innerHTML = '';

    const activeItem = compressPdfState.files[compressPdfState.activeFileIndex];
    if (!activeItem || !compressPdfState.originalDoc) return;

    const pageCount = activeItem.pageCount || 1;

    for (let pNum = 1; pNum <= pageCount; pNum++) {
      const itemEl = document.createElement('div');
      itemEl.className = 'workbench-thumb-item' + (pNum === compressPdfState.activePage ? ' active' : '');
      itemEl.dataset.page = pNum;
      itemEl.setAttribute('role', 'tab');
      itemEl.setAttribute('aria-label', `หน้า ${pNum}`);

      const canvas = document.createElement('canvas');
      canvas.className = 'workbench-thumb-canvas';
      itemEl.appendChild(canvas);

      const numBadge = document.createElement('span');
      numBadge.className = 'workbench-thumb-number';
      numBadge.textContent = pNum;
      itemEl.appendChild(numBadge);

      itemEl.addEventListener('click', () => {
        compressPdfState.activePage = pNum;
        renderActivePagePreview();
      });

      thumbStrip.appendChild(itemEl);

      // Render thumbnail asynchronously
      (async (p, cvs) => {
        try {
          if (compressPdfState.renderedThumbs.has(p)) {
            const img = new Image();
            img.onload = () => {
              cvs.width = img.naturalWidth;
              cvs.height = img.naturalHeight;
              cvs.getContext('2d').drawImage(img, 0, 0);
            };
            img.src = compressPdfState.renderedThumbs.get(p);
            return;
          }

          const page = await compressPdfState.originalDoc.getPage(p);
          const vp = page.getViewport({ scale: 0.25 });
          cvs.width = Math.round(vp.width);
          cvs.height = Math.round(vp.height);
          const ctx = cvs.getContext('2d');
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          compressPdfState.renderedThumbs.set(p, cvs.toDataURL('image/jpeg', 0.8));
        } catch (_) {}
      })(pNum, canvas);
    }
  }

  function renderCompressPdfUI() {
    const uploadScreen = document.getElementById('compressPdfUploadScreen');
    const workspaceScreen = document.getElementById('compressPdfWorkspaceScreen');
    const fileListEl = document.getElementById('compressPdfFileList');
    const fileBadge = document.getElementById('compressPdfFileBadge');
    const statusBadge = document.getElementById('compressPdfStatusBadge');
    const ctaSubtext = document.getElementById('compressPdfCtaSubtext');
    const summaryCard = document.getElementById('compressPdfSummaryCard');
    const summarySubtext = document.getElementById('compressPdfSummarySubtext');
    const resultBadges = document.getElementById('compressPdfResultBadges');
    const executeBtn = document.getElementById('btnExecuteCompressPdf');
    const activeFileNameEl = document.getElementById('compressPdfActiveFileName');
    const activePageCountEl = document.getElementById('compressPdfActivePageCount');
    const activeFileSizeEl = document.getElementById('compressPdfActiveFileSize');
    const fileTabsEl = document.getElementById('compressPdfFileTabs');
    const btnDownloadAll = document.getElementById('btnDownloadAllCompressPdf');

    if (!uploadScreen || !workspaceScreen) return;

    if (compressPdfState.files.length === 0) {
      uploadScreen.classList.remove('hidden');
      workspaceScreen.classList.add('hidden');
      if (fileListEl) fileListEl.innerHTML = '';
      if (summaryCard) summaryCard.classList.add('hidden');
      if (executeBtn) executeBtn.classList.remove('hidden');
      return;
    }

    uploadScreen.classList.add('hidden');
    workspaceScreen.classList.remove('hidden');

    const totalFiles = compressPdfState.files.length;
    const compressedFiles = compressPdfState.files.filter(f => f.isCompressed);
    const allDone = compressedFiles.length === totalFiles && totalFiles > 0;

    if (fileBadge) fileBadge.textContent = `${totalFiles} ไฟล์`;
    if (ctaSubtext) ctaSubtext.textContent = `${totalFiles} ไฟล์`;

    if (statusBadge) {
      if (allDone) {
        statusBadge.textContent = 'บีบอัดเรียบร้อย';
        statusBadge.className = 'badge-status badge-success';
      } else {
        statusBadge.textContent = 'พร้อมบีบอัด';
        statusBadge.className = 'badge-status';
      }
    }

    // Active File Meta in Top Bar
    const activeIndex = Math.min(compressPdfState.activeFileIndex, totalFiles - 1);
    compressPdfState.activeFileIndex = Math.max(0, activeIndex);
    const activeItem = compressPdfState.files[compressPdfState.activeFileIndex];

    if (activeItem) {
      if (activeFileNameEl) {
        activeFileNameEl.textContent = activeItem.name;
        activeFileNameEl.title = activeItem.name;
      }
      if (activePageCountEl) activePageCountEl.textContent = `${activeItem.pageCount} หน้า`;
      if (activeFileSizeEl) activeFileSizeEl.textContent = `${formatFileSize(activeItem.size)}`;
    }

    // Multi-file tabs
    if (fileTabsEl) {
      if (totalFiles > 1) {
        fileTabsEl.classList.remove('hidden');
        fileTabsEl.innerHTML = '';
        compressPdfState.files.forEach((f, idx) => {
          const tab = document.createElement('button');
          tab.type = 'button';
          tab.className = 'workbench-file-tab' + (idx === compressPdfState.activeFileIndex ? ' active' : '');
          tab.textContent = `${idx + 1}. ${f.name.length > 12 ? f.name.substr(0, 10) + '…' : f.name}`;
          tab.title = f.name;
          tab.addEventListener('click', async () => {
            await switchActiveFile(idx);
            renderCompressPdfUI();
          });
          fileTabsEl.appendChild(tab);
        });
      } else {
        fileTabsEl.classList.add('hidden');
      }
    }

    // Summary Card & Result Badges
    if (summaryCard) {
      if (compressedFiles.length > 0) {
        summaryCard.classList.remove('hidden');
        if (executeBtn) executeBtn.classList.add('hidden');

        const origTotal = compressedFiles.reduce((acc, f) => acc + f.size, 0);
        const compTotal = compressedFiles.reduce((acc, f) => acc + (f.compressedSize || f.size), 0);
        const reducedFiles = compressedFiles.filter(f => f.compressedSize < f.size);
        const savedBytes = reducedFiles.reduce((acc, f) => acc + (f.size - f.compressedSize), 0);

        if (summarySubtext) {
          if (savedBytes > 0) {
            const percentSaved = Math.round((savedBytes / origTotal) * 100);
            summarySubtext.textContent = `ประหยัดพื้นที่ได้ ${formatFileSize(savedBytes)} (${percentSaved}%) จากขนาดเดิม ${formatFileSize(origTotal)} เหลือ ${formatFileSize(compTotal)}`;
          } else {
            summarySubtext.textContent = 'ไฟล์ที่เลือกไม่สามารถลดขนาดได้เพิ่มเติมด้วยการตั้งค่านี้ (ขนาดไฟล์หลังประมวลผลใกล้เคียงหรือใหญ่กว่าเดิม)';
          }
        }

        // Populate Result Badges
        if (resultBadges && activeItem && activeItem.isCompressed) {
          const origSize = activeItem.size;
          const compSize = activeItem.compressedSize;
          let badgeHtml = '';
          if (compSize < origSize) {
            const pct = Math.round(((origSize - compSize) / origSize) * 100);
            badgeHtml += `<span class="compress-result-badge badge-reduced">↓ ${pct}% (${formatFileSize(compSize)})</span>`;
          } else {
            badgeHtml += `<span class="compress-result-badge badge-neutral">ไฟล์นี้ไม่สามารถลดขนาดได้เพิ่มเติมด้วยการตั้งค่านี้ (${formatFileSize(compSize)})</span>`;
          }

          if (activeItem.hasText) {
            badgeHtml += `<span class="badge-text-status badge-text-searchable" title="เอกสารมีข้อความที่สามารถเลือกหรือค้นหาได้">📄 ข้อความยังเลือก/ค้นหาได้</span>`;
          } else {
            badgeHtml += `<span class="badge-text-status badge-text-rasterized" title="เอกสารถูกแปลงเป็นภาพ ข้อความจึงไม่สามารถเลือกหรือค้นหาได้">🖼️ เอกสารภาพ — ไม่สามารถเลือก/ค้นหาข้อความได้</span>`;
          }
          resultBadges.innerHTML = badgeHtml;
        }

        if (btnDownloadAll) {
          btnDownloadAll.classList.toggle('hidden', compressedFiles.length <= 1);
        }
      } else {
        summaryCard.classList.add('hidden');
        if (executeBtn) executeBtn.classList.remove('hidden');
      }
    }

    // Render Thumbnail Strip & Active Page Preview
    renderThumbnailStrip();
    renderActivePagePreview();

    // Legacy File List Hook for Programmatic/Test Compatibility
    if (fileListEl) {
      fileListEl.innerHTML = '';
      compressPdfState.files.forEach((item, idx) => {
        const row = document.createElement('div');
        row.className = 'compress-file-item';
        row.dataset.id = item.id;

        const thumbHtml = item.thumbUrl
          ? `<img class="compress-file-thumb" src="${item.thumbUrl}" alt="หน้าปก">`
          : `<div class="compress-file-thumb-placeholder"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg></div>`;

        let resultBadgeHtml = '';
        let textStatusBadgeHtml = '';
        if (item.isCompressed) {
          const origSize = item.size;
          const compSize = item.compressedSize;
          if (compSize < origSize) {
            const pct = Math.round(((origSize - compSize) / origSize) * 100);
            resultBadgeHtml = `
              <span class="compress-result-badge badge-reduced">
                ↓ ${pct}% (${formatFileSize(compSize)})
              </span>
            `;
          } else {
            resultBadgeHtml = `
              <span class="compress-result-badge badge-neutral">
                ไฟล์นี้ไม่สามารถลดขนาดได้เพิ่มเติมด้วยการตั้งค่านี้ (${formatFileSize(compSize)})
              </span>
            `;
          }

          if (item.hasText) {
            textStatusBadgeHtml = `<span class="badge-text-status badge-text-searchable" title="เอกสารมีข้อความที่สามารถเลือกหรือค้นหาได้">📄 ข้อความยังเลือก/ค้นหาได้</span>`;
          } else {
            textStatusBadgeHtml = `<span class="badge-text-status badge-text-rasterized" title="เอกสารถูกแปลงเป็นภาพ ข้อความจึงไม่สามารถเลือกหรือค้นหาได้">🖼️ เอกสารภาพ — ไม่สามารถเลือก/ค้นหาข้อความได้</span>`;
          }
        }

        row.innerHTML = `
          ${thumbHtml}
          <div class="compress-file-info">
            <span class="compress-file-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
            <div class="compress-file-meta">
              <span>${item.pageCount} หน้า</span>
              <span class="compress-size-pill">ขนาดเดิม: ${formatFileSize(item.size)}</span>
              ${resultBadgeHtml}
              ${textStatusBadgeHtml}
            </div>
          </div>
          <div class="compress-file-actions">
            ${item.isCompressed ? `
              <button type="button" class="btn btn-primary btn-sm btn-dl-single" title="ดาวน์โหลดไฟล์ที่บีบอัดแล้ว">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                <span>โหลด</span>
              </button>
            ` : ''}
            <button type="button" class="btn btn-ghost btn-sm btn-remove-item text-danger" title="ลบไฟล์นี้">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        `;

        const dlBtn = row.querySelector('.btn-dl-single');
        dlBtn?.addEventListener('click', () => {
          if (item.compressedBlob) {
            let outName = item.name.replace(/\.pdf$/i, '') + '-compressed.pdf';
            downloadBlob(item.compressedBlob, outName);
            showToast(`ดาวน์โหลด "${outName}" เรียบร้อย`, 'success');
          }
        });

        const removeBtn = row.querySelector('.btn-remove-item');
        removeBtn?.addEventListener('click', async () => {
          if (item.thumbUrl && item.thumbUrl.startsWith('blob:')) URL.revokeObjectURL(item.thumbUrl);
          compressPdfState.files.splice(idx, 1);
          if (compressPdfState.activeFileIndex >= compressPdfState.files.length) {
            compressPdfState.activeFileIndex = Math.max(0, compressPdfState.files.length - 1);
          }
          await switchActiveFile(compressPdfState.activeFileIndex);
          renderCompressPdfUI();
        });

        fileListEl.appendChild(row);
      });
    }
  }

  async function executeCompressPdf() {
    if (compressPdfState.files.length === 0) {
      showToast('กรุณาเลือกไฟล์ PDF ที่ต้องการบีบอัด', 'warning');
      return;
    }

    if (compressPdfState.isProcessing) return;
    compressPdfState.isProcessing = true;

    // Release old compressedDoc from previous runs before starting new compression
    if (compressPdfState.compressedDoc) {
      try {
        await compressPdfState.compressedDoc.destroy();
      } catch (_) {}
      compressPdfState.compressedDoc = null;
    }

    showProgressModal();
    const totalFiles = compressPdfState.files.length;
    const preset = COMPRESS_PDF_PRESETS[compressPdfState.level] || COMPRESS_PDF_PRESETS.balanced;

    try {
      for (let fIdx = 0; fIdx < totalFiles; fIdx++) {
        const item = compressPdfState.files[fIdx];
        const progressPrefix = `ไฟล์ ${fIdx + 1}/${totalFiles}: "${item.name}"`;

        updateProgress(fIdx, totalFiles, `${progressPrefix} (กำลังโหลด PDF)...`);

        // Local Image Recompression Mode (Per-page Canvas Downsampling with Dimension Preservation)
        const targetDoc = await window.PDFLib.PDFDocument.create();
        const loadingTask = window.pdfjsLib.getDocument({ data: new Uint8Array(item.buffer.slice(0)) });
        const pdfJsDoc = await loadingTask.promise;
        const pageCount = pdfJsDoc.numPages;
        const origPageDimensions = [];

        for (let pNum = 1; pNum <= pageCount; pNum++) {
          updateProgress(
            pNum,
            pageCount,
            `${progressPrefix} — หน้า ${pNum}/${pageCount}`
          );

          const page = await pdfJsDoc.getPage(pNum);
          const origViewport = page.getViewport({ scale: 1.0 });
          const origWidth = origViewport.width;
          const origHeight = origViewport.height;
          origPageDimensions.push({ width: origWidth, height: origHeight });

          const renderViewport = page.getViewport({ scale: preset.scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(renderViewport.width);
          canvas.height = Math.round(renderViewport.height);
          const ctx = canvas.getContext('2d', { alpha: false });

          await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

          // Encode to JPEG data URL with selected quality
          const dataUrl = canvas.toDataURL('image/jpeg', preset.quality);
          canvas.width = 0;
          canvas.height = 0;

          const embeddedJpg = await targetDoc.embedJpg(dataUrl);
          const newPage = targetDoc.addPage([origWidth, origHeight]);
          newPage.drawImage(embeddedJpg, {
            x: 0,
            y: 0,
            width: origWidth,
            height: origHeight
          });
        }

        const outBytes = await targetDoc.save({ useObjectStreams: true });

        // Post-Compression Verification (Geometry, Render, Searchability)
        updateProgress(pageCount, pageCount, `${progressPrefix} (กำลังตรวจสอบความสมบูรณ์ของเอกสาร)...`);
        const verifyDoc = await window.pdfjsLib.getDocument({ data: new Uint8Array(outBytes.slice(0)) }).promise;

        // 1. Page count verification
        if (verifyDoc.numPages !== pageCount) {
          throw new Error(`จำนวนหน้าไม่ตรงกับต้นฉบับ: ได้ ${verifyDoc.numPages} หน้า แต่ต้นฉบับมี ${pageCount} หน้า`);
        }

        // 2. Authoritative Geometry verification (< 0.5 pt tolerance)
        for (let p = 1; p <= verifyDoc.numPages; p++) {
          const vPage = await verifyDoc.getPage(p);
          const vViewport = vPage.getViewport({ scale: 1.0 });
          const origDim = origPageDimensions[p - 1];
          const diffW = Math.abs(vViewport.width - origDim.width);
          const diffH = Math.abs(vViewport.height - origDim.height);
          if (diffW >= 0.5 || diffH >= 0.5) {
            throw new Error(`ขนาดหน้า ${p} คลาดเคลื่อนเกินกำหนด (${diffW.toFixed(2)}pt, ${diffH.toFixed(2)}pt)`);
          }
        }

        // 3. Post-Compression Render Validation (Render check on canvas)
        const samplePage = await verifyDoc.getPage(1);
        const testCanvas = document.createElement('canvas');
        const testVp = samplePage.getViewport({ scale: 0.2 });
        testCanvas.width = Math.max(1, Math.round(testVp.width));
        testCanvas.height = Math.max(1, Math.round(testVp.height));
        const testCtx = testCanvas.getContext('2d');
        await samplePage.render({ canvasContext: testCtx, viewport: testVp }).promise;
        if (testCanvas.width === 0 || testCanvas.height === 0) {
          throw new Error('ไม่สามารถเรนเดอร์หน้าเอกสารที่สร้างขึ้นได้');
        }
        testCanvas.width = 0;
        testCanvas.height = 0;

        // 4. Text Searchability Check (Verified, not inferred)
        let hasExtractableText = false;
        for (let p = 1; p <= verifyDoc.numPages; p++) {
          const vPage = await verifyDoc.getPage(p);
          const tc = await vPage.getTextContent();
          if (tc && tc.items && tc.items.some(it => it.str && it.str.trim().length > 0)) {
            hasExtractableText = true;
            break;
          }
        }

        item.hasText = hasExtractableText;
        item.compressedBlob = new Blob([outBytes], { type: 'application/pdf' });
        item.compressedSize = item.compressedBlob.size;
        item.isCompressed = true;
      }

      await switchActiveFile(compressPdfState.activeFileIndex);
      renderCompressPdfUI();
      hideProgressModal();
      compressPdfState.isProcessing = false;
      showToast(`บีบอัดเอกสาร PDF สำเร็จครบทั้ง ${totalFiles} ไฟล์!`, 'success');
    } catch (err) {
      console.error('executeCompressPdf error:', err);
      hideProgressModal();
      compressPdfState.isProcessing = false;
      showToast('เกิดข้อผิดพลาดในการบีบอัด PDF: ' + err.message, 'error');
    }
  }

  async function downloadAllCompressPdf() {
    const compressedFiles = compressPdfState.files.filter(f => f.isCompressed && f.compressedBlob);
    if (compressedFiles.length === 0) {
      showToast('ไม่มีไฟล์ที่บีบอัดแล้วให้ดาวน์โหลด', 'warning');
      return;
    }

    if (compressedFiles.length === 1) {
      const item = compressedFiles[0];
      const outName = item.name.replace(/\.pdf$/i, '') + '-compressed.pdf';
      downloadBlob(item.compressedBlob, outName);
      showToast(`ดาวน์โหลด "${outName}" เรียบร้อย`, 'success');
      return;
    }

    // Multiple files -> Bundle ZIP
    if (!window.JSZip) {
      showToast('ไลบรารี JSZip ไม่พร้อมใช้งาน กำลังดาวน์โหลดทีละไฟล์...', 'warning');
      compressedFiles.forEach(item => {
        const outName = item.name.replace(/\.pdf$/i, '') + '-compressed.pdf';
        downloadBlob(item.compressedBlob, outName);
      });
      return;
    }

    showProgressModal();
    updateProgress(0, 1, 'กำลังสร้างไฟล์ ZIP รวมเอกสาร...');

    try {
      const zip = new window.JSZip();
      for (const item of compressedFiles) {
        const outName = item.name.replace(/\.pdf$/i, '') + '-compressed.pdf';
        const ab = await item.compressedBlob.arrayBuffer();
        zip.file(outName, ab);
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
        updateProgress(Math.round(metadata.percent), 100, `กำลังบีบอัด ZIP... ${Math.round(metadata.percent)}%`);
      });

      hideProgressModal();
      downloadBlob(zipBlob, 'pdf-lab-compressed.zip');
      showToast('ดาวน์โหลด ZIP รวมไฟล์บีบอัดเรียบร้อย', 'success');
    } catch (err) {
      console.error('downloadAllCompressPdf error:', err);
      hideProgressModal();
      showToast('เกิดข้อผิดพลาดในการสร้างไฟล์ ZIP: ' + err.message, 'error');
    }
  }

  // ==========================================================================
  // TOOL 9: บีบอัดรูปภาพ (Compress Image)
  // ==========================================================================
  const compressImageState = {
    items: [], // Array of { id, file, name, size, type, width, height, previewUrl, originalBlob, compressedBlob, compressedSize, isCompressed, outputWidth, outputHeight, outputFormat }
    level: 'balanced', // 'high' | 'balanced' | 'small'
    format: 'original', // 'original' | 'jpeg' | 'webp' | 'png'
    isProcessing: false
  };

  const COMPRESS_IMG_LEVELS = {
    high: { quality: 0.90, label: 'คุณภาพสูง (Quality 90%)' },
    balanced: { quality: 0.75, label: 'สมดุล (Quality 75%)' },
    small: { quality: 0.50, label: 'ขนาดเล็ก (Quality 50%)' }
  };

  function initCompressImageTool() {
    const fileInput = document.getElementById('fileInputCompressImage');
    const btnSelect = document.getElementById('btnSelectCompressImage');
    const dropZone = document.getElementById('compressImageDropZone');
    const btnAddMore = document.getElementById('btnAddMoreCompressImg');
    const btnClear = document.getElementById('btnClearCompressImg');
    const btnExecute = document.getElementById('btnExecuteCompressImg');
    const btnDownloadAll = document.getElementById('btnDownloadAllCompressImg');
    const formatSelect = document.getElementById('compressImgFormat');
    const formatNotice = document.getElementById('compressImgFormatNotice');

    btnSelect?.addEventListener('click', () => fileInput?.click());
    btnAddMore?.addEventListener('click', () => fileInput?.click());

    dropZone?.addEventListener('click', (e) => {
      if (e.target.closest('#btnSelectCompressImage')) return;
      fileInput?.click();
    });

    dropZone?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput?.click();
      }
    });

    setupDropZoneEvents(dropZone, handleCompressImageFiles);

    fileInput?.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleCompressImageFiles(Array.from(e.target.files));
        fileInput.value = '';
      }
    });

    btnClear?.addEventListener('click', () => {
      compressImageState.items.forEach(item => {
        if (item.previewUrl && item.previewUrl.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
      });
      compressImageState.items = [];
      renderCompressImgUI();
      showToast('ล้างรายการรูปภาพทั้งหมดแล้ว', 'info');
    });

    // Level selector radio changes
    document.querySelectorAll('input[name="compressImgLevel"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        compressImageState.level = e.target.value;
        // Update selection UI classes
        document.querySelectorAll('.compression-level-selector .level-card').forEach(card => {
          const input = card.querySelector('input[type="radio"]');
          card.classList.toggle('selected', input && input.checked);
        });
      });
    });

    // Format control changes
    formatSelect?.addEventListener('change', (e) => {
      compressImageState.format = e.target.value;
      if (formatNotice) {
        // Show transparency warning when JPEG is selected
        formatNotice.classList.toggle('hidden', compressImageState.format !== 'jpeg');
      }
    });

    btnExecute?.addEventListener('click', executeCompressImage);
    btnDownloadAll?.addEventListener('click', downloadAllCompressImage);
  }

  async function handleCompressImageFiles(files) {
    const validExts = /\.(jpe?g|png|webp|heic|heif|bmp)$/i;
    const imgFiles = files.filter(f => validExts.test(f.name) || f.type.startsWith('image/'));

    if (imgFiles.length === 0) {
      showToast('กรุณาเลือกไฟล์รูปภาพที่รองรับ (JPG, PNG, WebP, HEIC)', 'error');
      return;
    }

    showProgressModal();
    updateProgress(0, imgFiles.length, 'กำลังเตรียมรูปภาพ...');

    let loaded = 0;
    for (let i = 0; i < imgFiles.length; i++) {
      const file = imgFiles[i];
      updateProgress(i + 1, imgFiles.length, `กำลังอ่าน "${file.name}"...`);

      try {
        let displayBlob = file;
        const isHeic = file.name.toLowerCase().endsWith('.heic') || file.name.toLowerCase().endsWith('.heif') || file.type === 'image/heic' || file.type === 'image/heif';

        if (isHeic) {
          if (window.heic2any) {
            try {
              const converted = await window.heic2any({
                blob: file,
                toType: 'image/jpeg',
                quality: 0.92
              });
              displayBlob = Array.isArray(converted) ? converted[0] : converted;
            } catch (heicErr) {
              console.warn('HEIC decode error:', heicErr);
              showToast(`ไม่สามารถถอดรหัส HEIC "${file.name}" ได้`, 'error');
              continue;
            }
          } else {
            showToast(`โปรแกรมถอดรหัส HEIC ยังไม่พร้อมใช้งานสำหรับ "${file.name}"`, 'error');
            continue;
          }
        }

        const previewUrl = URL.createObjectURL(displayBlob);
        const dimensions = await getImageDimensions(previewUrl);

        compressImageState.items.push({
          id: 'comp_img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
          file,
          name: file.name,
          size: file.size,
          type: isHeic ? 'image/jpeg' : (file.type || 'image/jpeg'),
          width: dimensions.width,
          height: dimensions.height,
          previewUrl,
          originalBlob: displayBlob,
          compressedBlob: null,
          compressedSize: null,
          isCompressed: false,
          outputWidth: dimensions.width,
          outputHeight: dimensions.height,
          outputFormat: null
        });
        loaded++;
      } catch (err) {
        console.warn('handleCompressImageFiles error:', file.name, err);
        showToast(`ไม่สามารถเปิดภาพ "${file.name}" ได้`, 'error');
      }
    }

    hideProgressModal();
    if (loaded > 0) {
      renderCompressImgUI();
      showToast(`เพิ่มรูปภาพสำเร็จ ${loaded} ภาพ`, 'success');
    }
  }

  function renderCompressImgUI() {
    const uploadScreen = document.getElementById('compressImageUploadScreen');
    const workspaceScreen = document.getElementById('compressImageWorkspaceScreen');
    const gridEl = document.getElementById('compressImgGrid');
    const fileBadge = document.getElementById('compressImgFileBadge');
    const statusBadge = document.getElementById('compressImgStatusBadge');
    const ctaSubtext = document.getElementById('compressImgCtaSubtext');
    const summaryCard = document.getElementById('compressImgSummaryCard');
    const summarySubtext = document.getElementById('compressImgSummarySubtext');

    if (!uploadScreen || !workspaceScreen) return;

    if (compressImageState.items.length === 0) {
      uploadScreen.classList.remove('hidden');
      workspaceScreen.classList.add('hidden');
      if (gridEl) gridEl.innerHTML = '';
      if (summaryCard) summaryCard.classList.add('hidden');
      return;
    }

    uploadScreen.classList.add('hidden');
    workspaceScreen.classList.remove('hidden');

    const totalCount = compressImageState.items.length;
    const compressedCount = compressImageState.items.filter(it => it.isCompressed).length;
    const allDone = compressedCount === totalCount && totalCount > 0;

    if (fileBadge) fileBadge.textContent = `${totalCount} ภาพ`;
    if (ctaSubtext) ctaSubtext.textContent = `${totalCount} ภาพ`;

    if (statusBadge) {
      if (allDone) {
        statusBadge.textContent = 'บีบอัดเรียบร้อย';
        statusBadge.className = 'badge-status badge-success';
      } else {
        statusBadge.textContent = 'พร้อมบีบอัด';
        statusBadge.className = 'badge-status';
      }
    }

    // Summary card with aggregate byte measurement
    if (summaryCard) {
      const compressedItems = compressImageState.items.filter(it => it.isCompressed && it.compressedBlob);
      if (compressedItems.length > 0) {
        summaryCard.classList.remove('hidden');
        const origTotal = compressedItems.reduce((acc, it) => acc + it.size, 0);
        const compTotal = compressedItems.reduce((acc, it) => acc + it.compressedSize, 0);
        const doneCount = compressedItems.length;
        const summaryTitle = summaryCard.querySelector('.compress-summary-title');

        if (compTotal < origTotal) {
          const savedBytes = origTotal - compTotal;
          const pct = ((savedBytes / origTotal) * 100).toFixed(1);
          if (summaryTitle) summaryTitle.textContent = `บีบอัดเสร็จเรียบร้อย ${doneCount}/${totalCount} ภาพ`;
          if (summarySubtext) {
            summarySubtext.textContent = `ประหยัดพื้นที่ได้ ${formatFileSize(savedBytes)} (${pct}%) จากขนาดรวม ${formatFileSize(origTotal)} เหลือ ${formatFileSize(compTotal)}`;
          }
        } else if (compTotal > origTotal) {
          const diffBytes = compTotal - origTotal;
          const pct = ((diffBytes / origTotal) * 100).toFixed(1);
          if (summaryTitle) summaryTitle.textContent = `ประมวลผลเสร็จสิ้น ${doneCount}/${totalCount} ภาพ`;
          if (summarySubtext) {
            summarySubtext.textContent = `ชุดไฟล์นี้มีขนาดเพิ่มขึ้น ${pct}% (+${formatFileSize(diffBytes)}) จากการตั้งค่าปัจจุบัน (เดิม ${formatFileSize(origTotal)} เป็น ${formatFileSize(compTotal)})`;
          }
        } else {
          if (summaryTitle) summaryTitle.textContent = `ประมวลผลเสร็จสิ้น ${doneCount}/${totalCount} ภาพ`;
          if (summarySubtext) {
            summarySubtext.textContent = `ขนาดไฟล์โดยรวมเท่าเดิม (${formatFileSize(compTotal)}) ไม่มีการลดขนาด`;
          }
        }
      } else {
        summaryCard.classList.add('hidden');
      }
    }

    // Grid rendering
    if (gridEl) {
      gridEl.innerHTML = '';
      compressImageState.items.forEach((item, idx) => {
        const card = document.createElement('div');
        card.className = 'compress-img-card';
        card.dataset.id = item.id;

        let resultBadgeHtml = '';
        const dimsHtml = `${item.width} × ${item.height}`;

        if (item.isCompressed) {
          const origSize = item.size;
          const compSize = item.compressedSize;
          if (compSize < origSize) {
            const pct = Math.round(((origSize - compSize) / origSize) * 100);
            resultBadgeHtml = `
              <span class="compress-result-badge badge-reduced">
                ↓ ${pct}% (${formatFileSize(compSize)})
              </span>
            `;
          } else {
            resultBadgeHtml = `
              <span class="compress-result-badge badge-neutral" title="ไฟล์นี้ไม่สามารถลดขนาดได้เพิ่มเติมด้วยการตั้งค่านี้">
                ขนาดใกล้เคียงเดิม (${formatFileSize(compSize)})
              </span>
            `;
          }
        }

        card.innerHTML = `
          <div class="compress-img-preview-box">
            <img src="${item.previewUrl}" alt="${escapeHtml(item.name)}" loading="lazy">
          </div>
          <div class="compress-img-card-body">
            <span class="compress-img-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
            <div class="compress-img-meta">
              <span>ขนาดมิติ: ${dimsHtml}</span>
              <span class="compress-size-pill">เดิม: ${formatFileSize(item.size)}</span>
              ${resultBadgeHtml}
            </div>
            <div class="compress-img-actions">
              ${item.isCompressed ? `
                <button type="button" class="btn btn-primary btn-sm btn-dl-img" title="ดาวน์โหลดภาพที่บีบอัดแล้ว">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  <span>โหลด</span>
                </button>
              ` : ''}
              <button type="button" class="btn btn-ghost btn-sm btn-del-img text-danger" title="ลบภาพนี้">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>
        `;

        // Download Single Image
        const dlBtn = card.querySelector('.btn-dl-img');
        dlBtn?.addEventListener('click', () => {
          if (item.compressedBlob) {
            const outName = getCompressedImageName(item.name, item.outputFormat);
            downloadBlob(item.compressedBlob, outName);
            showToast(`ดาวน์โหลด "${outName}" เรียบร้อย`, 'success');
          }
        });

        // Delete Image
        const delBtn = card.querySelector('.btn-del-img');
        delBtn?.addEventListener('click', () => {
          if (item.previewUrl && item.previewUrl.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
          compressImageState.items.splice(idx, 1);
          renderCompressImgUI();
        });

        gridEl.appendChild(card);
      });
    }
  }

  function getCompressedImageName(originalName, targetMime) {
    const baseName = originalName.replace(/\.[^/.]+$/, '');
    let ext = '.jpg';
    if (targetMime === 'image/png') ext = '.png';
    else if (targetMime === 'image/webp') ext = '.webp';
    else if (targetMime === 'image/jpeg') ext = '.jpg';
    return `${baseName}-compressed${ext}`;
  }

  async function executeCompressImage() {
    if (compressImageState.items.length === 0) {
      showToast('กรุณาเลือกรูปภาพที่ต้องการบีบอัด', 'warning');
      return;
    }

    if (compressImageState.isProcessing) return;
    compressImageState.isProcessing = true;

    showProgressModal();
    const total = compressImageState.items.length;
    const currentConfig = COMPRESS_IMG_LEVELS[compressImageState.level] || COMPRESS_IMG_LEVELS.balanced;
    const qualityRatio = currentConfig.quality;

    try {
      for (let i = 0; i < total; i++) {
        const item = compressImageState.items[i];
        updateProgress(i + 1, total, `กำลังบีบอัดรูปภาพ ${i + 1}/${total}: "${item.name}"...`);

        // Determine target mime type
        let targetMime = 'image/jpeg';
        if (compressImageState.format === 'original') {
          if (item.type === 'image/png') targetMime = 'image/png';
          else if (item.type === 'image/webp') targetMime = 'image/webp';
          else targetMime = 'image/jpeg';
        } else if (compressImageState.format === 'png') {
          targetMime = 'image/png';
        } else if (compressImageState.format === 'webp') {
          targetMime = 'image/webp';
        } else {
          targetMime = 'image/jpeg';
        }

        // 100% Dimension Preservation: Always keep original width and height
        const targetW = item.width;
        const targetH = item.height;

        // Render to canvas
        const img = new Image();
        img.src = item.previewUrl;
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = rej;
        });

        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');

        // Transparency safety: JPEG needs white background, PNG/WebP preserve transparency
        if (targetMime === 'image/jpeg') {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, targetW, targetH);
        }

        ctx.drawImage(img, 0, 0, targetW, targetH);

        // Convert canvas to real Blob
        const compBlob = await new Promise(resolve => {
          canvas.toBlob(resolve, targetMime, qualityRatio);
        });

        // Clean up canvas memory immediately
        canvas.width = 0;
        canvas.height = 0;

        // Verify dimensions and integrity by decoding back into Image
        const verifyUrl = URL.createObjectURL(compBlob);
        try {
          const verifyDims = await getImageDimensions(verifyUrl);
          if (verifyDims.width !== targetW || verifyDims.height !== targetH) {
            console.warn(`Dimension mismatch for ${item.name}: expected ${targetW}x${targetH}, got ${verifyDims.width}x${verifyDims.height}`);
          }
        } finally {
          URL.revokeObjectURL(verifyUrl);
        }

        item.compressedBlob = compBlob;
        item.compressedSize = compBlob.size;
        item.outputWidth = targetW;
        item.outputHeight = targetH;
        item.outputFormat = targetMime;
        item.isCompressed = true;
      }

      hideProgressModal();
      compressImageState.isProcessing = false;
      renderCompressImgUI();
      showToast(`บีบอัดรูปภาพสำเร็จครบทั้ง ${total} ภาพ!`, 'success');
    } catch (err) {
      console.error('executeCompressImage error:', err);
      hideProgressModal();
      compressImageState.isProcessing = false;
      showToast('เกิดข้อผิดพลาดในการบีบอัดรูปภาพ: ' + err.message, 'error');
    }
  }

  async function downloadAllCompressImage() {
    const compressedItems = compressImageState.items.filter(it => it.isCompressed && it.compressedBlob);
    if (compressedItems.length === 0) {
      showToast('ไม่มีภาพที่บีบอัดแล้วให้ดาวน์โหลด', 'warning');
      return;
    }

    if (compressedItems.length === 1) {
      const item = compressedItems[0];
      const outName = getCompressedImageName(item.name, item.outputFormat);
      downloadBlob(item.compressedBlob, outName);
      showToast(`ดาวน์โหลด "${outName}" เรียบร้อย`, 'success');
      return;
    }

    // Multiple -> ZIP
    if (!window.JSZip) {
      showToast('ไลบรารี JSZip ไม่พร้อมใช้งาน กำลังดาวน์โหลดทีละภาพ...', 'warning');
      compressedItems.forEach(item => {
        const outName = getCompressedImageName(item.name, item.outputFormat);
        downloadBlob(item.compressedBlob, outName);
      });
      return;
    }

    showProgressModal();
    updateProgress(0, 1, 'กำลังสร้างไฟล์ ZIP รวมรูปภาพ...');

    try {
      const zip = new window.JSZip();
      for (const item of compressedItems) {
        const outName = getCompressedImageName(item.name, item.outputFormat);
        const ab = await item.compressedBlob.arrayBuffer();
        zip.file(outName, ab);
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' }, (meta) => {
        updateProgress(Math.round(meta.percent), 100, `กำลังบีบอัด ZIP... ${Math.round(meta.percent)}%`);
      });

      hideProgressModal();
      downloadBlob(zipBlob, 'pdf-lab-compressed-images.zip');
      showToast('ดาวน์โหลด ZIP รวมรูปภาพบีบอัดเรียบร้อย', 'success');
    } catch (err) {
      console.error('downloadAllCompressImage error:', err);
      hideProgressModal();
      showToast('เกิดข้อผิดพลาดในการสร้างไฟล์ ZIP: ' + err.message, 'error');
    }
  }

  // --- Dropzone Event Helper ---
  function setupDropZoneEvents(dropZoneEl, onDropFiles) {
    if (!dropZoneEl) return;

    ['dragenter', 'dragover'].forEach(eventName => {
      dropZoneEl.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZoneEl.classList.add('drag-active');
      });
    });

    ['dragleave', 'drop'].forEach(eventName => {
      dropZoneEl.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZoneEl.classList.remove('drag-active');
      });
    });

    dropZoneEl.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        onDropFiles(Array.from(e.dataTransfer.files));
      }
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // --- Tool Switch Callback ---
  function onSwitchTool(toolId) {
    if (toolId === 'merge-pdf') renderMergeUI();
    else if (toolId === 'split-pdf') renderSplitUI();
    else if (toolId === 'organize-pdf') renderOrganizeUI();
    else if (toolId === 'pdf-to-image') renderPdfToImgUI();
    else if (toolId === 'page-number') renderPageNumUI();
    else if (toolId === 'ocr-pdf') renderOcrUI();
    else if (toolId === 'compress-pdf') renderCompressPdfUI();
    else if (toolId === 'compress-image') renderCompressImgUI();
  }

  // --- Initialize All PDF Lab Tools ---
  function initPdfLab() {
    initMergeTool();
    initSplitTool();
    initOrganizeTool();
    initPdfToImgTool();
    initPageNumTool();
    initOcrTool();
    initCompressPdfTool();
    initCompressImageTool();
  }

  window.PdfLabTools = {
    onSwitchTool,
    mergeState,
    splitState,
    organizeState,
    pdfToImgState,
    pageNumState,
    ocrState,
    compressPdfState,
    compressImageState,
    handleMergeFiles,
    handleSplitFile,
    handleOrganizeFile,
    handlePdfToImgFile,
    handlePageNumFile,
    handleOcrFile,
    handleOcrFiles,
    handleCompressPdfFiles,
    handleCompressImageFiles,
    executeMerge,
    executeSplit,
    executeOrganize,
    executePdfToImg,
    executePageNum,
    executeOcr,
    executeCompressPdf,
    executeCompressImage,
    cancelOcr,
    buildSearchablePdf,
    downloadSearchablePdf,
    preprocessImageForOcr,
    setMergeViewMode,
    renderMergeUI,
    renderOrganizeCards,
    setSplitMode,
    addRangeRow,
    removeRangeRow,
    renderRangeRows,
    validateRange,
    checkRangeOverlap,
    updateSplitModeUI,
    updateSplitGridHighlights
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPdfLab);
  } else {
    initPdfLab();
  }

})();
