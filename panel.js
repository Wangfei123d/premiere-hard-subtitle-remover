(function () {
  'use strict';
  var fs = require('fs');
  var path = require('path');
  var os = require('os');
  var url = require('url');
  var $ = function (id) { return document.getElementById(id); };
  var state = { snapshot: null, jobs: [], results: [], current: null, regions: [], selectedRegion: -1, busy: false, reviewResolver: null, previewPath: '' };
  var canvas = $('regionCanvas'), ctx = canvas.getContext('2d');

  function log(message, kind) {
    var node = document.createElement('div'); node.className = 'message ' + (kind || ''); node.textContent = message;
    $('messages').appendChild(node); $('messages').scrollTop = $('messages').scrollHeight;
  }
  function setProgress(value, label) { $('progress').value = Math.max(0, Math.min(100, Number(value) || 0)); $('progressLabel').textContent = label || ''; }
  function host(name, args) {
    return new Promise(function (resolve, reject) {
      if (!window.__adobe_cep__ || !window.__adobe_cep__.evalScript) return reject(new Error('Premiere CEP 桥接不可用，请在 Premiere 中打开扩展。'));
      var expression = name + '(' + (args === undefined ? '' : args.map(function (arg) { return JSON.stringify(arg); }).join(',')) + ')';
      window.__adobe_cep__.evalScript(expression, function (value) {
        try { resolve(typeof value === 'string' ? JSON.parse(value) : value); } catch (error) { reject(new Error(String(value || 'Premiere 宿主返回了无效结果。'))); }
      });
    });
  }
  function renderClips(jobs, skipped) {
    var list = $('clipList'); list.textContent = ''; list.className = 'cards';
    jobs.forEach(function (job) {
      var card = document.createElement('div'); card.className = 'clip-card';
      var title = document.createElement('span'); title.textContent = job.clip.clipName || path.basename(job.sourcePath);
      var duration = document.createElement('small'); duration.textContent = job.durationSeconds.toFixed(1) + ' 秒';
      card.appendChild(title); card.appendChild(duration); list.appendChild(card);
    });
    skipped.forEach(function (item) {
      var card = document.createElement('div'); card.className = 'clip-card';
      var reason = String(item.reason || '').replace('overlapping-video', '与其他视频画面重叠').replace('transition', '片段范围包含转场').replace('missing-track', '找不到视频轨道').replace('ambiguous-clip', '无法唯一识别片段');
      card.textContent = (item.clip.clipName || item.clip.name || '未知片段') + ' · 跳过：' + reason; list.appendChild(card);
    });
    if (!jobs.length && !skipped.length) { list.className = 'cards empty'; list.textContent = '没有可处理的片段。'; }
  }
  function safeFileName(value) { return String(value || 'clip').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 70); }
  function fileUrl(filePath) { return url.pathToFileURL(filePath).toString(); }
  function contentRect() {
    var w = canvas.width, h = canvas.height, vw = $('previewVideo').videoWidth || w, vh = $('previewVideo').videoHeight || h;
    var scale = Math.min(w / vw, h / vh), rw = vw * scale, rh = vh * scale;
    return { x: (w - rw) / 2, y: (h - rh) / 2, w: rw, h: rh };
  }
  function resizeCanvas() {
    var box = $('previewWrap').getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(box.width * dpr)); canvas.height = Math.max(1, Math.round(box.height * dpr));
    canvas.style.width = box.width + 'px'; canvas.style.height = box.height + 'px'; drawRegionOverlay();
  }
  function drawRegionOverlay() {
    if (!canvas.width || !canvas.height) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var area = contentRect();
    state.regions.forEach(function (r, i) {
      var x = area.x + r.topLeftX * area.w, y = area.y + r.topLeftY * area.h;
      var w = (r.bottomRightX - r.topLeftX) * area.w, h = (r.bottomRightY - r.topLeftY) * area.h;
      ctx.fillStyle = i === state.selectedRegion ? 'rgba(255,175,40,.16)' : 'rgba(255,75,65,.14)';
      ctx.strokeStyle = i === state.selectedRegion ? '#ffc35a' : '#ff756c'; ctx.lineWidth = Math.max(2, canvas.width / 500);
      ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
      if (i === state.selectedRegion) { ctx.fillStyle = '#ffc35a'; ctx.fillRect(x + w - 8, y + h - 8, 8, 8); }
    });
  }
  function readRegionPointerEvent(event, bounds) {
    var rect = canvas.getBoundingClientRect(), dprX = canvas.width / rect.width, dprY = canvas.height / rect.height, area = contentRect();
    var x = (event.clientX - rect.left) * dprX, y = (event.clientY - rect.top) * dprY;
    return { x: Math.max(0, Math.min(1, (x - area.x) / area.w)), y: Math.max(0, Math.min(1, (y - area.y) / area.h)), inside: x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h, rect: rect, bounds: bounds };
  }
  function fitAxis(start, end, minimum) {
    if (end - start >= minimum) return [start, end];
    var center = (start + end) / 2;
    start = Math.max(0, Math.min(1 - minimum, center - minimum / 2));
    return [start, start + minimum];
  }
  function renderOcr(subtitles) {
    var box = $('ocrRows'); box.textContent = '';
    if (!subtitles.length) { var empty = document.createElement('div'); empty.className = 'ocr-row'; empty.textContent = '没有识别到字幕；仍可手动框选后继续。'; box.appendChild(empty); return; }
    subtitles.slice(0, 100).forEach(function (item) {
      var row = document.createElement('div'); row.className = 'ocr-row'; var time = document.createElement('time');
      time.textContent = Number(item.startTime).toFixed(1) + '–' + Number(item.endTime).toFixed(1) + 's';
      var text = document.createElement('span'); text.textContent = item.text; row.appendChild(time); row.appendChild(text); box.appendChild(row);
    });
    if (subtitles.length > 100) { var more = document.createElement('div'); more.className = 'ocr-row'; more.textContent = '另有 ' + (subtitles.length - 100) + ' 条识别结果未展开。'; box.appendChild(more); }
  }
  function activeReview(job, renderPath, subtitles, batchCount) {
    state.current = job; state.current.batchCount = batchCount || 1; state.previewPath = renderPath; state.regions = [{ topLeftX: 0, topLeftY: 0.5, bottomRightX: 1, bottomRightY: 1 }]; state.selectedRegion = 0;
    $('review').hidden = false; $('reviewCount').textContent = (job.clip.clipName || path.basename(job.sourcePath)) + (batchCount > 1 ? ' · 本次公共区域应用于 ' + batchCount + ' 个片段' : '');
    $('continueClip').textContent = batchCount > 1 ? '确认总体区域并处理本批' : '确认区域并处理此片段';
    $('skipClip').textContent = batchCount > 1 ? '跳过整批' : '跳过片段';
    $('previewVideo').src = fileUrl(renderPath); $('previewVideo').load(); renderOcr(subtitles); $('continueClip').disabled = false;
    $('costBox').hidden = true; resizeCanvas();
    return new Promise(function (resolve) { state.reviewResolver = resolve; });
  }
  function outputPathFor(job, directory) {
    var name = safeFileName(path.parse(job.sourcePath).name) + '_' + safeFileName(job.clipKey).slice(-36) + '_字幕已擦除_' + Date.now() + '.mp4';
    return path.join(directory, name);
  }
  function readVideoDimensions(videoPath) {
    return new Promise(function (resolve, reject) {
      var video = document.createElement('video');
      var settled = false;
      var timer = setTimeout(function () { finish(new Error('读取处理结果的视频尺寸超时。')); }, 15000);
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.onloadedmetadata = null;
        video.onerror = null;
        if (error) { resolveCleanup(); reject(error); return; }
        var dimensions = { width: Number(video.videoWidth), height: Number(video.videoHeight) };
        resolveCleanup();
        if (!dimensions.width || !dimensions.height) { reject(new Error('处理结果未提供有效的视频画面尺寸。')); return; }
        resolve(dimensions);
      }
      function resolveCleanup() {
        video.removeAttribute('src');
        video.load();
      }
      video.preload = 'metadata';
      video.onloadedmetadata = function () { finish(null); };
      video.onerror = function () { finish(new Error('Premiere 面板无法读取处理结果的视频尺寸。')); };
      video.src = fileUrl(videoPath);
      video.load();
    });
  }
  function ensureSettings() {
    var outputDir = $('outputDir').value.trim(); var preset = $('presetPath').value.trim();
    if (!outputDir) throw new Error('请填写处理结果目录。');
    if (!preset) throw new Error('请填写 Adobe Media Encoder 导出预设 .epr 路径。');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    var concurrency = Math.max(1, Math.min(20, Number($('concurrency').value) || 2));
    return { outputDir: outputDir, preset: preset, concurrency: concurrency };
  }
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  async function runConcurrent(items, concurrency, worker) {
    var results = new Array(items.length), nextIndex = 0, workerCount = Math.min(items.length, Math.max(1, Math.min(20, Number(concurrency) || 2))), workers = [];
    async function runWorker() {
      while (true) {
        var index = nextIndex++;
        if (index >= items.length) return;
        try { results[index] = await worker(items[index], index); }
        catch (error) { results[index] = { error: error }; }
      }
    }
    for (var i = 0; i < workerCount; i += 1) workers.push(runWorker());
    await Promise.all(workers);
    return results;
  }
  async function processSelectedJobs(jobs, settings) {
    var temporary = path.join(os.tmpdir(), 'HardSubtitleRemover', String(Date.now())); fs.mkdirSync(temporary, { recursive: true });
    setProgress(2, '正在提交 Premiere 片段导出');
    var start = await host('startSubtitleRenderBatch', [jobs, temporary, settings.preset]);
    if (!start || !start.ok) throw new Error(start && start.error || 'Premiere 导出队列启动失败。');
    var renderState = null, waited = 0;
    while (waited < 60 * 60 * 1000) {
      await wait(1800); waited += 1800; renderState = await host('getSubtitleRenderBatchState');
      var ready = (renderState.jobs || []).filter(function (x) { return x.status === 'complete' || x.status === 'failed'; }).length;
      setProgress(3 + Math.floor(ready / Math.max(1, jobs.length) * 18), 'AME 导出 ' + ready + '/' + jobs.length);
      if (renderState.done) break;
    }
    if (!renderState || !renderState.done) throw new Error('AME 导出超过 60 分钟仍未完成。');
    var rendered = {};
    (renderState.jobs || []).forEach(function (row) { rendered[row.clipKey] = row; });
    var completed = [];
    var concurrency = Math.max(1, Math.min(20, Number(settings.concurrency) || 2));
    var apiKey = await HardSubtitleCredentialStore.loadApiKey();
    var client = new VolcengineClient({ apiKey: apiKey });
    var readyToUpload = [];
    var prepared = [];
    var subtitles = [];
    var prepDone = 0;
    var totalDuration = 0;
    var i;
    for (i = 0; i < jobs.length; i += 1) {
      var initialJob = jobs[i], initialRender = rendered[initialJob.clipKey];
      if (!initialRender || initialRender.status !== 'complete' || !fs.existsSync(initialRender.renderPath)) {
        log((initialJob.clip.clipName || initialJob.clipKey) + '：预览导出失败，' + ((initialRender && initialRender.error) || '找不到导出文件。'), 'error');
      } else readyToUpload.push({ job: initialJob, render: initialRender });
    }
    if (!readyToUpload.length) throw new Error('没有成功导出的预览视频可供处理。');

    setProgress(22, '并行上传并识别 0/' + readyToUpload.length);
    var prepResults = await runConcurrent(readyToUpload, concurrency, async function (item) {
      var name = item.job.clip.clipName || item.job.clipKey;
      var mediaUrl;
      var recognized = [];
      try {
        var renderMimeType = /\.mp4$/i.test(item.render.renderPath) ? 'video/mp4' : 'video/quicktime';
        mediaUrl = await client.uploadMedia(item.render.renderPath, renderMimeType);
        try {
          var ocr = await client.recognizeSubtitles(mediaUrl);
          recognized = ocr.subtitles || [];
        } catch (ocrError) {
          log(name + ' · OCR 识别失败；仍可使用公共区域尝试擦除：' + String(ocrError.message || ocrError), 'error');
        }
        return { job: item.job, render: item.render, mediaUrl: mediaUrl, subtitles: recognized };
      } catch (uploadError) {
        var uploadMessage = String(uploadError.message || uploadError).replace(/https?:\/\/[^\s)]+/g, '[URL 已隐藏]');
        if (/429|RequestLimitExceeded|Too Many Requests/i.test(uploadMessage)) uploadMessage += '；火山并发额度不足，请降低并行数后重试。';
        log(name + ' · 上传失败：' + uploadMessage, 'error');
        return null;
      } finally {
        prepDone += 1;
        setProgress(22 + Math.floor(prepDone / readyToUpload.length * 30), '并行上传与 OCR ' + prepDone + '/' + readyToUpload.length);
      }
    });
    for (i = 0; i < prepResults.length; i += 1) {
      if (!prepResults[i] || !prepResults[i].mediaUrl) continue;
      prepared.push(prepResults[i]);
      totalDuration += Number(prepResults[i].job.durationSeconds) || 0;
      for (var subtitleIndex = 0; subtitleIndex < prepResults[i].subtitles.length; subtitleIndex += 1) {
        var subtitle = prepResults[i].subtitles[subtitleIndex];
        subtitles.push({ startTime: subtitle.startTime, endTime: subtitle.endTime, text: '[' + (prepResults[i].job.clip.clipName || prepResults[i].job.clipKey) + '] ' + subtitle.text });
      }
    }
    if (!prepared.length) throw new Error('所有视频上传均失败，未提交擦除任务。');

    var firstPrepared = prepared[0];
    var reviewJob = { clip: { clipName: firstPrepared.job.clip.clipName || path.basename(firstPrepared.job.sourcePath) }, durationSeconds: totalDuration };
    var choice = await activeReview(reviewJob, firstPrepared.render.renderPath, subtitles, prepared.length);
    $('review').hidden = true;
    if (!choice || choice.skip) { log('已跳过整批视频擦除。'); setProgress(100, '批次已跳过'); return; }
    var estimate = HardSubtitleJobPlanner.estimateCostYuan(totalDuration, 1);
    $('costBox').hidden = false;
    $('costBox').textContent = '本批 ' + prepared.length + ' 个片段预计费用 ¥' + estimate.toFixed(2) + '（按 ¥1/分钟估算；实际以火山账单为准）。';
    if (!window.confirm('将为本批 ' + prepared.length + ' 个片段提交可能产生费用的火山字幕擦除任务。预计总费用 ¥' + estimate.toFixed(2) + '，继续吗？')) {
      log('已取消整批付费擦除任务。'); setProgress(100, '已取消付费任务'); return;
    }

    var eraseDone = 0;
    setProgress(55, '并行擦除 0/' + prepared.length + '（并行上限 ' + concurrency + '）');
    var eraseResults = await runConcurrent(prepared, concurrency, async function (item) {
      var job = item.job;
      var name = job.clip.clipName || job.clipKey;
      try {
        var erased = await client.eraseSubtitles(item.mediaUrl, choice.regions, { onProgress: function (value, status) {
          $('progressLabel').textContent = name + '：火山处理中 ' + status + '；已完成 ' + eraseDone + '/' + prepared.length;
        } });
        if (!erased.video_url) throw new Error('火山任务已完成，但没有返回 video_url。');
        var outputPath = outputPathFor(job, settings.outputDir);
        await client.downloadResult(erased.video_url, outputPath);
        var outputDimensions = await readVideoDimensions(outputPath);
        log(name + '：擦除完成并已下载。', 'ok');
        return { clipKey: job.clipKey, sourcePath: job.sourcePath, outputPath: outputPath, outputWidth: outputDimensions.width, outputHeight: outputDimensions.height, clip: job.clip, status: 'complete' };
      } catch (error) {
        var detail = String(error.message || error).replace(/https?:\/\/[^\s)]+/g, '[URL 已隐藏]');
        if (/429|RequestLimitExceeded|Too Many Requests/i.test(detail)) detail += '；火山并发额度不足，请降低并行数后重试。';
        log(name + ' · 擦除或下载失败：' + detail, 'error');
        return null;
      } finally {
        eraseDone += 1;
        setProgress(55 + Math.floor(eraseDone / prepared.length * 35), '擦除与下载 ' + eraseDone + '/' + prepared.length + '（并行上限 ' + concurrency + '）');
      }
    });
    for (i = 0; i < eraseResults.length; i += 1) if (eraseResults[i] && eraseResults[i].status === 'complete') completed.push(eraseResults[i]);
    if (completed.length) {
      setProgress(94, '正在校验时间线并替换视频片段');
      var applied = await host('applySubtitleResults', [completed]);
      (applied.results || []).forEach(function (row) { log(row.clipKey + '：' + row.message, row.status === 'applied' ? 'ok' : 'error'); });
      if (!applied.ok) log(applied.error || '有结果未能替换；下载文件仍保留在输出目录。', 'error');
    }
    setProgress(100, '处理结束');
  }

  $('scan').addEventListener('click', async function () {
    if (state.busy) return;
    try {
      var snapshot = await host('getSubtitleTimelineSnapshot');
      if (!snapshot.ok) throw new Error(snapshot.error || '无法读取 Premiere 时间线。');
      state.snapshot = snapshot;
      var planned = HardSubtitleJobPlanner.buildClipJobs(snapshot.clips || []);
      state.jobs = planned.jobs; renderClips(planned.jobs, planned.skipped);
      if (!state.jobs.length) { log('没有可导出的选中视频片段。', 'error'); return; }
      log('扫描到 ' + state.jobs.length + ' 个可处理视频片段。', 'ok');
    } catch (error) { log(error.message, 'error'); }
  });
  $('saveKey').addEventListener('click', async function () {
    try { await HardSubtitleCredentialStore.saveApiKey($('apiKey').value.trim()); $('apiKey').value = ''; $('connection').textContent = '密钥已保存'; log('API Key 已用 Windows 用户加密保存。', 'ok'); }
    catch (error) { log('保存 API Key 失败：' + error.message, 'error'); }
  });
  $('continueClip').addEventListener('click', function () {
    if (!state.reviewResolver) return;
    try { VolcengineClient.normalizeEraseRegions(state.regions); }
    catch (error) { log(error.message, 'error'); return; }
    var estimate = HardSubtitleJobPlanner.estimateCostYuan(state.current.durationSeconds, 1);
    var batchCount = Number(state.current.batchCount) || 1;
    $('costBox').hidden = false; $('costBox').textContent = '本批 ' + batchCount + ' 个片段预计费用 ¥' + estimate.toFixed(2) + '（¥1/分钟估算；实际以火山账单为准）。';
    var resolve = state.reviewResolver; state.reviewResolver = null; $('continueClip').disabled = true; resolve({ regions: state.regions.slice(), skip: false });
  });
  $('skipClip').addEventListener('click', function () { if (state.reviewResolver) { var resolve = state.reviewResolver; state.reviewResolver = null; resolve({ skip: true }); } });
  $('addRegion').addEventListener('click', function () { if (state.regions.length >= 20) return log('最多支持 20 个擦除框。', 'error'); state.regions.push({ topLeftX: .3, topLeftY: .55, bottomRightX: .7, bottomRightY: .9 }); state.selectedRegion = state.regions.length - 1; drawRegionOverlay(); });
  $('removeRegion').addEventListener('click', function () { if (state.selectedRegion >= 0) state.regions.splice(state.selectedRegion, 1); state.selectedRegion = state.regions.length ? 0 : -1; drawRegionOverlay(); });

  var drag = null;
  canvas.addEventListener('pointerdown', function (event) {
    if (!state.current) return;
    var point = readRegionPointerEvent(event); if (!point.inside) return;
    var area = contentRect(), px = point.x, py = point.y, hit = -1, mode = 'draw';
    for (var i = state.regions.length - 1; i >= 0; i -= 1) {
      var r = state.regions[i];
      if (px >= r.topLeftX && px <= r.bottomRightX && py >= r.topLeftY && py <= r.bottomRightY) {
        hit = i; mode = (r.bottomRightX - px < 0.04 && r.bottomRightY - py < 0.04) ? 'resize' : 'move'; break;
      }
    }
    state.selectedRegion = hit;
    if (hit >= 0 && mode !== 'draw') { var old = state.regions[hit]; drag = { mode: mode, index: hit, x: px, y: py, old: Object.assign({}, old) }; }
    else { if (state.regions.length >= 20) return; drag = { mode: 'draw', index: state.regions.length, x: px, y: py }; state.regions.push({ topLeftX: px, topLeftY: py, bottomRightX: px, bottomRightY: py }); }
    canvas.setPointerCapture(event.pointerId); drawRegionOverlay();
  });
  canvas.addEventListener('pointermove', function (event) {
    if (!drag) return;
    var p = readRegionPointerEvent(event), r = state.regions[drag.index]; if (!r) return;
    if (drag.mode === 'draw') {
      var xRange = fitAxis(Math.min(drag.x, p.x), Math.max(drag.x, p.x), .005);
      var yRange = fitAxis(Math.min(drag.y, p.y), Math.max(drag.y, p.y), .005);
      r.topLeftX = xRange[0]; r.bottomRightX = xRange[1]; r.topLeftY = yRange[0]; r.bottomRightY = yRange[1];
    }
    else if (drag.mode === 'move') {
      var dx = p.x - drag.x, dy = p.y - drag.y, w = drag.old.bottomRightX - drag.old.topLeftX, h = drag.old.bottomRightY - drag.old.topLeftY;
      var x = Math.max(0, Math.min(1 - w, drag.old.topLeftX + dx)), y = Math.max(0, Math.min(1 - h, drag.old.topLeftY + dy));
      r.topLeftX = x; r.topLeftY = y; r.bottomRightX = x + w; r.bottomRightY = y + h;
    } else {
      var minimum = .005;
      r.topLeftX = Math.max(0, Math.min(1 - minimum, r.topLeftX));
      r.topLeftY = Math.max(0, Math.min(1 - minimum, r.topLeftY));
      r.bottomRightX = Math.max(r.topLeftX + minimum, Math.min(1, p.x));
      r.bottomRightY = Math.max(r.topLeftY + minimum, Math.min(1, p.y));
    }
    drawRegionOverlay();
  });
  function finishRegionDrag() {
    if (!drag) return;
    var region = state.regions[drag.index];
    if (region && drag.mode === 'draw') {
      var xRange = fitAxis(region.topLeftX, region.bottomRightX, .005);
      var yRange = fitAxis(region.topLeftY, region.bottomRightY, .005);
      region.topLeftX = xRange[0]; region.bottomRightX = xRange[1];
      region.topLeftY = yRange[0]; region.bottomRightY = yRange[1];
    }
    drag = null;
    drawRegionOverlay();
  }
  canvas.addEventListener('pointerup', finishRegionDrag);
  canvas.addEventListener('pointercancel', finishRegionDrag);
  $('previewVideo').addEventListener('loadedmetadata', function () {
    resizeCanvas();
    var video = $('previewVideo');
    if (video.duration > 0.2) video.currentTime = Math.min(0.2, video.duration / 2);
  });
  $('previewVideo').addEventListener('loadeddata', resizeCanvas);
  $('previewVideo').addEventListener('error', function () {
    var error = $('previewVideo').error;
    log('预览视频无法解码（MediaError ' + (error ? error.code : '未知') + '）；请使用 H.264 MP4 导出预设。', 'error');
  });
  window.addEventListener('resize', resizeCanvas);
  $('apiKey').value = '';
  var defaultOutputDir = path.join(os.homedir(), 'Videos', 'HardSubtitleRemover');
  var oldDefaultPresetPath = 'C:\\Program Files\\Adobe\\Adobe Media Encoder 2025\\MediaIO\\systempresets\\3F3F3F3F_4D6F6F56\\Apple ProRes 422.epr';
  var defaultPresetPath = 'C:\\Program Files\\Adobe\\Adobe Media Encoder 2025\\MediaIO\\systempresets\\4E49434B_48323634\\00 - Match Source - High bitrate.epr';
  var savedOutputDir = localStorage.getItem('hardSubtitle.outputDir');
  var savedPresetPath = localStorage.getItem('hardSubtitle.presetPath');
  if (savedPresetPath && savedPresetPath.toLowerCase() === oldDefaultPresetPath.toLowerCase()) {
    savedPresetPath = defaultPresetPath;
    localStorage.setItem('hardSubtitle.presetPath', savedPresetPath);
  }
  $('outputDir').value = savedOutputDir || defaultOutputDir;
  $('presetPath').value = savedPresetPath || (fs.existsSync(defaultPresetPath) ? defaultPresetPath : '');
  $('concurrency').value = localStorage.getItem('hardSubtitle.concurrency') || '2';
  $('outputDir').addEventListener('change', function () { localStorage.setItem('hardSubtitle.outputDir', $('outputDir').value.trim()); });
  $('presetPath').addEventListener('change', function () { localStorage.setItem('hardSubtitle.presetPath', $('presetPath').value.trim()); });
  $('concurrency').addEventListener('change', function () { localStorage.setItem('hardSubtitle.concurrency', $('concurrency').value); });
  HardSubtitleCredentialStore.loadApiKey().then(function (key) { $('connection').textContent = key ? 'API Key 已配置' : '未连接'; }).catch(function () { $('connection').textContent = '密钥解密失败'; });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && state.reviewResolver) $('skipClip').click(); });
  $('scan').addEventListener('dblclick', function () { if (state.busy) return; });
  window.addEventListener('beforeunload', function () { if (state.reviewResolver) { var resolve = state.reviewResolver; state.reviewResolver = null; resolve({ skip: true }); } });
  $('scan').title = '扫描后，点击扫描按钮下方的片段列表，然后在右侧设置中启动处理';
  var run = document.createElement('button'); run.id = 'run'; run.className = 'primary'; run.textContent = '处理已扫描片段'; $('scan').parentNode.appendChild(run);
  run.addEventListener('click', async function () {
    if (state.busy) return;
    if (!state.jobs.length) return log('请先扫描选中片段。', 'error');
    state.busy = true; run.disabled = true; $('scan').disabled = true;
    try {
      var settings = ensureSettings();
      var key = await HardSubtitleCredentialStore.loadApiKey(); if (!key) throw new Error('请先保存火山 AI MediaKit API Key。');
      await processSelectedJobs(state.jobs, settings);
    } catch (error) { log(error.message, 'error'); }
    finally { state.busy = false; run.disabled = false; $('scan').disabled = false; }
  });
}());
