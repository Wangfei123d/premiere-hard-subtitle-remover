function __hardSubtitleJsonString(value) {
    return '"' + String(value === null || value === undefined ? '' : value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t') + '"';
}

function __hardSubtitleJsonValue(value) {
    var i;
    var parts;
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') return __hardSubtitleJsonString(value);
    if (typeof value === 'number') return isFinite(value) ? String(value) : 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (value instanceof Array) {
        parts = [];
        for (i = 0; i < value.length; i += 1) parts.push(__hardSubtitleJsonValue(value[i]));
        return '[' + parts.join(',') + ']';
    }
    if (typeof value === 'object') {
        parts = [];
        for (i in value) {
            if (value.hasOwnProperty(i) && typeof value[i] !== 'undefined') {
                parts.push(__hardSubtitleJsonString(i) + ':' + __hardSubtitleJsonValue(value[i]));
            }
        }
        return '{' + parts.join(',') + '}';
    }
    return 'null';
}

function __hardSubtitleTicks(timeObject) {
    if (!timeObject || typeof timeObject.ticks === 'undefined') return null;
    return String(timeObject.ticks);
}

function __hardSubtitleClipSnapshot(clip, sequence, sequenceName, trackIndex) {
    var projectItem = clip ? clip.projectItem : null;
    var mediaPath = '';
    var mediaType = '';
    if (!clip) return null;
    try {
        mediaType = String(clip.mediaType || '');
    } catch (mediaTypeError) {
        mediaType = '';
    }
    if (clip.type !== 1 && mediaType !== 'Video') {
        return null;
    }
    if (projectItem && typeof projectItem.getMediaPath === 'function') {
        try {
            mediaPath = projectItem.getMediaPath() || '';
        } catch (pathError) {
            mediaPath = '';
        }
    }
    return {
        type: 'Video',
        projectItemId: projectItem ? String(projectItem.nodeId || '') : '',
        path: String(mediaPath),
        sequenceId: String(sequence.sequenceID || sequence.id || ''),
        sequenceName: String(sequenceName || ''),
        sequenceWidth: Number(sequence.frameSizeHorizontal || 0),
        sequenceHeight: Number(sequence.frameSizeVertical || 0),
        trackIndex: trackIndex,
        clipId: String(clip.nodeId || ''),
        clipName: String(clip.name || ''),
        sequenceStart: __hardSubtitleTicks(clip.start),
        sequenceEnd: __hardSubtitleTicks(clip.end),
        sourceIn: __hardSubtitleTicks(clip.inPoint),
        sourceOut: __hardSubtitleTicks(clip.outPoint)
    };
}

function __hardSubtitleTimesOverlap(aStart, aEnd, bStart, bEnd) {
    var as = Number(aStart);
    var ae = Number(aEnd);
    var bs = Number(bStart);
    var be = Number(bEnd);
    return isFinite(as) && isFinite(ae) && isFinite(bs) && isFinite(be) && as < be && bs < ae;
}

function __hardSubtitleFindSelectedTrack(sequence, selectedClip) {
    var matches = [];
    var track;
    var candidate;
    var i;
    var j;
    var count = sequence.videoTracks.numTracks;
    for (i = 0; i < count; i += 1) {
        track = sequence.videoTracks[i];
        for (j = 0; j < track.clips.numItems; j += 1) {
            candidate = track.clips[j];
            if (candidate && String(candidate.nodeId || '') === String(selectedClip.nodeId || '')) {
                matches.push(i);
            }
        }
    }
    return matches;
}

function __hardSubtitleHasTransition(track, startTicks, endTicks) {
    var transitions = track.transitions;
    var transition;
    var start;
    var end;
    var i;
    if (!transitions || typeof transitions.numItems !== 'number') return false;
    for (i = 0; i < transitions.numItems; i += 1) {
        transition = transitions[i];
        start = __hardSubtitleTicks(transition && transition.start);
        end = __hardSubtitleTicks(transition && transition.end);
        if (!start || !end || __hardSubtitleTimesOverlap(startTicks, endTicks, start, end)) return true;
    }
    return false;
}

function __hardSubtitleOverlapsVideo(sequence, selectedClip, trackIndex, startTicks, endTicks) {
    var track;
    var candidate;
    var candidateStart;
    var candidateEnd;
    var i;
    var j;
    for (i = 0; i < sequence.videoTracks.numTracks; i += 1) {
        track = sequence.videoTracks[i];
        for (j = 0; j < track.clips.numItems; j += 1) {
            candidate = track.clips[j];
            if (!candidate || String(candidate.nodeId || '') === String(selectedClip.nodeId || '')) continue;
            if (candidate.type !== 1 && String(candidate.mediaType || '') !== 'Video') continue;
            candidateStart = __hardSubtitleTicks(candidate.start);
            candidateEnd = __hardSubtitleTicks(candidate.end);
            if (__hardSubtitleTimesOverlap(startTicks, endTicks, candidateStart, candidateEnd)) return true;
        }
    }
    return false;
}

function getSubtitleTimelineSnapshot() {
    var project;
    var sequence;
    var clips = [];
    var selected;
    var clip;
    var matchTracks;
    var blockers;
    var trackIndex;
    var clipSnapshot;
    var i;
    var trackCount;
    var sequenceName;
    var snapshot;

    try {
        project = app.project;
        if (!project) {
            return __hardSubtitleJsonValue({ ok: false, error: '请先打开 Premiere 项目。' });
        }
        sequence = project.activeSequence;
        if (!sequence) {
            return __hardSubtitleJsonValue({ ok: false, error: '请先激活一个时间轴序列。' });
        }
        sequenceName = String(sequence.name || '');

        selected = sequence.getSelection();
        if (!selected || selected.length === 0) {
            return __hardSubtitleJsonValue({ ok: false, error: '请先在时间轴中选择要修复的视频片段。' });
        }
        for (i = 0; i < selected.length; i += 1) {
            clip = selected[i];
            clipSnapshot = __hardSubtitleClipSnapshot(clip, sequence, sequenceName, null);
            if (!clipSnapshot) continue;
            blockers = [];
            matchTracks = __hardSubtitleFindSelectedTrack(sequence, clip);
            trackIndex = matchTracks.length === 1 ? matchTracks[0] : null;
            if (matchTracks.length === 0) blockers.push('missing-track');
            if (matchTracks.length > 1) blockers.push('ambiguous-clip');
            clipSnapshot.trackIndex = trackIndex;
            if (!clipSnapshot.sequenceStart || !clipSnapshot.sequenceEnd || Number(clipSnapshot.sequenceEnd) <= Number(clipSnapshot.sequenceStart)) {
                blockers.push('missing-range');
            } else if (trackIndex !== null) {
                if (__hardSubtitleOverlapsVideo(sequence, clip, trackIndex, clipSnapshot.sequenceStart, clipSnapshot.sequenceEnd)) {
                    blockers.push('overlapping-video');
                }
                if (__hardSubtitleHasTransition(sequence.videoTracks[trackIndex], clipSnapshot.sequenceStart, clipSnapshot.sequenceEnd)) {
                    blockers.push('transition');
                }
            }
            clipSnapshot.renderBlockers = blockers;
            clips.push(clipSnapshot);
        }

        snapshot = {
            ok: true,
            premiereVersion: String(app.version || ''),
            projectPath: String(project.path || ''),
            projectId: String(project.documentID || project.path || ''),
            sequence: { id: String(sequence.sequenceID || sequence.id || ''), name: sequenceName },
            mode: 'selected',
            clips: clips
        };
        for (i = 0; i < snapshot.clips.length; i += 1) snapshot.clips[i].projectPath = snapshot.projectPath;
        return __hardSubtitleJsonValue(snapshot);
    } catch (error) {
        return __hardSubtitleJsonValue({ ok: false, error: String(error) });
    }
}

function __hardSubtitleNormalizePath(value) {
    return String(value || '').replace(/\//g, '\\').toLowerCase();
}

function __hardSubtitleFindProjectItem(container, nodeId, visited) {
    var children;
    var item;
    var found;
    var i;
    if (!container || !container.children) return null;
    children = container.children;
    if (typeof children.numItems !== 'number') return null;
    for (i = 0; i < children.numItems; i += 1) {
        item = children[i];
        if (!item) continue;
        if (String(item.nodeId || '') === String(nodeId)) return item;
        if (!visited[String(item.nodeId || i)]) {
            visited[String(item.nodeId || i)] = true;
            found = __hardSubtitleFindProjectItem(item, nodeId, visited);
            if (found) return found;
        }
    }
    return null;
}

var __hardSubtitleRenderBatch = null;
var __hardSubtitleEncoderHandlersBound = false;
var __hardSubtitleTicksPerSecond = 254016000000;

function __hardSubtitlePathKey(value) {
    return String(value || '').replace(/\//g, '\\').toLowerCase();
}

function __hardSubtitleTrackItemPath(trackItem) {
    try {
        return String(trackItem.projectItem.getMediaPath() || '');
    } catch (error) {
        return '';
    }
}

function __hardSubtitleCloneSequence(project, sequence) {
    var collection = project && project.sequences;
    var existing = {};
    var candidates = [];
    var item;
    var itemID;
    var cloneResult;
    var i;
    if (!collection || typeof collection.numSequences !== 'number') {
        throw new Error('Premiere 未提供项目序列列表，无法定位临时克隆序列。');
    }
    for (i = 0; i < collection.numSequences; i += 1) {
        item = collection[i];
        itemID = item ? String(item.sequenceID || item.id || '') : '';
        if (itemID) existing[itemID] = true;
    }
    cloneResult = sequence.clone();
    if (cloneResult !== true) throw new Error('Premiere 未能克隆当前序列。');
    for (i = 0; i < collection.numSequences; i += 1) {
        item = collection[i];
        itemID = item ? String(item.sequenceID || item.id || '') : '';
        if (item && itemID && !existing[itemID]) candidates.push(item);
    }
    if (candidates.length !== 1) {
        throw new Error('克隆序列后无法唯一定位新序列。');
    }
    return candidates[0];
}

function __hardSubtitleFindCloneClip(sequence, job) {
    var matches = [];
    var track;
    var clip;
    var i;
    var j;
    track = sequence.videoTracks[job.clip.trackIndex];
    if (!track) throw new Error('临时序列找不到目标视频轨道。');
    for (j = 0; j < track.clips.numItems; j += 1) {
        clip = track.clips[j];
        if (String(clip.start.ticks) === String(job.clip.sequenceStart) &&
            String(clip.end.ticks) === String(job.clip.sequenceEnd) &&
            __hardSubtitlePathKey(__hardSubtitleTrackItemPath(clip)) === __hardSubtitlePathKey(job.sourcePath)) {
            matches.push(clip);
        }
    }
    if (matches.length !== 1) throw new Error('临时序列中无法唯一定位目标片段。');
    return matches[0];
}

function __hardSubtitleRemoveCloneItems(collection, keepItem) {
    var item;
    var keepID = keepItem ? String(keepItem.nodeId || '') : '';
    var i;
    if (!collection || typeof collection.numItems !== 'number') return;
    for (i = collection.numItems - 1; i >= 0; i -= 1) {
        item = collection[i];
        if (item && item !== keepItem && (!keepID || String(item.nodeId || '') !== keepID)) item.remove(0, 0);
    }
}

function __hardSubtitleDeleteTemporarySequence(sequence) {
    if (!sequence) return;
    try {
        app.project.deleteSequence(sequence);
    } catch (error) {
    }
}

function __hardSubtitleFinishEncoderJob(jobID, status, renderPath, errorMessage) {
    var job = __hardSubtitleRenderBatch && __hardSubtitleRenderBatch.encoderJobs[String(jobID)];
    if (!job || job.status === 'complete' || job.status === 'failed') return;
    job.status = status;
    if (status === 'complete') job.renderPath = String(renderPath || job.renderPath);
    if (errorMessage) job.error = String(errorMessage);
    __hardSubtitleDeleteTemporarySequence(job.sequence);
    job.sequence = null;
    __hardSubtitleRenderBatch.completed += 1;
}

function __hardSubtitleBindEncoderHandlers() {
    if (__hardSubtitleEncoderHandlersBound) return;
    app.encoder.bind('onEncoderJobComplete', function (jobID, outputFilePath) {
        __hardSubtitleFinishEncoderJob(jobID, 'complete', outputFilePath, '');
    });
    app.encoder.bind('onEncoderJobError', function (jobID, errorMessage) {
        __hardSubtitleFinishEncoderJob(jobID, 'failed', '', errorMessage || 'AME 导出失败。');
    });
    app.encoder.bind('onEncoderJobCanceled', function (jobID) {
        __hardSubtitleFinishEncoderJob(jobID, 'failed', '', 'AME 导出已取消。');
    });
    __hardSubtitleEncoderHandlersBound = true;
}

function __hardSubtitleOutputExtensionForPreset(presetPath) {
    var presetFile = new File(presetPath);
    var contents;
    var match;
    if (!presetFile.exists || !presetFile.open('r')) return '.mov';
    try { contents = presetFile.read(); } finally { presetFile.close(); }
    match = /<ExporterFileType>\s*(\d+)\s*<\/ExporterFileType>/.exec(contents);
    if (match && Number(match[1]) === 1211250228) return '.mp4'; // H264 container
    if (match && Number(match[1]) === 1299148630) return '.mov'; // QuickTime container
    return '.mov';
}

function startSubtitleRenderBatch(jobs, renderDirectory, presetPath) {
    var project = app.project;
    var activeSequence = project ? project.activeSequence : null;
    var directory = String(renderDirectory || '').replace(/[\\\\]+$/, '');
    var preset = String(presetPath || '');
    var seen = {};
    var batch;
    var job;
    var clone;
    var target;
    var track;
    var safeKey;
    var outputPath;
    var outputExtension;
    var encoderJobID;
    var i;
    var j;
    var k;
    var startResult;
    var validationJob;
    try {
        if (!activeSequence) throw new Error('请先激活一个 Premiere 时间轴序列。');
        if (Object.prototype.toString.call(jobs) !== '[object Array]' || jobs.length === 0) throw new Error('没有可导出的片段任务。');
        if (!directory || !preset || !new File(preset).exists) throw new Error('AME 导出预设不存在，请检查配置路径。');
        outputExtension = __hardSubtitleOutputExtensionForPreset(preset);
        if (__hardSubtitleRenderBatch && __hardSubtitleRenderBatch.completed < __hardSubtitleRenderBatch.jobs.length) {
            throw new Error('上一次 AME 导出批次仍在运行。');
        }
        for (i = 0; i < jobs.length; i += 1) {
            validationJob = jobs[i];
            if (!validationJob || !validationJob.clipKey || !validationJob.clip || seen[String(validationJob.clipKey)]) throw new Error('片段任务缺少 clipKey 或包含重复 ID。');
            seen[String(validationJob.clipKey)] = true;
            if (String(validationJob.clip.sequenceId || '') !== String(activeSequence.sequenceID || activeSequence.id || '')) throw new Error('片段属于其他序列，拒绝渲染。');
            if (!isFinite(Number(validationJob.clip.trackIndex)) || Number(validationJob.clip.trackIndex) < 0 ||
                !isFinite(Number(validationJob.clip.sequenceStart)) || !isFinite(Number(validationJob.clip.sequenceEnd)) ||
                Number(validationJob.clip.sequenceEnd) <= Number(validationJob.clip.sequenceStart)) throw new Error('片段时间范围或轨道无效。');
        }
        seen = {};
        batch = { jobs: [], encoderJobs: {}, completed: 0, sequenceID: String(activeSequence.sequenceID || activeSequence.id || '') };
        __hardSubtitleRenderBatch = batch;
        __hardSubtitleBindEncoderHandlers();
        app.encoder.launchEncoder();

        for (i = 0; i < jobs.length; i += 1) {
            job = jobs[i];
            clone = __hardSubtitleCloneSequence(project, activeSequence);
            try {
                target = __hardSubtitleFindCloneClip(clone, job);
                for (j = 0; j < clone.videoTracks.numTracks; j += 1) {
                    track = clone.videoTracks[j];
                    __hardSubtitleRemoveCloneItems(track.clips, j === Number(job.clip.trackIndex) ? target : null);
                }
                clone.setInPoint(Number(job.clip.sequenceStart) / __hardSubtitleTicksPerSecond);
                clone.setOutPoint(Number(job.clip.sequenceEnd) / __hardSubtitleTicksPerSecond);
                safeKey = String(i + 1) + '_' + String(job.clipKey).replace(/[^A-Za-z0-9_-]/g, '_');
                outputPath = directory + '\\' + safeKey + outputExtension;
                encoderJobID = app.encoder.encodeSequence(clone, outputPath, preset, app.encoder.ENCODE_IN_TO_OUT, 1);
                if (!encoderJobID) throw new Error('AME 没有返回导出任务 ID。');
                batch.jobs.push({ clipKey: String(job.clipKey), status: 'queued', renderPath: outputPath, sequence: clone, encoderJobID: String(encoderJobID) });
                batch.encoderJobs[String(encoderJobID)] = batch.jobs[batch.jobs.length - 1];
                clone = null;
            } catch (jobError) {
                __hardSubtitleDeleteTemporarySequence(clone);
                batch.jobs.push({ clipKey: String(job.clipKey || ''), status: 'failed', error: String(jobError), renderPath: '', sequence: null });
                batch.completed += 1;
            }
        }
        startResult = app.encoder.startBatch();
        if (startResult !== 1 && startResult !== true) {
            for (k = 0; k < batch.jobs.length; k += 1) {
                if (batch.jobs[k].status === 'queued') __hardSubtitleFinishEncoderJob(batch.jobs[k].encoderJobID, 'failed', '', 'AME 未能启动导出队列。');
            }
        }
        return __hardSubtitleJsonValue({ ok: true, jobs: __hardSubtitlePublicRenderJobs(batch) });
    } catch (error) {
        if (clone) __hardSubtitleDeleteTemporarySequence(clone);
        if (batch) {
            for (k = 0; k < batch.jobs.length; k += 1) {
                if (batch.jobs[k].status !== 'queued') continue;
                __hardSubtitleDeleteTemporarySequence(batch.jobs[k].sequence);
                batch.jobs[k].sequence = null;
                batch.jobs[k].status = 'failed';
                batch.jobs[k].error = String(error);
                batch.completed += 1;
            }
        }
        return __hardSubtitleJsonValue({ ok: false, error: String(error) });
    }
}

function __hardSubtitlePublicRenderJobs(batch) {
    var jobs = [];
    var i;
    for (i = 0; i < batch.jobs.length; i += 1) {
        jobs.push({ clipKey: batch.jobs[i].clipKey, status: batch.jobs[i].status, renderPath: batch.jobs[i].renderPath || '', error: batch.jobs[i].error || '' });
    }
    return jobs;
}

function getSubtitleRenderBatchState() {
    if (!__hardSubtitleRenderBatch) return __hardSubtitleJsonValue({ ok: false, error: '当前没有 AME 导出批次。', jobs: [] });
    return __hardSubtitleJsonValue({
        ok: true,
        done: __hardSubtitleRenderBatch.completed >= __hardSubtitleRenderBatch.jobs.length,
        jobs: __hardSubtitlePublicRenderJobs(__hardSubtitleRenderBatch)
    });
}

function __hardSubtitleFindProjectItemByPath(container, mediaPath) {
    var children;
    var item;
    var found;
    var itemPath;
    var i;
    if (!container || !container.children || typeof container.children.numItems !== 'number') return null;
    children = container.children;
    for (i = 0; i < children.numItems; i += 1) {
        item = children[i];
        if (!item) continue;
        itemPath = __hardSubtitleTrackItemPath({ projectItem: item });
        if (itemPath && __hardSubtitlePathKey(itemPath) === __hardSubtitlePathKey(mediaPath)) return item;
        found = __hardSubtitleFindProjectItemByPath(item, mediaPath);
        if (found) return found;
    }
    return null;
}

function __hardSubtitleFindTrackItem(sequence, clipSnapshot) {
    var matches = [];
    var track = sequence.videoTracks[Number(clipSnapshot.trackIndex)];
    var item;
    var i;
    if (!track) return null;
    for (i = 0; i < track.clips.numItems; i += 1) {
        item = track.clips[i];
        if (!item || String(item.nodeId || '') !== String(clipSnapshot.clipId || '')) continue;
        if (__hardSubtitlePathKey(__hardSubtitleTrackItemPath(item)) !== __hardSubtitlePathKey(clipSnapshot.path)) continue;
        if (String(item.start.ticks) !== String(clipSnapshot.sequenceStart) || String(item.end.ticks) !== String(clipSnapshot.sequenceEnd)) continue;
        matches.push(item);
    }
    return matches.length === 1 ? matches[0] : null;
}

function __hardSubtitleFindInsertedTrackItem(sequence, trackIndex, outputPath, startTicks, endTicks) {
    var track = sequence.videoTracks[Number(trackIndex)];
    var matches = [];
    var item;
    var tolerance = __hardSubtitleTicksPerSecond / 10;
    var expectedStart = Number(startTicks);
    var expectedDuration = Number(endTicks) - expectedStart;
    var actualStart;
    var actualEnd;
    var actualDuration;
    var i;
    if (!track) return null;
    for (i = 0; i < track.clips.numItems; i += 1) {
        item = track.clips[i];
        if (!item || __hardSubtitlePathKey(__hardSubtitleTrackItemPath(item)) !== __hardSubtitlePathKey(outputPath)) continue;
        actualStart = Number(item.start.ticks);
        actualEnd = Number(item.end.ticks);
        actualDuration = actualEnd - actualStart;
        if (!isFinite(actualStart) || !isFinite(actualDuration) || actualDuration <= 0) continue;
        if (Math.abs(actualStart - expectedStart) <= tolerance && Math.abs(actualDuration - expectedDuration) <= tolerance) matches.push(item);
    }
    return matches.length === 1 ? matches[0] : null;
}

function __hardSubtitleSetRestoredClipScale(trackItem, scale) {
    var components = trackItem ? trackItem.components : null;
    var component;
    var properties;
    var parameter;
    var value = 100 / Number(scale);
    var i;
    var j;
    if (!isFinite(value) || value <= 0) throw new Error('放大倍数无效。');
    for (i = 0; components && i < components.numItems; i += 1) {
        component = components[i];
        if (String(component.matchName || '') !== 'ADBE Motion') continue;
        properties = component.properties;
        for (j = 0; properties && j < properties.numItems; j += 1) {
            parameter = properties[j];
            if (String(parameter.displayName || '') === 'Scale' || String(parameter.displayName || '') === '缩放') {
                parameter.setValue(value, 1);
                if (Math.abs(Number(parameter.getValue()) - value) > 0.001) throw new Error('Premiere 未能设置修复片段的缩放。');
                return true;
            }
        }
    }
    throw new Error('修复片段中找不到 Motion 缩放参数。');
}

function __hardSubtitleSetSequenceFitScale(trackItem, sequenceWidth, sequenceHeight, outputWidth, outputHeight) {
    var components = trackItem ? trackItem.components : null;
    var component;
    var properties;
    var parameter;
    var sequenceW = Number(sequenceWidth);
    var sequenceH = Number(sequenceHeight);
    var outputW = Number(outputWidth);
    var outputH = Number(outputHeight);
    var value;
    var i;
    var j;
    if (!isFinite(sequenceW) || !isFinite(sequenceH) || !isFinite(outputW) || !isFinite(outputH) ||
        sequenceW <= 0 || sequenceH <= 0 || outputW <= 0 || outputH <= 0) {
        throw new Error('序列或处理结果的画面尺寸无效，无法自动恢复画面大小。');
    }
    // Fit the processed, sequence-sized render inside the original frame without stretching or cropping.
    value = Math.min(sequenceW / outputW, sequenceH / outputH) * 100;
    if (!isFinite(value) || value <= 0) throw new Error('自动缩放比例无效。');
    for (i = 0; components && i < components.numItems; i += 1) {
        component = components[i];
        if (String(component.matchName || '') !== 'ADBE Motion') continue;
        properties = component.properties;
        for (j = 0; properties && j < properties.numItems; j += 1) {
            parameter = properties[j];
            if (String(parameter.displayName || '') === 'Scale' || String(parameter.displayName || '') === '缩放') {
                parameter.setValue(value, 1);
                if (Math.abs(Number(parameter.getValue()) - value) > 0.001) throw new Error('Premiere 未能设置自动缩放。');
                return value;
            }
        }
    }
    throw new Error('替换片段中找不到 Motion 缩放参数。');
}

function applySubtitleResults(results) {
    var project = app.project;
    var sequence = project ? project.activeSequence : null;
    var staged = [];
    var report = [];
    var seen = {};
    var outputPaths = [];
    var entry;
    var clip;
    var original;
    var track;
    var item;
    var inserted;
    var reportItem;
    var key;
    var importResult;
    var failedCount = 0;
    var applied = 0;
    var i;

    if (!project || !project.rootItem || !sequence) return __hardSubtitleJsonValue({ ok: false, applied: 0, error: '请先打开项目并激活目标序列。', results: [] });
    if (Object.prototype.toString.call(results) !== '[object Array]' || results.length === 0) return __hardSubtitleJsonValue({ ok: false, applied: 0, error: '没有可应用的修复片段。', results: [] });

    for (i = 0; i < results.length; i += 1) {
        entry = results[i] || {};
        clip = entry.clip || {};
        key = String(entry.clipKey || '');
        reportItem = { clipKey: key, status: 'failed', message: '' };
        report.push(reportItem);
        if (entry.status !== 'complete' || !key || !entry.outputPath || !entry.sourcePath || !clip.clipId || !clip.sequenceId) {
            reportItem.message = '修复结果缺少必要字段或未成功完成。';
            failedCount += 1;
            continue;
        }
        if (seen[key]) {
            reportItem.message = '批次包含重复的片段任务 ID。';
            failedCount += 1;
            continue;
        }
        seen[key] = true;
        if (String(clip.sequenceId) !== String(sequence.sequenceID || sequence.id || '')) {
            reportItem.message = '当前活动序列与修复结果不一致。';
            failedCount += 1;
            continue;
        }
        if (!isFinite(Number(clip.trackIndex)) || Number(clip.trackIndex) < 0 || !clip.sequenceStart || !clip.sequenceEnd || Number(clip.sequenceEnd) <= Number(clip.sequenceStart)) {
            reportItem.message = '片段轨道或时间范围无效。';
            failedCount += 1;
            continue;
        }
        if (!isFinite(Number(entry.scale)) || Number(entry.scale) < 2 || !isFinite(Number(entry.frameCount)) || Number(entry.frameCount) <= 0 || !/^\d+\/\d+$/.test(String(entry.frameRate || '')) || Number(entry.width) <= 0 || Number(entry.height) <= 0) {
            reportItem.message = '修复文件的帧数、帧率、尺寸或缩放校验信息不完整。';
            failedCount += 1;
            continue;
        }
        if (!new File(String(entry.outputPath)).exists) {
            reportItem.message = '修复文件不存在。';
            failedCount += 1;
            continue;
        }
        original = __hardSubtitleFindTrackItem(sequence, clip);
        if (!original) {
            reportItem.message = '选中片段的序列、轨道、素材路径或入出点已变化。';
            failedCount += 1;
            continue;
        }
        track = sequence.videoTracks[Number(clip.trackIndex)];
        staged.push({ entry: entry, clip: clip, track: track, reportIndex: report.length - 1 });
        outputPaths.push(String(entry.outputPath));
        reportItem.status = 'ready';
        reportItem.message = '时间轴快照和修复文件均已通过预检。';
    }

    if (failedCount > 0 || staged.length !== results.length) {
        for (i = 0; i < report.length; i += 1) if (report[i].status === 'ready') report[i].status = 'not-applied';
        var preflightDetails = [];
        for (i = 0; i < report.length; i += 1) {
            if (report[i].status === 'failed') preflightDetails.push(report[i].clipKey + '：' + report[i].message);
        }
        return __hardSubtitleJsonValue({
            ok: false,
            applied: 0,
            error: '整批预检失败，时间轴未更改。' + (preflightDetails.length ? ' ' + preflightDetails.join('；') : ''),
            results: report
        });
    }

    try {
        importResult = project.importFiles(outputPaths, 1, project.rootItem, 0);
        if (importResult !== true && importResult !== 1) throw new Error('Premiere 未能导入修复文件。');
        for (i = 0; i < staged.length; i += 1) {
            staged[i].item = __hardSubtitleFindProjectItemByPath(project.rootItem, staged[i].entry.outputPath);
            if (!staged[i].item) throw new Error('导入后找不到修复文件项目项：' + staged[i].entry.outputPath);
        }
    } catch (importError) {
        for (i = 0; i < staged.length; i += 1) {
            report[staged[i].reportIndex].status = 'not-applied';
            report[staged[i].reportIndex].message = String(importError);
        }
        return __hardSubtitleJsonValue({ ok: false, applied: 0, error: String(importError), results: report });
    }

    for (i = 0; i < staged.length; i += 1) {
        entry = staged[i].entry;
        clip = staged[i].clip;
        reportItem = report[staged[i].reportIndex];
        try {
            item = staged[i].track.overwriteClip(staged[i].item, String(clip.sequenceStart));
            if (item !== true && item !== 1) throw new Error('Premiere 拒绝覆盖目标时间轴片段。');
            inserted = __hardSubtitleFindInsertedTrackItem(sequence, clip.trackIndex, entry.outputPath, clip.sequenceStart,
                String(Number(clip.sequenceStart) + Number(clip.sequenceEnd) - Number(clip.sequenceStart)));
            if (!inserted) throw new Error('覆盖后无法按修复路径和时间范围确认新片段。');
            __hardSubtitleSetRestoredClipScale(inserted, entry.scale);
            reportItem.status = 'applied';
            reportItem.message = '已替换选中片段，原片段效果已烘焙进修复视频。';
            applied += 1;
        } catch (applyError) {
            reportItem.status = 'failed';
            reportItem.message = String(applyError);
            for (var remaining = i + 1; remaining < staged.length; remaining += 1) {
                report[staged[remaining].reportIndex].status = 'not-applied';
                report[staged[remaining].reportIndex].message = '前一片段替换失败，未继续处理。';
            }
            return __hardSubtitleJsonValue({ ok: false, applied: applied, error: '批次替换部分失败；已完成项已保留，未执行回滚。', results: report });
        }
    }
    return __hardSubtitleJsonValue({ ok: true, applied: applied, results: report });
}

// The extension calls this replacement implementation; it deliberately keeps
// the original audio tracks untouched and performs a full preflight first.
function applySubtitleResults(results) {
    var project = app.project;
    var sequence = project ? project.activeSequence : null;
    var staged = [];
    var report = [];
    var paths = [];
    var entry;
    var clip;
    var original;
    var track;
    var item;
    var inserted;
    var outputPaths = {};
    var i;
    var failed = 0;
    var applied = 0;
    if (!project || !project.rootItem || !sequence) return __hardSubtitleJsonValue({ ok: false, applied: 0, failed: results ? results.length : 0, error: '请打开原项目并激活处理时的序列。', results: [] });
    if (Object.prototype.toString.call(results) !== '[object Array]' || !results.length) return __hardSubtitleJsonValue({ ok: false, applied: 0, failed: 0, error: '没有可替换的结果。', results: [] });

    for (i = 0; i < results.length; i += 1) {
        entry = results[i] || {};
        clip = entry.clip || {};
        var row = { clipKey: String(entry.clipKey || ''), status: 'failed', message: '' };
        report.push(row);
        if (entry.status !== 'complete' || !entry.outputPath || !entry.sourcePath || !clip.clipId || !clip.sequenceId) {
            row.message = '结果缺少片段身份或输出文件。'; failed += 1; continue;
        }
        if (String(clip.sequenceId) !== String(sequence.sequenceID || sequence.id || '') ||
            (clip.projectPath && String(clip.projectPath) !== String(project.path || '')) ||
            !clip.sequenceStart || !clip.sequenceEnd || !isFinite(Number(clip.trackIndex))) {
            row.message = '活动序列、轨道或片段时间范围已变化。'; failed += 1; continue;
        }
        if (!isFinite(Number(clip.sequenceWidth)) || !isFinite(Number(clip.sequenceHeight)) || Number(clip.sequenceWidth) <= 0 || Number(clip.sequenceHeight) <= 0 ||
            !isFinite(Number(entry.outputWidth)) || !isFinite(Number(entry.outputHeight)) || Number(entry.outputWidth) <= 0 || Number(entry.outputHeight) <= 0) {
            row.message = '序列或处理结果的画面尺寸无效，无法自动恢复画面大小。'; failed += 1; continue;
        }
        if (!new File(String(entry.outputPath)).exists) { row.message = '下载的处理结果文件不存在。'; failed += 1; continue; }
        original = __hardSubtitleFindTrackItem(sequence, clip);
        if (!original) { row.message = '片段 ID、源路径、轨道或时间范围与处理前不一致，拒绝自动替换。'; failed += 1; continue; }
        if (outputPaths[String(entry.outputPath)]) { row.message = '批次包含重复输出路径。'; failed += 1; continue; }
        outputPaths[String(entry.outputPath)] = true;
        staged.push({ entry: entry, clip: clip, track: sequence.videoTracks[Number(clip.trackIndex)], reportIndex: report.length - 1 });
        paths.push(String(entry.outputPath)); row.status = 'ready';
    }
    if (failed || staged.length !== results.length) {
        for (i = 0; i < report.length; i += 1) if (report[i].status === 'ready') report[i].status = 'not-applied';
        return __hardSubtitleJsonValue({ ok: false, applied: 0, failed: failed, error: '整批预检未通过，时间线没有更改。', results: report });
    }
    try {
        var imported = project.importFiles(paths, 1, project.rootItem, 0);
        if (imported !== true && imported !== 1) throw new Error('Premiere 未能导入处理结果。');
        for (i = 0; i < staged.length; i += 1) {
            staged[i].item = __hardSubtitleFindProjectItemByPath(project.rootItem, staged[i].entry.outputPath);
            if (!staged[i].item) throw new Error('导入后无法定位处理结果文件。');
        }
    } catch (importError) {
        for (i = 0; i < staged.length; i += 1) { report[staged[i].reportIndex].status = 'not-applied'; report[staged[i].reportIndex].message = String(importError); }
        return __hardSubtitleJsonValue({ ok: false, applied: 0, failed: staged.length, error: String(importError), results: report });
    }
    for (i = 0; i < staged.length; i += 1) {
        entry = staged[i].entry; clip = staged[i].clip; row = report[staged[i].reportIndex];
        try {
            original = __hardSubtitleFindTrackItem(sequence, clip);
            if (!original) throw new Error('替换前片段身份再次核验失败。');
            item = staged[i].track.overwriteClip(staged[i].item, String(clip.sequenceStart));
            if (item !== true && item !== 1) throw new Error('Premiere 拒绝覆盖选中视频片段。');
            inserted = __hardSubtitleFindInsertedTrackItem(sequence, clip.trackIndex, entry.outputPath, clip.sequenceStart,
                String(Number(clip.sequenceStart) + Number(clip.sequenceEnd) - Number(clip.sequenceStart)));
            if (!inserted) throw new Error('Premiere 已执行覆盖，但无法确认新视频片段。请检查时间线。');
            __hardSubtitleSetSequenceFitScale(inserted, clip.sequenceWidth, clip.sequenceHeight, entry.outputWidth, entry.outputHeight);
            row.status = 'applied'; row.message = '已替换视频画面，并按原序列尺寸自动恢复画面大小；原音频轨道未修改。'; applied += 1;
        } catch (applyError) {
            row.status = 'failed'; row.message = String(applyError);
            for (var remaining = i + 1; remaining < staged.length; remaining += 1) {
                report[staged[remaining].reportIndex].status = 'not-applied'; report[staged[remaining].reportIndex].message = '前一个片段替换失败，未继续替换。';
            }
            return __hardSubtitleJsonValue({ ok: false, applied: applied, failed: results.length - applied, error: '部分替换失败；已完成的替换保留，未执行虚假回滚。', results: report });
        }
    }
    return __hardSubtitleJsonValue({ ok: true, applied: applied, failed: 0, results: report });
}

