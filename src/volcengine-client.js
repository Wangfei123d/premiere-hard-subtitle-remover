(function (root) {
  'use strict';
  var fs = require('fs');
  var path = require('path');
  var https = require('https');
  var http = require('http');
  var API = 'https://mediakit.cn-beijing.volces.com';

  function request(urlString, options, body, redirects) {
    return new Promise(function (resolve, reject) {
      var url = new URL(urlString);
      var transport = url.protocol === 'http:' ? http : https;
      // Pass a string to Node's request overload. In CEP mixed context, the
      // global URL may be Chromium's URL object, which Node can misread as
      // request options and then treat the options object as a listener.
      var req = transport.request(url.toString(), options || {}, function (res) {
        var chunks = [];
        if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location && (redirects || 0) < 5) {
          res.resume();
          return request(new URL(res.headers.location, url).toString(), options, body, (redirects || 0) + 1).then(resolve, reject);
        }
        res.on('data', function (chunk) { chunks.push(Buffer.from(chunk)); });
        res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
      });
      req.setTimeout(120000, function () { req.destroy(new Error('网络请求超时。')); });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
  function uploadBinary(uploadUrl, headers, filePath, contentType) {
    return new Promise(function (resolve, reject) {
      var target = new URL(uploadUrl), transport = target.protocol === 'http:' ? http : https, stat = fs.statSync(filePath);
      var requestHeaders = {}, source;
      Object.keys(headers || {}).forEach(function (key) { requestHeaders[key] = headers[key]; });
      if (!Object.keys(requestHeaders).some(function (key) { return key.toLowerCase() === 'content-type'; })) requestHeaders['Content-Type'] = contentType;
      requestHeaders['Content-Length'] = stat.size;
      // See request(): avoid crossing CEP's browser/Node URL implementations.
      var req = transport.request(target.toString(), { method: 'PUT', headers: requestHeaders }, function (res) {
        var chunks = [];
        res.on('data', function (chunk) { chunks.push(Buffer.from(chunk)); });
        res.on('end', function () {
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('媒体上传失败（HTTP ' + res.statusCode + '）。'));
          resolve(true);
        });
      });
      req.setTimeout(30 * 60 * 1000, function () { req.destroy(new Error('媒体上传超过 30 分钟。')); });
      req.on('error', reject);
      source = fs.createReadStream(filePath);
      source.on('error', function (error) { req.destroy(error); });
      source.pipe(req);
    });
  }
  function downloadToFile(urlString, outputPath, redirects) {
    return new Promise(function (resolve, reject) {
      var target = new URL(urlString), transport = target.protocol === 'http:' ? http : https;
      // Pass a URL string here as well: CEP's browser URL can cross into
      // Node's HTTP overload as a plain options object and default to ::1.
      var req = transport.get(target.toString(), function (res) {
        if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location && (redirects || 0) < 5) {
          res.resume(); return downloadToFile(new URL(res.headers.location, target).toString(), outputPath, (redirects || 0) + 1).then(resolve, reject);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new Error('下载擦除结果失败（HTTP ' + res.statusCode + '）。')); }
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        var output = fs.createWriteStream(outputPath);
        res.on('error', reject); output.on('error', reject); output.on('finish', function () { output.close(function () { resolve(outputPath); }); });
        res.pipe(output);
      });
      req.setTimeout(30 * 60 * 1000, function () { req.destroy(new Error('结果下载超过 30 分钟。')); });
      req.on('error', reject);
    });
  }
  function parseJson(response) {
    var data;
    try { data = JSON.parse(response.body.toString('utf8')); } catch (error) { throw new Error('火山接口返回了无法解析的数据。'); }
    if (response.status < 200 || response.status >= 300 || data.success === false) {
      var message = (data.error && data.error.message) || data.message || ('火山接口请求失败（HTTP ' + response.status + '）。');
      var requestId = data.request_id ? '（request_id: ' + String(data.request_id) + '）' : '';
      throw new Error(String(message) + requestId);
    }
    return data;
  }
  function VolcengineClient(options) {
    this.apiKey = String(options && options.apiKey || '').trim();
    this.fetchImpl = options && options.fetchImpl;
    if (!this.apiKey) throw new Error('请先保存 AI MediaKit API Key。');
  }
  function normalizeEraseRegions(regions) {
    if (!Array.isArray(regions) || !regions.length) throw new Error('请至少保留一个有效擦除框。');
    return regions.map(function (region, index) {
      var left = Number(region && region.topLeftX), top = Number(region && region.topLeftY);
      var right = Number(region && region.bottomRightX), bottom = Number(region && region.bottomRightY);
      if (!isFinite(left) || !isFinite(top) || !isFinite(right) || !isFinite(bottom) ||
          left < 0 || top < 0 || right > 1 || bottom > 1 || right <= left || bottom <= top) {
        throw new Error('第 ' + (index + 1) + ' 个擦除框坐标无效；请确保框在画面内且右下角大于左上角。');
      }
      return { top_left_x: left, top_left_y: top, bottom_right_x: right, bottom_right_y: bottom };
    });
  }
  VolcengineClient.normalizeEraseRegions = normalizeEraseRegions;
  VolcengineClient.prototype._json = function (method, endpoint, data) {
    var body = data ? Buffer.from(JSON.stringify(data), 'utf8') : null;
    return request(API + endpoint, { method: method, headers: { Authorization: 'Bearer ' + this.apiKey, 'Content-Type': 'application/json', 'Content-Length': body ? body.length : 0 } }, body).then(parseJson);
  };
  VolcengineClient.prototype.uploadMedia = function (filePath, contentType, onStage) {
    var stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 5 * 1024 * 1024 * 1024) return Promise.reject(new Error('视频文件为空或超过 AI MediaKit 5 GB 上传限制。'));
    if (onStage) onStage('申请上传地址');
    return this._json('POST', '/api/v1/tools-sync/request-media-upload-url', {}).then(function (data) {
      var result = data.result || data;
      if (!result.upload_url || !result.file_id) throw new Error('火山上传接口未返回 upload_url/file_id。');
      var headers = result.upload_headers || {};
      if (Array.isArray(headers)) { var mapped = {}; headers.forEach(function (entry) { if (entry && entry.key) mapped[entry.key] = entry.value; }); headers = mapped; }
      if (onStage) onStage('上传预览视频');
      return uploadBinary(result.upload_url, headers, filePath, contentType || 'video/quicktime').then(function () {
        return /^mediakit:\/\//.test(String(result.file_id)) ? String(result.file_id) : 'mediakit://' + String(result.file_id);
      });
    });
  };
  VolcengineClient.prototype.waitForTask = function (taskId, onProgress) {
    var self = this;
    var started = Date.now();
    var interval = 2500;
    function poll() {
      if (Date.now() - started > 45 * 60 * 1000) return Promise.reject(new Error('云端任务超过 45 分钟仍未完成。'));
      return self._json('GET', '/api/v1/tasks/' + encodeURIComponent(taskId)).then(function (data) {
        var status = String(data.status || '').toLowerCase();
        if (onProgress) onProgress(data.progress || data.progress_percent || null, status);
        if (status === 'completed' || status === 'success' || status === 'succeeded') return data.result || {};
        if (status === 'failed' || status === 'error' || data.success === false) throw new Error((data.error && data.error.message) || data.message || '火山云端任务失败。');
        return new Promise(function (resolve) { setTimeout(resolve, interval); }).then(function () { interval = Math.min(10000, Math.round(interval * 1.25)); return poll(); });
      });
    }
    return poll();
  };
  VolcengineClient.prototype.recognizeSubtitles = function (videoUrl) {
    var self = this;
    return this._json('POST', '/api/v1/tools/video-ocr', { video_url: videoUrl, mode: 'Subtitle' }).then(function (data) {
      if (!data.task_id) throw new Error('字幕识别接口未返回任务 ID。');
      return self.waitForTask(data.task_id).then(function (result) {
        return { subtitles: (result.subtitles || []).map(function (item) { return { text: String(item.subtitle_text || item.text || ''), startTime: Number(item.start_time || item.startTime || 0), endTime: Number(item.end_time || item.endTime || 0) }; }) };
      });
    });
  };
  VolcengineClient.prototype.eraseSubtitles = function (videoUrl, regions, options) {
    var self = this;
    var normalized = normalizeEraseRegions(regions);
    return this._json('POST', '/api/v1/tools/erase-video-subtitle-pro', { video_url: videoUrl, mode: 'Subtitle', model_version: 'v5', erase_ratio_location: normalized }).then(function (data) {
      if (!data.task_id) throw new Error('字幕擦除接口未返回任务 ID。');
      return self.waitForTask(data.task_id, options && options.onProgress);
    });
  };
  VolcengineClient.prototype.downloadResult = function (videoUrl, outputPath) {
    return downloadToFile(videoUrl, outputPath);
  };
  root.VolcengineClient = VolcengineClient;
}(this));
