const state = {
  bootstrap: null,
  contacts: null,
  page: 1,
  search: '',
  filter: 'all',
  city: '',
  tag: '',
  templateDirty: false,
  contactsRequestId: 0,
  refreshTimer: null,
  autoQrShown: false,
  currentAction: null,
  batchPreview: null,
  managedContact: null,
};

const elements = {};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  cacheElements();
  bindEvents();
  await refreshAll({ initial: true });
  connectRealtime();
  setInterval(() => refreshAll(), 30_000);
  setInterval(updateCountdown, 1_000);
}

function cacheElements() {
  const ids = [
    'connection-pill', 'connection-pill-label', 'connection-action', 'connection-dot', 'connection-title',
    'connection-message', 'account-label', 'connection-secondary', 'stat-total', 'stat-total-note',
    'stat-eligible', 'stat-review', 'stat-sent', 'stat-replies', 'queue-title', 'queue-status-badge',
    'queue-empty', 'queue-live', 'queue-progress-label', 'queue-next-time', 'queue-progress-track', 'queue-progress-bar',
    'queue-current', 'queue-counts', 'queue-alert', 'queue-empty-copy', 'start-queue', 'pause-queue', 'resume-queue',
    'cancel-queue', 'contact-search', 'contact-filter', 'city-filter', 'contacts-body',
    'pagination-label', 'page-label', 'previous-page', 'next-page', 'message-template', 'template-count',
    'message-preview', 'save-template', 'activity-list', 'qr-modal', 'qr-frame', 'action-modal',
    'action-form', 'action-modal-icon', 'action-modal-title', 'action-modal-copy', 'action-modal-content',
    'action-close', 'action-cancel', 'action-confirm', 'toast-region', 'policy-details', 'delete-filtered', 'tag-filter', 'show-imports', 'export-csv',
  ];
  for (const id of ids) elements[toCamel(id)] = document.getElementById(id);
}

function bindEvents() {
  elements.connectionAction.addEventListener('click', handleConnectionAction);
  elements.connectionSecondary.addEventListener('click', handleConnectionSecondary);
  elements.startQueue.addEventListener('click', openStartQueueModal);
  elements.pauseQueue.addEventListener('click', () => queueAction('/api/queue/pause', 'Fila pausada.'));
  elements.resumeQueue.addEventListener('click', () => queueAction('/api/queue/resume', 'Fila retomada.'));
  elements.cancelQueue.addEventListener('click', openCancelQueueModal);
  elements.saveTemplate.addEventListener('click', saveTemplate);
  elements.messageTemplate.addEventListener('input', () => {
    state.templateDirty = true;
    updateTemplatePreview();
    if (state.bootstrap) renderQueue(state.bootstrap.queue);
  });
  elements.contactSearch.addEventListener('input', debounce(() => {
    state.search = elements.contactSearch.value;
    state.page = 1;
    loadContacts().catch((error) => toast(error.message, 'error'));
  }, 280));
  elements.contactFilter.addEventListener('change', () => {
    state.filter = elements.contactFilter.value;
    state.page = 1;
    loadContacts().catch((error) => toast(error.message, 'error'));
  });
  elements.cityFilter.addEventListener('change', () => {
    state.city = elements.cityFilter.value;
    state.page = 1;
    loadContacts().catch((error) => toast(error.message, 'error'));
  });
  elements.previousPage.addEventListener('click', () => changePage(-1));
  elements.nextPage.addEventListener('click', () => changePage(1));
  elements.contactsBody.addEventListener('click', handleContactAction);
  elements.qrFrame.addEventListener('click', (event) => {
    if (event.target.closest('[data-qr-retry]')) retryQrConnection();
  });
  elements.policyDetails.addEventListener('click', openPolicyModal);
  elements.deleteFiltered.addEventListener('click', openDeleteFilteredModal);
  elements.showImports.addEventListener('click', openImportsModal);
  elements.tagFilter.addEventListener('change', () => {
    state.tag = elements.tagFilter.value;
    state.page = 1;
    loadContacts().catch((error) => toast(error.message, 'error'));
  });
  elements.actionClose.addEventListener('click', () => elements.actionModal.close('cancel'));
  elements.actionCancel.addEventListener('click', () => elements.actionModal.close('cancel'));
  elements.actionForm.addEventListener('submit', handleModalSubmit);
  elements.actionModalContent.addEventListener('click', handleRecipientAction);
  elements.actionModalContent.addEventListener('click', handleManageAction);
  elements.actionModalContent.addEventListener('click', handleImportAction);
  elements.actionModal.addEventListener('close', () => {
    state.currentAction = null;
    state.batchPreview = null;
    state.managedContact = null;
    elements.actionModalContent.replaceChildren();
  });
  window.addEventListener('beforeunload', (event) => {
    if (!state.templateDirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

async function refreshAll({ initial = false } = {}) {
  try {
    const [bootstrap] = await Promise.all([
      api('/api/bootstrap'),
      loadContacts({ silent: !initial }),
    ]);
    state.bootstrap = bootstrap;
    renderBootstrap({ initial });
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadContacts({ silent = false } = {}) {
  const requestId = ++state.contactsRequestId;
  if (!silent && !state.contacts) {
    elements.contactsBody.innerHTML = '<tr><td colspan="4"><div class="table-loading">Carregando contatos…</div></td></tr>';
  }
  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: '30',
    filter: state.filter,
  });
  if (state.search) params.set('search', state.search);
  if (state.city) params.set('city', state.city);
  if (state.tag) params.set('tag', state.tag);
  const contacts = await api(`/api/contacts?${params}`);
  if (requestId !== state.contactsRequestId) return state.contacts;
  state.contacts = contacts;
  renderContacts();
  return contacts;
}

function renderBootstrap({ initial = false } = {}) {
  const data = state.bootstrap;
  if (!data) return;
  renderConnection(data.whatsapp);
  renderSummary(data.summary, data.import);
  renderQueue(data.queue);
  renderEvents(data.events);
  renderCities(data.cities);
  renderTags(data.tags);
  elements.policyDetails.disabled = false;

  if (!state.templateDirty) {
    elements.messageTemplate.value = data.template;
    updateTemplatePreview();
  }

  if (data.whatsapp.status === 'qr_pending') {
    renderQrState(data.whatsapp);
    if (initial && !state.autoQrShown) {
      state.autoQrShown = true;
      showQrModal();
    }
  } else if (data.whatsapp.status === 'ready' && elements.qrModal.open) {
    elements.qrModal.close();
    toast('WhatsApp conectado.');
  } else if (elements.qrModal.open) {
    renderQrState(data.whatsapp);
  }
}

function renderSummary(summary, importInfo) {
  elements.statTotal.textContent = formatNumber(summary.total);
  const sourcePending = importInfo?.summary?.pending ?? summary.pending;
  elements.statTotalNote.textContent = `${formatNumber(sourcePending)} telefones pendentes`;
  elements.statEligible.textContent = formatNumber(summary.eligible);
  elements.statReview.textContent = formatNumber(summary.awaiting_review);
  elements.statSent.textContent = formatNumber(summary.sent);
  elements.statReplies.textContent = `${formatNumber(summary.replied)} resposta${summary.replied === 1 ? '' : 's'}`;
}

function renderConnection(whatsapp) {
  const meta = connectionMeta(whatsapp.status);
  elements.connectionPillLabel.textContent = meta.short;
  elements.connectionPill.className = `connection-pill ${meta.className}`;
  const pillDot = elements.connectionPill.querySelector('.status-dot');
  pillDot.className = `status-dot ${meta.dot}`;
  elements.connectionDot.className = `status-dot large ${meta.dot}`;
  elements.connectionTitle.textContent = meta.title;
  elements.connectionMessage.textContent = whatsapp.message || meta.message;
  elements.connectionAction.textContent = whatsapp.status === 'ready' ? 'Gerenciar conexão' : 'Conectar WhatsApp';
  elements.connectionAction.disabled = ['starting', 'authenticated'].includes(whatsapp.status);

  const accountText = whatsapp.account
    ? [whatsapp.account.name, whatsapp.account.phoneMasked].filter(Boolean).join(' · ')
    : '';
  elements.accountLabel.textContent = accountText;
  elements.accountLabel.classList.toggle('hidden', !accountText);

  if (whatsapp.status === 'ready') {
    elements.connectionSecondary.textContent = 'Desconectar deste computador';
    elements.connectionSecondary.dataset.mode = 'disconnect';
  } else if (whatsapp.status === 'qr_pending') {
    elements.connectionSecondary.textContent = 'Mostrar QR Code';
    elements.connectionSecondary.dataset.mode = 'qr';
  } else {
    elements.connectionSecondary.textContent = 'Tentar conectar novamente';
    elements.connectionSecondary.dataset.mode = 'reconnect';
  }
  elements.connectionSecondary.disabled = ['starting', 'authenticated'].includes(whatsapp.status);
}

function renderQueue(queue) {
  const active = ['running', 'paused'].includes(queue.status);
  const hasRun = Boolean(queue.runId);
  const label = {
    idle: 'Parada',
    running: 'Em andamento',
    paused: 'Pausada',
    completed: 'Concluída',
    canceled: 'Cancelada',
  }[queue.status] || queue.status;
  elements.queueStatusBadge.textContent = label;
  elements.queueStatusBadge.className = `queue-status-badge ${queue.status}`;
  elements.queueTitle.textContent = queue.status === 'running'
    ? 'Enviando o lote atual'
    : queue.status === 'paused'
      ? 'Lote pausado'
      : queue.status === 'completed'
        ? 'Lote concluído'
        : queue.status === 'canceled'
          ? 'Lote cancelado'
          : 'Nenhum lote em andamento';

  elements.queueEmpty.classList.toggle('hidden', hasRun);
  elements.queueLive.classList.toggle('hidden', !hasRun);
  if (hasRun) {
    const progress = queue.total ? Math.min(100, (queue.processed / queue.total) * 100) : 0;
    elements.queueProgressLabel.textContent = `${queue.processed} de ${queue.total} processados`;
    elements.queueProgressBar.style.width = `${progress}%`;
    elements.queueProgressTrack.setAttribute('aria-valuemax', String(queue.total));
    elements.queueProgressTrack.setAttribute('aria-valuenow', String(queue.processed));
    const focus = queue.current || queue.next;
    elements.queueCurrent.textContent = focus
      ? `${focus.company} · ${focus.phoneMasked}`
      : 'Nenhum contato pendente';
    elements.queueCounts.innerHTML = [
      `<span>${queue.sent} enviados</span>`,
      queue.invalid ? `<span>${queue.invalid} sem WhatsApp</span>` : '',
      queue.failed ? `<span>${queue.failed} falhas</span>` : '',
      queue.uncertain ? `<span>${queue.uncertain} incertos</span>` : '',
      queue.canceled ? `<span>${queue.canceled} removidos</span>` : '',
    ].join('');
    elements.queueAlert.textContent = queue.pauseReason || '';
    elements.queueAlert.classList.toggle('hidden', !queue.pauseReason);
  }

  const maxBatch = state.bootstrap?.policy.maxBatchSize;
  if (elements.queueEmptyCopy && maxBatch) {
    elements.queueEmptyCopy.textContent = `Confirme o opt-in dos contatos e inicie um lote de até ${formatNumber(maxBatch)} mensagens. Você confere a lista de destinatários antes de qualquer envio.`;
  }

  const ready = state.bootstrap?.whatsapp.status === 'ready';
  const eligible = state.bootstrap?.summary.eligible || 0;
  elements.startQueue.classList.toggle('hidden', active);
  elements.startQueue.disabled = !ready || eligible === 0 || state.templateDirty;
  elements.startQueue.title = !ready
    ? 'Conecte o WhatsApp primeiro'
    : eligible === 0
      ? 'Registre o opt-in de pelo menos um contato'
      : state.templateDirty
        ? 'Salve a mensagem antes de iniciar'
        : '';
  elements.pauseQueue.classList.toggle('hidden', queue.status !== 'running');
  elements.resumeQueue.classList.toggle('hidden', queue.status !== 'paused');
  elements.cancelQueue.classList.toggle('hidden', !active);
  updateCountdown();
}

function renderContacts() {
  if (!state.contacts) return;
  const { items, pagination } = state.contacts;
  if (!items.length) {
    elements.contactsBody.innerHTML = '<tr><td colspan="4"><div class="table-empty">Nenhum contato encontrado com estes filtros.</div></td></tr>';
  } else {
    elements.contactsBody.innerHTML = items.map(contactRow).join('');
  }
  const start = pagination.total ? (pagination.page - 1) * pagination.pageSize + 1 : 0;
  const end = Math.min(pagination.total, pagination.page * pagination.pageSize);
  elements.paginationLabel.textContent = `${start}–${end} de ${formatNumber(pagination.total)} contatos`;
  elements.pageLabel.textContent = `${pagination.page} / ${pagination.pages}`;
  elements.previousPage.disabled = pagination.page <= 1;
  elements.nextPage.disabled = pagination.page >= pagination.pages;
  updateExportLink();
}

function contactRow(contact) {
  const action = primaryContactAction(contact);
  const tags = contactTags(contact).map((tag) => `<span class="tag ${tag.className}">${escapeHtml(tag.label)}</span>`).join('');
  const phoneLabel = contact.phoneRaw || 'Telefone ausente';
  const details = [
    contact.phoneKind === 'landline' ? 'telefone fixo' : contact.phoneKind === 'mobile' ? 'celular' : '',
    contact.sourceTag ? `[${contact.sourceTag.toLowerCase()}]` : '',
  ].filter(Boolean).join(' · ');

  return `<tr data-contact-id="${contact.id}">
    <td class="company-cell">
      <strong title="${escapeHtml(contact.company)}">${escapeHtml(contact.company)}</strong>
      <span>#${contact.sourceIndex} · ${escapeHtml(contact.city)}</span>
      <span class="mobile-phone">${escapeHtml(phoneLabel)}</span>
    </td>
    <td class="phone-cell">
      <strong>${escapeHtml(phoneLabel)}</strong>
      <span>${escapeHtml(details || '—')}</span>
    </td>
    <td><div class="status-stack">${tags}</div></td>
    <td class="actions-column"><div class="row-actions">
      ${action ? `<button class="mini-button" type="button" data-action="${action.action}" data-id="${contact.id}">${escapeHtml(action.label)}</button>` : ''}
      <button class="mini-button" type="button" data-action="manage" data-id="${contact.id}" title="Editar, bloquear ou apagar"><span>Gerenciar</span></button>
    </div></td>
  </tr>`;
}

function primaryContactAction(contact) {
  if (['sent', 'replied', 'suppressed', 'invalid', 'uncertain', 'sending'].includes(contact.status)) return null;
  if (contact.consentStatus === 'unknown') return { action: 'consent', label: 'Registrar opt-in' };
  if (contact.needsReview && !contact.reviewApproved) return { action: 'review', label: 'Revisar dados' };
  if (contact.eligible) return { action: 'send', label: 'Enviar' };
  return null;
}

function contactTags(contact) {
  const status = {
    pending: { label: 'Pendente', className: '' },
    sending: { label: 'Enviando', className: 'blue' },
    sent: { label: 'Enviado', className: 'green' },
    replied: { label: 'Respondeu', className: 'blue' },
    suppressed: { label: 'Não contatar', className: 'red' },
    invalid: { label: 'Sem telefone', className: 'red' },
    failed: { label: 'Falhou', className: 'red' },
    uncertain: { label: 'Resultado incerto', className: 'amber' },
  }[contact.status] || { label: contact.status, className: '' };
  const tags = [status];
  if (contact.consentStatus === 'confirmed') tags.push({ label: 'Opt-in confirmado', className: 'green' });
  if (contact.consentStatus === 'unknown' && contact.status === 'pending') tags.push({ label: 'Sem opt-in', className: 'amber' });
  if (contact.needsReview && !contact.reviewApproved) tags.push({ label: 'Revisar', className: 'amber' });
  if (contact.phoneKind === 'landline') tags.push({ label: 'Fixo', className: '' });
  if (contact.dddMismatch) tags.push({ label: 'DDD divergente', className: 'amber' });
  if (contact.suppressed && contact.status !== 'suppressed') tags.push({ label: 'Número bloqueado', className: 'red' });
  for (const tag of contact.tags || []) tags.push({ label: tag, className: 'blue' });
  if (contact.hasCompanyName === false) tags.push({ label: 'Sem nome', className: '' });
  return tags;
}

function renderEvents(events) {
  if (!events?.length) {
    elements.activityList.innerHTML = '<li class="activity-empty">Nenhuma atividade ainda.</li>';
    return;
  }
  elements.activityList.innerHTML = events.map((event) => `<li>
    <span class="activity-dot ${escapeHtml(event.level)}"></span>
    <strong>${escapeHtml(event.title)}</strong>
    <time datetime="${escapeHtml(event.createdAt)}">${escapeHtml(relativeTime(event.createdAt))}</time>
  </li>`).join('');
}

function renderCities(cities) {
  const selected = state.city;
  elements.cityFilter.replaceChildren(new Option('Todas as cidades', ''));
  for (const item of cities || []) {
    const option = document.createElement('option');
    option.value = item.city;
    option.textContent = `${item.city} (${item.total})`;
    elements.cityFilter.append(option);
  }
  elements.cityFilter.value = selected;
}

function renderTags(tags) {
  const selected = state.tag;
  elements.tagFilter.replaceChildren(new Option('Todas as etiquetas', ''));
  for (const item of tags || []) {
    elements.tagFilter.append(new Option(`${item.tag} (${item.total})`, item.tag));
  }
  elements.tagFilter.value = selected;
  // Uma etiqueta pode ter deixado de existir; nesse caso o filtro volta a "todas".
  if (elements.tagFilter.value !== selected) state.tag = '';
  elements.tagFilter.hidden = !(tags || []).length && !selected;
}

// A exportação acompanha o que a tela está mostrando, em vez de despejar a base
// inteira toda vez.
function updateExportLink() {
  const params = new URLSearchParams();
  if (state.filter !== 'all') params.set('filter', state.filter);
  if (state.search) params.set('search', state.search);
  if (state.city) params.set('city', state.city);
  if (state.tag) params.set('tag', state.tag);
  const query = params.toString();
  elements.exportCsv.href = query ? `/api/export.csv?${query}` : '/api/export.csv';
  elements.exportCsv.textContent = query ? 'Exportar filtrados' : 'Exportar CSV';
}

function updateTemplatePreview() {
  const template = elements.messageTemplate.value;
  elements.templateCount.textContent = `${template.length} / 4096`;
  elements.templateCount.style.color = template.length > 4096 ? 'var(--red)' : '';
  elements.messagePreview.textContent = template.split('{empresa}').join('Empresa Exemplo');
  elements.saveTemplate.disabled = !state.templateDirty || !template.includes('{empresa}') || template.length > 4096;
}

async function saveTemplate() {
  if (!state.bootstrap) return toast('Aguarde o painel terminar de carregar.', 'warning');
  const submittedTemplate = elements.messageTemplate.value;
  setBusy(elements.saveTemplate, true, 'Salvando…');
  elements.messageTemplate.disabled = true;
  try {
    const result = await api('/api/template', {
      method: 'PUT',
      body: { template: submittedTemplate },
    });
    state.templateDirty = false;
    elements.messageTemplate.value = result.template;
    updateTemplatePreview();
    toast('Mensagem salva.');
    scheduleRefresh();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    elements.messageTemplate.disabled = false;
    setBusy(elements.saveTemplate, false);
    updateTemplatePreview();
  }
}

async function handleConnectionAction() {
  const status = state.bootstrap?.whatsapp.status;
  if (status === 'ready') {
    document.getElementById('connection-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (status === 'qr_pending') {
    showQrModal();
    return;
  }
  showQrModal();
  try {
    await api('/api/whatsapp/connect', { method: 'POST' });
    scheduleRefresh(200);
  } catch (error) {
    renderQrError(error.message);
    toast(error.message, 'error');
  }
}

async function handleConnectionSecondary() {
  const mode = elements.connectionSecondary.dataset.mode;
  if (mode === 'qr') return showQrModal();
  if (mode === 'disconnect') {
    return openActionModal({
      title: 'Desconectar o WhatsApp?',
      copy: 'A fila será pausada. O login fica preservado neste computador para a próxima conexão.',
      confirmText: 'Desconectar',
      danger: true,
      onConfirm: async () => {
        await api('/api/whatsapp/disconnect', { method: 'POST' });
        toast('WhatsApp desconectado.', 'warning');
        scheduleRefresh();
      },
    });
  }
  showQrModal();
  try {
    await api('/api/whatsapp/reconnect', { method: 'POST' });
    scheduleRefresh(200);
  } catch (error) {
    renderQrError(error.message);
    toast(error.message, 'error');
  }
}

function showQrModal() {
  const whatsapp = state.bootstrap?.whatsapp;
  renderQrState(whatsapp || { status: 'starting', message: 'Preparando a conexão…' });
  if (!elements.qrModal.open) elements.qrModal.showModal();
}

function renderQrState(whatsapp) {
  if (whatsapp?.qrDataUrl) {
    const image = document.createElement('img');
    image.src = whatsapp.qrDataUrl;
    image.alt = 'QR Code temporário para conectar o WhatsApp';
    elements.qrFrame.replaceChildren(image);
  } else if (['error', 'auth_failed', 'disconnected'].includes(whatsapp?.status)) {
    renderQrError(whatsapp.message || 'Não foi possível gerar o QR Code.');
  } else {
    const loading = document.createElement('div');
    loading.className = 'qr-loading';
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    const copy = document.createElement('p');
    copy.textContent = whatsapp?.message || 'Gerando QR Code…';
    loading.append(spinner, copy);
    elements.qrFrame.replaceChildren(loading);
  }
}

function renderQrError(message) {
  const wrapper = document.createElement('div');
  wrapper.className = 'qr-loading qr-error';
  const copy = document.createElement('p');
  copy.textContent = message;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button button-secondary button-compact';
  button.dataset.qrRetry = 'true';
  button.textContent = 'Tentar novamente';
  wrapper.append(copy, button);
  elements.qrFrame.replaceChildren(wrapper);
}

async function retryQrConnection() {
  renderQrState({ status: 'starting', message: 'Gerando um novo QR Code…' });
  try {
    await api('/api/whatsapp/reconnect', { method: 'POST' });
    scheduleRefresh(200);
  } catch (error) {
    renderQrError(error.message);
    toast(error.message, 'error');
  }
}

function openStartQueueModal() {
  if (!state.bootstrap) return toast('Aguarde o painel terminar de carregar.', 'warning');
  if (state.templateDirty) return toast('Salve a mensagem antes de iniciar o lote.', 'warning');
  const { summary, policy } = state.bootstrap;
  if (!summary.eligible) return toast('Registre o opt-in de pelo menos um contato antes de iniciar.', 'warning');
  const maxLimit = Math.min(summary.eligible, policy.maxBatchSize);
  openActionModal({
    title: 'Iniciar um novo lote',
    copy: 'Na próxima etapa você vê a lista completa de quem receberia e remove quem não deve receber.',
    confirmText: 'Ver destinatários',
    content: `<div class="modal-summary">
      <div><span>Elegíveis</span><strong>${summary.eligible}</strong></div>
      <div><span>Limite diário</span><strong>${policy.dailyLimit}</strong></div>
    </div>
    <div class="modal-field">
      <label for="batch-limit">Quantidade neste lote (máximo ${policy.maxBatchSize})</label>
      <input id="batch-limit" type="number" min="1" max="${maxLimit}" step="1" value="${maxLimit}" required>
    </div>
    <div class="modal-field">
      <label for="batch-interval">Intervalo entre mensagens</label>
      <select id="batch-interval">
        <option value="180">3 minutos (recomendado)</option>
        <option value="240">4 minutos</option>
        <option value="300">5 minutos</option>
        <option value="120">2 minutos</option>
        <option value="90">1 minuto e 30 segundos</option>
      </select>
    </div>`,
    onConfirm: async () => {
      const limit = Number(document.getElementById('batch-limit').value);
      if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
        throw new Error('Informe uma quantidade válida para o lote.');
      }
      const intervalSeconds = Number(document.getElementById('batch-interval').value);
      const preview = await api(`/api/queue/preview?limit=${limit}`);
      if (!preview.contacts.length) {
        throw new Error('Nenhum contato está elegível agora. Registre o opt-in antes de iniciar.');
      }
      openRecipientsModal(preview.contacts, intervalSeconds);
      return { keepOpen: true };
    },
  });
}

function openRecipientsModal(contacts, intervalSeconds) {
  state.batchPreview = { contacts, intervalSeconds, removed: new Set() };
  openActionModal({
    title: 'Confira quem vai receber',
    copy: `Uma mensagem por vez, com espera sorteada em torno de ${formatDuration(intervalSeconds)}. Remova qualquer empresa que não deva receber.`,
    confirmText: 'Iniciar envio',
    content: `<div class="recipient-head">
      <span id="recipient-count">—</span>
      <button class="text-button" type="button" data-restore-recipients>Restaurar removidos</button>
    </div>
    <ul class="recipient-list" id="recipient-list"></ul>
    <div class="check-row">
      <input id="batch-authorization" type="checkbox">
      <label for="batch-authorization">Confirmo que estes contatos forneceram o número e autorizaram receber esta mensagem. Vou respeitar qualquer pedido de saída.</label>
    </div>`,
    onConfirm: async () => {
      const preview = state.batchPreview;
      const remaining = remainingRecipients();
      if (!remaining.length) throw new Error('Deixe pelo menos um destinatário na lista.');
      if (!document.getElementById('batch-authorization').checked) {
        throw new Error('Marque a confirmação de autorização para continuar.');
      }
      await api('/api/queue/start', {
        method: 'POST',
        body: {
          contactIds: remaining.map((contact) => contact.id),
          intervalSeconds: preview.intervalSeconds,
          authorizationAcknowledged: true,
        },
      });
      toast(`Lote iniciado com ${remaining.length} contato(s).`);
      scheduleRefresh(100);
    },
  });
  renderRecipients();
}

function remainingRecipients() {
  const preview = state.batchPreview;
  if (!preview) return [];
  return preview.contacts.filter((contact) => !preview.removed.has(contact.id));
}

function renderRecipients() {
  const preview = state.batchPreview;
  const list = document.getElementById('recipient-list');
  const count = document.getElementById('recipient-count');
  if (!preview || !list || !count) return;

  list.innerHTML = preview.contacts.map((contact) => {
    const removed = preview.removed.has(contact.id);
    const detail = [`#${contact.sourceIndex}`, contact.city, contact.phoneRaw || 'sem telefone']
      .filter(Boolean).join(' · ');
    const alert = contact.needsCompanyName
      ? '<span class="tag amber">sem nome para {empresa}</span>'
      : '';
    return `<li class="${removed ? 'removed' : ''}">
      <div title="${escapeHtml(contact.message || 'Falta o nome da empresa para montar a mensagem.')}">
        <strong>${escapeHtml(contact.company)}</strong>
        <span>${escapeHtml(detail)}</span>
        ${alert}
      </div>
      <button class="mini-button ${removed ? '' : 'danger'}" type="button" data-remove-recipient="${contact.id}">${removed ? 'Devolver' : 'Remover'}</button>
    </li>`;
  }).join('');

  const remaining = remainingRecipients().length;
  const missingNames = remainingRecipients().filter((contact) => contact.needsCompanyName).length;
  count.textContent = missingNames
    ? `${remaining} de ${preview.contacts.length} · ${missingNames} sem nome`
    : `${remaining} de ${preview.contacts.length} vão receber`;
  elements.actionConfirm.textContent = remaining ? `Iniciar envio (${remaining})` : 'Nenhum destinatário';
  elements.actionConfirm.disabled = remaining === 0;
}

function handleRecipientAction(event) {
  if (!state.batchPreview) return;
  const removeButton = event.target.closest('[data-remove-recipient]');
  if (removeButton) {
    const id = Number(removeButton.dataset.removeRecipient);
    const { removed } = state.batchPreview;
    if (removed.has(id)) removed.delete(id);
    else removed.add(id);
    renderRecipients();
    return;
  }
  if (event.target.closest('[data-restore-recipients]')) {
    state.batchPreview.removed.clear();
    renderRecipients();
  }
}

function openCancelQueueModal() {
  openActionModal({
    title: 'Cancelar o lote?',
    copy: 'Itens ainda pendentes voltarão para a lista. Uma mensagem que já estiver sendo enviada pode ser concluída.',
    confirmText: 'Cancelar lote',
    danger: true,
    onConfirm: async () => {
      await api('/api/queue/cancel', { method: 'POST' });
      toast('Lote cancelado.', 'warning');
      scheduleRefresh();
    },
  });
}

async function queueAction(url, successMessage) {
  try {
    await api(url, { method: 'POST' });
    toast(successMessage);
    scheduleRefresh();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function handleContactAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const contact = state.contacts?.items.find((item) => item.id === Number(button.dataset.id));
  if (!contact) return;
  const handlers = {
    consent: openConsentModal,
    review: openReviewModal,
    send: openSingleSendModal,
    manage: openManageModal,
    suppress: openSuppressModal,
  };
  handlers[button.dataset.action]?.(contact);
}

function openConsentModal(contact) {
  openActionModal({
    title: 'Registrar opt-in',
    copy: `Confirme a autorização de ${contact.company}. Esta confirmação libera o contato para a fila.`,
    confirmText: 'Registrar autorização',
    content: `<div class="modal-field">
      <label for="consent-note">Como/quando autorizou? (opcional)</label>
      <textarea id="consent-note" placeholder="Ex.: pediu uma demonstração em 28/08/2026"></textarea>
    </div>
    <div class="check-row">
      <input id="consent-confirm" type="checkbox">
      <label for="consent-confirm">Confirmo que esta empresa forneceu o número e aceitou receber esta mensagem pelo WhatsApp.</label>
    </div>`,
    onConfirm: async () => {
      if (!document.getElementById('consent-confirm').checked) throw new Error('Confirme o opt-in para continuar.');
      await api(`/api/contacts/${contact.id}/consent`, {
        method: 'POST',
        body: { confirmed: true, note: document.getElementById('consent-note').value },
      });
      toast(`Opt-in de ${contact.company} registrado.`);
      scheduleRefresh();
    },
  });
}

function openReviewModal(contact) {
  const warnings = [
    contact.phoneKind === 'landline' ? 'O número tem formato de telefone fixo.' : '',
    contact.sourceTag ? `A origem marcou este item como [${contact.sourceTag}].` : '',
    contact.dddMismatch ? 'O DDD não corresponde à cidade da seção.' : '',
  ].filter(Boolean);
  openActionModal({
    title: 'Aprovar dados do contato',
    copy: `${contact.company} · ${contact.phoneRaw || 'sem telefone'}`,
    confirmText: 'Dados conferidos',
    content: `<div class="check-row"><div>${warnings.map((warning) => `<div>• ${escapeHtml(warning)}</div>`).join('')}</div></div>
      <div class="check-row">
        <input id="review-confirm" type="checkbox">
        <label for="review-confirm">Conferi o nome e o telefone em uma fonte confiável e os dados estão corretos.</label>
      </div>`,
    onConfirm: async () => {
      if (!document.getElementById('review-confirm').checked) throw new Error('Confirme que os dados foram conferidos.');
      await api(`/api/contacts/${contact.id}/review`, { method: 'POST', body: { approved: true } });
      toast(`Dados de ${contact.company} aprovados.`);
      scheduleRefresh();
    },
  });
}

function openSingleSendModal(contact) {
  if (state.templateDirty) return toast('Salve a mensagem antes de visualizar e enviar.', 'warning');
  const template = elements.messageTemplate.value;
  const preview = template.split('{empresa}').join(contact.company);
  openActionModal({
    title: `Enviar para ${contact.company}?`,
    copy: `${contact.phoneRaw} · ${contact.city}`,
    confirmText: 'Enviar uma mensagem',
    content: `<div class="message-preview">${escapeHtml(preview)}</div>
      <div class="check-row">
        <input id="single-authorization" type="checkbox">
        <label for="single-authorization">Confirmo novamente que este contato autorizou a mensagem.</label>
      </div>`,
    onConfirm: async () => {
      if (!document.getElementById('single-authorization').checked) throw new Error('Confirme a autorização para continuar.');
      await api(`/api/contacts/${contact.id}/send`, {
        method: 'POST',
        body: { authorizationAcknowledged: true },
      });
      toast('Mensagem adicionada à fila.');
      scheduleRefresh(100);
    },
  });
}

async function openManageModal(contact) {
  let stats = { deliveries: 0, sent: 0, suppressed: 0 };
  let historico = [];
  try {
    const detalhe = await api(`/api/contacts/${contact.id}`);
    stats = detalhe.stats;
    historico = detalhe.deliveries || [];
  } catch {
    // Sem o detalhe o modal ainda edita; só o histórico e o aviso somem.
  }

  const desfazer = [
    contact.consentStatus === 'confirmed'
      ? '<button class="text-button" type="button" data-manage="revoke-consent">Revogar opt-in</button>'
      : '',
    contact.reviewApproved
      ? '<button class="text-button" type="button" data-manage="revoke-review">Desfazer revisão</button>'
      : '',
    contact.status !== 'suppressed' && contact.phoneRaw
      ? '<button class="text-button" type="button" data-manage="suppress">Bloquear para sempre</button>'
      : '',
  ].filter(Boolean).join('');

  // Envio incerto é o único desfecho que o sistema não decide sozinho.
  const incerto = contact.status === 'uncertain' ? `<div class="uncertain-box">
    <strong>Resultado incerto</strong>
    <p>A conexão caiu durante o envio e não dá para saber se a mensagem chegou. Confira no WhatsApp e diga o que aconteceu — o painel nunca reenvia sozinho.</p>
    <div class="manage-actions">
      <button class="text-button" type="button" data-manage="resolve-sent">A mensagem chegou</button>
      <button class="text-button" type="button" data-manage="resolve-pending">Não chegou, voltar para a fila</button>
    </div>
  </div>` : '';

  const historicoHtml = historico.length ? `<details class="history">
    <summary>Histórico de envio (${historico.length})</summary>
    <ol class="history-list">
      ${historico.map((item) => `<li>
        <div class="history-head">
          <span class="tag ${deliveryTagClass(item.status)}">${escapeHtml(item.status)}</span>
          <time datetime="${escapeHtml(item.createdAt)}">${escapeHtml(relativeTime(item.sentAt || item.createdAt))}</time>
        </div>
        <p>${escapeHtml(item.message)}</p>
        ${item.error ? `<small>${escapeHtml(item.error)}</small>` : ''}
      </li>`).join('')}
    </ol>
  </details>` : ''

  const perda = [
    stats.sent ? `${stats.sent} mensagem(ns) enviada(s)` : '',
    stats.deliveries ? `${stats.deliveries} registro(s) de envio` : '',
  ].filter(Boolean).join(' e ');

  openActionModal({
    title: 'Gerenciar contato',
    copy: `#${contact.sourceIndex} · ${contact.company}`,
    confirmText: 'Salvar alterações',
    content: `<div class="modal-field">
      <label for="manage-company">Nome da empresa</label>
      <input id="manage-company" type="text" maxlength="100" value="${escapeHtml(contact.companyName ?? '')}" placeholder="Opcional — é o que entra em {empresa}">
    </div>
    <div class="modal-field">
      <label for="manage-phone">Telefone</label>
      <input id="manage-phone" type="text" maxlength="40" value="${escapeHtml(contact.phoneRaw ?? '')}" placeholder="(71) 99999-9999">
    </div>
    <div class="modal-field">
      <label for="manage-city">Cidade</label>
      <input id="manage-city" type="text" maxlength="80" value="${escapeHtml(contact.city ?? '')}" placeholder="Opcional">
    </div>
    <div class="modal-field">
      <label for="manage-tags">Etiquetas</label>
      <input id="manage-tags" type="text" maxlength="200" value="${escapeHtml((contact.tags || []).join(', '))}" placeholder="Separe por vírgula: clientes, evento, vip">
    </div>
    <p class="modal-note">Trocar o telefone reclassifica o contato e devolve os dados para conferência.</p>
    ${incerto}
    ${historicoHtml}
    ${desfazer ? `<div class="manage-actions">${desfazer}</div>` : ''}
    <div class="danger-zone">
      <div>
        <strong>Apagar da lista</strong>
        <p>${perda ? `Vai junto: ${escapeHtml(perda)}.` : 'Este contato ainda não recebeu nada.'}${stats.suppressed ? ' O bloqueio do número continua valendo mesmo depois de apagar.' : ''}</p>
      </div>
      <button class="mini-button danger" type="button" data-manage="delete">Apagar</button>
    </div>`,
    onConfirm: async () => {
      const body = {
        company: document.getElementById('manage-company').value.trim(),
        phone: document.getElementById('manage-phone').value.trim(),
        city: document.getElementById('manage-city').value.trim(),
      };
      if (!body.company) delete body.company;
      if (!body.phone) delete body.phone;
      if (!Object.keys(body).length) throw new Error('Preencha ao menos um campo.');

      await api(`/api/contacts/${contact.id}`, { method: 'PATCH', body });
      await api(`/api/contacts/${contact.id}/tags`, {
        method: 'PUT',
        body: { tags: document.getElementById('manage-tags').value.split(',') },
      });
      toast('Contato atualizado.');
      scheduleRefresh();
    },
  });

  state.managedContact = contact;
}

function deliveryTagClass(status) {
  return { sent: 'green', invalid: 'red', failed: 'red', uncertain: 'amber' }[status] || '';
}

async function handleManageAction(event) {
  const button = event.target.closest('[data-manage]');
  if (!button || !state.managedContact) return;
  const contact = state.managedContact;

  const acao = {
    'revoke-consent': {
      pergunta: `Revogar o opt-in de ${contact.company}? Ele sai da fila e volta a precisar de autorização.`,
      executar: () => api(`/api/contacts/${contact.id}/consent`, { method: 'DELETE', body: { reason: 'Revogado no painel' } }),
      aviso: 'Opt-in revogado.',
    },
    'revoke-review': {
      pergunta: `Devolver ${contact.company} para conferência de dados?`,
      executar: () => api(`/api/contacts/${contact.id}/review`, { method: 'DELETE' }),
      aviso: 'Contato voltou para revisão.',
    },
    suppress: {
      pergunta: `Bloquear ${contact.company} para sempre? O painel não desfaz isso.`,
      executar: () => api(`/api/contacts/${contact.id}/suppress`, { method: 'POST', body: { reason: 'Bloqueio manual' } }),
      aviso: 'Contato bloqueado.',
    },
    'resolve-sent': {
      pergunta: `Confirmar que ${contact.company} recebeu a mensagem?`,
      executar: () => api(`/api/contacts/${contact.id}/resolve`, { method: 'POST', body: { outcome: 'sent' } }),
      aviso: 'Marcado como enviado.',
    },
    'resolve-pending': {
      pergunta: `Devolver ${contact.company} para a fila? Ele poderá receber a mensagem de novo.`,
      executar: () => api(`/api/contacts/${contact.id}/resolve`, { method: 'POST', body: { outcome: 'pending' } }),
      aviso: 'Contato voltou para a fila.',
    },
    delete: {
      pergunta: `Apagar ${contact.company} da lista? Não dá para desfazer.`,
      executar: () => api(`/api/contacts/${contact.id}`, { method: 'DELETE' }),
      aviso: 'Contato apagado.',
    },
  }[button.dataset.manage];
  if (!acao) return;

  if (!window.confirm(acao.pergunta)) return;
  setBusy(button, true, 'Aguarde…');
  try {
    await acao.executar();
    toast(acao.aviso, 'warning');
    elements.actionModal.close('confirm');
    scheduleRefresh();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

/**
 * Apaga exatamente o conjunto que a tabela está mostrando. Manda junto a
 * contagem exibida: se o banco discordar, o servidor recusa em vez de apagar
 * um conjunto diferente do que foi conferido.
 */
function openDeleteFilteredModal() {
  const total = state.contacts?.pagination.total || 0;
  if (!total) return toast('Nenhum contato nos filtros atuais.', 'warning');

  const criterios = [
    state.filter !== 'all' ? `filtro "${elements.contactFilter.selectedOptions[0].textContent}"` : '',
    state.city ? `cidade "${state.city}"` : '',
    state.search ? `busca "${state.search}"` : '',
  ].filter(Boolean).join(', ') || 'a lista inteira';

  openActionModal({
    title: `Apagar ${formatNumber(total)} contato(s)?`,
    copy: `Serão apagados os contatos de ${criterios}. Não dá para desfazer.`,
    confirmText: 'Apagar definitivamente',
    danger: true,
    content: `<div class="check-row">
      <div>
        <div>• O histórico de envio desses contatos vai junto.</div>
        <div>• Quem pediu <strong>SAIR</strong> continua bloqueado: a supressão é por telefone e sobrevive.</div>
        <div>• Contatos em um lote ativo não são apagados — conclua ou cancele o lote antes.</div>
      </div>
    </div>
    <div class="modal-field">
      <label for="delete-confirm-text">Digite <strong>APAGAR</strong> para confirmar</label>
      <input id="delete-confirm-text" type="text" autocomplete="off" placeholder="APAGAR">
    </div>`,
    onConfirm: async () => {
      const digitado = document.getElementById('delete-confirm-text').value.trim().toUpperCase();
      if (digitado !== 'APAGAR') throw new Error('Digite APAGAR para confirmar.');

      const resposta = await api('/api/contacts/delete-many', {
        method: 'POST',
        body: {
          confirmed: true,
          expected: total,
          filter: state.filter,
          city: state.city,
          search: state.search,
        },
      });
      toast(`${formatNumber(resposta.deleted)} contato(s) apagados.`, 'warning');
      state.page = 1;
      scheduleRefresh();
    },
  });
}

/**
 * Lista as importações já feitas e permite desfazer uma inteira. Só entram aqui
 * as importações registradas como lote — a lista inicial e o que veio antes
 * disso não pertencem a lote nenhum e continuam intocados.
 */
async function openImportsModal() {
  let batches = [];
  try {
    ({ batches } = await api('/api/imports'));
  } catch (error) {
    return toast(error.message, 'error');
  }

  const linhas = batches.length
    ? batches.map((batch) => `<li>
        <div>
          <strong>${escapeHtml(batch.source || 'importação sem arquivo')}</strong>
          <span>#${batch.id} · ${escapeHtml(batch.format || '—')} · ${formatNumber(batch.inserted)} importados · ${formatNumber(batch.remaining)} ainda na lista · ${escapeHtml(relativeTime(batch.createdAt))}</span>
        </div>
        ${batch.remaining
          ? `<button class="mini-button danger" type="button" data-import="${batch.id}">Desfazer</button>`
          : '<span class="tag">nada a desfazer</span>'}
      </li>`).join('')
    : '<li class="history-empty">Nenhuma importação registrada ainda. Use <code>npm run import</code>.</li>';

  openActionModal({
    title: 'Importações',
    copy: 'Desfazer uma importação apaga só os contatos que entraram nela e que ainda estão na lista.',
    confirmText: 'Fechar',
    hideCancel: true,
    content: `<ul class="import-list">${linhas}</ul>`,
    onConfirm: async () => {},
  });
}

async function handleImportAction(event) {
  const button = event.target.closest('[data-import]');
  if (!button) return;
  const id = button.dataset.import;

  if (!window.confirm('Desfazer esta importação? Os contatos dela serão apagados. Quem pediu SAIR continua bloqueado.')) return;
  setBusy(button, true, 'Desfazendo…');
  try {
    const resposta = await api(`/api/imports/${id}`, { method: 'DELETE', body: { confirmed: true } });
    toast(`${formatNumber(resposta.deleted)} contato(s) apagados.`, 'warning');
    elements.actionModal.close('confirm');
    state.page = 1;
    scheduleRefresh();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

function openSuppressModal(contact) {
  openActionModal({
    title: 'Nunca mais contatar?',
    copy: `${contact.company} será removida de qualquer fila atual e futura. A supressão não pode ser desfeita pelo painel.`,
    confirmText: 'Bloquear contato',
    danger: true,
    content: `<div class="modal-field">
      <label for="suppress-reason">Motivo</label>
      <input id="suppress-reason" type="text" maxlength="240" value="Pedido de saída ou decisão manual">
    </div>`,
    onConfirm: async () => {
      await api(`/api/contacts/${contact.id}/suppress`, {
        method: 'POST',
        body: { reason: document.getElementById('suppress-reason').value },
      });
      toast(`${contact.company} foi bloqueada para novos contatos.`, 'warning');
      scheduleRefresh();
    },
  });
}

function openPolicyModal() {
  if (!state.bootstrap) return toast('Aguarde o painel terminar de carregar.', 'warning');
  const policy = state.bootstrap.policy;
  openActionModal({
    title: 'Limites deste painel',
    copy: 'Os controles reduzem erros operacionais; eles não transformam contato sem opt-in em uso permitido.',
    confirmText: 'Entendi',
    hideCancel: true,
    content: `<div class="modal-summary">
      <div><span>Por lote</span><strong>${policy.maxBatchSize}</strong></div>
      <div><span>Por hora</span><strong>${policy.hourlyLimit}</strong></div>
      <div><span>Por dia</span><strong>${policy.dailyLimit}</strong></div>
      <div><span>Horário</span><strong>${String(policy.businessHourStart).padStart(2, '0')}h–${String(policy.businessHourEnd).padStart(2, '0')}h</strong></div>
    </div>
    <div class="check-row"><label>A integração por QR usa um cliente não oficial e pode parar de funcionar após mudanças no WhatsApp Web. Para operação comercial recorrente, prefira a plataforma oficial.</label></div>
    <div class="check-row"><label><strong>Uso por sua conta e risco.</strong> Software fornecido sem garantia, sob licença MIT. O uso pode levar à restrição ou ao banimento da conta, e a responsabilidade legal por quem recebe, com qual consentimento e com qual conteúdo é de quem envia.</label></div>`,
    onConfirm: async () => {},
  });
}

function openActionModal({ title, copy, content = '', confirmText = 'Confirmar', danger = false, hideCancel = false, onConfirm }) {
  elements.actionModalTitle.textContent = title;
  elements.actionModalCopy.textContent = copy || '';
  elements.actionModalContent.innerHTML = content;
  // Descarta o rótulo guardado pela etapa anterior para o setBusy não restaurá-lo.
  delete elements.actionConfirm.dataset.originalLabel;
  elements.actionConfirm.disabled = false;
  elements.actionConfirm.textContent = confirmText;
  elements.actionConfirm.className = `button ${danger ? 'button-ghost' : 'button-primary'}`;
  if (danger) elements.actionConfirm.style.color = 'var(--red)';
  else elements.actionConfirm.style.color = '';
  elements.actionCancel.classList.toggle('hidden', hideCancel);
  state.currentAction = onConfirm;
  if (!elements.actionModal.open) elements.actionModal.showModal();
}

async function handleModalSubmit(event) {
  event.preventDefault();
  if (!state.currentAction) return elements.actionModal.close('confirm');
  setBusy(elements.actionConfirm, true, 'Processando…');
  try {
    const result = await state.currentAction();
    // Uma etapa que abre a próxima (conferir destinatários) mantém o modal vivo.
    if (!result?.keepOpen) elements.actionModal.close('confirm');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(elements.actionConfirm, false);
  }
}

function changePage(delta) {
  const pages = state.contacts?.pagination.pages || 1;
  state.page = Math.min(pages, Math.max(1, state.page + delta));
  loadContacts().catch((error) => toast(error.message, 'error'));
}

function updateCountdown() {
  const queue = state.bootstrap?.queue;
  if (!queue?.nextRunAt || queue.status !== 'running') {
    if (elements.queueNextTime) elements.queueNextTime.textContent = queue?.status === 'paused' ? 'aguardando retomada' : '—';
    return;
  }
  const seconds = Math.max(0, Math.ceil((new Date(queue.nextRunAt).getTime() - Date.now()) / 1000));
  elements.queueNextTime.textContent = seconds <= 1 ? 'processando agora' : `próximo em ${formatDuration(seconds)}`;
}

function connectRealtime() {
  const source = new EventSource('/api/events/stream');
  source.addEventListener('refresh', () => scheduleRefresh(180));
  source.onerror = () => {
    // O EventSource se reconecta sozinho; o polling periódico cobre quedas prolongadas.
  };
}

function scheduleRefresh(delay = 250) {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => refreshAll(), delay);
}

async function api(url, options = {}) {
  const request = { ...options, headers: { ...(options.headers || {}) } };
  if (options.body && typeof options.body !== 'string') {
    request.headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, request);
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(payload?.error || `Falha na requisição (${response.status}).`);
  return payload;
}

function connectionMeta(status) {
  return {
    disconnected: { short: 'Desconectado', title: 'WhatsApp desconectado', message: 'Conecte para começar.', dot: '', className: '' },
    starting: { short: 'Iniciando', title: 'Preparando conexão', message: 'Abrindo o navegador interno…', dot: 'pending', className: 'pending' },
    qr_pending: { short: 'QR Code pendente', title: 'Leia o QR Code', message: 'Use a opção Aparelhos conectados no celular.', dot: 'pending', className: 'pending' },
    authenticated: { short: 'Sincronizando', title: 'Conta reconhecida', message: 'Aguarde a sincronização.', dot: 'pending', className: 'pending' },
    ready: { short: 'WhatsApp pronto', title: 'Conectado e pronto', message: 'A fila pode ser iniciada.', dot: 'ready', className: 'ready' },
    auth_failed: { short: 'Falha no login', title: 'Falha de autenticação', message: 'Gere um novo QR Code.', dot: 'error', className: 'error' },
    error: { short: 'Erro de conexão', title: 'Não foi possível conectar', message: 'Tente novamente.', dot: 'error', className: 'error' },
  }[status] || { short: status, title: 'Estado desconhecido', message: '', dot: '', className: '' };
}

function toast(message, type = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.textContent = message;
  elements.toastRegion.append(item);
  setTimeout(() => item.remove(), 5_000);
}

function setBusy(button, busy, label) {
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalLabel || button.textContent;
    button.disabled = false;
  }
}

function relativeTime(value) {
  const timestamp = new Date(value).getTime();
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}m ${String(remainder).padStart(2, '0')}s` : `${remainder}s`;
}

function formatNumber(value) {
  return new Intl.NumberFormat('pt-BR').format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
