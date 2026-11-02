// Module operations (ids 100-199). The foundation already has op_sheets / op_lines /
// sheet_issues / photo_jobs / work_orders; this adds what the paper flow needs on top:
//   - a draft flag (a sheet being typed is not in the review queue yet)
//   - versions (an approved sheet is never edited: a correction is a new version)
//   - the photo job kind and the photo's fingerprint (the same photo is not read twice)
//   - ai_reads: how often each field the reader was sure of turned out right after review
//     (the trust gate: a field earns "sure" only with a track record)
export const MIGRATIONS = [
  {
    id: 100,
    name: 'operations: drafts, versions, photo jobs, AI track record',
    sql: `
ALTER TABLE op_sheets ADD COLUMN draft INTEGER NOT NULL DEFAULT 0 CHECK (draft IN (0,1));
ALTER TABLE op_sheets ADD COLUMN submitted_at TEXT;
ALTER TABLE op_sheets ADD COLUMN updated_at TEXT;
ALTER TABLE op_sheets ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE op_sheets ADD COLUMN base_serial TEXT;
ALTER TABLE op_sheets ADD COLUMN supersedes_id INTEGER REFERENCES op_sheets(id);
ALTER TABLE op_sheets ADD COLUMN superseded_by INTEGER REFERENCES op_sheets(id);
ALTER TABLE op_sheets ADD COLUMN photo_job_id INTEGER REFERENCES photo_jobs(id);
CREATE INDEX idx_op_sheets_draft ON op_sheets(draft, created_by);

ALTER TABLE photo_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'upload' CHECK (kind IN ('upload','reread'));
ALTER TABLE photo_jobs ADD COLUMN photo_hash TEXT;
CREATE INDEX idx_photo_jobs_hash ON photo_jobs(photo_hash);

CREATE TABLE ai_reads (
  id INTEGER PRIMARY KEY,
  sheet_id INTEGER NOT NULL REFERENCES op_sheets(id),
  line_id INTEGER REFERENCES op_lines(id),
  field TEXT NOT NULL,
  confidence REAL NOT NULL,
  correct INTEGER NOT NULL CHECK (correct IN (0,1)),
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ai_reads_field ON ai_reads(field, confidence);
`,
  },
];
