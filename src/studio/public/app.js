/**
 * app.js — fframes-node Studio front end (`page.md` §7).
 *
 * Vanilla, no build step, no framework, no module loader: `server.ts` serves this file as it is
 * under `/static/app.js`, and the page loads it with a plain `<script>` (§5.8). Everything here is
 * plain ES2022 in one IIFE so nothing leaks onto `window`.
 *
 * The shape of this file follows the three contracts that matter:
 *
 * - **§7.2 one `state`.** `projectId`, `status`, `timeline`, `job`, `assets`, `refs` — the single
 *   source of truth the state machine of §1 drives. Every button's enabled/disabled state is
 *   *derived* from `status` by `syncUi()` rather than set ad hoc at each call site, so there is
 *   exactly one place where "can I press this" is decided.
 * - **§6 JSON shapes.** What the server sends is what the panels read: `ValidationResult`,
 *   `TimelineReport`, `AssetInfo`, `RenderJob`, and the SSE `progress` / `done` / `error` events.
 * - **§7 "no alert".** Every rejected `fetch` lands in the ⑤ console in red and sets
 *   `status = 'error'`. `code: 'MODEL_UNSET'` (501) is the one special case: the server is fine, the
 *   *studio* is not configured for that capability, so it says which model is missing.
 *
 * Two behaviours worth knowing before editing:
 *
 * - **Frame loading is debounced and replaceable.** `scrub`'s `input` event only schedules a fetch
 *   120 ms later (§7.3). §7.2 says to cancel the unfinished previous request before setting a new
 *   `src` — either with an `AbortController` or by letting the browser drop it — and this file
 *   takes the second route, which needs no second network API: each request loads into a detached
 *   `Image` whose `onload` is ignored unless it still owns the newest token, so a slow earlier
 *   `/api/frame` can never paint over a newer frame. The `src` also carries a `t=` stamp, because
 *   a back/forward cache restore can replay an older PNG.
 * - **SSE has a snapshot fallback.** `EventSource` may fire `error` for two very different reasons:
 *   the server sent `event: error` (a render failure — payload in `event.data`), or the connection
 *   dropped. The two are told apart by whether `data` is a string; the second one is answered with
 *   `GET /api/render/<jobId>`, the §7.4 "断线用快照兜底".
 */

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // state (§7.2)
  // -------------------------------------------------------------------------

  /** The whole UI state. Nothing else is mutable state worth naming. */
  var state = {
    /** `null` until the server lazily creates one (§7.2 "项目引导"). */
    projectId: null,
    /** §1 state machine: idle | generating | validating | ready | error | rendering | rendered. */
    status: 'idle',
    /** The `TimelineReport` of the last successful validation, or `null`. */
    timeline: null,
    /** The last `RenderJob` snapshot (`GET /api/render/:jobId`), or `null`. */
    job: null,
    /** `AssetInfo[]` (§6) for the current project. */
    assets: [],
    /** `Set<string>` of asset names ticked as "reference material" for `/api/generate`. */
    refs: new Set(),
  };

  /** `/api/config` body (§5.8) — capability flags, never the key (§8.3). */
  var config = { hasKey: false, model: '', vision: false, image: false, imageSize: '1024x1024', mock: false, examples: [] };

  /** `EventSource` of the running render, or `null`. Closed on every terminal event. */
  var stream = null;
  /** `true` once the current job reached done/error, so a late connection error is ignored. */
  var jobFinished = false;
  /** Monotonic counter: only the newest frame request may paint (§7.3). */
  var frameToken = 0;
  /** Pending scrub timer id. */
  var scrubTimer = 0;

  // -------------------------------------------------------------------------
  // tiny DOM helpers
  // -------------------------------------------------------------------------

  function el(id) {
    return document.getElementById(id);
  }

  /** All ids the panels touch, resolved once. */
  var dom = {
    badgeModel: el('badge-model'),
    badgeMode: el('badge-mode'),
    badgeProject: el('badge-project'),
    badgeStatus: el('badge-status'),
    nl: el('nl'),
    generate: el('generate'),
    chips: el('chips'),
    refs: el('refs'),
    code: el('code'),
    validate: el('validate'),
    frame: el('frame'),
    frameEmpty: el('frame-empty'),
    scrub: el('scrub'),
    scrubOut: el('scrub-out'),
    scrubPrev: el('scrub-prev'),
    scrubNext: el('scrub-next'),
    spec: el('spec'),
    frameGo: el('frame-go'),
    timeline: el('timeline'),
    scenes: el('scenes'),
    validation: el('validation'),
    findings: el('findings'),
    upload: el('upload'),
    uploadHint: el('upload-hint'),
    assetPrompt: el('asset-prompt'),
    assetSize: el('asset-size'),
    assetGen: el('asset-gen'),
    assets: el('assets'),
    draft: el('draft'),
    range: el('range'),
    render: el('render'),
    bar: el('bar'),
    progress: el('progress'),
    player: el('player'),
    playerEmpty: el('player-empty'),
    log: el('log'),
    logClear: el('log-clear'),
  };

  // No text in this file is ever assigned through `innerHTML`: asset descriptions and validation
  // messages come from a model, and every panel below writes them with `textContent`.

  // -------------------------------------------------------------------------
  // ⑤ console
  // -------------------------------------------------------------------------

  /**
   * Appends one console line. `level` is `info` | `warn` | `error`; the level also becomes a CSS
   * class so red and yellow come from the stylesheet, not from inline styles (§7.2).
   */
  function log(level, text) {
    var stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    var line = document.createElement('span');
    line.className = 'line line-' + level;
    line.textContent = '[' + stamp + '] ' + text + '\n';
    dom.log.appendChild(line);
    dom.log.scrollTop = dom.log.scrollHeight;
  }

  function info(text) {
    log('info', text);
  }

  function warn(text) {
    log('warn', text);
  }

  function error(text) {
    log('error', text);
  }

  /**
   * The single failure funnel: red console line, `status = 'error'`, no `alert` (§7.2).
   *
   * `MODEL_UNSET` is the one specialised case — the 501 the server returns when `LLM_VISION_MODEL`
   * or `LLM_IMAGE_MODEL` is unset is not a bug, it is a missing configuration, and saying which
   * model is missing is more useful than echoing the English message.
   */
  function fail(err) {
    if (err && err.code === 'MODEL_UNSET') {
      error('未配置对应模型：' + (err.message || 'vision / image model not configured') +
        '（在 .env 里设置 LLM_VISION_MODEL / LLM_IMAGE_MODEL 后重启服务）');
    } else {
      error(err && err.message ? err.message : String(err));
    }
    setStatus('error');
    syncUi();
  }

  /** An `Error` that also carries the server's `{ error, code }` body (§5.8). */
  function ApiError(message, code) {
    this.name = 'ApiError';
    this.message = message;
    this.code = code;
  }
  ApiError.prototype = Object.create(Error.prototype);

  /**
   * `fetch` + JSON, with the server's error body turned into a thrown `ApiError`.
   *
   * Non-2xx answers are the normal way this API reports failure (502 upstream, 501 unset model,
   * 413 too large…), so they are parsed for `{ error, code }` rather than being swallowed. A
   * network-level failure (the studio server went away) has no body, so the status is used.
   */
  function api(path, options) {
    return fetch(path, options).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (body) {
          if (!response.ok) {
            throw new ApiError(body.error || ('HTTP ' + response.status + ' ' + path), body.code);
          }
          return body;
        });
    });
  }

  function postJson(path, payload) {
    return api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  // -------------------------------------------------------------------------
  // state machine + derived UI (§1, §7.2)
  // -------------------------------------------------------------------------

  /** The §1 state machine's states, spelled out so a typo is a missing array entry, not silence. */
  var STATUSES = ['idle', 'generating', 'validating', 'ready', 'error', 'rendering', 'rendered'];

  function setStatus(next) {
    if (STATUSES.indexOf(next) === -1) {
      error('internal: unknown status ' + next);
      return;
    }
    state.status = next;
    dom.badgeStatus.textContent = next;
    dom.badgeStatus.setAttribute('data-status', next);
  }

  /** True when the ③ preview (frame, scrub, spec) may be used (§7.3). */
  function previewReady() {
    return state.status === 'ready' || state.status === 'rendered';
  }

  /**
   * Enables and disables every control from `state` — the one place "can I press this" is decided.
   *
   * The rules, in the order the §1 diagram gives them:
   * - ① `[生成]`: needs something to generate from, and the studio is not already busy.
   * - ② `[校验并预览]`: needs code, and no generation/validation in flight.
   * - ③ frame + scrub + spec: `status ∈ {ready, rendered}` — off while rendering so a scrub does
   *   not fight ffmpeg for the CPU (§7.3).
   * - ④ `[渲染]`: follows a validated video.
   * - ⑥ upload / asset gen: also gated by `/api/config`'s `vision` / `image` flags (§7.1), because
   *   the server answers 501 for a capability it was not configured with.
   */
  function syncUi() {
    var busy = state.status === 'generating' || state.status === 'validating';
    var rendering = state.status === 'rendering';

    dom.generate.disabled = busy || rendering || dom.nl.value.trim() === '';
    dom.validate.disabled = busy || rendering || dom.code.value.trim() === '';
    dom.frameGo.disabled = !previewReady();
    dom.spec.disabled = !previewReady();
    dom.scrub.disabled = !previewReady();
    dom.scrubPrev.disabled = !previewReady();
    dom.scrubNext.disabled = !previewReady();
    dom.render.disabled = !previewReady();
    dom.badgeProject.textContent = state.projectId === null ? '未创建项目' : state.projectId;

    var hasProject = state.projectId !== null;
    // §7.2: a missing vision model must not block *入库*. Upload stays clickable (only a render in
    // progress blocks it); the capability merely decides the `understand` flag on the request and the
    // hint below — matching the drag-drop path, which also warns-and-continues rather than refusing.
    dom.upload.disabled = rendering;
    dom.uploadHint.textContent = config.vision
      ? 'png · jpg · gif，上传后由视觉模型描述'
      : '未配置视觉模型（LLM_VISION_MODEL）：只能上传入库，不会被理解';
    dom.assetGen.disabled = !config.image || rendering;
    dom.assetPrompt.disabled = !config.image;
    dom.assetSize.disabled = !config.image;
    var cardButtons = dom.assets.querySelectorAll('button');
    for (var i = 0; i < cardButtons.length; i += 1) {
      cardButtons[i].disabled = rendering || !hasProject;
    }
  }

  // -------------------------------------------------------------------------
  // ③ readouts: timeline / scenes / validation / findings
  // -------------------------------------------------------------------------

  /** Renders the `TimelineReport` (§6) into the read-only box. */
  function renderTimeline() {
    var t = state.timeline;
    if (t === null) {
      dom.timeline.textContent = '—';
      return;
    }
    var lines = [
      t.width + 'x' + t.height + ' @' + t.fps + 'fps',
      t.durationSeconds.toFixed(2) + 's',
      t.durationFrames + ' 帧',
      '音频轨道 ' + (t.audio && t.audio.tracks ? t.audio.tracks.length : 0) +
        ' @' + (t.audio ? t.audio.sampleRate : 0) + 'Hz',
    ];
    dom.timeline.textContent = lines.join('\n');
    dom.scrub.max = String(Math.max(0, t.durationFrames - 1));
    dom.scrub.value = String(Math.min(Number(dom.scrub.value), t.durationFrames - 1));
  }

  /** Renders `timeline.scenes[]` — the `defineScenes()` of the generated `video.ts`. */
  function renderScenes() {
    var t = state.timeline;
    if (t === null || !t.scenes || t.scenes.length === 0) {
      dom.scenes.textContent = '（无场景，单场景视频）';
      return;
    }
    dom.scenes.textContent = t.scenes
      .map(function (scene) {
        return (
          '#' + scene.index + ' ' + scene.fullName + ' ' +
          scene.startFrame + '..' + scene.endFrame +
          ' (' + scene.startSeconds.toFixed(2) + 's..' + scene.endSeconds.toFixed(2) + 's)'
        );
      })
      .join('\n');
  }

  /** Renders the `ValidationResult` (§6) and the findings list (§5.6). */
  function renderValidation(validation) {
    if (validation === undefined || validation === null) {
      dom.validation.textContent = '—';
      return;
    }
    var lines = [];
    if (validation.ok) {
      lines.push('✓ 校验通过（stage=' + validation.stage + '）');
      if (validation.probeFramePngBytes > 0) {
        lines.push('✓ 首帧非空 ' + validation.probeFramePngBytes + ' 字节');
      }
    } else {
      lines.push('✗ 校验失败（stage=' + validation.stage + '）');
      lines.push(validation.error === null || validation.error === undefined ? '（无错误信息）' : String(validation.error));
    }
    if (validation.timeline) {
      lines.push('✓ 时长/场景已解析');
    }
    dom.validation.textContent = lines.join('\n');

    var findings = validation.findings || [];
    dom.findings.textContent = '';
    if (findings.length === 0) {
      var none = document.createElement('li');
      none.className = 'muted';
      none.textContent = '✓ 无缺失字体/媒体';
      dom.findings.appendChild(none);
      return;
    }
    findings.forEach(function (finding) {
      var item = document.createElement('li');
      item.className = 'finding finding-' + finding.severity;
      item.textContent =
        '[' + finding.severity + '] ' + (finding.kind || '-') +
        (finding.count === undefined ? '' : ' ×' + finding.count) +
        ' frame ' + finding.frame + '：' + finding.message;
      dom.findings.appendChild(item);
    });
  }

  /**
   * Applies a `ValidationResult` to the whole ③ panel and drives the state machine (§7.2).
   *
   * `ok` → `ready` (and the caller asks for the first frame); not `ok` → `error` with `stage`,
   * `error` and every finding printed, because "it did not work" without a stage is useless.
   */
  function applyValidation(validation) {
    renderValidation(validation);
    if (validation.timeline) {
      state.timeline = validation.timeline;
      renderTimeline();
      renderScenes();
    } else {
      state.timeline = null;
      dom.scrub.max = '0';
      dom.scrub.value = '0';
      renderTimeline();
      renderScenes();
    }
    if (validation.ok) {
      setStatus('ready');
      info('校验通过：' + validation.probeFramePngBytes + ' 字节的首帧探针');
    } else {
      setStatus('error');
      error('校验失败于 stage=' + validation.stage + '：' + (validation.error || '（无错误信息）'));
      (validation.findings || []).forEach(function (finding) {
        warn('finding [' + finding.severity + '] ' + finding.kind + '：' + finding.message);
      });
    }
    syncUi();
    return validation.ok;
  }

  // -------------------------------------------------------------------------
  // ③ frame scrubbing (§7.3)
  // -------------------------------------------------------------------------

  /** `/api/frame` takes a `spec`; a bare integer is frame `n` (§7.3 "帧号 → spec"). */
  function frameUrl(spec) {
    return (
      '/api/frame?projectId=' + encodeURIComponent(state.projectId) +
      '&spec=' + encodeURIComponent(String(spec)) +
      '&t=' + Date.now()
    );
  }

  /**
   * Loads one frame. A token keeps a slow earlier request from painting over a newer one — the
   * browser would happily decode and swap in an out-of-order PNG.
   */
  function loadFrame(spec) {
    if (!previewReady()) {
      return;
    }
    var specText = String(spec).trim() === '' ? '0' : String(spec).trim();
    frameToken += 1;
    var mine = frameToken;
    var image = new Image();
    image.onload = function () {
      if (mine !== frameToken) {
        return;
      }
      dom.frame.src = image.src;
      dom.frameEmpty.hidden = true;
    };
    image.onerror = function () {
      if (mine !== frameToken) {
        return;
      }
      dom.frame.removeAttribute('src');
      dom.frameEmpty.hidden = false;
      error('取帧失败：spec=' + specText + '（空帧、或该 spec 解析不到）');
    };
    image.src = frameUrl(specText);
  }

  /** The scrub bar's `input` handler: debounce 120ms, then fetch that frame (§7.3). */
  function onScrub() {
    var frame = dom.scrub.value;
    dom.scrubOut.textContent = frame;
    window.clearTimeout(scrubTimer);
    scrubTimer = window.setTimeout(function () {
      loadFrame(frame);
    }, 120);
  }

  /**
   * The ±1 buttons beside the scrub bar: move the slider by `delta` frames (clamped to [0, max])
   * and load that frame at once. A discrete click fetches immediately — no debounce — and cancels
   * any pending scrub fetch so a half-dragged frame cannot paint over the stepped one.
   */
  function stepFrame(delta) {
    if (!previewReady()) {
      return;
    }
    var max = Number(dom.scrub.max) || 0;
    var next = Math.min(max, Math.max(0, (Number(dom.scrub.value) || 0) + delta));
    dom.scrub.value = String(next);
    dom.scrubOut.textContent = dom.scrub.value;
    window.clearTimeout(scrubTimer);
    loadFrame(next);
  }

  // -------------------------------------------------------------------------
  // ① generation
  // -------------------------------------------------------------------------

  function onGenerate() {
    var prompt = dom.nl.value.trim();
    if (prompt === '') {
      warn('请先写一句自然语言');
      return;
    }
    var references = Array.from(state.refs);
    setStatus('generating');
    syncUi();
    info('生成中… 引用素材 ' + references.length + ' 个（references=[' + references.join(', ') + ']）');
    postJson('/api/generate', {
      prompt: prompt,
      projectId: state.projectId,
      references: references,
    })
      .then(function (body) {
        state.projectId = body.projectId;
        dom.code.value = body.source;
        info('已生成 ' + String(body.source).split('\n').length + ' 行，projectId=' + body.projectId);
        if (applyValidation(body.validation)) {
          loadFrame(0);
        }
      })
      .catch(fail);
  }

  function onValidate() {
    if (state.projectId === null) {
      fail(new ApiError('还没有项目：请先点「生成」'));
      return;
    }
    setStatus('validating');
    syncUi();
    info('校验并预览中…（重新导入 video.ts）');
    postJson('/api/validate', { projectId: state.projectId, source: dom.code.value })
      .then(function (body) {
        state.projectId = body.projectId === undefined ? state.projectId : body.projectId;
        if (applyValidation(body.validation)) {
          loadFrame(dom.spec.value.trim() === '' ? 0 : dom.spec.value.trim());
        }
      })
      .catch(fail);
  }

  // -------------------------------------------------------------------------
  // ⑥ asset library
  // -------------------------------------------------------------------------

  function assetThumbUrl(name) {
    return '/media/' + encodeURIComponent(state.projectId) + '/media/' + encodeURIComponent(name);
  }

  /** Re-reads `/api/assets` for the current project (§5.8). */
  function refreshAssets() {
    if (state.projectId === null) {
      state.assets = [];
      renderAssets();
      return Promise.resolve();
    }
    return api('/api/assets?projectId=' + encodeURIComponent(state.projectId))
      .then(function (body) {
        state.assets = body.assets || [];
        // A reference to an asset that no longer exists is not a reference any more — a stale
        // name would be sent as `references` and silently dropped by `getAssetRefs` (§5.4).
        var present = new Set(
          state.assets.map(function (asset) {
            return asset.name;
          }),
        );
        Array.from(state.refs).forEach(function (name) {
          if (!present.has(name)) {
            state.refs.delete(name);
          }
        });
        renderAssets();
        renderRefs();
      })
      .catch(function (err) {
        warn('素材清单读取失败：' + err.message);
      });
  }

  /** The ① reference checkboxes, driven by `state.refs` (§7.1). */
  function renderRefs() {
    dom.refs.textContent = '';
    if (state.assets.length === 0) {
      var none = document.createElement('span');
      none.className = 'muted';
      none.textContent = '（还没有素材，先在 ⑥ 生成或上传）';
      dom.refs.appendChild(none);
      return;
    }
    state.assets.forEach(function (asset) {
      var label = document.createElement('label');
      label.className = 'ref';
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state.refs.has(asset.name);
      box.addEventListener('change', function () {
        if (box.checked) {
          state.refs.add(asset.name);
        } else {
          state.refs.delete(asset.name);
        }
        info((box.checked ? '加入参考：' : '移出参考：') + asset.name + '（共 ' + state.refs.size + ' 个）');
        renderAssetGridStates();
      });
      label.appendChild(box);
      label.appendChild(document.createTextNode(' ' + asset.name));
      dom.refs.appendChild(label);
    });
  }

  /** Marks each grid card's `[用作参考]` button with the current tick state. */
  function renderAssetGridStates() {
    var buttons = dom.assets.querySelectorAll('button[data-ref]');
    for (var i = 0; i < buttons.length; i += 1) {
      var name = buttons[i].getAttribute('data-ref');
      buttons[i].setAttribute('aria-pressed', state.refs.has(name) ? 'true' : 'false');
    }
  }

  /** The ⑥ grid: one thumbnail, name, dimensions, source, description, `[删]` + `[用作参考]`. */
  function renderAssets() {
    dom.assets.textContent = '';
    if (state.projectId === null || state.assets.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = '素材网格为空。上传一张图，或描述一张让图片模型生成。';
      dom.assets.appendChild(empty);
      return;
    }
    state.assets.forEach(function (asset) {
      var card = document.createElement('div');
      card.className = 'asset';

      var thumb = document.createElement('img');
      thumb.className = 'asset-thumb';
      thumb.alt = asset.name;
      thumb.loading = 'lazy';
      thumb.src = assetThumbUrl(asset.name);
      card.appendChild(thumb);

      var name = document.createElement('div');
      name.className = 'asset-name mono';
      name.textContent = asset.name;
      card.appendChild(name);

      var meta = document.createElement('div');
      meta.className = 'asset-meta muted';
      var dims = asset.width === null || asset.height === null ? '尺寸未知' : asset.width + '×' + asset.height;
      meta.textContent = dims + ' · ' + Math.round(asset.bytes / 1024) + ' KB · ' +
        (asset.source === 'upload' ? '上传' : '生成');
      card.appendChild(meta);

      var description = document.createElement('div');
      description.className = 'asset-desc';
      description.textContent = asset.description === null ? '（无描述：没有视觉模型或理解失败）' : asset.description;
      card.appendChild(description);

      var actions = document.createElement('div');
      actions.className = 'asset-actions';

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'ghost danger';
      del.textContent = '删';
      del.addEventListener('click', function () {
        onDeleteAsset(asset.name);
      });
      actions.appendChild(del);

      var ref = document.createElement('button');
      ref.type = 'button';
      ref.className = 'ghost';
      ref.setAttribute('data-ref', asset.name);
      ref.setAttribute('aria-pressed', state.refs.has(asset.name) ? 'true' : 'false');
      ref.textContent = '用作参考';
      ref.addEventListener('click', function () {
        if (state.refs.has(asset.name)) {
          state.refs.delete(asset.name);
        } else {
          state.refs.add(asset.name);
        }
        renderRefs();
        renderAssetGridStates();
        info('参考素材：' + Array.from(state.refs).join(', '));
      });
      actions.appendChild(ref);

      card.appendChild(actions);
      dom.assets.appendChild(card);
    });
    syncUi();
  }

  /** `DELETE /api/assets/<name>` (§5.8). */
  function onDeleteAsset(name) {
    if (state.projectId === null) {
      return;
    }
    if (!window.confirm('删除素材 ' + name + ' ？（video.ts 里引用它的画面会走空帧兜底）')) {
      return;
    }
    api('/api/assets/' + encodeURIComponent(name) + '?projectId=' + encodeURIComponent(state.projectId), {
      method: 'DELETE',
    })
      .then(function () {
        state.refs.delete(name);
        info('已删除素材 ' + name);
        return refreshAssets();
      })
      .catch(fail);
  }

  /**
   * `POST /api/upload` — `FileReader.readAsDataURL` then the base64 half of the data URL (§7.2,
   * §5.8 "上传走 JSON base64 而非 multipart").
   *
   * The whole file is read in memory; the server enforces the real limit (§8.5) and answers 413,
   * which arrives here as an ordinary red console line.
   */
  function onUpload(file) {
    if (typeof FileReader === 'undefined') {
      fail(new ApiError('这个浏览器没有 FileReader'));
      return;
    }
    info('上传中… ' + file.name + '（' + Math.round(file.size / 1024) + ' KB）');
    var reader = new FileReader();
    reader.onerror = function () {
      fail(new ApiError('读取文件失败：' + file.name));
    };
    reader.onload = function () {
      var dataUrl = String(reader.result);
      var comma = dataUrl.indexOf(',');
      if (comma === -1) {
        fail(new ApiError('FileReader 没有返回 data URL'));
        return;
      }
      postJson('/api/upload', {
        projectId: state.projectId,
        name: file.name,
        dataBase64: dataUrl.slice(comma + 1),
        mime: file.type === '' ? guessMime(file.name) : file.type,
        // §7.2: an understanding that can not happen must not block the upload. The server answers
        // 501 to `understand: true` without a vision model (§5.8), so when the capability is off the
        // asset is stored with a null description instead of the whole upload failing.
        understand: config.vision === true,
      })
        .then(function (body) {
          state.projectId = body.projectId;
          info('已入库 ' + body.asset.name + '（' + body.asset.bytes + ' 字节）');
          if (body.warning) {
            warn('素材已入库，但理解失败：' + body.warning);
          }
          return refreshAssets();
        })
        .catch(fail);
    };
    reader.readAsDataURL(file);
  }

  /** Fallback mime from the extension; the server still checks the magic bytes (§8.5). */
  function guessMime(name) {
    var lower = String(name).toLowerCase();
    if (lower.slice(-4) === '.png') {
      return 'image/png';
    }
    if (lower.slice(-4) === '.gif') {
      return 'image/gif';
    }
    if (lower.slice(-4) === '.jpg' || lower.slice(-5) === '.jpeg') {
      return 'image/jpeg';
    }
    return 'application/octet-stream';
  }

  /** `POST /api/asset/gen` — a described asset out of `LLM_IMAGE_MODEL` (§5.3 ③). */
  function onAssetGen() {
    var prompt = dom.assetPrompt.value.trim();
    if (prompt === '') {
      warn('先描述这张素材');
      return;
    }
    dom.assetGen.disabled = true;
    dom.assetGen.textContent = '生成中…';
    info('生成素材中… ' + prompt + '（' + dom.assetSize.value + '）');
    postJson('/api/asset/gen', {
      projectId: state.projectId,
      prompt: prompt,
      size: dom.assetSize.value,
    })
      .then(function (body) {
        state.projectId = body.projectId;
        info('已出图 ' + body.asset.name + '（' + body.asset.width + '×' + body.asset.height + '）');
        dom.assetPrompt.value = '';
        return refreshAssets();
      })
      .catch(fail)
      .then(function () {
        dom.assetGen.textContent = '生成';
        syncUi();
      });
  }

  // -------------------------------------------------------------------------
  // ④ render + SSE (§7.4)
  // -------------------------------------------------------------------------

  /** `POST /api/render` → 202 `{ jobId }`, then follow it over SSE. */
  function onRender() {
    if (state.projectId === null) {
      fail(new ApiError('还没有项目：请先点「生成」'));
      return;
    }
    var range = dom.range.value.trim();
    setStatus('rendering');
    syncUi();
    dom.bar.style.width = '0%';
    dom.progress.textContent = '已入队…';
    info('渲染中… ' + (dom.draft.checked ? '草稿' : '全质量') + (range === '' ? ' 全片' : ' 范围 ' + range));
    postJson('/api/render', {
      projectId: state.projectId,
      draft: dom.draft.checked,
      range: range === '' ? undefined : range,
    })
      .then(function (body) {
        info('jobId=' + body.jobId + '，订阅 SSE');
        followJob(body.jobId);
      })
      .catch(fail);
  }

  /** Opens the stream for `jobId` after closing any previous one (§7.4). */
  function followJob(jobId) {
    closeStream();
    jobFinished = false;
    state.job = { id: jobId, status: 'queued', progress: { done: 0, total: 0 } };

    var es = new EventSource('/api/render/' + encodeURIComponent(jobId) + '/stream');
    stream = es;

    es.addEventListener('progress', function (event) {
      onProgress(parseEvent(event, 'progress'));
    });

    es.addEventListener('done', function (event) {
      onDone(parseEvent(event, 'done'));
    });

    es.addEventListener('error', function (event) {
      // Two meanings, told apart by whether the server sent a payload (§7.4 fallback).
      if (typeof event.data === 'string' && event.data !== '') {
        var payload = parseEvent(event, 'error');
        onJobError(payload === null ? String(event.data).slice(0, 200) : payload.message || '渲染失败');
        return;
      }
      if (jobFinished) {
        // The server ends the stream after a terminal event; that is not a failure.
        closeStream();
        return;
      }
      warn('SSE 断开，改用 GET /api/render/' + jobId + ' 快照兜底');
      closeStream();
      snapshotJob(jobId);
    });
  }

  /**
   * An SSE `data:` payload as an object; `null` when it is not JSON, so a malformed frame is one
   * red console line rather than an exception thrown inside a listener (which nothing would catch).
   */
  function parseEvent(event, kind) {
    try {
      var parsed = JSON.parse(event.data);
      return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch (err) {
      error('SSE ' + kind + ' 事件不是 JSON：' + String(event.data).slice(0, 120));
      return null;
    }
  }

  /** `progress` event → the bar (§6 `{done,total}`). */
  function onProgress(progress) {
    if (progress === null) {
      return;
    }
    var total = progress.total || 0;
    var done = progress.done || 0;
    var ratio = total > 0 ? done / total : 0;
    dom.bar.style.width = Math.round(ratio * 100) + '%';
    dom.progress.textContent = done + '/' + total + ' 帧（' + Math.round(ratio * 100) + '%）';
  }

  /** `done` event → play the mp4 (§7.4). */
  function onDone(payload) {
    if (payload === null) {
      // The frame parsed as nothing usable; `parseEvent` already logged it. Do not leave the ④
      // panel claiming to be rendering forever.
      onJobError('done 事件无法解析');
      return;
    }
    closeStream();
    jobFinished = true;
    var report = payload.report || {};
    state.job = { id: state.job === null ? '' : state.job.id, status: 'done', progress: state.job.progress, outputUrl: payload.outputUrl };
    setStatus('rendered');
    dom.bar.style.width = '100%';
    // `report` is optional in the `done` payload (§6) — a snapshot taken before the report landed
    // has none, so every field is printed only when it is there rather than as `undefined`.
    var facts = [];
    if (report.width !== undefined && report.height !== undefined) {
      facts.push(report.width + 'x' + report.height);
    }
    if (report.seconds !== undefined) {
      facts.push(report.seconds + 's');
    }
    if (report.elapsedSeconds !== undefined) {
      facts.push('用时 ' + Number(report.elapsedSeconds).toFixed(1) + 's');
    }
    dom.progress.textContent = facts.length === 0 ? '完成' : '完成 · ' + facts.join(' · ');
    info('渲染完成：' + payload.outputUrl);
    dom.player.src = payload.outputUrl;
    dom.playerEmpty.hidden = true;
    var playing = dom.player.play();
    if (playing && typeof playing.catch === 'function') {
      // Autoplay can be refused by the browser; the user can still press play.
      playing.catch(function () {
        warn('浏览器拒绝了自动播放，点 ▶ 手动播放');
      });
    }
    syncUi();
  }

  /** `error` event → red console line, `status = 'error'`. */
  function onJobError(message) {
    closeStream();
    jobFinished = true;
    if (state.job !== null) {
      state.job = { id: state.job.id, status: 'error', progress: state.job.progress, error: message };
    }
    dom.progress.textContent = '渲染失败';
    error('渲染失败：' + message);
    setStatus('error');
    syncUi();
  }

  /**
   * `GET /api/render/<jobId>` — the §7.4 fallback for a dropped stream, and it also covers the case
   * where the job finished while we were not listening.
   */
  function snapshotJob(jobId) {
    api('/api/render/' + encodeURIComponent(jobId))
      .then(function (job) {
        state.job = job;
        if (job.progress) {
          onProgress(job.progress);
        }
        if (job.status === 'done') {
          onDone({ report: job.report || {}, outputUrl: job.outputUrl || '' });
        } else if (job.status === 'error') {
          onJobError(job.error || '渲染失败');
        } else {
          warn('job ' + jobId + ' 仍在 ' + job.status + '，可再次点击「渲染」查看进度');
          setStatus('ready');
          syncUi();
        }
      })
      .catch(function (err) {
        onJobError('无法读取任务快照：' + err.message);
      });
  }

  function closeStream() {
    if (stream !== null) {
      stream.close();
      stream = null;
    }
  }

  // -------------------------------------------------------------------------
  // boot: /api/config → chips + capability gating (§7.1)
  // -------------------------------------------------------------------------

  function renderChips(examples) {
    dom.chips.textContent = '';
    if (!Array.isArray(examples) || examples.length === 0) {
      var none = document.createElement('span');
      none.className = 'muted';
      none.textContent = '（服务端没有提供示例）';
      dom.chips.appendChild(none);
      return;
    }
    examples.forEach(function (example) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = example.name;
      chip.title = example.prompt;
      chip.addEventListener('click', function () {
        dom.nl.value = example.prompt;
        syncUi();
        info('已填入示例：' + example.name);
      });
      dom.chips.appendChild(chip);
    });
  }

  function boot() {
    info('fframes-node Studio 就绪，正在读取 /api/config…');
    api('/api/config')
      .then(function (body) {
        config = body;
        renderChips(body.examples);
        if (body.imageSize) {
          dom.assetSize.value = body.imageSize;
        }
        dom.badgeModel.textContent = '代码模型 ' + body.model + (body.hasKey ? '' : '（未设 LLM_API_KEY）');
        dom.badgeMode.textContent = body.mock ? 'mock fixture 模式' : '';
        if (body.mock) {
          warn('LLM mock 模式：不发真实请求');
        }
        if (!body.vision) {
          warn('未配置视觉模型（LLM_VISION_MODEL）：⑥ 上传只能入库，不会被理解');
        }
        if (!body.image) {
          warn('未配置图片模型（LLM_IMAGE_MODEL）：⑥「生成素材」已禁用');
        }
        if (!body.hasKey) {
          warn('未设 LLM_API_KEY：「生成」会失败');
        }
        syncUi();
      })
      .catch(fail);

    dom.generate.addEventListener('click', onGenerate);
    dom.validate.addEventListener('click', onValidate);
    dom.frameGo.addEventListener('click', function () {
      loadFrame(dom.spec.value);
    });
    dom.scrub.addEventListener('input', onScrub);
    dom.scrubPrev.addEventListener('click', function () {
      stepFrame(-1);
    });
    dom.scrubNext.addEventListener('click', function () {
      stepFrame(1);
    });
    dom.spec.addEventListener('change', function () {
      var spec = dom.spec.value.trim();
      if (spec === '') {
        return;
      }
      loadFrame(spec);
      // A spec like `50%` or `Intro@1.2s` moves the slider too, when the report lets us.
      if (/^\d+$/.test(spec) && state.timeline) {
        dom.scrub.value = String(Math.min(Number(spec), state.timeline.durationFrames - 1));
        dom.scrubOut.textContent = dom.scrub.value;
      }
    });
    dom.nl.addEventListener('input', syncUi);
    dom.code.addEventListener('input', syncUi);
    dom.nl.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (!dom.generate.disabled) {
          onGenerate();
        }
      }
    });
    dom.upload.addEventListener('change', function () {
      var files = dom.upload.files;
      if (!files || files.length === 0) {
        return;
      }
      // `readAsDataURL` is async, so the same input can carry several files; re-read them one by
      // one instead of touching the DOM inside the loop.
      var pending = Array.prototype.slice.call(files);
      dom.upload.value = '';
      (function next() {
        if (pending.length === 0) {
          return;
        }
        var file = pending.shift();
        onUpload(file);
        window.setTimeout(next, 50);
      })();
    });
    dom.assetGen.addEventListener('click', onAssetGen);
    dom.render.addEventListener('click', onRender);
    dom.logClear.addEventListener('click', function () {
      dom.log.textContent = '';
    });

    // Drag and drop onto the whole asset panel (§7.1 "拖拽区").
    var panel = document.querySelector('.panel-assets');
    if (panel) {
      panel.addEventListener('dragover', function (event) {
        event.preventDefault();
        panel.classList.add('dragging');
      });
      panel.addEventListener('dragleave', function () {
        panel.classList.remove('dragging');
      });
      panel.addEventListener('drop', function (event) {
        event.preventDefault();
        panel.classList.remove('dragging');
        if (!config.vision) {
          warn('未配置视觉模型：只能上传入库，不会被理解');
        }
        var dropped = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files : [];
        Array.prototype.slice.call(dropped).forEach(onUpload);
      });
    }

    setStatus('idle');
    renderTimeline();
    renderScenes();
    renderValidation(null);
    renderRefs();
    renderAssets();
    syncUi();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
