// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — THE SIX PRODUCT MOCKS BEHIND THE PLATFORM TABS.
//
// Dark, like the product they describe. Decorative markup, aria-hidden at the
// call site: no screenshot asset, no request, no client data. Illustrative
// values only — the same convention the auth screens use for their panel.
// ═══════════════════════════════════════════════════════════════════════════

import { Check, Clock3, FileText, Sparkles } from 'lucide-react';

const Frame = ({ title, chip, children }) => (
  <div className="landing-preview overflow-hidden rounded-2xl" aria-hidden="true">
    <div className="flex items-center gap-2 border-b border-white/[0.08] bg-white/[0.03] px-3.5 py-2.5">
      <span className="flex gap-1.5">
        <span className="h-2 w-2 rounded-full bg-white/15" />
        <span className="h-2 w-2 rounded-full bg-white/15" />
        <span className="h-2 w-2 rounded-full bg-white/15" />
      </span>
      <span className="ml-1 text-[10px] font-semibold text-slate-400">{title}</span>
      {chip ? (
        <span className="ml-auto rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-semibold text-emerald-300">
          {chip}
        </span>
      ) : null}
    </div>
    <div className="p-3.5">{children}</div>
  </div>
);

const Row = ({ label, meta, dot = 'bg-slate-500' }) => (
  <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
    <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-slate-200">{label}</span>
    <span className="shrink-0 text-[9px] text-slate-500">{meta}</span>
  </div>
);

const PayrollPreview = () => (
  <Frame title="Payroll · October 2026" chip="In review">
    <div className="grid grid-cols-3 gap-2">
      {[
        { label: 'Gross', value: '₹24.8L' },
        { label: 'Deductions', value: '₹3.1L' },
        { label: 'Net payable', value: '₹21.7L' },
      ].map((tile) => (
        <div key={tile.label} className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-2.5">
          <p className="text-[8px] font-medium uppercase tracking-wide text-slate-500">{tile.label}</p>
          <p className="mt-0.5 text-[13px] font-bold text-white">{tile.value}</p>
        </div>
      ))}
    </div>
    <div className="mt-2 space-y-1.5">
      <Row label="Basic, HRA, allowances" meta="Structures" dot="bg-violet-400" />
      <Row label="PF · ESI · PT · TDS" meta="Computed" dot="bg-emerald-400" />
      <Row label="Attendance and leave inputs" meta="Synced" dot="bg-teal-400" />
      <Row label="Manager review" meta="Pending 1" dot="bg-amber-400" />
    </div>
    <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-emerald-400/20 bg-emerald-500/[0.08] px-2.5 py-1.5 text-[9px] font-medium text-emerald-200">
      <Check className="h-3 w-3" />
      Payslips generate from the numbers that get paid
    </div>
  </Frame>
);

const PeoplePreview = () => (
  <Frame title="People · Directory" chip="137 active">
    <div className="flex items-center gap-2 rounded-lg border border-white/[0.08] px-2.5 py-1.5 text-[9px] text-slate-500">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />
      Search people, departments, documents
    </div>
    <div className="mt-2 space-y-1.5">
      {[
        { initials: 'PS', name: 'Priya S.', meta: 'HR Manager', tone: 'bg-violet-500/15 text-violet-300' },
        { initials: 'RS', name: 'Ravi S.', meta: 'Engineering', tone: 'bg-emerald-500/15 text-emerald-300' },
        { initials: 'MK', name: 'Meena K.', meta: 'Design', tone: 'bg-teal-500/15 text-teal-300' },
      ].map((person) => (
        <div
          key={person.name}
          className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-1.5"
        >
          <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[8px] font-bold ${person.tone}`}>
            {person.initials}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[10px] font-medium text-slate-200">{person.name}</span>
            <span className="block text-[8px] text-slate-500">{person.meta}</span>
          </span>
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[8px] text-slate-400">Active</span>
        </div>
      ))}
    </div>
    <div className="mt-2 flex items-center justify-between rounded-lg border border-amber-400/20 bg-amber-400/[0.07] px-2.5 py-1.5">
      <span className="inline-flex items-center gap-1.5 text-[9px] font-medium text-amber-200">
        <FileText className="h-3 w-3" />
        2 documents expiring
      </span>
      <span className="text-[9px] font-semibold text-amber-300">Review</span>
    </div>
  </Frame>
);

const HiringPreview = () => (
  <Frame title="Hiring · Senior React Developer" chip="12 in pipeline">
    <div className="grid grid-cols-3 gap-2">
      {[
        { stage: 'Screening', count: 6, card: 'A. Kumar', tone: 'bg-white/[0.03]' },
        { stage: 'Interview', count: 4, card: 'N. Rao', tone: 'bg-violet-500/[0.08]' },
        { stage: 'Offer', count: 2, card: 'S. Iyer', tone: 'bg-emerald-500/[0.08]' },
      ].map((column) => (
        <div key={column.stage} className="rounded-xl border border-white/[0.07] p-1.5">
          <p className="flex items-center justify-between px-1 text-[8px] font-semibold uppercase tracking-wide text-slate-500">
            {column.stage}
            <span>{column.count}</span>
          </p>
          <div className={`mt-1.5 rounded-lg border border-white/[0.07] p-1.5 ${column.tone}`}>
            <p className="truncate text-[9px] font-semibold text-slate-200">{column.card}</p>
            <p className="text-[8px] text-slate-500">Scorecard attached</p>
          </div>
          <div className="mt-1 rounded-lg border border-dashed border-white/10 p-1.5">
            <p className="text-[8px] text-slate-600">Next round</p>
            <p className="truncate text-[8px] text-slate-400">Fri · 11:00</p>
          </div>
        </div>
      ))}
    </div>
    <div className="mt-2 space-y-1.5">
      <Row label="Requisition HR-1042" meta="Approved" dot="bg-emerald-400" />
      <Row label="Pre-onboarding · 3 documents" meta="Sent" dot="bg-violet-400" />
    </div>
  </Frame>
);

const AttendancePreview = () => (
  <Frame title="Attendance · This week" chip="Policy: hybrid">
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold text-white">Checked in · 09:04</p>
        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[8px] font-semibold text-emerald-300">
          Within geo-fence
        </span>
      </div>
      <div className="mt-2 grid grid-cols-7 gap-1">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => (
          <div key={`${day}-${index}`} className="text-center">
            <p className="text-[8px] text-slate-500">{day}</p>
            <span
              className={`mt-1 flex h-5 items-center justify-center rounded-md ${
                index === 6
                  ? 'bg-white/[0.05] text-slate-600'
                  : index === 3
                    ? 'bg-amber-400/15 text-amber-300'
                    : 'bg-emerald-500/15 text-emerald-300'
              }`}
            >
              <Check className="h-2.5 w-2.5" />
            </span>
          </div>
        ))}
      </div>
    </div>
    <div className="mt-2 space-y-1.5">
      <Row label="Regularisation · 1 day" meta="Approved" dot="bg-violet-400" />
      <Row label="Weekly hours goal" meta="32 / 40 h" dot="bg-teal-400" />
      <Row label="Leave balance" meta="9 days" dot="bg-emerald-400" />
    </div>
  </Frame>
);

const PerformancePreview = () => (
  <Frame title="Performance · FY 26 cycle" chip="Self review open">
    <div className="space-y-2">
      {[
        { goal: 'Ship the new payroll review flow', progress: 92, tone: 'from-emerald-500 to-teal-400' },
        { goal: 'Reduce attendance disputes to <2%', progress: 76, tone: 'from-teal-500 to-teal-400' },
        { goal: 'Mentor two engineers', progress: 55, tone: 'from-violet-500 to-violet-400' },
      ].map((goal) => (
        <div key={goal.goal} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 flex-1 truncate text-[10px] font-medium text-slate-200">{goal.goal}</p>
            <span className="text-[9px] font-semibold text-slate-400">{goal.progress}%</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
            <div className={`h-full rounded-full bg-gradient-to-r ${goal.tone}`} style={{ width: `${goal.progress}%` }} />
          </div>
        </div>
      ))}
    </div>
    <div className="mt-2 flex items-center justify-between rounded-lg border border-violet-400/20 bg-violet-500/[0.08] px-2.5 py-1.5">
      <span className="text-[9px] font-semibold text-violet-200">Next step: self review</span>
      <span className="text-[9px] text-violet-300/70">Due 2 Nov</span>
    </div>
  </Frame>
);

const CollaborationPreview = () => (
  <Frame title="Chat Hub · #engineering" chip="4 online">
    <div className="space-y-2">
      {[
        { initials: 'RS', name: 'Ravi S.', text: 'Payroll inputs are locked for October.', tone: 'bg-emerald-500/15 text-emerald-300' },
        { initials: 'PS', name: 'Priya S.', text: 'Review is open — approvals close Friday.', tone: 'bg-violet-500/15 text-violet-300' },
      ].map((message) => (
        <div key={message.name} className="flex gap-2">
          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[7px] font-bold ${message.tone}`}>
            {message.initials}
          </span>
          <div className="min-w-0">
            <p className="text-[9px] font-semibold text-slate-300">{message.name}</p>
            <p className="mt-0.5 rounded-lg rounded-tl-none bg-white/[0.05] px-2 py-1 text-[9px] text-slate-300">
              {message.text}
            </p>
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2 rounded-lg border border-violet-400/20 bg-violet-500/[0.08] px-2 py-1.5">
        <Sparkles className="h-3 w-3 text-violet-300" />
        <span className="text-[9px] text-violet-200">Crewly AI: 2 approvals are waiting on you.</span>
      </div>
    </div>
    <div className="mt-2 flex items-center justify-between rounded-lg border border-white/10 px-2.5 py-1.5">
      <span className="inline-flex items-center gap-1.5 text-[9px] font-medium text-slate-300">
        <Clock3 className="h-3 w-3 text-slate-500" />
        Standup · 10:30
      </span>
      <span className="text-[9px] font-semibold text-emerald-300">Join</span>
    </div>
  </Frame>
);

const PREVIEWS = {
  payroll: PayrollPreview,
  people: PeoplePreview,
  hiring: HiringPreview,
  attendance: AttendancePreview,
  performance: PerformancePreview,
  collaboration: CollaborationPreview,
};

const PlatformPreview = ({ name }) => {
  const Preview = PREVIEWS[name];

  return Preview ? <Preview /> : null;
};

export default PlatformPreview;
