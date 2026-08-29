const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_TEMPLATE } = require('./lib/template');
const { digitsOnly, maskPhone } = require('./lib/phones');

const ACTIVE_RUN_STATUSES = ['running', 'paused'];

// Regra única de elegibilidade: opt-in confirmado, dados aprovados, telefone
// utilizável e nenhuma supressão. Usada no resumo, nos filtros e na seleção da fila.
const ELIGIBLE_CONDITION = `status = 'pending'
  AND consent_status = 'confirmed'
  AND review_approved = 1
  AND phone_e164 IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.phone_e164 = contacts.phone_e164)`;

class AppDatabase {
  constructor({ databasePath, seedPath }) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.createSchema();
    this.recoverInterruptedWork();
    this.seedIfEmpty(seedPath);
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_hash TEXT NOT NULL UNIQUE,
        summary_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_index INTEGER NOT NULL UNIQUE,
        source_line INTEGER,
        section_occurrence INTEGER,
        company_raw TEXT NOT NULL,
        company_display TEXT NOT NULL,
        city TEXT NOT NULL,
        phone_raw TEXT,
        phone_digits TEXT,
        phone_e164 TEXT UNIQUE,
        whatsapp_digits TEXT,
        phone_kind TEXT NOT NULL CHECK (phone_kind IN ('mobile', 'landline', 'missing')),
        source_tag TEXT,
        ddd_mismatch INTEGER NOT NULL DEFAULT 0,
        needs_review INTEGER NOT NULL DEFAULT 0,
        review_approved INTEGER NOT NULL DEFAULT 0,
        consent_status TEXT NOT NULL DEFAULT 'unknown' CHECK (consent_status IN ('unknown', 'confirmed', 'legacy')),
        consent_note TEXT,
        consent_confirmed_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_message_id TEXT,
        sent_at TEXT,
        replied_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
      CREATE INDEX IF NOT EXISTS idx_contacts_city ON contacts(city);
      CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_display);
      CREATE INDEX IF NOT EXISTS idx_contacts_whatsapp_digits ON contacts(whatsapp_digits);

      CREATE TABLE IF NOT EXISTS suppressions (
        phone_e164 TEXT PRIMARY KEY,
        contact_id INTEGER,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (contact_id) REFERENCES contacts(id)
      );

      CREATE TABLE IF NOT EXISTS campaign_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        template_hash TEXT NOT NULL,
        interval_seconds INTEGER NOT NULL,
        total INTEGER NOT NULL DEFAULT 0,
        processed INTEGER NOT NULL DEFAULT 0,
        sent INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        invalid INTEGER NOT NULL DEFAULT 0,
        uncertain INTEGER NOT NULL DEFAULT 0,
        canceled INTEGER NOT NULL DEFAULT 0,
        pause_reason TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS queue_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        contact_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        delivery_id INTEGER,
        leased_at TEXT,
        finished_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, contact_id),
        FOREIGN KEY (run_id) REFERENCES campaign_runs(id),
        FOREIGN KEY (contact_id) REFERENCES contacts(id)
      );

      CREATE INDEX IF NOT EXISTS idx_queue_jobs_run_status ON queue_jobs(run_id, status, position);

      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        job_id INTEGER,
        contact_id INTEGER NOT NULL,
        template_hash TEXT NOT NULL,
        rendered_message TEXT NOT NULL,
        status TEXT NOT NULL,
        message_id TEXT,
        ack INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        FOREIGN KEY (contact_id) REFERENCES contacts(id)
      );

      CREATE INDEX IF NOT EXISTS idx_deliveries_contact ON deliveries(contact_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_deliveries_message_id ON deliveries(message_id);
      CREATE INDEX IF NOT EXISTS idx_deliveries_sent_at ON deliveries(sent_at);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        type TEXT NOT NULL,
        contact_id INTEGER,
        title TEXT NOT NULL,
        detail_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (contact_id) REFERENCES contacts(id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
    `);

    this.ensureColumn('campaign_runs', 'canceled', 'INTEGER NOT NULL DEFAULT 0');

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO NOTHING
    `).run('message_template', JSON.stringify(DEFAULT_TEMPLATE), now);
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  recoverInterruptedWork() {
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`
        UPDATE deliveries
        SET status = 'uncertain', error = COALESCE(error, 'Processo interrompido durante o envio.'), updated_at = ?
        WHERE status = 'sending'
      `).run(now);
      this.db.prepare(`
        UPDATE queue_jobs
        SET status = 'uncertain', error = COALESCE(error, 'Processo interrompido durante o envio.'), finished_at = ?, updated_at = ?
        WHERE status = 'sending'
      `).run(now, now);
      this.db.prepare(`
        UPDATE contacts
        SET status = 'uncertain', last_error = 'Resultado incerto; revisão manual necessária.', updated_at = ?
        WHERE status = 'sending'
      `).run(now);
      this.db.prepare(`
        UPDATE campaign_runs
        SET status = 'paused', pause_reason = 'O aplicativo foi reiniciado. Revise qualquer envio incerto antes de continuar.', updated_at = ?
        WHERE status = 'running'
      `).run(now);
      this.db.exec(`
        UPDATE campaign_runs
        SET
          processed = (SELECT COUNT(*) FROM queue_jobs j WHERE j.run_id = campaign_runs.id AND j.status IN ('sent', 'failed', 'invalid', 'uncertain', 'canceled')),
          sent = (SELECT COUNT(*) FROM queue_jobs j WHERE j.run_id = campaign_runs.id AND j.status = 'sent'),
          failed = (SELECT COUNT(*) FROM queue_jobs j WHERE j.run_id = campaign_runs.id AND j.status = 'failed'),
          invalid = (SELECT COUNT(*) FROM queue_jobs j WHERE j.run_id = campaign_runs.id AND j.status = 'invalid'),
          uncertain = (SELECT COUNT(*) FROM queue_jobs j WHERE j.run_id = campaign_runs.id AND j.status = 'uncertain'),
          canceled = (SELECT COUNT(*) FROM queue_jobs j WHERE j.run_id = campaign_runs.id AND j.status = 'canceled')
        WHERE status IN ('running', 'paused')
      `);
    });
  }

  seedIfEmpty(seedPath) {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM contacts').get();
    if (Number(row.count) > 0) return;
    // Instalação nova começa vazia: a lista entra pelo comando de importação.
    if (!seedPath || !fs.existsSync(seedPath)) return;

    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const now = new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT INTO contacts (
        source_index, source_line, section_occurrence, company_raw, company_display, city,
        phone_raw, phone_digits, phone_e164, whatsapp_digits, phone_kind, source_tag,
        ddd_mismatch, needs_review, review_approved, consent_status, status, sent_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.transaction(() => {
      for (const contact of seed.contacts) {
        insert.run(
          contact.sourceIndex,
          contact.sourceLine,
          contact.sectionOccurrence,
          contact.companyRaw,
          contact.companyDisplay,
          contact.city,
          contact.phoneRaw,
          contact.phoneDigits,
          contact.phoneE164,
          contact.whatsappDigits,
          contact.phoneKind,
          contact.sourceTag,
          contact.dddMismatch ? 1 : 0,
          contact.needsReview ? 1 : 0,
          contact.reviewApproved ? 1 : 0,
          contact.consentStatus,
          contact.status,
          contact.sentAt,
          now,
          now,
        );
      }

      this.db.prepare(`
        INSERT INTO imports (source_hash, summary_json, imported_at)
        VALUES (?, ?, ?)
      `).run(seed.sourceHash, JSON.stringify(seed.summary), seed.importedAt || now);

      this.recordEvent({
        type: 'import.completed',
        title: `${seed.contacts.length} contatos importados`,
        detail: seed.summary,
      });
    });
  }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  }

  setSetting(key, value) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), now);
  }

  getSummary() {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(status = 'pending') AS pending,
        SUM(status = 'sent') AS sent,
        SUM(status = 'replied') AS replied,
        SUM(status = 'suppressed') AS suppressed,
        SUM(status = 'invalid') AS invalid,
        SUM(status = 'failed') AS failed,
        SUM(status = 'uncertain') AS uncertain,
        SUM(phone_kind = 'mobile') AS mobile,
        SUM(phone_kind = 'landline') AS landline,
        SUM(needs_review = 1 AND review_approved = 0) AS awaiting_review,
        SUM(consent_status = 'confirmed') AS authorized,
        SUM(status = 'pending' AND consent_status = 'unknown') AS awaiting_consent,
        SUM(${ELIGIBLE_CONDITION}) AS eligible
      FROM contacts
    `).get();

    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value || 0)]));
  }

  getCities() {
    return this.db.prepare(`
      SELECT city, COUNT(*) AS total
      FROM contacts
      WHERE city <> ''
      GROUP BY city
      ORDER BY city COLLATE NOCASE
    `).all().map((row) => ({ city: row.city, total: Number(row.total) }));
  }

  getImportSummary() {
    const row = this.db.prepare(`
      SELECT source_hash, summary_json, imported_at FROM imports ORDER BY id DESC LIMIT 1
    `).get();
    return row ? {
      sourceHash: row.source_hash,
      summary: safeJson(row.summary_json),
      importedAt: row.imported_at,
    } : null;
  }

  listContacts({ search = '', filter = 'all', city = '', page = 1, pageSize = 30 } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.min(100, Math.max(10, Number.parseInt(pageSize, 10) || 30));
    const conditions = [];
    const params = [];

    if (search.trim()) {
      conditions.push('(company_display LIKE ? ESCAPE \'\\\' OR phone_raw LIKE ? ESCAPE \'\\\')');
      const escaped = search.trim().replace(/[\\%_]/g, '\\$&');
      params.push(`%${escaped}%`, `%${escaped}%`);
    }
    if (city) {
      conditions.push('city = ?');
      params.push(city);
    }

    const filterSql = {
      all: null,
      eligible: ELIGIBLE_CONDITION,
      pending: "status = 'pending'",
      consent: "status = 'pending' AND consent_status = 'unknown'",
      review: 'needs_review = 1 AND review_approved = 0',
      landline: "phone_kind = 'landline'",
      invalid: "status = 'invalid'",
      sent: "status = 'sent'",
      replied: "status = 'replied'",
      suppressed: "status = 'suppressed'",
      uncertain: "status = 'uncertain'",
      failed: "status = 'failed'",
    }[filter];
    if (filterSql) conditions.push(filterSql);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRow = this.db.prepare(`SELECT COUNT(*) AS total FROM contacts ${where}`).get(...params);
    const offset = (safePage - 1) * safePageSize;
    const rows = this.db.prepare(`
      SELECT * FROM contacts
      ${where}
      ORDER BY source_index
      LIMIT ? OFFSET ?
    `).all(...params, safePageSize, offset);

    return {
      items: rows.map(toPublicContact),
      pagination: {
        page: safePage,
        pageSize: safePageSize,
        total: Number(countRow.total),
        pages: Math.max(1, Math.ceil(Number(countRow.total) / safePageSize)),
      },
    };
  }

  /**
   * Acrescenta contatos vindos de uma lista importada. Telefone já presente é
   * pulado, nunca sobrescrito: reimportar o mesmo arquivo não duplica ninguém
   * nem apaga o opt-in já registrado.
   */
  importContacts(contacts) {
    const now = new Date().toISOString();
    const nextIndex = Number(
      this.db.prepare('SELECT COALESCE(MAX(source_index), 0) AS last FROM contacts').get().last,
    );
    const existing = this.db.prepare('SELECT 1 FROM contacts WHERE phone_e164 = ?');
    const insert = this.db.prepare(`
      INSERT INTO contacts (
        source_index, source_line, section_occurrence, company_raw, company_display, city,
        phone_raw, phone_digits, phone_e164, whatsapp_digits, phone_kind, source_tag,
        ddd_mismatch, needs_review, review_approved, consent_status, status, sent_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const report = { inserted: 0, duplicated: 0, invalid: 0 };
    this.transaction(() => {
      let index = nextIndex;
      for (const contact of contacts) {
        if (contact.phoneE164 && existing.get(contact.phoneE164)) {
          report.duplicated += 1;
          continue;
        }
        if (!contact.phoneE164) report.invalid += 1;

        index += 1;
        insert.run(
          index,
          contact.sourceLine ?? null,
          contact.sectionOccurrence ?? 0,
          contact.companyRaw || '',
          contact.companyDisplay || '',
          contact.city || '',
          contact.phoneRaw,
          contact.phoneDigits,
          contact.phoneE164,
          contact.whatsappDigits,
          contact.phoneKind,
          contact.sourceTag ?? null,
          contact.dddMismatch ? 1 : 0,
          contact.needsReview ? 1 : 0,
          contact.reviewApproved ? 1 : 0,
          contact.consentStatus || 'unknown',
          contact.status || 'pending',
          contact.sentAt ?? null,
          now,
          now,
        );
        report.inserted += 1;
      }

      this.recordEvent({
        type: 'import.completed',
        title: `${report.inserted} contato(s) importados`,
        detail: report,
      });
    });

    return report;
  }

  getContact(id) {
    const row = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(id));
    return row ? toPublicContact(row) : null;
  }

  getContactInternal(id) {
    return this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(id)) || null;
  }

  findContactByWhatsAppDigits(value) {
    const digits = digitsOnly(value);
    const row = this.db.prepare('SELECT * FROM contacts WHERE whatsapp_digits = ?').get(digits);
    return row || null;
  }

  updateCompanyName(id, companyDisplay) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE contacts SET company_display = ?, updated_at = ? WHERE id = ?
    `).run(companyDisplay, now, Number(id));
    return Number(result.changes) > 0;
  }

  confirmConsent(id, note = '') {
    const contact = this.getContactInternal(id);
    if (!contact) return false;
    if (['sent', 'replied', 'suppressed', 'invalid', 'uncertain'].includes(contact.status)) {
      const error = new Error('Este contato não pode ser autorizado no estado atual.');
      error.code = 'CONTACT_BLOCKED';
      throw error;
    }

    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`
        UPDATE contacts
        SET consent_status = 'confirmed', consent_note = ?, consent_confirmed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(String(note || '').trim().slice(0, 240) || null, now, now, Number(id));
      this.recordEvent({
        type: 'contact.consent_confirmed',
        contactId: Number(id),
        title: `Opt-in registrado para ${displayNameFor(contact)}`,
      });
    });
    return true;
  }

  approveReview(id) {
    const contact = this.getContactInternal(id);
    if (!contact) return false;
    if (!contact.phone_e164) {
      const error = new Error('Corrija o telefone antes de aprovar este contato.');
      error.code = 'INVALID_PHONE';
      throw error;
    }
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare('UPDATE contacts SET review_approved = 1, updated_at = ? WHERE id = ?').run(now, Number(id));
      this.recordEvent({
        type: 'contact.review_approved',
        contactId: Number(id),
        title: `Dados de ${displayNameFor(contact)} aprovados`,
      });
    });
    return true;
  }

  suppressContact(id, reason = 'Solicitação manual') {
    const contact = this.getContactInternal(id);
    if (!contact) return false;
    if (!contact.phone_e164) {
      const error = new Error('Contato sem telefone não pode entrar na lista de supressão.');
      error.code = 'INVALID_PHONE';
      throw error;
    }
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO suppressions (phone_e164, contact_id, reason, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(phone_e164) DO NOTHING
      `).run(contact.phone_e164, Number(id), String(reason).slice(0, 240), now);
      this.db.prepare(`
        UPDATE contacts SET status = 'suppressed', updated_at = ? WHERE id = ?
      `).run(now, Number(id));
      this.cancelPendingJobsForContact(Number(id), 'Contato suprimido', now);
      this.recordEvent({
        type: 'contact.suppressed',
        contactId: Number(id),
        title: `${displayNameFor(contact)} não receberá novas mensagens`,
        detail: { reason: String(reason).slice(0, 240) },
      });
    });
    return true;
  }

  recordInbound({ from, body, isOptOut }) {
    const contact = this.findContactByWhatsAppDigits(from);
    if (!contact) return null;
    const now = new Date().toISOString();
    const snippet = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const alreadySuppressed = Boolean(contact.phone_e164 && this.db.prepare(`
      SELECT 1 FROM suppressions WHERE phone_e164 = ?
    `).get(contact.phone_e164));
    const remainsSuppressed = Boolean(isOptOut || alreadySuppressed);

    this.transaction(() => {
      if (isOptOut && contact.phone_e164) {
        this.db.prepare(`
          INSERT INTO suppressions (phone_e164, contact_id, reason, created_at)
          VALUES (?, ?, 'Pedido de saída recebido no WhatsApp', ?)
          ON CONFLICT(phone_e164) DO NOTHING
        `).run(contact.phone_e164, contact.id, now);
      }
      this.db.prepare(`
        UPDATE contacts
        SET status = ?, replied_at = ?, updated_at = ?
        WHERE id = ?
      `).run(remainsSuppressed ? 'suppressed' : 'replied', now, now, contact.id);
      this.cancelPendingJobsForContact(contact.id, remainsSuppressed ? 'Contato suprimido' : 'Contato respondeu', now);
      this.recordEvent({
        type: isOptOut ? 'message.opt_out' : remainsSuppressed ? 'message.reply_suppressed' : 'message.reply',
        contactId: contact.id,
        title: isOptOut
          ? `${displayNameFor(contact)} pediu para não receber mensagens`
          : remainsSuppressed
            ? `${displayNameFor(contact)} respondeu e continua bloqueado para novos contatos`
          : `${displayNameFor(contact)} respondeu`,
        detail: { snippet },
      });
    });

    return toPublicContact(this.getContactInternal(contact.id));
  }

  selectEligibleContacts(limit) {
    return this.db.prepare(`
      SELECT *
      FROM contacts
      WHERE ${ELIGIBLE_CONDITION}
      ORDER BY source_index
      LIMIT ?
    `).all(Number(limit));
  }

  // Mantém apenas os ids que continuam elegíveis agora. A ordem de envio segue
  // source_index, não a ordem em que o painel mandou os ids.
  selectEligibleContactsByIds(ids) {
    const unique = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!unique.length) return [];
    const placeholders = unique.map(() => '?').join(', ');
    return this.db.prepare(`
      SELECT *
      FROM contacts
      WHERE id IN (${placeholders})
        AND ${ELIGIBLE_CONDITION}
      ORDER BY source_index
    `).all(...unique);
  }

  createCampaign({ contactIds, templateHash, intervalSeconds }) {
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const insertJob = this.db.prepare(`
      INSERT INTO queue_jobs (run_id, contact_id, position, status, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `);

    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO campaign_runs (
          id, status, template_hash, interval_seconds, total, created_at, started_at, updated_at
        ) VALUES (?, 'running', ?, ?, ?, ?, ?, ?)
      `).run(runId, templateHash, Number(intervalSeconds), contactIds.length, now, now, now);

      contactIds.forEach((contactId, index) => insertJob.run(runId, Number(contactId), index + 1, now, now));
      this.recordEvent({
        type: 'campaign.started',
        title: `Lote iniciado com ${contactIds.length} contato(s)`,
        detail: { runId, intervalSeconds },
      });
    });

    return this.getRun(runId);
  }

  getRun(id) {
    return this.db.prepare('SELECT * FROM campaign_runs WHERE id = ?').get(id) || null;
  }

  getActiveRun() {
    const placeholders = ACTIVE_RUN_STATUSES.map(() => '?').join(', ');
    return this.db.prepare(`
      SELECT * FROM campaign_runs
      WHERE status IN (${placeholders})
      ORDER BY created_at DESC LIMIT 1
    `).get(...ACTIVE_RUN_STATUSES) || null;
  }

  getQueueView() {
    const run = this.getActiveRun() || this.db.prepare(`
      SELECT * FROM campaign_runs ORDER BY created_at DESC LIMIT 1
    `).get();

    if (!run) {
      return { status: 'idle', runId: null, total: 0, processed: 0, sent: 0, failed: 0, invalid: 0, uncertain: 0, canceled: 0 };
    }

    const current = this.db.prepare(`
      SELECT c.id, c.source_index, c.company_display, c.city, c.phone_raw, c.phone_e164, j.status
      FROM queue_jobs j JOIN contacts c ON c.id = j.contact_id
      WHERE j.run_id = ? AND j.status = 'sending'
      ORDER BY j.position LIMIT 1
    `).get(run.id);
    const next = this.db.prepare(`
      SELECT c.id, c.source_index, c.company_display, c.city, c.phone_raw, c.phone_e164, j.status
      FROM queue_jobs j JOIN contacts c ON c.id = j.contact_id
      WHERE j.run_id = ? AND j.status = 'pending'
      ORDER BY j.position LIMIT 1
    `).get(run.id);

    return {
      runId: run.id,
      status: run.status,
      total: Number(run.total),
      processed: Number(run.processed),
      sent: Number(run.sent),
      failed: Number(run.failed),
      invalid: Number(run.invalid),
      uncertain: Number(run.uncertain),
      canceled: Number(run.canceled || 0),
      intervalSeconds: Number(run.interval_seconds),
      pauseReason: run.pause_reason,
      nextRunAt: run.next_run_at,
      startedAt: run.started_at,
      current: current ? toQueueContact(current) : null,
      next: next ? toQueueContact(next) : null,
    };
  }

  leaseNextJob(runId, renderedMessage, templateHash) {
    const now = new Date().toISOString();
    return this.transaction(() => {
      const job = this.db.prepare(`
        SELECT j.*, c.*,
          j.id AS job_id,
          c.id AS contact_id
        FROM queue_jobs j
        JOIN contacts c ON c.id = j.contact_id
        WHERE j.run_id = ? AND j.status = 'pending'
        ORDER BY j.position
        LIMIT 1
      `).get(runId);
      if (!job) return null;

      const delivery = this.db.prepare(`
        INSERT INTO deliveries (
          run_id, job_id, contact_id, template_hash, rendered_message, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'sending', ?, ?)
      `).run(runId, job.job_id, job.contact_id, templateHash, renderedMessage(job), now, now);
      const deliveryId = Number(delivery.lastInsertRowid);

      this.db.prepare(`
        UPDATE queue_jobs
        SET status = 'sending', delivery_id = ?, leased_at = ?, updated_at = ?
        WHERE id = ?
      `).run(deliveryId, now, now, job.job_id);
      this.db.prepare(`
        UPDATE contacts
        SET status = 'sending', attempts = attempts + 1, last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(now, job.contact_id);
      return { ...job, deliveryId };
    });
  }

  completeJob({ jobId, contactId, deliveryId, outcome, messageId = null, error = null }) {
    const now = new Date().toISOString();
    const mapping = {
      sent: { job: 'sent', contact: 'sent', delivery: 'sent', counter: 'sent' },
      invalid: { job: 'invalid', contact: 'invalid', delivery: 'invalid', counter: 'invalid' },
      failed: { job: 'failed', contact: 'failed', delivery: 'failed', counter: 'failed' },
      uncertain: { job: 'uncertain', contact: 'uncertain', delivery: 'uncertain', counter: 'uncertain' },
    }[outcome];
    if (!mapping) throw new Error(`Resultado de fila desconhecido: ${outcome}`);

    this.transaction(() => {
      this.db.prepare(`
        UPDATE queue_jobs
        SET status = ?, error = ?, finished_at = ?, updated_at = ?
        WHERE id = ?
      `).run(mapping.job, error, now, now, jobId);
      this.db.prepare(`
        UPDATE deliveries
        SET status = ?, message_id = ?, error = ?, sent_at = ?, updated_at = ?
        WHERE id = ?
      `).run(mapping.delivery, messageId, error, outcome === 'sent' ? now : null, now, deliveryId);
      this.db.prepare(`
        UPDATE contacts
        SET status = CASE WHEN status IN ('suppressed', 'replied') THEN status ELSE ? END,
            last_message_id = ?, last_error = ?, sent_at = ?, updated_at = ?
        WHERE id = ?
      `).run(mapping.contact, messageId, error, outcome === 'sent' ? now : null, now, contactId);

      const job = this.db.prepare('SELECT run_id FROM queue_jobs WHERE id = ?').get(jobId);
      this.db.prepare(`
        UPDATE campaign_runs
        SET processed = processed + 1, ${mapping.counter} = ${mapping.counter} + 1, updated_at = ?
        WHERE id = ?
      `).run(now, job.run_id);
      this.recordEvent({
        level: outcome === 'sent' ? 'success' : outcome === 'invalid' ? 'warning' : 'error',
        type: `message.${outcome}`,
        contactId,
        title: outcomeTitle(outcome, displayNameFor(this.getContactInternal(contactId))),
        detail: error ? { error: String(error).slice(0, 300) } : null,
      });
    });
  }

  finishCampaignIfDone(runId) {
    const outstanding = this.db.prepare(`
      SELECT COUNT(*) AS count FROM queue_jobs WHERE run_id = ? AND status IN ('pending', 'sending')
    `).get(runId);
    if (Number(outstanding.count) > 0) return false;
    const current = this.getRun(runId);
    if (!current || current.status === 'canceled') return true;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE campaign_runs
      SET status = 'completed', pause_reason = NULL, next_run_at = NULL, finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, runId);
    const run = this.getRun(runId);
    this.recordEvent({
      type: 'campaign.completed',
      title: `Lote concluído: ${run.sent} enviada(s)`,
      detail: { runId, sent: run.sent, failed: run.failed, invalid: run.invalid, uncertain: run.uncertain },
    });
    return true;
  }

  pauseCampaign(runId, reason) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE campaign_runs SET status = 'paused', pause_reason = ?, next_run_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(String(reason || 'Pausado manualmente').slice(0, 300), now, runId);
    this.recordEvent({ type: 'campaign.paused', title: 'Lote pausado', detail: { runId, reason } });
  }

  resumeCampaign(runId) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE campaign_runs SET status = 'running', pause_reason = NULL, updated_at = ?
      WHERE id = ? AND status = 'paused'
    `).run(now, runId);
    if (Number(result.changes) > 0) {
      this.recordEvent({ type: 'campaign.resumed', title: 'Lote retomado', detail: { runId } });
      return true;
    }
    return false;
  }

  cancelCampaign(runId) {
    const now = new Date().toISOString();
    this.transaction(() => {
      const pending = this.db.prepare(`
        SELECT COUNT(*) AS count FROM queue_jobs WHERE run_id = ? AND status = 'pending'
      `).get(runId);
      const canceledCount = Number(pending.count);
      this.db.prepare(`
        UPDATE queue_jobs
        SET status = 'canceled', error = 'Lote cancelado', finished_at = ?, updated_at = ?
        WHERE run_id = ? AND status = 'pending'
      `).run(now, now, runId);
      this.db.prepare(`
        UPDATE campaign_runs
        SET status = 'canceled', processed = processed + ?, canceled = canceled + ?,
            pause_reason = NULL, next_run_at = NULL, finished_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('running', 'paused')
      `).run(canceledCount, canceledCount, now, now, runId);
      this.recordEvent({ type: 'campaign.canceled', title: 'Lote cancelado', detail: { runId } });
    });
  }

  cancelPendingJobsForContact(contactId, reason, now = new Date().toISOString()) {
    const jobs = this.db.prepare(`
      SELECT id, run_id FROM queue_jobs WHERE contact_id = ? AND status = 'pending'
    `).all(Number(contactId));
    if (!jobs.length) return 0;

    const cancelJob = this.db.prepare(`
      UPDATE queue_jobs
      SET status = 'canceled', error = ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `);
    const updateRun = this.db.prepare(`
      UPDATE campaign_runs
      SET processed = processed + 1, canceled = canceled + 1, updated_at = ?
      WHERE id = ?
    `);
    let changed = 0;
    for (const job of jobs) {
      const result = cancelJob.run(reason, now, now, job.id);
      if (Number(result.changes) > 0) {
        updateRun.run(now, job.run_id);
        changed += 1;
      }
    }
    return changed;
  }

  setNextRunAt(runId, value) {
    this.db.prepare('UPDATE campaign_runs SET next_run_at = ?, updated_at = ? WHERE id = ?')
      .run(value, new Date().toISOString(), runId);
  }

  countSentSince(isoTimestamp) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM deliveries WHERE status = 'sent' AND sent_at >= ?
    `).get(isoTimestamp);
    return Number(row.count);
  }

  countSentToday() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM deliveries
      WHERE status = 'sent' AND date(sent_at, 'localtime') = date('now', 'localtime')
    `).get();
    return Number(row.count);
  }

  updateMessageAck(messageId, ack) {
    if (!messageId) return;
    this.db.prepare(`
      UPDATE deliveries SET ack = ?, updated_at = ? WHERE message_id = ?
    `).run(Number(ack), new Date().toISOString(), messageId);
  }

  recordEvent({ level = 'info', type, contactId = null, title, detail = null }) {
    this.db.prepare(`
      INSERT INTO events (level, type, contact_id, title, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(level, type, contactId, title, detail ? JSON.stringify(detail) : null, new Date().toISOString());
  }

  listEvents(limit = 30) {
    return this.db.prepare(`
      SELECT e.*, c.source_index, c.company_display, c.phone_raw
      FROM events e
      LEFT JOIN contacts c ON c.id = e.contact_id
      ORDER BY e.id DESC
      LIMIT ?
    `).all(Math.min(100, Math.max(1, Number(limit) || 30))).map((row) => ({
      id: Number(row.id),
      level: row.level,
      type: row.type,
      title: row.title,
      company: row.contact_id ? displayNameFor(row) : null,
      detail: safeJson(row.detail_json),
      createdAt: row.created_at,
    }));
  }

  exportRows() {
    return this.db.prepare(`
      SELECT source_index, company_display, city, phone_raw, phone_e164, phone_kind,
             source_tag, needs_review, review_approved, consent_status, status, sent_at, replied_at, last_error
      FROM contacts ORDER BY source_index
    `).all();
  }
}

function toPublicContact(row) {
  return {
    id: Number(row.id),
    sourceIndex: Number(row.source_index),
    company: displayNameFor(row),
    companyName: row.company_display || '',
    hasCompanyName: Boolean(row.company_display),
    companyRaw: row.company_raw,
    city: row.city,
    phoneRaw: row.phone_raw,
    phoneMasked: maskPhone(row.phone_e164),
    phoneKind: row.phone_kind,
    sourceTag: row.source_tag,
    dddMismatch: Boolean(row.ddd_mismatch),
    needsReview: Boolean(row.needs_review),
    reviewApproved: Boolean(row.review_approved),
    consentStatus: row.consent_status,
    consentNote: row.consent_note,
    status: row.status,
    attempts: Number(row.attempts),
    lastError: row.last_error,
    sentAt: row.sent_at,
    repliedAt: row.replied_at,
    eligible: isEligibleContact(row),
  };
}

// Mesma regra do SQL em ELIGIBLE_CONDITION, aplicada a uma linha já carregada.
// A supressão não entra aqui: ela é verificada na consulta.
function isEligibleContact(row) {
  return row.status === 'pending'
    && row.consent_status === 'confirmed'
    && Boolean(row.review_approved)
    && Boolean(row.phone_e164);
}

// Um contato importado só com o número não tem nome para mostrar; a tela cai
// para o telefone e, se nem isso houver, para o índice da linha importada.
function displayNameFor(row) {
  return row.company_display || row.phone_raw || `#${row.source_index}`;
}

function toQueueContact(row) {
  return {
    id: Number(row.id),
    company: displayNameFor(row),
    city: row.city,
    phoneMasked: maskPhone(row.phone_e164),
    status: row.status,
  };
}

function safeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function outcomeTitle(outcome, company) {
  return {
    sent: `Mensagem enviada para ${company}`,
    invalid: `${company} não possui WhatsApp ativo`,
    failed: `Falha antes do envio para ${company}`,
    uncertain: `Envio para ${company} ficou incerto`,
  }[outcome];
}

module.exports = { AppDatabase, isEligibleContact };
