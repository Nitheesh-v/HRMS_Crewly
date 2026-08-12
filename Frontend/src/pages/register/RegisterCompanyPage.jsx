import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import authService from '../../services/authService.js';
import useAuth from "../../hooks/useAuth.jsx"
import { getDashboardPath } from '../../utils/roles.js';

const RegisterCompanyPage = () => {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({ companyName: '', adminName: '', email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const onChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (form.password !== form.confirmPassword) {
      return setError('Passwords do not match');
    }

    setLoading(true);
    try {
      const { confirmPassword, ...payload } = form;
      const data = await authService.registerCompany(payload);
      login(data.user, data.token); // auto login after register
      navigate(getDashboardPath(data.user.role), { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center px-4 py-12">
      <form onSubmit={onSubmit} className="card w-full max-w-md">
        <h1 className="text-2xl font-bold">Register your company</h1>
        <p className="mb-6 mt-1 text-sm text-crewly-dim">14-day free trial · Company Admin account auto-created.</p>

        {error && (
          <div className="mb-4 rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
            {error}
          </div>
        )}

        <label className="label">Company Name</label>
        <input name="companyName" className="input mb-4" placeholder="e.g. Acme Technologies" value={form.companyName} onChange={onChange} required />

        <label className="label">Your Name (Company Admin)</label>
        <input name="adminName" className="input mb-4" placeholder="e.g. Priya Sharma" value={form.adminName} onChange={onChange} required />

        <label className="label">Work Email</label>
        <input name="email" type="email" className="input mb-4" placeholder="priya@acme.com" value={form.email} onChange={onChange} required />

        <label className="label">Password</label>
        <input name="password" type="password" className="input mb-4" placeholder="Min. 6 characters" value={form.password} onChange={onChange} required minLength={6} />

        <label className="label">Confirm Password</label>
        <input name="confirmPassword" type="password" className="input mb-6" placeholder="Repeat password" value={form.confirmPassword} onChange={onChange} required />

        <button type="submit" className="btn-primary w-full" disabled={loading}>
          {loading ? 'Creating your workspace…' : 'Create Company Workspace'}
        </button>

        <p className="mt-4 text-center text-sm text-crewly-dim">
          Already registered? <Link to="/login" className="text-crewly-green hover:underline">Sign in</Link>
        </p>
      </form>
    </div>
  );
};

export default RegisterCompanyPage;