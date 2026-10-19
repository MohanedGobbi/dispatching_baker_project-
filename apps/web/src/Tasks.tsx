import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, ListChecks, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { api } from './api'
import { Modal } from './dialogs'
import { PageGuide } from './guide'
import { errMsg, useApi, useDebounced, useLive } from './hooks'
import { fmtDate } from './labels'
import { PersonLink } from './profiles'
import { Pill, useToast } from './ui'

interface Task {
  id: string; title: string; notes: string | null; dueDate: string | null; status: 'OPEN' | 'DONE'; overdue: boolean; doneAt: string | null; doneNote: string | null; createdAt: string
  employee: { id: string; employeeNo: string; name: string }
}

/** Tasks the manager gives to people. They see them in their portal ("To do") and mark them done. */
export default function Tasks() {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const [status, setStatus] = useState('OPEN')
  const [text, setText] = useState('')
  const q = useDebounced(text.trim())
  const list = useApi<Task[]>(`/tasks?${new URLSearchParams({ ...(status ? { status } : {}), ...(q ? { q } : {}) })}`)
  useLive(list.reload)
  const [editing, setEditing] = useState<Task | 'new' | null>(null)
  const rows = list.data ?? []
  const overdue = rows.filter(r => r.overdue).length

  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); await list.reload() } catch (e) { toast(errMsg(e), 'error') } }

  return (
    <main className="page wide">
      <PageGuide id="tasks" Icon={ListChecks} color="var(--pal-teal-700)" title={t('tasksTitle', 'Tasks')}
        purpose={t('tasksPurpose', 'Things you ask people to do: bring a document, attend a training, check a piece of equipment.')}
        steps={[
          t('tkStep1', '"New task": pick one or more people, say what and by when. Each person is notified.'),
          t('tkStep2', 'They see it in their phone portal under "To do" and mark it done, with a note if needed. You are told.'),
          t('tkStep3', 'Overdue tasks are shown in red. Change, reopen or delete any task here.'),
        ]}>
        <button type="button" className="primary" onClick={() => setEditing('new')}><Plus size={15} aria-hidden /> {t('newTask', 'New task')}</button>
      </PageGuide>
      <div className="filters">
        <select value={status} onChange={e => setStatus(e.target.value)} aria-label={t('status', 'Status')}>
          <option value="OPEN">{t('open', 'Open')}</option><option value="DONE">{t('doneLc', 'Done')}</option><option value="">{t('all', 'All')}</option>
        </select>
        <input value={text} onChange={e => setText(e.target.value)} placeholder={t('taskSearch', 'Task, name or employee number')} aria-label={t('search', 'Search')} />
        <span className="spacer" />
        {overdue > 0 && <Pill severity="bad">{overdue} {t('overdueLc', 'overdue')}</Pill>}
        <span className="muted">{rows.length}</span>
      </div>
      {list.error && <div className="banner error" role="alert">{list.error}</div>}
      <div className="table-scroll">
        <table className="table compact">
          <thead><tr><th>{t('person', 'Person')}</th><th>{t('task', 'Task')}</th><th>{t('due', 'Due')}</th><th>{t('status', 'Status')}</th><th /></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className={r.overdue ? 'row-bad' : ''}>
                <td><PersonLink id={r.employee.id}>{r.employee.name}</PersonLink> <small className="muted">{r.employee.employeeNo}</small></td>
                <td><strong>{r.title}</strong>{r.notes && <small className="muted unit-note" title={r.notes}>{r.notes}</small>}</td>
                <td>{r.dueDate ? fmtDate(r.dueDate, i18n.language) : <span className="muted">—</span>}</td>
                <td>
                  {r.status === 'DONE' ? <><Pill severity="ok">{t('doneLc', 'Done')} {r.doneAt ? fmtDate(r.doneAt, i18n.language) : ''}</Pill>{r.doneNote && <small className="muted unit-note" title={r.doneNote}>{r.doneNote}</small>}</>
                    : r.overdue ? <Pill severity="bad">{t('overdue', 'Overdue')}</Pill> : <Pill severity="info">{t('open', 'Open')}</Pill>}
                </td>
                <td className="row-actions">
                  {r.status === 'OPEN'
                    ? <button type="button" onClick={() => void act(() => api(`/tasks/${r.id}`, { method: 'PUT', body: { status: 'DONE' } }), t('markedDone', 'Marked done'))} aria-label={`${t('markDone', 'Done')}: ${r.title}`} title={t('markDone', 'Done')}><CheckCircle2 size={14} aria-hidden /></button>
                    : <button type="button" onClick={() => void act(() => api(`/tasks/${r.id}`, { method: 'PUT', body: { status: 'OPEN' } }), t('reopened', 'Reopened'))} aria-label={`${t('reopen', 'Reopen')}: ${r.title}`} title={t('reopen', 'Reopen')}><RotateCcw size={14} aria-hidden /></button>}
                  <button type="button" onClick={() => setEditing(r)} aria-label={`${t('edit', 'Edit')}: ${r.title}`} title={t('edit', 'Edit')}><Pencil size={14} aria-hidden /></button>
                  <button type="button" className="danger" onClick={() => void act(() => api(`/tasks/${r.id}`, { method: 'DELETE' }), t('taskDeleted', 'Task deleted'))} aria-label={`${t('delete', 'Delete')}: ${r.title}`} title={t('delete', 'Delete')}><Trash2 size={14} aria-hidden /></button>
                </td>
              </tr>
            ))}
            {list.data && rows.length === 0 && <tr><td colSpan={5} className="muted">{status === 'OPEN' ? t('noOpenTasks', 'No open task.') : t('noTasks', 'No task matches.')}</td></tr>}
          </tbody>
        </table>
      </div>
      {editing && <TaskDialog task={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void list.reload() }} />}
    </main>
  )
}

function TaskDialog({ task, onClose, onDone }: { task: Task | null; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [title, setTitle] = useState(task?.title ?? '')
  const [notes, setNotes] = useState(task?.notes ?? '')
  const [due, setDue] = useState(task?.dueDate ?? '')
  const [people, setPeople] = useState<{ id: string; name: string }[]>(task ? [{ id: task.employee.id, name: task.employee.name }] : [])
  const [text, setText] = useState('')
  const q = useDebounced(text.trim())
  const hits = useApi<{ items: { id: string; firstName: string; lastName: string; employeeNo: string; position: { name: string } }[] }>(!task && q.length >= 2 ? `/employees?q=${encodeURIComponent(q)}&limit=8` : null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      if (task) await api(`/tasks/${task.id}`, { method: 'PUT', body: { title: title.trim(), notes: notes.trim() || null, dueDate: due || null } })
      else await api('/tasks', { method: 'POST', body: { employeeIds: people.map(p => p.id), title: title.trim(), notes: notes.trim() || undefined, dueDate: due || undefined } })
      toast(task ? t('saved', 'Saved') : t('taskSent', 'Task sent')); onDone()
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false) }
  }
  return (
    <Modal title={task ? t('editTask', 'Edit task') : t('newTask', 'New task')} onClose={onClose}>
      <div className="form2">
        {task ? <p className="muted" style={{ margin: 0 }}>{t('for', 'For')} {task.employee.name}</p> : (
          <>
            <label>{t('who', 'Who')} *<input value={text} onChange={e => setText(e.target.value)} placeholder={t('searchPerson', 'Name or employee number')} autoFocus /></label>
            {people.length > 0 && <p className="chips">{people.map(p => <span className="tag tag-OH" key={p.id}>{p.name} <button type="button" className="link" aria-label={`${t('remove', 'Remove')} ${p.name}`} onClick={() => setPeople(people.filter(x => x.id !== p.id))}>×</button></span>)}</p>}
            {hits.data && <ul className="cand-list">{hits.data.items.filter(h => !people.some(p => p.id === h.id)).map(h => <li key={h.id}><div><strong>{h.firstName} {h.lastName}</strong><small className="why">{h.employeeNo} · {h.position.name}</small></div><button type="button" onClick={() => { setPeople([...people, { id: h.id, name: `${h.firstName} ${h.lastName}` }]); setText('') }}>{t('add', 'Add')}</button></li>)}</ul>}
          </>
        )}
        <label>{t('whatToDo', 'What to do')} *<input value={title} onChange={e => setTitle(e.target.value)} maxLength={200} /></label>
        <label>{t('details', 'Details')}<textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} /></label>
        <label>{t('dueBy', 'By')}<input type="date" value={due} onChange={e => setDue(e.target.value)} /></label>
        <footer>
          <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
          <button type="button" className="primary" disabled={busy || !title.trim() || (!task && !people.length)} onClick={() => void save()}>{task ? t('save', 'Save') : t('send', 'Send')}</button>
        </footer>
      </div>
    </Modal>
  )
}
