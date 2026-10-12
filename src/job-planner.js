(function (root) {
  'use strict';
  function buildClipJobs(clips) {
    var jobs = [];
    var skipped = [];
    var i, clip, duration, key;
    clips = clips || [];
    for (i = 0; i < clips.length; i += 1) {
      clip = clips[i] || {};
      duration = Number(clip.durationSeconds);
      if (!isFinite(duration) || duration <= 0) {
        duration = (Number(clip.sequenceEnd) - Number(clip.sequenceStart)) / 254016000000;
      }
      if (!clip.path || !clip.clipId || !clip.sequenceId || !isFinite(duration) || duration <= 0) {
        skipped.push({ clip: clip, reason: !clip.path ? '片段源媒体路径不可用。' : '片段 ID 或时间范围无效。' });
        continue;
      }
      if (clip.renderBlockers && clip.renderBlockers.length) {
        skipped.push({ clip: clip, reason: clip.renderBlockers.join('、') });
        continue;
      }
      if (duration > 600) {
        skipped.push({ clip: clip, reason: 'AI MediaKit 视频字幕 OCR 单文件时长上限为 10 分钟。' });
        continue;
      }
      key = String(clip.sequenceId) + '_' + String(clip.clipId) + '_' + String(clip.sequenceStart);
      jobs.push({ clipKey: key, sourcePath: String(clip.path), clip: clip, durationSeconds: duration });
    }
    return { jobs: jobs, skipped: skipped };
  }
  function estimateCostYuan(durationSeconds, rateYuanPerMinute) {
    var rate = rateYuanPerMinute === undefined ? 1 : Number(rateYuanPerMinute);
    var seconds = Number(durationSeconds);
    if (!isFinite(rate) || rate < 0 || !isFinite(seconds) || seconds < 0) return 0;
    return seconds * rate / 60;
  }
  root.HardSubtitleJobPlanner = { buildClipJobs: buildClipJobs, estimateCostYuan: estimateCostYuan };
}(this));
