(function () {
  'use strict';

  var DEFAULT_LINK = 'offisielle-dokumenter';
  var MAX_FALLBACK = 50 * 1024 * 1024;
  var LOCAL_HOSTS = ['', 'localhost', '127.0.0.1', '::1'];
  var STATUS_LABELS = {
    waiting: 'Klar',
    signing: 'Klargjør',
    uploading: 'Laster opp',
    confirming: 'Bekrefter',
    success: 'Mottatt',
    error: 'Feil'
  };

  var state = {
    enabled: false,
    previewMode: false,
    uploading: false,
    maxFileSize: MAX_FALLBACK,
    allowedExtensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'png', 'jpg', 'jpeg', 'heic', 'zip'],
    files: []
  };

  var els = {
    form: document.getElementById('upload-form'),
    drop: document.getElementById('drop-zone'),
    input: document.getElementById('file-input'),
    uploadButton: document.getElementById('upload-button'),
    clearButton: document.getElementById('clear-button'),
    message: document.getElementById('status-message'),
    fileList: document.getElementById('file-list'),
    empty: document.getElementById('empty-state'),
    count: document.getElementById('file-count'),
    linkState: document.getElementById('link-state'),
    linkLabel: document.getElementById('link-label'),
    maxSize: document.getElementById('max-size'),
    company: document.getElementById('sender-company'),
    name: document.getElementById('sender-name'),
    email: document.getElementById('sender-email'),
    reference: document.getElementById('sender-reference')
  };

  var linkKey = getLinkKey();

  init();

  function init() {
    els.maxSize.textContent = formatBytes(state.maxFileSize);
    wireEvents();
    checkStatus();
  }

  function wireEvents() {
    els.input.addEventListener('change', function () {
      addFiles(Array.prototype.slice.call(els.input.files || []));
      els.input.value = '';
    });

    ['dragenter', 'dragover'].forEach(function (eventName) {
      els.drop.addEventListener(eventName, function (event) {
        event.preventDefault();
        if (!state.enabled) return;
        els.drop.classList.add('is-dragging');
      });
    });

    ['dragleave', 'drop'].forEach(function (eventName) {
      els.drop.addEventListener(eventName, function () {
        els.drop.classList.remove('is-dragging');
      });
    });

    els.drop.addEventListener('drop', function (event) {
      event.preventDefault();
      if (!state.enabled) return;
      addFiles(Array.prototype.slice.call(event.dataTransfer.files || []));
    });

    els.form.addEventListener('submit', function (event) {
      event.preventDefault();
      uploadPendingFiles();
    });

    els.clearButton.addEventListener('click', function () {
      if (state.uploading) return;
      state.files = [];
      setMessage('');
      render();
    });

    [els.company, els.name, els.email, els.reference].forEach(function (input) {
      input.addEventListener('input', updateControls);
    });
  }

  function getLinkKey() {
    var params = new URLSearchParams(window.location.search);
    var raw = (params.get('link') || DEFAULT_LINK).trim();
    return /^[a-zA-Z0-9_-]{1,80}$/.test(raw) ? raw : DEFAULT_LINK;
  }

  function checkStatus() {
    setLinkState('checking', 'Kontrollerer mottak');

    fetch('/api/document-intake-status?link=' + encodeURIComponent(linkKey), {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    }).then(parseJson).then(function (data) {
      state.enabled = !!data.enabled;
      state.previewMode = false;
      state.maxFileSize = data.maxFileSize || state.maxFileSize;
      state.allowedExtensions = data.allowedExtensions || state.allowedExtensions;
      els.maxSize.textContent = formatBytes(state.maxFileSize);
      els.linkLabel.textContent = data.label || els.linkLabel.textContent;

      if (state.enabled) {
        setLinkState('open', 'Mottaket er åpent');
        setMessage('Velg dokumentene som skal sendes til Netkem.', 'success');
      } else {
        setLinkState('closed', 'Mottaket er stengt');
        setMessage('Netkem har stengt denne lenken midlertidig.', 'error');
      }
      render();
    }).catch(function () {
      if (isLocalPreview()) {
        state.enabled = true;
        state.previewMode = true;
        setLinkState('preview', 'Lokal forhåndsvisning');
        setMessage('Forhåndsvisning uten API. Opplasting virker først etter deploy.', '');
        render();
        return;
      }
      state.enabled = false;
      setLinkState('error', 'Kunne ikke kontrollere mottak');
      setMessage('Mottaket kunne ikke kontrolleres akkurat nå. Prøv igjen senere.', 'error');
      render();
    });
  }

  function addFiles(files) {
    if (!state.enabled) {
      setMessage('Mottaket er stengt.', 'error');
      return;
    }

    var added = 0;
    files.forEach(function (file) {
      var duplicate = state.files.some(function (item) {
        return item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified;
      });
      if (duplicate) return;

      var validation = validateFile(file);
      state.files.push({
        id: Math.random().toString(36).slice(2),
        file: file,
        status: validation.ok ? 'waiting' : 'error',
        progress: 0,
        error: validation.ok ? '' : validation.message
      });
      added += 1;
    });

    if (added) setMessage(added + ' fil' + (added === 1 ? '' : 'er') + ' lagt til.');
    render();
  }

  function validateFile(file) {
    if (!file || !file.name) return { ok: false, message: 'Ugyldig fil.' };
    if (file.size < 1) return { ok: false, message: 'Filen er tom.' };
    if (file.size > state.maxFileSize) return { ok: false, message: 'Filen er større enn ' + formatBytes(state.maxFileSize) + '.' };

    var ext = extensionOf(file.name);
    if (state.allowedExtensions.indexOf(ext) === -1) {
      return { ok: false, message: 'Filtypen støttes ikke.' };
    }
    return { ok: true };
  }

  function uploadPendingFiles() {
    if (state.uploading) return;
    if (!state.enabled) {
      setMessage('Mottaket er stengt.', 'error');
      return;
    }
    if (state.previewMode) {
      setMessage('Dette er lokal forhåndsvisning. API og AWS må være konfigurert før opplasting.', 'error');
      return;
    }
    if (!state.files.length) {
      setMessage('Velg minst én fil først.', 'error');
      return;
    }
    if (!validateSender()) return;

    var queue = state.files.filter(function (item) {
      return item.status === 'waiting' || item.status === 'error';
    }).filter(function (item) {
      var validation = validateFile(item.file);
      item.error = validation.ok ? '' : validation.message;
      item.status = validation.ok ? 'waiting' : 'error';
      return validation.ok;
    });

    if (!queue.length) {
      setMessage('Ingen filer er klare for opplasting.', 'error');
      render();
      return;
    }

    state.uploading = true;
    setMessage('Laster opp ' + queue.length + ' fil' + (queue.length === 1 ? '' : 'er') + ' ...');
    render();

    runSequential(queue).then(function () {
      state.uploading = false;
      var failed = state.files.filter(function (item) { return item.status === 'error'; }).length;
      var missingNotice = state.files.some(function (item) {
        return item.status === 'success' && item.notificationSent === false;
      });
      if (failed) {
        setMessage('Noen filer kunne ikke lastes opp. Se listen for detaljer.', 'error');
      } else if (missingNotice) {
        setMessage('Filer mottatt. Varsel kunne ikke bekreftes fra serveren.', 'success');
      } else {
        setMessage('Ferdig. Netkem har fått beskjed om opplastingen.', 'success');
      }
      render();
    });
  }

  function runSequential(queue) {
    return queue.reduce(function (promise, item) {
      return promise.then(function () { return uploadOne(item); });
    }, Promise.resolve());
  }

  function uploadOne(item) {
    item.status = 'signing';
    item.progress = 0;
    item.error = '';
    render();

    var sender = collectSender();
    var payload = {
      linkKey: linkKey,
      fileName: item.file.name,
      fileSize: item.file.size,
      fileType: item.file.type || 'application/octet-stream',
      sender: sender
    };

    return fetch('/api/document-upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    }).then(parseJson).then(function (data) {
      item.status = 'uploading';
      render();
      return uploadToS3(data.uploadUrl, data.fields, item.file, function (progress) {
        item.progress = progress;
        render();
      }).then(function () {
        item.status = 'confirming';
        item.progress = 100;
        render();
        return completeUpload(data, item.file, sender).then(function (result) {
          item.notificationSent = result.notificationSent !== false;
        });
      });
    }).then(function () {
      item.status = 'success';
      item.progress = 100;
      render();
    }).catch(function (error) {
      item.status = 'error';
      item.error = friendlyError(error);
      render();
    });
  }

  function uploadToS3(url, fields, file, onProgress) {
    return new Promise(function (resolve, reject) {
      var form = new FormData();
      Object.keys(fields || {}).forEach(function (key) {
        form.append(key, fields[key]);
      });
      form.append('file', file);

      var xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.upload.onprogress = function (event) {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error('s3_upload_failed'));
      };
      xhr.onerror = function () { reject(new Error('network_error')); };
      xhr.send(form);
    });
  }

  function completeUpload(uploadData, file, sender) {
    return fetch('/api/document-upload-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        linkKey: linkKey,
        uploadId: uploadData.uploadId,
        objectKey: uploadData.objectKey,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || 'application/octet-stream',
        sender: sender
      })
    }).then(parseJson);
  }

  function collectSender() {
    return {
      company: els.company.value.trim(),
      name: els.name.value.trim(),
      email: els.email.value.trim(),
      reference: els.reference.value.trim()
    };
  }

  function validateSender() {
    var sender = collectSender();
    if (!sender.company) {
      setMessage('Fyll inn firma før opplasting.', 'error');
      els.company.focus();
      return false;
    }
    if (!sender.name) {
      setMessage('Fyll inn kontaktperson før opplasting.', 'error');
      els.name.focus();
      return false;
    }
    if (sender.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender.email)) {
      setMessage('E-postadressen ser ikke gyldig ut.', 'error');
      els.email.focus();
      return false;
    }
    return true;
  }

  function render() {
    els.fileList.innerHTML = '';
    els.empty.hidden = state.files.length > 0;
    els.count.textContent = String(state.files.length);

    state.files.forEach(function (item) {
      var li = document.createElement('li');
      li.className = 'file-item';
      li.dataset.status = item.status;

      var body = document.createElement('div');
      var name = document.createElement('span');
      name.className = 'file-item__name';
      name.textContent = item.file.name;
      body.appendChild(name);

      var meta = document.createElement('span');
      meta.className = 'file-item__meta';
      meta.textContent = formatBytes(item.file.size) + (item.error ? ' - ' + item.error : '');
      body.appendChild(meta);

      var status = document.createElement('span');
      status.className = 'file-item__status';
      status.textContent = STATUS_LABELS[item.status] || item.status;

      li.appendChild(body);
      li.appendChild(status);

      if (item.status === 'uploading' || item.status === 'confirming') {
        var progress = document.createElement('progress');
        progress.max = 100;
        progress.value = item.status === 'confirming' ? 100 : item.progress;
        li.appendChild(progress);
      }

      els.fileList.appendChild(li);
    });

    updateControls();
  }

  function updateControls() {
    var hasReadyFiles = state.files.some(function (item) {
      return item.status === 'waiting' || item.status === 'error';
    });
    var disabled = !state.enabled || state.uploading;
    els.input.disabled = disabled;
    els.uploadButton.disabled = disabled || !hasReadyFiles;
    els.clearButton.disabled = state.uploading || !state.files.length;
    els.drop.classList.toggle('is-disabled', disabled);
  }

  function setLinkState(type, text) {
    els.linkState.dataset.state = type;
    els.linkState.textContent = text;
  }

  function setMessage(text, type) {
    els.message.textContent = text || '';
    if (type) els.message.dataset.state = type;
    else els.message.removeAttribute('data-state');
  }

  function parseJson(response) {
    return response.json().catch(function () {
      return {};
    }).then(function (body) {
      if (response.ok && body.ok !== false) return body;
      var error = new Error(body.error || 'request_failed');
      error.code = body.error;
      throw error;
    });
  }

  function friendlyError(error) {
    var code = error && (error.code || error.message);
    if (code === 'intake_closed') return 'Mottaket ble stengt.';
    if (code === 'file_too_large') return 'Filen er for stor.';
    if (code === 'file_type_not_allowed') return 'Filtypen støttes ikke.';
    if (code === 'server_misconfigured') return 'Mottaket er ikke ferdig konfigurert.';
    if (code === 'upload_not_found') return 'Filen ble ikke funnet i lagring.';
    if (code === 's3_upload_failed') return 'AWS avviste opplastingen.';
    if (code === 'network_error') return 'Nettverksfeil.';
    return 'Kunne ikke laste opp.';
  }

  function extensionOf(name) {
    var parts = String(name).toLowerCase().split('.');
    return parts.length > 1 ? parts.pop() : '';
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var size = bytes;
    var unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size = size / 1024;
      unit += 1;
    }
    return (unit === 0 ? size : size.toFixed(size >= 10 ? 0 : 1)) + ' ' + units[unit];
  }

  function isLocalPreview() {
    return window.location.protocol === 'file:' || LOCAL_HOSTS.indexOf(window.location.hostname) !== -1;
  }
})();
