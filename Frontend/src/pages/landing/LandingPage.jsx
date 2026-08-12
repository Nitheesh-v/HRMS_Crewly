import { Link } from 'react-router-dom';

const modules = [
  '👥 Core HR', '🕒 Attendance', '💰 Payroll', '🧑‍💼 Recruitment',
  '🎯 Performance', '🖥️ Assets', '🎓 Learning', '📁 Projects', '💬 Communication',
];

const LandingPage = () => {
  return (
    <div>
      <section className="px-6 py-24 text-center">
        <h1 className="mx-auto max-w-3xl text-5xl font-extrabold leading-tight">
          One platform for your <span className="text-crewly-green">entire workforce</span>
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-lg text-crewly-dim">
          Crewly HRMS — multi-tenant SaaS for Core HR, Attendance, Payroll, Recruitment,
          Performance, Assets and Learning.
        </p>
        <div className="mt-8 flex justify-center gap-4">
          <Link to="/register" className="btn-primary">Start Free Trial →</Link>
          <Link to="/login" className="btn-ghost">Sign In</Link>
        </div>
        <p className="mt-4 text-sm text-crewly-dim">14-day free trial · No credit card required</p>
      </section>

      <section className="mx-auto grid max-w-4xl grid-cols-2 gap-4 px-6 pb-24 sm:grid-cols-3">
        {modules.map((m) => (
          <div key={m} className="card py-4 text-center text-crewly-dim transition hover:border-crewly-green hover:text-crewly-text">
            {m}
          </div>
        ))}
      </section>
    </div>
  );
};

export default LandingPage;