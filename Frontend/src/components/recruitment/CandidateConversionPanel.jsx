import { useState } from 'react';
import { UserPlus2 } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import usePermission from '../../hooks/usePermission.js';

const CandidateConversionPanel = ({ candidate }) => {
  const { candidateRef } = useParams();
  const { hasPermission } = usePermission();
  const canConvert = hasPermission('CANDIDATE_CONVERT');
  const [openHint, setOpenHint] = useState(false);

  const stage =
    candidate?.overview?.currentStage || candidate?.overview?.stage || '';
  const alreadyJoined = ['JOINED', 'HIRED'].includes(stage);
  const convertedUser =
    candidate?.overview?.convertedUser ||
    candidate?.convertedUser ||
    null;

  // Show when ready for conversion or already converted.
  const show =
    canConvert &&
    (stage === 'PRE_ONBOARDING' || alreadyJoined || convertedUser);
  if (!show) return null;

  const ref =
    candidateRef ||
    candidate?.candidateCode ||
    candidate?.overview?.candidateCode ||
    candidate?.id ||
    candidate?.overview?.id;

  if (alreadyJoined || convertedUser) {
    return (
      <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold text-slate-100">Converted to employee</h2>
            <p className="mt-1 text-sm text-slate-400">
              This candidate has completed recruitment conversion. Recruitment history remains available here.
            </p>
          </div>
          <Link to="/app/users" className="btn-ghost">
            Open employees
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-emerald-500/25 bg-emerald-500/5 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-emerald-500/10 p-2 text-emerald-300">
            <UserPlus2 className="h-5 w-5" />
          </span>
          <div>
            <h2 className="font-semibold text-slate-100">Convert to employee</h2>
            <p className="mt-1 text-sm text-slate-400">
              Pre-onboarding is ready. Create the employee account, start onboarding, and send a
              secure password setup link. No temporary password is emailed.
            </p>
            {openHint ? (
              <p className="mt-2 text-xs text-slate-500">
                You will confirm department, manager, designation, and joining date on the next screen.
              </p>
            ) : null}
          </div>
        </div>
        <Link
          to={`/app/recruitment/candidates/${ref}/convert`}
          className="btn-primary gap-2"
          onClick={() => setOpenHint(true)}
        >
          <UserPlus2 className="h-4 w-4" />
          Convert to employee
        </Link>
      </div>
    </section>
  );
};

export default CandidateConversionPanel;
