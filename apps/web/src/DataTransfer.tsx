import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FileSpreadsheet, Upload } from 'lucide-react'
import { api, ApiError, download } from './api'
import { useAuth } from './auth'
import { errMsg } from './hooks'
import { Pill, useToast } from './ui'

type Kind = 'bases' | 'units' | 'employees'
interface Report {
  sheet: string; fatal: string[]; ignoredColumns: string[]
  summary: { rows: number; create: number; update: number; unchanged: number; errors: number; warnings: number }
  rows: { row: number; key: string; action: 'create' | 'update' | 'error'; errors: string[]; warnings: string[]; changes: string[] }[]
}

// Mirrors the API's access rules so people only see buttons that will work.
const SHEETS: { kind: Kind; title: string; intro: string; exportRoles: string[]; importRoles: string[] }[] = [
  { kind: 'employees', title: 'Employees', intro: 'People, positions, home base, rotation pattern and anchor date (the rotation sheet), qualifications.', exportRoles: ['SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'HR'], importRoles: ['SUPER_ADMIN', 'OPS_MANAGER', 'HR'] },
  { kind: 'units', title: 'Units', intro: 'Logging units with type and home base. New units get the crew seats of their type.', exportRoles: ['SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'HR', 'BASE_MANAGER'], importRoles: ['SUPER_ADMIN', 'OPS_MANAGER'] },
  { kind: 'bases', title: 'Bases', intro: 'Bases with location and capacities.', exportRoles: ['SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'HR', 'BASE_MANAGER'], importRoles: ['SUPER_ADMIN', 'OPS_MANAGER'] },
]

const toBase64 = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
  r.onerror = () => reject(r.error)
  r.readAsDataURL(f)
})

/** Excel import and export (plan E27, 31): download a template or the current data, upload it back, check, then commit. */
export default function DataTransfer() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const sheets = SHEETS.filter(s => can(...s.exportRoles) || can(...s.importRoles))
  return (
    <main className="page">
      <header className="page-head"><div><h1>{t('dataTitle', 'Import / export')}</h1><p className="muted">{t('dataIntro', 'Excel in and out. An upload is checked first; nothing is written until you confirm.')}</p></div></header>
      {sheets.map(s => <SheetPanel key={s.kind} {...s} canExport={can(...s.exportRoles)} canImport={can(...s.importRoles)} />)}
    </main>
  )
}

function SheetPanel({ kind, title, intro, canExport, canImport }: { kind: Kind; title: string; intro: string; canExport: boolean; canImport: boolean }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [file, setFile] = useState<{ name: string; data: string } | null>(null)
  const [report, setReport] = useState<Report | null>(null)
  const [skip, setSkip] = useState(false)
  const [busy, setBusy] = useState(false)

  const get = async (what: 'template' | 'export') => {
    try { await download(`/transfer/${kind}/${what}`, `${kind}-${what}.xlsx`) } catch (e) { toast(errMsg(e), 'error') }
  }
  const pick = async (f: File | undefined) => {
    if (!f) return
    setBusy(true); setReport(null); setSkip(false)
    try {
      const data = await toBase64(f)
      setFile({ name: f.name, data })
      setReport(await api<Report>(`/transfer/${kind}/validate`, { method: 'POST', body: { file: data } }))
    } catch (e) { toast(errMsg(e), 'error'); setFile(null) } finally { setBusy(false) }
  }
  const commit = async () => {
    if (!file) return
    setBusy(true)
    try {
      const r = await api<{ created: number; updated: number; skipped: number }>(`/transfer/${kind}/commit`, { method: 'POST', body: { file: file.data, skipInvalid: skip } })
      toast(t('importDone', '{{created}} created, {{updated}} updated, {{skipped}} skipped', r))
      setReport(null); setFile(null)
    } catch (e) {
      // A refused commit carries a fresh report (the data may have changed since the check).
      const body = e instanceof ApiError ? (e.body as { report?: Report } | null) : null
      if (body?.report) setReport(body.report)
      toast(errMsg(e), 'error')
    } finally { setBusy(false) }
  }
  const s = report?.summary
  const writes = s ? s.create + s.update : 0

  return (
    <section className="panel">
      <h2><FileSpreadsheet size={18} aria-hidden /> {t(`data_${kind}`, title)}</h2>
      <p className="muted">{t(`data_${kind}_intro`, intro)}</p>
      <div className="row-actions">
        {canImport && <button type="button" onClick={() => void get('template')}><Download size={14} aria-hidden /> {t('template', 'Template')}</button>}
        {canExport && <button type="button" onClick={() => void get('export')}><Download size={14} aria-hidden /> {t('exportData', 'Export current data')}</button>}
        {canImport && (
          <label className="upload-btn">
            <Upload size={14} aria-hidden /> {busy ? '…' : t('uploadCheck', 'Upload and check')}
            <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={e => { void pick(e.target.files?.[0]); e.target.value = '' }} />
          </label>
        )}
      </div>
      {report && s && (
        <div className="import-report">
          <p><strong>{file?.name}</strong> · {t('sheet', 'sheet')} “{report.sheet}”</p>
          {report.fatal.map(f => <div key={f} className="banner error" role="alert">{f}</div>)}
          {report.fatal.length === 0 && (
            <div className="badges">
              <Pill severity="ok">{t('willCreate', '{{n}} new', { n: s.create })}</Pill>
              <Pill severity="info">{t('willUpdate', '{{n}} changed', { n: s.update })}</Pill>
              <span className="badge">{t('unchanged', '{{n}} unchanged', { n: s.unchanged })}</span>
              {s.errors > 0 && <Pill severity="bad">{t('rowErrors', '{{n}} with errors', { n: s.errors })}</Pill>}
              {s.warnings > 0 && <Pill severity="warn">{t('rowWarnings', '{{n}} warnings', { n: s.warnings })}</Pill>}
            </div>
          )}
          {report.ignoredColumns.length > 0 && <p className="muted">{t('ignoredCols', 'Ignored columns')}: {report.ignoredColumns.join(', ')}</p>}
          {report.rows.length > 0 && (
            <table className="table compact">
              <thead><tr><th>{t('row', 'Row')}</th><th>{t('key', 'Key')}</th><th>{t('result', 'Result')}</th><th>{t('details', 'Details')}</th></tr></thead>
              <tbody>
                {report.rows.slice(0, 300).map(r => (
                  <tr key={r.row} className={r.action === 'error' ? 'row-bad' : ''}>
                    <td>{r.row}</td><td><code>{r.key || '—'}</code></td>
                    <td>{r.action === 'error' ? <Pill severity="bad">{t('error', 'Error')}</Pill> : r.action === 'create' ? <Pill severity="ok">{t('new', 'New')}</Pill> : <Pill severity="info">{t('changed', 'Changed')}</Pill>}</td>
                    <td>
                      {r.errors.map(x => <div key={x} className="error">{x}</div>)}
                      {r.warnings.map(x => <div key={x} className="warn-text">{x}</div>)}
                      {r.action === 'update' && <small className="muted">{r.changes.join(', ')}</small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {report.rows.length > 300 && <p className="muted">{t('moreRows', 'and {{n}} more rows', { n: report.rows.length - 300 })}</p>}
          {report.fatal.length === 0 && (
            <div className="row-actions end">
              {s.errors > 0 && writes > 0 && <label className="check"><input type="checkbox" checked={skip} onChange={e => setSkip(e.target.checked)} /> {t('skipErrors', 'Skip the rows with errors')}</label>}
              <button type="button" onClick={() => { setReport(null); setFile(null) }}>{t('cancel', 'Cancel')}</button>
              <button type="button" className="primary" disabled={busy || writes === 0 || (s.errors > 0 && !skip)} onClick={() => void commit()}>
                {writes === 0 ? t('nothingToImport', 'Nothing to import') : t('importRows', 'Import {{n}} rows', { n: writes })}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
