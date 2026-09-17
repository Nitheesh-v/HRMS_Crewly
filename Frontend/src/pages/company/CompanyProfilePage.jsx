import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Globe2, ImagePlus, Trash2, Eye, Loader2 } from 'lucide-react';
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
  const [branding, setBranding] = useState(null);
  const [layoutForm, setLayoutForm] = useState({ width: 34, maxHeight: 30, fit: 'CONTAIN', alignment: 'LEFT' });
  const [templateId, setTemplateId] = useState('CLASSIC_CORPORATE');
  const [logoBusy, setLogoBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);

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
        try {
          const loaded = await companyService.getBranding();
          setBranding(loaded);
          if (loaded?.layout) setLayoutForm({ ...loaded.layout });
          if (loaded?.documentBranding?.payslip?.templateId) {
            setTemplateId(loaded.documentBranding.payslip.templateId);
          }
        } catch {
          setBranding({ hasLogo: false });
        }
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

  const onLogoFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpe?g)$/i.test(file.type)) {
      flash('error', 'Logo must be a PNG or JPG image');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      flash('error', 'Logo must be 2 MB or smaller');
      return;
    }
    setLogoBusy(true);
    try {
      const updated = await companyService.uploadLogo(file);
      setBranding(updated);
      flash('success', 'Company logo updated. New documents use it; old PDFs are unchanged.');
    } catch (err) {
      flash('error', err?.message || 'Could not upload the logo');
    } finally {
      setLogoBusy(false);
    }
  };

  const onRemoveLogo = async () => {
    if (!window.confirm('Remove the company logo? New documents will use the initials fallback. Old PDFs stay unchanged.')) return;
    setLogoBusy(true);
    try {
      const updated = await companyService.removeLogo();
      setBranding(updated);
      flash('success', 'Company logo removed.');
    } catch (err) {
      flash('error', err?.message || 'Could not remove the logo');
    } finally {
      setLogoBusy(false);
    }
  };

  const setLayout = (key) => (event) =>
    setLayoutForm((current) => ({ ...current, [key]: event.target.value }));

  const saveBrandingSettings = async () => {
    setSettingsBusy(true);
    try {
      const updated = await companyService.updateBranding({
        layout: {
          width: Number(layoutForm.width),
          maxHeight: Number(layoutForm.maxHeight),
          fit: layoutForm.fit,
          alignment: layoutForm.alignment,
        },
        documentBranding: { payslip: { templateId } },
      });
      setBranding(updated);
      if (updated?.layout) setLayoutForm({ ...updated.layout });
      flash('success', 'Branding settings saved. Applies to newly generated documents.');
    } catch (err) {
      flash('error', err?.message || 'Could not save branding settings');
    } finally {
      setSettingsBusy(false);
    }
  };

  const downloadPreview = async () => {
    setPreviewBusy(true);
    try {
      const blob = await companyService.previewPayslip({
        templateId,
        layout: {
          width: Number(layoutForm.width),
          maxHeight: Number(layoutForm.maxHeight),
          fit: layoutForm.fit,
          alignment: layoutForm.alignment,
        },
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `payslip-preview-${templateId}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      flash('error', 'Could not generate the template preview');
    } finally {
      setPreviewBusy(false);
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
              {branding?.hasLogo && branding?.logo?.deliveryUrl ? (
                <img
                  src={branding.logo.deliveryUrl}
                  alt="Company logo"
                  className="h-9 w-10 rounded-md bg-white object-contain"
                />
              ) : (
                <div className="w-10 h-9 rounded-md bg-[#16324f] text-white flex items-center justify-center font-bold text-sm">
                  {initials}
                </div>
              )}
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
        <div>
          <h2 className="text-sm font-semibold">Company Branding</h2>
          <p className="mt-1 text-xs text-crewly-dim">
            Your logo and document style. New payslips, offers and reports use this branding;
            previously generated PDFs are never changed.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex h-20 w-28 items-center justify-center overflow-hidden rounded-lg bg-white p-2">
            {logoBusy ? (
              <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
            ) : branding?.hasLogo && branding?.logo?.deliveryUrl ? (
              <img src={branding.logo.deliveryUrl} alt="Company logo" className="max-h-full max-w-full object-contain" />
            ) : (
              <span className="text-2xl font-bold text-[#16324f]">{initials}</span>
            )}
          </div>
          <div className="space-y-1 text-xs text-crewly-dim">
            <p className="font-medium text-crewly-text">{form.name || 'Company Name'}</p>
            <p>PNG or JPG only · 2 MB max · best under 2000px on either side</p>
            <p>SVG, remote URLs and other formats are not accepted.</p>
          </div>
          {isAdmin && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <label className={`btn-ghost cursor-pointer ${logoBusy ? 'pointer-events-none opacity-60' : ''}`}>
                <ImagePlus className="h-4 w-4" />
                {branding?.hasLogo ? 'Replace logo' : 'Upload logo'}
                <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={onLogoFile} disabled={logoBusy} />
              </label>
              {branding?.hasLogo && (
                <button type="button" className="btn-ghost" onClick={onRemoveLogo} disabled={logoBusy}>
                  <Trash2 className="h-4 w-4" /> Remove
                </button>
              )}
            </div>
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-4">
          <div>
            <label className="label">Logo width (16–120)</label>
            <input type="number" min={16} max={120} className="input" value={layoutForm.width} onChange={setLayout('width')} disabled={!isAdmin} />
          </div>
          <div>
            <label className="label">Logo max height (12–80)</label>
            <input type="number" min={12} max={80} className="input" value={layoutForm.maxHeight} onChange={setLayout('maxHeight')} disabled={!isAdmin} />
          </div>
          <div>
            <label className="label">Image fit</label>
            <select className="input" value={layoutForm.fit} onChange={setLayout('fit')} disabled={!isAdmin}>
              <option value="CONTAIN">Contain (never crops)</option>
              <option value="COVER">Cover (fills box, may crop)</option>
            </select>
          </div>
          <div>
            <label className="label">Logo alignment</label>
            <select className="input" value={layoutForm.alignment} onChange={setLayout('alignment')} disabled={!isAdmin}>
              <option value="LEFT">Left</option>
              <option value="CENTER">Center</option>
              <option value="RIGHT">Right</option>
            </select>
          </div>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-crewly-dim">Payslip template</h3>
          <div className="mt-2 grid gap-2 lg:grid-cols-2">
            {[
              { id: 'CLASSIC_CORPORATE', name: 'Classic Corporate', hint: 'Traditional formal layout with bordered header' },
              { id: 'MINIMAL', name: 'Minimal', hint: 'Printer-friendly grayscale, economical ink' },
            ].map((entry) => (
              <label key={entry.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${templateId === entry.id ? 'border-indigo-500 bg-indigo-500/10' : 'border-white/10 bg-white/5'} ${!isAdmin ? 'pointer-events-none opacity-70' : ''}`}>
                <input type="radio" name="payslip-template" className="mt-1" checked={templateId === entry.id} onChange={() => setTemplateId(entry.id)} disabled={!isAdmin} />
                <span>
                  <span className="block font-medium">{entry.name}</span>
                  <span className="block text-xs text-crewly-dim">{entry.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {isAdmin ? (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary" onClick={saveBrandingSettings} disabled={settingsBusy}>
              {settingsBusy ? 'Saving…' : 'Save branding settings'}
            </button>
            <button type="button" className="btn-ghost" onClick={downloadPreview} disabled={previewBusy}>
              <Eye className="h-4 w-4" /> {previewBusy ? 'Generating…' : 'Preview payslip template'}
            </button>
            <span className="text-[11px] text-crewly-dim">Preview uses sample data and is watermarked SAMPLE.</span>
          </div>
        ) : (
          <p className="text-xs text-crewly-dim">Only the Company Admin can change branding.</p>
        )}
      </section>

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
