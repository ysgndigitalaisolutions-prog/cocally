'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { FIELD_LABELS, LEAD_FIELDS, guessMapping, onDncRegister, type ColumnMapping, type LeadField } from '@/lib/lead-columns';
import { readXlsx, toCsv } from '@/lib/xlsx';

interface ImportReport {
  total: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  rejects: Array<{ row: number; reason: string }>;
}

/** A tiny CSV reader for pasted text and .csv files: quoted fields, commas, newlines. */
function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) rows.push([...row, cell.trim()]);
  return rows.filter((r) => r.some((x) => x !== ''));
}

/**
 * Upload an Excel or CSV list into a campaign: the columns are matched from the
 * headers (and can be changed), Do Not Call "Y" rows are counted up front and
 * skipped by the server, and the server cleans numbers, removes duplicates and
 * works out each lead's calling hours from state or postcode.
 */
export default function LeadImport({ campaignId, campaignName, onImported }: { campaignId: string; campaignName?: string; onImported: () => void }) {
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [paste, setPaste] = useState('');
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);

  const headers = rows[0] ?? [];
  const body = rows.slice(1);
  const col = (field: LeadField) => (mapping[field] ? headers.indexOf(mapping[field]!) : -1);
  const dncCount = col('dncrStatus') >= 0 ? body.filter((r) => onDncRegister(r[col('dncrStatus')])).length : 0;
  const noPhone = col('phone') >= 0 ? body.filter((r) => !(r[col('phone')] ?? '').trim()).length : body.length;

  function load(name: string, table: string[][]) {
    if (table.length < 2) throw new Error('No rows found under the header line');
    setFileName(name);
    setRows(table);
    setMapping(guessMapping(table[0]!));
    setReport(null);
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setError('');
    setReading(true);
    try {
      const table = /\.xlsx$/i.test(file.name) ? await readXlsx(await file.arrayBuffer()) : readCsv(await file.text());
      load(file.name, table);
    } catch (e) {
      setError(`${file.name}: ${(e as Error).message}. Save it as .xlsx or .csv and try again.`);
    } finally {
      setReading(false);
    }
  }

  async function runImport() {
    setImporting(true);
    setError('');
    try {
      const { data } = await api.post<ImportReport>('/leads/import', {
        campaignId,
        filename: fileName || 'pasted.csv',
        csvContent: toCsv(rows),
        mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)),
      });
      setReport(data);
      onImported();
    } catch (e) {
      const msg = (e as { response?: { data?: { message?: string } } }).response?.data?.message;
      setError(msg ?? 'Import failed.');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="card space-y-4 p-5" style={{ border: '1px solid var(--accent-dim)' }}>
      <p className="text-sm">
        Importing into <b>{campaignName}</b>. Upload an Excel (.xlsx) or CSV file; the first row must be the column names.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <input type="file" accept=".xlsx,.csv,text/csv" className="text-sm" onChange={(e) => void pickFile(e.target.files?.[0])} />
        {reading && <span className="text-xs text-dim">Reading…</span>}
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer text-dim">or paste CSV text</summary>
        <textarea
          className="input mt-2 h-28 font-mono text-xs"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder={'phone,firstName,lastName,suburb,state\n0412 345 678,Kim,Lee,Fitzroy,VIC'}
        />
        <button
          type="button"
          className="btn btn-ghost mt-2 text-xs"
          onClick={() => {
            try {
              load('pasted.csv', readCsv(paste));
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Use pasted text
        </button>
      </details>

      {error && <p className="text-sm" style={{ color: 'var(--bad)' }}>{error}</p>}

      {rows.length > 1 && (
        <>
          <div>
            <h3 className="mb-2 text-sm font-semibold">
              {fileName}: {body.length.toLocaleString()} rows, {headers.length} columns
            </h3>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {LEAD_FIELDS.map((field) => (
                <label key={field} className="block text-xs text-dim">
                  {FIELD_LABELS[field]}
                  <select
                    className="input mt-1"
                    value={mapping[field] ?? ''}
                    onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value || undefined }))}
                  >
                    <option value="">— not in this file —</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-dim">Other columns are kept on each lead as extra details.</p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-dim">
                  {LEAD_FIELDS.filter((f) => mapping[f]).map((f) => (
                    <th key={f} className="p-2 font-medium">{FIELD_LABELS[f].replace(' (required)', '')}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.slice(0, 5).map((r, i) => (
                  <tr key={i} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    {LEAD_FIELDS.filter((f) => mapping[f]).map((f) => (
                      <td key={f} className="p-2 font-mono">{r[col(f)] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="space-y-1 text-sm">
            {!mapping.phone && <li style={{ color: 'var(--bad)' }}>Choose the phone column to continue.</li>}
            {mapping.dncrStatus && (
              <li>
                Do Not Call Register: <b>{dncCount.toLocaleString()}</b> marked Y will be skipped.
              </li>
            )}
            {!mapping.dncrStatus && <li className="text-dim">No Do Not Call column: numbers are imported as they are.</li>}
            {mapping.phone && noPhone > 0 && <li>{noPhone.toLocaleString()} rows have no phone and will be skipped.</li>}
            {!mapping.state && !mapping.postcode && (
              <li style={{ color: 'var(--bad)' }}>No state or postcode column: Australian leads need one for their local calling hours.</li>
            )}
            <li className="text-dim">Numbers are cleaned (04…, 4…, 61…, +61…) and duplicates removed on import.</li>
          </ul>

          <button type="button" className="btn btn-primary" disabled={importing || !mapping.phone} onClick={() => void runImport()}>
            {importing ? 'Importing…' : `Import ${body.length.toLocaleString()} rows into ${campaignName ?? 'campaign'}`}
          </button>
        </>
      )}

      {report && (
        <div className="rounded-lg p-3 text-sm" style={{ background: 'var(--surface-2)' }}>
          <p>
            Total {report.total} · accepted <span style={{ color: 'var(--good)' }}>{report.accepted}</span> · duplicates {report.duplicates} ·
            rejected <span style={{ color: report.rejected > 0 ? 'var(--bad)' : undefined }}>{report.rejected}</span>
          </p>
          {report.rejects.slice(0, 5).map((reject) => (
            <p key={reject.row} className="text-xs text-dim">
              row {reject.row}: {reject.reason}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
