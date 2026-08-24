import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Globe2 } from 'lucide-react';
import companyService from '../../services/companyService';
import useAuth from '../../hooks/useAuth';
import { ROLES } from '../../utils/roles';


const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const emptyForm = {
  name: '',
  line: '',
  city: '',
  state: '',
  pincode: '',
  careerSlug: '',
  careerPortalEnabled: false,
  careerAbout: '',
  careerWebsite: '',
  careerLocation: '',
};

const CompanyProfilePage = () => {
  const { user } = useAuth();
  const isAdmin = user?.role === ROLES.COMPANY_ADMIN;

  const [form, setForm] = useState(emptyForm);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState(null);
  const [copied, setCopied] = useState(false);

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
          careerSlug: company.careerSlug || '',
          careerPortalEnabled: Boolean(company.careerPortalEnabled),
          careerAbout: company.careerAbout || '',
          careerWebsite: company.careerWebsite || '',
          careerLocation: company.careerLocation || '',
        });
        setCode(company.code || '');
      } catch (err) {
        flash('error', err?.message || 'Could not load company profile');
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
        careerPortalEnabled: form.careerPortalEnabled,
        careerAbout: form.careerAbout.trim(),
        careerWebsite: form.careerWebsite.trim(),
        careerLocation: form.careerLocation.trim(),
      });
      flash('success', 'Company profile and career portal settings saved.');
    } catch (err) {
      flash('error', err?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const initials = (form.name || 'C').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const now = new Date();
  const careerPath = form.careerSlug ? `/careers/${form.careerSlug}` : '';
  const careerUrl = careerPath && typeof window !== 'undefined'
    ? `${window.location.origin}${careerPath}`
    : '';

  const copyCareerUrl = async () => {
    if (!careerUrl) return;

    try {
      await navigator.clipboard.writeText(careerUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      flash('error', 'Could not copy the career portal URL');
    }
  };

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
        <form id="company-profile-form" onSubmit={save} className="card p-5 space-y-4">
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

      <section className="card p-5 space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Globe2 className="h-5 w-5 text-indigo-300" />
              <h2 className="text-sm font-semibold">Public career portal</h2>
            </div>
            <p className="mt-1 text-xs text-crewly-dim">
              Control your public careers page. Only published, open and unexpired jobs can appear.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs font-medium">
            <input
              type="checkbox"
              checked={form.careerPortalEnabled}
              disabled={!isAdmin}
              onChange={(event) => setForm((current) => ({
                ...current,
                careerPortalEnabled: event.target.checked,
              }))}
              className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-indigo-500"
            />
            Portal enabled
          </label>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <label className="label">Stable career slug</label>
            <input className="input opacity-70" value={form.careerSlug} disabled />
            <p className="mt-1 text-[11px] text-crewly-dim">
              This tenant-safe identifier is assigned by Crewly and does not expose your company ID.
            </p>
          </div>
          <div>
            <label className="label">Public URL</label>
            <div className="flex gap-2">
              <input className="input min-w-0 opacity-70" value={careerUrl} disabled />
              <button
                type="button"
                className="btn-ghost shrink-0 !px-3"
                onClick={copyCareerUrl}
                disabled={!careerUrl}
                aria-label="Copy public career URL"
              >
                {copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
              </button>
              {form.careerPortalEnabled && careerUrl && (
                <a
                  href={careerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-ghost shrink-0 !px-3"
                  aria-label="Open public career portal"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              )}
            </div>
          </div>
        </div>

        <div>
          <label className="label">Career page introduction</label>
          <textarea
            className="input min-h-28 resize-y"
            maxLength={2000}
            value={form.careerAbout}
            onChange={set('careerAbout')}
            disabled={!isAdmin}
            placeholder="Tell candidates what makes your company a great place to work."
          />
          <p className="mt-1 text-right text-[11px] text-crewly-dim">
            {form.careerAbout.length}/2000
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <label className="label">Company website</label>
            <input
              type="url"
              className="input"
              value={form.careerWebsite}
              onChange={set('careerWebsite')}
              disabled={!isAdmin}
              placeholder="https://company.example"
            />
          </div>
          <div>
            <label className="label">Public location</label>
            <input
              className="input"
              maxLength={180}
              value={form.careerLocation}
              onChange={set('careerLocation')}
              disabled={!isAdmin}
              placeholder="Chennai, Tamil Nadu"
            />
          </div>
        </div>

        {isAdmin ? (
          <button
            type="submit"
            form="company-profile-form"
            className="btn-primary"
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save career settings'}
          </button>
        ) : (
          <p className="text-xs text-crewly-dim">
            Only the Company Admin can change public career settings.
          </p>
        )}
      </section>
    </div>
  );
};

export default CompanyProfilePage;
