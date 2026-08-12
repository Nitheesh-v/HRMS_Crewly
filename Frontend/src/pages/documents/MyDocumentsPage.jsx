// 📄 MY DOCUMENTS — upload, view, delete personal documents
import { useCallback, useEffect, useRef, useState } from 'react';
import { documentService } from '../../services/selfService';
import useAuth from '../../hooks/useAuth.jsx';

const errMsg = (err, fb) => err?.response?.data?.message || err?.data?.message || err?.message || fb;
const CATEGORIES = ['PERSONAL', 'EDUCATION', 'EXPERIENCE', 'ID_PROOF', 'PAYSLIP', 'OTHER'];
const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((b || 0) / 1024))} KB`);

const MyDocumentsPage = () => {
  useAuth(); // ensures page sits comfortably inside the app
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('PERSONAL');
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await documentService.my();
      setDocs(Array.isArray(res) ? res : res?.data || []);
    } catch (err) { setError(errMsg(err, 'Failed to load documents')); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true); setError(''); setNotice('');
    try {
      await documentService.upload(file, name.trim() || file.name, category);
      setName(''); setCategory('PERSONAL');
      setNotice('Document uploaded 📄');
      await load();
    } catch (err) { setError(errMsg(err, 'Upload failed')); }
    finally { setUploading(false); }
  };

  const onDelete = async (d) => {
    if (!window.confirm(`Delete "${d.name}"?`)) return;
    try { await documentService.remove(d._id); setDocs((l) => l.filter((x) => x._id !== d._id)); }
    catch (err) { setError(errMsg(err, 'Delete failed')); }
  };

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold">📄 My Documents</h1>
      <p className="mt-1 text-sm text-crewly-dim">Your ID proofs, certificates, letters — stored safely in the cloud. PDF/PNG/JPG · max 5 MB.</p>

      {error && <div className="mt-4 rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">{error}</div>}
      {notice && <div className="mt-4 rounded-lg border border-crewly-green/40 bg-crewly-green/10 px-4 py-3 text-sm text-crewly-green">{notice}</div>}

      {/* uploader */}
      <div className="card mt-5 flex flex-wrap items-end gap-3">
        <div className="min-w-52 flex-1">
          <label className="label">Document name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Aadhaar card, Degree certificate…" />
        </div>
        <div>
          <label className="label">Category</label>
          <select className="input w-auto" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
          </select>
        </div>
        <button className="btn-primary px-5 py-2.5 text-sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? 'Uploading…' : '⬆️ Choose & Upload'}
        </button>
        <input ref={fileRef} type="file" accept=".pdf,image/*" className="hidden" onChange={onUpload} />
      </div>

      {/* list */}
      <div className="mt-5 space-y-2">
        {loading && <p className="text-crewly-dim">Loading…</p>}
        {!loading && docs.length === 0 && (
          <div className="card text-center text-crewly-dim">No documents yet — upload your first one above ⬆️</div>
        )}
        {docs.map((d) => (
          <div key={d._id} className="card flex items-center gap-4 py-3">
            <span className="text-2xl">{d.mimeType === 'application/pdf' ? '📕' : '🖼️'}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{d.name}</p>
              <p className="text-xs text-crewly-dim">
                {d.category.replace('_', ' ')} · {fmtSize(d.size)} · {new Date(d.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
              </p>
            </div>
            <span className="badge bg-crewly-green/15 text-crewly-green">{d.category.replace('_', ' ')}</span>
            <a href={d.fileUrl} target="_blank" rel="noreferrer" download={d.name} className="btn-ghost px-3 py-1.5 text-xs">👁 View</a>
            <button onClick={() => onDelete(d)} className="rounded-md bg-crewly-red/15 px-3 py-1.5 text-xs text-crewly-red hover:bg-crewly-red/25">Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default MyDocumentsPage;