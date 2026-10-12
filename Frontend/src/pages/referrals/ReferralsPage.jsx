/* eslint-disable react-hooks/set-state-in-effect */
// ═══════════════════════════════════════════════════════════════════════════
//  JOB REFERRALS — posted jobs, visible to every employee.
//
//  Visibility follows the career page: an opening appears here exactly when
//  HR publishes it (and disappears when it closes or the deadline passes).
//  The server scopes everything to the caller's company; "My referrals" is
//  additionally scoped to the caller's own submissions.
//
//  The page deliberately avoids inventing programmes this product does not
//  have — the candidate enters the normal pipeline and HR takes over; that
//  is the whole story the UI tells.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useState } from "react";
import { UserPlus, Briefcase } from "lucide-react";

import referralService from "../../services/referralService";

const humaniseStage = (stage = "") =>
  String(stage)
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

const employmentTypeLabel = (value = "") =>
  String(value).replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

const workModeLabel = (value = "") =>
  String(value).replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

const EmptyState = ({ children }) => (
  <div className="card text-center text-crewly-dim">{children}</div>
);

const ReferralsPage = () => {
  const [tab, setTab] = useState("openings");
  const [openings, setOpenings] = useState([]);
  const [mine, setMine] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [referring, setReferring] = useState(null); // the opening being referred into
  const [form, setForm] = useState({ fullName: "", email: "", phone: "", notes: "" });
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError("");
      try {
        const [openingsRes, mineRes] = await Promise.all([
          referralService.openings(),
          referralService.mine(),
        ]);
        if (cancelled) return;
        setOpenings(openingsRes?.data?.data?.openings || []);
        setMine(mineRes?.data?.data?.referrals || []);
      } catch (err) {
        if (!cancelled) {
          setError(err?.response?.data?.message || "Could not load job referrals.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const openRefer = (opening) => {
    setReferring(opening);
    setForm({ fullName: "", email: "", phone: "", notes: "" });
    setFieldErrors({});
  };

  const validate = () => {
    const errors = {};
    if (form.fullName.trim().length < 2) errors.fullName = "Enter the candidate's full name";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errors.email = "Enter a valid email";
    if (form.phone.trim() && !/^[+\d][\d\s-]{5,19}$/.test(form.phone.trim()))
      errors.phone = "Enter a valid phone number (or leave it empty)";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!referring || !validate()) return;
    setSubmitting(true);
    try {
      await referralService.refer(referring.jobCode, {
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        notes: form.notes.trim(),
      });
      const mineRes = await referralService.mine();
      setMine(mineRes?.data?.data?.referrals || []);
      setReferring(null);
      setToast(`Referral for ${form.fullName.trim()} submitted — thank you!`);
      setTimeout(() => setToast(""), 4000);
    } catch (err) {
      setFieldErrors({
        form: err?.response?.data?.message || "Could not submit the referral. Try again.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <UserPlus className="h-6 w-6 text-crewly-green" />
          Job Referrals
        </h1>
        <p className="mt-1 text-sm text-crewly-dim">
          Know someone great for one of our open roles? Refer them — they enter the
          normal pipeline and HR takes it from there.
        </p>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setTab("openings")}
          className={`rounded-lg px-4 py-2 text-sm transition ${
            tab === "openings"
              ? "bg-crewly-green text-black"
              : "text-crewly-dim hover:text-crewly-text"
          }`}
        >
          Open roles ({openings.length})
        </button>
        <button
          type="button"
          onClick={() => setTab("mine")}
          className={`rounded-lg px-4 py-2 text-sm transition ${
            tab === "mine"
              ? "bg-crewly-green text-black"
              : "text-crewly-dim hover:text-crewly-text"
          }`}
        >
          My referrals ({mine.length})
        </button>
      </div>

      {toast && (
        <div className="card border-crewly-green/40 text-sm text-crewly-green" role="status">
          {toast}
        </div>
      )}
      {error && <div className="card text-sm text-red-400">{error}</div>}
      {loading && <p className="text-crewly-dim">Loading…</p>}

      {!loading && tab === "openings" && (
        <div className="space-y-3">
          {openings.length === 0 && (
            <EmptyState>No open roles right now — check back soon.</EmptyState>
          )}
          {openings.map((job) => (
            <article key={job._id || job.jobCode} className="card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="flex items-center gap-2 font-semibold">
                    <Briefcase className="h-4 w-4 text-crewly-green" />
                    {job.title}
                  </h3>
                  <p className="mt-1 text-xs text-crewly-dim">
                    {[
                      job.department?.name,
                      job.location,
                      workModeLabel(job.workMode),
                      employmentTypeLabel(job.employmentType),
                    ]
                      .filter(Boolean)
                      .join(" • ")}
                    {job.openings > 1 ? ` • ${job.openings} openings` : ""}
                  </p>
                  {job.description && (
                    <p className="mt-2 max-w-3xl text-sm text-crewly-dim">{job.description}</p>
                  )}
                  {(job.requiredSkills || []).length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {job.requiredSkills.slice(0, 8).map((skill) => (
                        <span
                          key={skill}
                          className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-crewly-dim"
                        >
                          {skill}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => openRefer(job)}
                  className="rounded-lg bg-crewly-green px-4 py-2 text-sm font-medium text-black transition hover:opacity-90"
                >
                  Refer someone
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {!loading && tab === "mine" && (
        <div className="space-y-3">
          {mine.length === 0 && (
            <EmptyState>
              You haven&apos;t referred anyone yet. Pick an open role and refer a
              candidate — you&apos;ll see their stage here.
            </EmptyState>
          )}
          {mine.map((referral) => (
            <article key={referral._id} className="card flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold">{referral.name}</h3>
                <p className="mt-0.5 text-xs text-crewly-dim">
                  {referral.job?.title || "Opening closed"}
                  {referral.job?.jobCode ? ` · ${referral.job.jobCode}` : ""}
                  {referral.applicationDate
                    ? ` · referred ${new Date(referral.applicationDate).toLocaleDateString()}`
                    : ""}
                </p>
              </div>
              <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-crewly-dim">
                {humaniseStage(referral.stage)}
              </span>
            </article>
          ))}
        </div>
      )}

      {referring && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Refer a candidate for ${referring.title}`}
          onClick={(event) => {
            if (event.target === event.currentTarget && !submitting) setReferring(null);
          }}
        >
          <form onSubmit={submit} className="card w-full max-w-md space-y-4">
            <div>
              <h3 className="font-semibold">Refer a candidate</h3>
              <p className="mt-0.5 text-xs text-crewly-dim">
                for <span className="text-crewly-text">{referring.title}</span>
              </p>
            </div>

            <label className="block text-sm">
              <span className="text-crewly-dim">Full name *</span>
              <input
                type="text"
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                className="mt-1 w-full rounded-lg border border-white/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-crewly-green"
                autoFocus
              />
              {fieldErrors.fullName && (
                <span className="mt-1 block text-xs text-red-400">{fieldErrors.fullName}</span>
              )}
            </label>

            <label className="block text-sm">
              <span className="text-crewly-dim">Email *</span>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="mt-1 w-full rounded-lg border border-white/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-crewly-green"
              />
              {fieldErrors.email && (
                <span className="mt-1 block text-xs text-red-400">{fieldErrors.email}</span>
              )}
            </label>

            <label className="block text-sm">
              <span className="text-crewly-dim">Phone (optional)</span>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="mt-1 w-full rounded-lg border border-white/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-crewly-green"
              />
              {fieldErrors.phone && (
                <span className="mt-1 block text-xs text-red-400">{fieldErrors.phone}</span>
              )}
            </label>

            <label className="block text-sm">
              <span className="text-crewly-dim">Why are they a good fit? (optional)</span>
              <textarea
                rows={3}
                maxLength={500}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-crewly-green"
              />
            </label>

            {fieldErrors.form && <p className="text-xs text-red-400">{fieldErrors.form}</p>}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReferring(null)}
                disabled={submitting}
                className="rounded-lg px-4 py-2 text-sm text-crewly-dim transition hover:text-crewly-text"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-lg bg-crewly-green px-4 py-2 text-sm font-medium text-black transition hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? "Submitting…" : "Submit referral"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

export default ReferralsPage;
