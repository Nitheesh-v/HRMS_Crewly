import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import authService from '../../services/authService.js';
import useAuth from '../../hooks/useAuth.jsx';
import { getDashboardPath } from '../../utils/roles.js';

const LoginPage = () => {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({ companyCode: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const onChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await authService.login(form);
      login(data.user, data.token);
      navigate(getDashboardPath(data.user.role), { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center px-4 py-16">
      <form onSubmit={onSubmit} className="card w-full max-w-md">
        <h1 className="text-2xl font-bold">Sign in to Crewly</h1>
        <p className="mb-6 mt-1 text-sm text-crewly-dim">Use the company code you got at registration.</p>

        {error && (
          <div className="mb-4 rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
            {error}
          </div>
        )}

        <label className="label">Company Code</label>
        <input name="companyCode" className="input mb-4" placeholder="e.g. acme — Super Admin: CREWLY" value={form.companyCode} onChange={onChange} required />

        <label className="label">Email</label>
        <input name="email" type="email" className="input mb-4" placeholder="you@company.com" value={form.email} onChange={onChange} required />

        <label className="label">Password</label>
        <input name="password" type="password" className="input mb-6" placeholder="••••••••" value={form.password} onChange={onChange} required />

        <button type="submit" className="btn-primary w-full" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign In'}
        </button>

        <p className="mt-4 text-center text-sm text-crewly-dim">
          New company? <Link to="/register" className="text-crewly-green hover:underline">Register here</Link>
        </p>
      </form>
    </div>
  );
};

export default LoginPage;