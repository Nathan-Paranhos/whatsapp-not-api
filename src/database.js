const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_TEMPLATE } = require('./lib/template');
const { digitsOnly, maskPhone, normalizeBrazilianPhone, hasCityDddMismatch } = require('./lib/phones');

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

      -- Cada execução de importação vira um lote, para poder ser desfeita
      -- inteira depois. Contatos anteriores a isto ficam com import_batch_id
      -- nulo e simplesmente não pertencem a lote nenhum.
      CREATE TABLE IF NOT EXISTS import_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT,
        format TEXT,
        inserted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contact_tags (
        contact_id INTEGER NOT NULL,
        tag TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (contact_id, tag),
        FOREIGN KEY (contact_id) REFERENCES contacts(id)
      );

      CREATE INDEX IF NOT EXISTS idx_contact_tags_tag ON contact_tags(tag);
    `);

    this.ensureColumn('campaign_runs', 'canceled', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('contacts', 'import_batch_id', 'INTEGER');

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

  // Variáveis personalizadas vivem em settings: são configuração do painel,
  // não dado de contato.
  getCustomVariables() {
    const bruto = this.getSetting('custom_variables');
    if (!Array.isArray(bruto)) return [];
    return bruto
      .filter((item) => item && typeof item.name === 'string')
      .map((item) => ({ name: item.name, value: String(item.value ?? '') }));
  }

  setCustomVariables(list) {
    this.setSetting('custom_variables', list);
    this.recordEvent({
      type: 'variables.updated',
      title: `${list.length} variável(is) personalizada(s) salva(s)`,
      detail: { names: list.map((item) => item.name) },
    });
    return this.getCustomVariables();
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

  // Monta o WHERE usado pela listagem, pela contagem e pela exclusão em massa.
  // Um lugar só evita que a tela mostre um conjunto e a exclusão apague outro.
  buildContactFilter({ search = '', filter = 'all', city = '', tag = '', importBatchId = null } = {}) {
    const conditions = [];
    const params = [];

    if (Number.isInteger(Number(importBatchId)) && importBatchId !== null && importBatchId !== '') {
      conditions.push('import_batch_id = ?');
      params.push(Number(importBatchId));
    }
    if (String(tag).trim()) {
      conditions.push('EXISTS (SELECT 1 FROM contact_tags t WHERE t.contact_id = contacts.id AND t.tag = ?)');
      params.push(String(tag).trim());
    }

    if (String(search).trim()) {
      conditions.push('(company_display LIKE ? ESCAPE \'\\\' OR phone_raw LIKE ? ESCAPE \'\\\')');
      const escaped = String(search).trim().replace(/[\\%_]/g, '\\$&');
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
      unnamed: "company_display = ''",
    }[filter];
    if (filterSql) conditions.push(filterSql);

    return {
      where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
      params,
    };
  }

  countContacts(criteria) {
    const { where, params } = this.buildContactFilter(criteria);
    return Number(this.db.prepare(`SELECT COUNT(*) AS total FROM contacts ${where}`).get(...params).total);
  }

  listContacts({ page = 1, pageSize = 30, ...criteria } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.min(100, Math.max(10, Number.parseInt(pageSize, 10) || 30));
    // Repassa o critério inteiro: qualquer filtro novo (etiqueta, lote) passa a
    // valer na listagem sem precisar ser costurado aqui de novo.
    const { where, params } = this.buildContactFilter(criteria);
    const countRow = this.db.prepare(`SELECT COUNT(*) AS total FROM contacts ${where}`).get(...params);
    const offset = (safePage - 1) * safePageSize;
    const rows = this.db.prepare(`
      SELECT *, EXISTS(SELECT 1 FROM suppressions s WHERE s.phone_e164 = contacts.phone_e164) AS is_suppressed,
             (SELECT GROUP_CONCAT(t.tag, ',') FROM contact_tags t WHERE t.contact_id = contacts.id) AS tag_list FROM contacts
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
  importContacts(contacts, { source = null, format = null } = {}) {
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
        import_batch_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const report = { inserted: 0, duplicated: 0, invalid: 0, batchId: null };
    this.transaction(() => {
      // Cada importação vira um lote próprio, para poder ser desfeita inteira
      // depois sem depender de filtro nenhum.
      report.batchId = Number(this.db.prepare(`
        INSERT INTO import_batches (source, format, created_at) VALUES (?, ?, ?)
      `).run(source, format, now).lastInsertRowid);

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
          report.batchId,
          now,
          now,
        );
        report.inserted += 1;
      }

      this.db.prepare('UPDATE import_batches SET inserted = ? WHERE id = ?')
        .run(report.inserted, report.batchId);
      this.recordEvent({
        type: 'import.completed',
        title: `${report.inserted} contato(s) importados`,
        detail: report,
      });
    });

    return report;
  }

  /**
   * Lotes de importação, com quantos contatos daquele lote ainda existem. Os
   * contatos da lista inicial e os de versões anteriores ficam fora — eles não
   * pertencem a lote nenhum e por isso não aparecem aqui.
   */
  listImportBatches(limit = 30) {
    return this.db.prepare(`
      SELECT b.id, b.source, b.format, b.inserted, b.created_at,
             (SELECT COUNT(*) FROM contacts c WHERE c.import_batch_id = b.id) AS remaining
      FROM import_batches b
      ORDER BY b.id DESC
      LIMIT ?
    `).all(Math.min(100, Math.max(1, Number(limit) || 30))).map((row) => ({
      id: Number(row.id),
      source: row.source,
      format: row.format,
      inserted: Number(row.inserted),
      remaining: Number(row.remaining),
      createdAt: row.created_at,
    }));
  }

  // Desfaz uma importação inteira: apaga só o que entrou naquele lote e que
  // ainda está lá. Usa a mesma exclusão segura, então a supressão sobrevive.
  deleteImportBatch(batchId) {
    const batch = this.db.prepare('SELECT * FROM import_batches WHERE id = ?').get(Number(batchId));
    if (!batch) return null;

    const result = this.deleteContactsByFilter({ importBatchId: Number(batchId) });
    this.db.prepare('DELETE FROM import_batches WHERE id = ?').run(Number(batchId));
    return { ...result, source: batch.source };
  }

  // --- 3. etiquetas -----------------------------------------------------------

  listTags() {
    return this.db.prepare(`
      SELECT t.tag, COUNT(*) AS total
      FROM contact_tags t
      JOIN contacts c ON c.id = t.contact_id
      GROUP BY t.tag
      ORDER BY t.tag COLLATE NOCASE
    `).all().map((row) => ({ tag: row.tag, total: Number(row.total) }));
  }

  listContactTags(contactId) {
    return this.db.prepare('SELECT tag FROM contact_tags WHERE contact_id = ? ORDER BY tag COLLATE NOCASE')
      .all(Number(contactId)).map((row) => row.tag);
  }

  /**
   * Substitui as etiquetas do contato pelo conjunto informado. Etiqueta é
   * texto livre curto, normalizado em minúsculas para "Clientes" e "clientes"
   * não virarem dois segmentos diferentes.
   */
  setContactTags(id, tags) {
    const contact = this.getContactInternal(id);
    if (!contact) return false;

    const limpas = [...new Set(
      (Array.isArray(tags) ? tags : [])
        .map((tag) => String(tag).trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 40))
        .filter(Boolean),
    )].slice(0, 20);

    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare('DELETE FROM contact_tags WHERE contact_id = ?').run(Number(id));
      const insert = this.db.prepare('INSERT INTO contact_tags (contact_id, tag, created_at) VALUES (?, ?, ?)');
      for (const tag of limpas) insert.run(Number(id), tag, now);
    });
    return true;
  }

  hasJobInActiveRun(contactId) {
    const placeholders = ACTIVE_RUN_STATUSES.map(() => '?').join(', ');
    return Boolean(this.db.prepare(`
      SELECT 1 FROM queue_jobs j
      JOIN campaign_runs r ON r.id = j.run_id
      WHERE j.contact_id = ? AND r.status IN (${placeholders})
      LIMIT 1
    `).get(Number(contactId), ...ACTIVE_RUN_STATUSES));
  }

  // O que se perde ao apagar este contato — a tela usa isso para avisar antes.
  getContactStats(id) {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM deliveries WHERE contact_id = ?) AS deliveries,
        (SELECT COUNT(*) FROM deliveries WHERE contact_id = ? AND status = 'sent') AS sent,
        (SELECT COUNT(*) FROM suppressions WHERE contact_id = ?) AS suppressed
    `).get(Number(id), Number(id), Number(id));
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value || 0)]));
  }

  /**
   * Remove o contato de vez. A supressão NÃO vai junto: ela é regravada sem
   * dono, presa ao telefone. Assim, apagar alguém que pediu SAIR — de propósito
   * ou por engano — não o traz de volta para a fila numa reimportação.
   */
  deleteContact(id) {
    const contact = this.getContactInternal(id);
    if (!contact) return false;
    if (this.hasJobInActiveRun(id)) {
      const error = new Error('Este contato está em um lote ativo. Conclua ou cancele o lote antes de apagar.');
      error.code = 'CONTACT_IN_ACTIVE_RUN';
      throw error;
    }

    this.transaction(() => {
      this.db.prepare('UPDATE suppressions SET contact_id = NULL WHERE contact_id = ?').run(Number(id));
      this.db.prepare('UPDATE events SET contact_id = NULL WHERE contact_id = ?').run(Number(id));
      this.db.prepare('DELETE FROM contact_tags WHERE contact_id = ?').run(Number(id));
      this.db.prepare('DELETE FROM queue_jobs WHERE contact_id = ?').run(Number(id));
      this.db.prepare('DELETE FROM deliveries WHERE contact_id = ?').run(Number(id));
      this.db.prepare('DELETE FROM contacts WHERE id = ?').run(Number(id));
      this.recordEvent({
        type: 'contact.deleted',
        title: `${displayNameFor(contact)} foi apagado da lista`,
        detail: { phoneMasked: maskPhone(contact.phone_e164), suppressionKept: true },
      });
    });
    return true;
  }

  /**
   * Apaga em massa exatamente o conjunto que a tela está mostrando. Recusa
   * enquanto houver lote ativo, para não apagar o chão sob os pés da fila.
   */
  deleteContactsByFilter(criteria) {
    if (this.getActiveRun()) {
      const error = new Error('Conclua ou cancele o lote atual antes de apagar contatos em massa.');
      error.code = 'CAMPAIGN_ACTIVE';
      throw error;
    }

    const { where, params } = this.buildContactFilter(criteria);
    const ids = this.db.prepare(`SELECT id FROM contacts ${where}`).all(...params).map((row) => Number(row.id));
    if (!ids.length) return { deleted: 0 };

    const placeholders = ids.map(() => '?').join(', ');
    this.transaction(() => {
      this.db.prepare(`UPDATE suppressions SET contact_id = NULL WHERE contact_id IN (${placeholders})`).run(...ids);
      this.db.prepare(`UPDATE events SET contact_id = NULL WHERE contact_id IN (${placeholders})`).run(...ids);
      this.db.prepare(`DELETE FROM contact_tags WHERE contact_id IN (${placeholders})`).run(...ids);
      this.db.prepare(`DELETE FROM queue_jobs WHERE contact_id IN (${placeholders})`).run(...ids);
      this.db.prepare(`DELETE FROM deliveries WHERE contact_id IN (${placeholders})`).run(...ids);
      this.db.prepare(`DELETE FROM contacts WHERE id IN (${placeholders})`).run(...ids);
      this.recordEvent({
        level: 'warning',
        type: 'contacts.bulk_deleted',
        title: `${ids.length} contato(s) apagados da lista`,
        detail: { criteria, suppressionsKept: true },
      });
    });
    return { deleted: ids.length };
  }

  /**
   * Desfaz o opt-in. Não desfaz envio já feito — só impede novos. Usado quando
   * a confirmação foi registrada por engano.
   */
  revokeConsent(id, reason = 'Opt-in revogado manualmente') {
    const contact = this.getContactInternal(id);
    if (!contact) return false;
    if (contact.consent_status === 'unknown') return true;

    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`
        UPDATE contacts
        SET consent_status = 'unknown', consent_note = NULL, consent_confirmed_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(now, Number(id));
      this.cancelPendingJobsForContact(Number(id), 'Opt-in revogado', now);
      this.recordEvent({
        level: 'warning',
        type: 'contact.consent_revoked',
        contactId: Number(id),
        title: `Opt-in de ${displayNameFor(contact)} foi revogado`,
        detail: { reason: String(reason).slice(0, 240) },
      });
    });
    return true;
  }

  revokeReview(id) {
    const contact = this.getContactInternal(id);
    if (!contact) return false;
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare('UPDATE contacts SET review_approved = 0, updated_at = ? WHERE id = ?').run(now, Number(id));
      this.cancelPendingJobsForContact(Number(id), 'Revisão desfeita', now);
      this.recordEvent({
        type: 'contact.review_revoked',
        contactId: Number(id),
        title: `Dados de ${displayNameFor(contact)} voltaram para revisão`,
      });
    });
    return true;
  }

  getContact(id) {
    const row = this.db.prepare(`SELECT *, EXISTS(SELECT 1 FROM suppressions s WHERE s.phone_e164 = contacts.phone_e164) AS is_suppressed,
             (SELECT GROUP_CONCAT(t.tag, ',') FROM contact_tags t WHERE t.contact_id = contacts.id) AS tag_list FROM contacts WHERE id = ?`).get(Number(id));
    return row ? toPublicContact(row) : null;
  }

  getContactInternal(id) {
    return this.db.prepare(`SELECT *, EXISTS(SELECT 1 FROM suppressions s WHERE s.phone_e164 = contacts.phone_e164) AS is_suppressed,
             (SELECT GROUP_CONCAT(t.tag, ',') FROM contact_tags t WHERE t.contact_id = contacts.id) AS tag_list FROM contacts WHERE id = ?`).get(Number(id)) || null;
  }

  findContactByWhatsAppDigits(value) {
    const digits = digitsOnly(value);
    const row = this.db.prepare(`SELECT *, EXISTS(SELECT 1 FROM suppressions s WHERE s.phone_e164 = contacts.phone_e164) AS is_suppressed,
             (SELECT GROUP_CONCAT(t.tag, ',') FROM contact_tags t WHERE t.contact_id = contacts.id) AS tag_list FROM contacts WHERE whatsapp_digits = ?`).get(digits);
    return row || null;
  }

  updateCompanyName(id, companyDisplay) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE contacts SET company_display = ?, updated_at = ? WHERE id = ?
    `).run(companyDisplay, now, Number(id));
    return Number(result.changes) > 0;
  }

  /**
   * Edita nome, telefone e cidade. Trocar o telefone reclassifica o contato
   * (celular/fixo, DDD) e derruba a aprovação de revisão: o dado mudou, então
   * a conferência anterior não vale mais para o número novo.
   */
  updateContact(id, { company, phone, city } = {}) {
    const contact = this.getContactInternal(id);
    if (!contact) return false;
    if (this.hasJobInActiveRun(id)) {
      const error = new Error('Este contato está em um lote ativo. Conclua ou cancele o lote antes de editar.');
      error.code = 'CONTACT_IN_ACTIVE_RUN';
      throw error;
    }

    const changes = {};
    if (company !== undefined) changes.company_display = String(company).trim().slice(0, 100);
    if (city !== undefined) changes.city = String(city).trim().slice(0, 80);

    let phoneChanged = false;
    if (phone !== undefined && String(phone).trim() !== String(contact.phone_raw || '')) {
      const raw = String(phone).trim();
      const parsed = normalizeBrazilianPhone(raw);
      if (!parsed.valid) {
        const error = new Error('Telefone inválido. Use um número brasileiro com DDD.');
        error.code = 'INVALID_PHONE';
        throw error;
      }

      const taken = this.db.prepare('SELECT id FROM contacts WHERE phone_e164 = ? AND id <> ?')
        .get(parsed.e164, Number(id));
      if (taken) {
        const error = new Error('Outro contato da lista já usa este telefone.');
        error.code = 'DUPLICATE_PHONE';
        throw error;
      }

      const cityName = changes.city ?? contact.city;
      const mismatch = cityName ? hasCityDddMismatch(cityName, parsed.ddd) : false;
      Object.assign(changes, {
        phone_raw: raw,
        phone_digits: parsed.digits,
        phone_e164: parsed.e164,
        whatsapp_digits: parsed.whatsappDigits,
        phone_kind: parsed.kind,
        ddd_mismatch: mismatch ? 1 : 0,
        needs_review: parsed.kind === 'landline' || mismatch ? 1 : 0,
        review_approved: 0,
        last_error: null,
      });
      // Um contato que estava marcado como sem telefone volta para a fila de
      // trabalho assim que ganha um número válido.
      if (contact.status === 'invalid') changes.status = 'pending';
      phoneChanged = true;
    }

    if (!Object.keys(changes).length) return true;

    const now = new Date().toISOString();
    const columns = Object.keys(changes);
    const assignments = columns.map((column) => `${column} = ?`).join(', ');
    this.transaction(() => {
      this.db.prepare(`UPDATE contacts SET ${assignments}, updated_at = ? WHERE id = ?`)
        .run(...columns.map((column) => changes[column]), now, Number(id));
      if (phoneChanged) {
        this.cancelPendingJobsForContact(Number(id), 'Telefone alterado', now);
        this.recordEvent({
          type: 'contact.phone_updated',
          contactId: Number(id),
          title: `Telefone de ${displayNameFor({ ...contact, ...changes })} foi corrigido`,
          detail: { de: maskPhone(contact.phone_e164), para: maskPhone(changes.phone_e164) },
        });
      }
    });
    return true;
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

  /**
   * Remove um lote encerrado do painel, devolvendo a fila ao estado inicial.
   * O que já foi enviado continua enviado: apaga apenas o lote e seus itens de
   * fila. As entregas ficam — elas são o registro do que a pessoa recebeu, e
   * apagar isso perderia a prova do envio.
   */
  discardRun(runId) {
    const run = this.getRun(runId);
    if (!run) return null;
    if (run.status === 'running') {
      const error = new Error('Pause ou cancele o lote antes de removê-lo do painel.');
      error.code = 'CAMPAIGN_ACTIVE';
      throw error;
    }

    this.transaction(() => {
      this.db.prepare('DELETE FROM queue_jobs WHERE run_id = ?').run(runId);
      this.db.prepare('DELETE FROM campaign_runs WHERE id = ?').run(runId);
      this.recordEvent({
        type: 'campaign.discarded',
        title: 'Lote removido do painel',
        detail: { runId, status: run.status, sent: Number(run.sent) },
      });
    });
    return { runId, sent: Number(run.sent), total: Number(run.total) };
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

  exportRows(criteria = {}) {
    const { where, params } = this.buildContactFilter(criteria);
    return this.db.prepare(`
      SELECT source_index, company_display, city, phone_raw, phone_e164, phone_kind,
             source_tag, needs_review, review_approved, consent_status, consent_note,
             status, sent_at, replied_at, last_error
      FROM contacts
      ${where}
      ORDER BY source_index
    `).all(...params);
  }

  // --- 1. histórico de envio de um contato -----------------------------------

  /**
   * O que já saiu para este contato, do mais recente para o mais antigo. Guarda
   * a mensagem exata que foi enviada, não o modelo atual: se o texto mudou
   * depois, o histórico continua mostrando o que a pessoa recebeu.
   */
  listDeliveries(contactId, limit = 20) {
    return this.db.prepare(`
      SELECT id, run_id, status, rendered_message, message_id, ack, error, created_at, sent_at
      FROM deliveries
      WHERE contact_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(Number(contactId), Math.min(100, Math.max(1, Number(limit) || 20)))
      .map((row) => ({
        id: Number(row.id),
        status: row.status,
        message: row.rendered_message,
        messageId: row.message_id,
        ack: row.ack === null ? null : Number(row.ack),
        error: row.error,
        createdAt: row.created_at,
        sentAt: row.sent_at,
      }));
  }

  // --- 5. desfecho manual de um envio incerto --------------------------------

  /**
   * Um envio incerto nunca é reenviado sozinho — a decisão é humana. Aqui ela
   * é registrada: ou a mensagem chegou (vira "sent"), ou não chegou e o contato
   * volta para a fila (vira "pending").
   */
  resolveUncertain(id, outcome) {
    if (!['sent', 'pending'].includes(outcome)) {
      const error = new Error('Escolha se a mensagem chegou ou se o contato volta para a fila.');
      error.code = 'INVALID_OUTCOME';
      throw error;
    }

    const contact = this.getContactInternal(id);
    if (!contact) return false;
    if (contact.status !== 'uncertain') {
      const error = new Error('Só um contato com resultado incerto pode ser resolvido assim.');
      error.code = 'CONTACT_NOT_UNCERTAIN';
      throw error;
    }

    const now = new Date().toISOString();
    this.transaction(() => {
      if (outcome === 'sent') {
        this.db.prepare(`
          UPDATE contacts
          SET status = 'sent', sent_at = COALESCE(sent_at, ?), last_error = NULL, updated_at = ?
          WHERE id = ?
        `).run(now, now, Number(id));
      } else {
        this.db.prepare(`
          UPDATE contacts SET status = 'pending', last_error = NULL, updated_at = ? WHERE id = ?
        `).run(now, Number(id));
      }
      this.recordEvent({
        type: 'contact.uncertain_resolved',
        contactId: Number(id),
        title: outcome === 'sent'
          ? `${displayNameFor(contact)} confirmado como enviado`
          : `${displayNameFor(contact)} voltou para a fila`,
        detail: { outcome },
      });
    });
    return true;
  }
}

function toPublicContact(row) {
  return {
    id: Number(row.id),
    sourceIndex: Number(row.source_index),
    company: displayNameFor(row),
    companyName: row.company_display || '',
    hasCompanyName: Boolean(row.company_display),
    suppressed: Boolean(row.is_suppressed),
    tags: row.tag_list ? String(row.tag_list).split(',').sort() : [],
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
    && Boolean(row.phone_e164)
    // A supressão é por telefone, não por contato: ela sobrevive a apagar e
    // reimportar o número, e precisa valer também aqui. Sem isto, o envio
    // individual escaparia da trava que só o SQL do lote aplicava.
    && !row.is_suppressed;
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
