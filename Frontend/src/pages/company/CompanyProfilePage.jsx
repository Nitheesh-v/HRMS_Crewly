import { useEffect, useState } from 'react';
import companyService from '../../services/companyService';
import useAuth from '../../hooks/useAuth';
import { ROLES } from '../../utils/roles';


const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const emptyForm = { name: '', line: '', city: '', state: '', pincode: '' };

export default function CompanyProfilePage() {
  const { user } = useAuth();
  const isAdmin = user?.role === ROLES.COMPANY_ADMIN;

  const [form, setForm] = useState(emptyForm);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState(null);

  const flash = (type, text) => {
    setBanner({ type, text });
    setTimeout(() => setBanner(null), 4000);
  };

  useEffect(() => {
    (async () => {
      try {
        const company = await companyService.getMy();
        setForm({
          name: company.name || '',
          line: company.address?.line || '',
          city: company.address?.city || '',
          state: company.address?.state || '',
          pincode: company.address?.pincode || '',
        });
        setCode(company.code || '');
      } catch (err) {
        flash('error', err?.response?.data?.message || 'Could not load company profile');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await companyService.updateMy({
        name: form.name.trim(),
        address: { line: form.line.trim(), city: form.city.trim(), state: form.state.trim(), pincode: form.pincode.trim() },
      });
      flash('success', 'Saved! New payslips will show this company info 🎉');
    } catch (err) {
      flash('error', err?.response?.data?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const initials = (form.name || 'C').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const now = new Date();

  if (loading) return <div className="p-6 text-crewly-dim">Loading company profile…</div>;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold">🏢 Company Profile</h1>
        <p className="text-sm text-crewly-dim">This name &amp; address is printed on every payslip you generate.</p>
      </div>

      {banner && (
        <div className={`card px-4 py-3 text-sm ${banner.type === 'error' ? 'text-crewly-red' : 'text-crewly-green'}`}>
          {banner.text}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── form ── */}
        <form onSubmit={save} className="card p-5 space-y-4">
          <div>
            <label className="label">Company Name</label>
            <input className="input" value={form.name} onChange={set('name')} disabled={!isAdmin} required />
          </div>
          <div>
            <label className="label">Company Code (login code — fixed)</label>
            <input className="input opacity-60" value={code} disabled />
          </div>
          <div>
            <label className="label">Address Line</label>
            <input className="input" value={form.line} onChange={set('line')} disabled={!isAdmin}
              placeholder="65, AA Arcade First Floor, Vilankuruchi Main Road" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">City</label>
              <input className="input" value={form.city} onChange={set('city')} disabled={!isAdmin} placeholder="Coimbatore" />
            </div>
            <div>
              <label className="label">State</label>
              <input className="input" value={form.state} onChange={set('state')} disabled={!isAdmin} placeholder="Tamil Nadu" />
            </div>
          </div>
          <div>
            <label className="label">PIN Code</label>
            <input className="input" value={form.pincode} onChange={set('pincode')} disabled={!isAdmin} placeholder="641035" maxLength={6} />
          </div>
          {isAdmin ? (
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save Profile'}
            </button>
          ) : (
            <p className="text-xs text-crewly-dim">Only the Company Admin can edit this profile.</p>
          )}
        </form>

        {/* ── live payslip header preview ── */}
        <div className="card p-5 space-y-3">
          <h2 className="text-sm font-semibold">📄 Payslip header preview</h2>
          <div className="bg-white text-gray-900 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-9 rounded-md bg-[#16324f] text-white flex items-center justify-center font-bold text-sm">
                {initials}
              </div>
              <div className="flex-1">
                <div className="font-bold text-[13px] text-[#16324f] leading-tight">
                  {(form.name || 'Company Name').toUpperCase()}
                </div>
                <div className="text-[10px] text-gray-500 leading-snug">
                  {[form.line, form.city].filter(Boolean).join(', ') || 'Address line, City'}
                  <br />
                  {[form.state, form.pincode ? `- ${form.pincode}` : ''].filter(Boolean).join(' ') || 'State - 6XXXXX'}
                </div>
              </div>
              <div className="text-right border-l border-indigo-100 pl-3">
                <div className="font-bold text-[12px]">Payslip: {MONTH_SHORT[now.getMonth()]} {now.getFullYear()}</div>
                <div className="text-[9px] text-gray-400">Generated by</div>
                <div className="text-[10px] font-bold">🟩 Crewly HRMS</div>
              </div>
            </div>
          </div>
          <p className="text-xs text-crewly-dim">
            Exactly like this on the PDF — employee details, earnings &amp; deductions tables appear below it. ✅
          </p>
        </div>
      </div>
    </div>
  );
}