import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import authService from '../../services/authService.js';
import useAuth from "../../hooks/useAuth.jsx"
import { getDashboardPath } from '../../utils/roles.js';
import AuthLayout from '../../layout/AuthLayout.jsx';
import PasswordField from '../../components/auth/PasswordField.jsx';

const RegisterCompanyPage = () => {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({ companyName: '', adminName: '', email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const onChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const mismatch = form.confirmPassword && form.password !== form.confirmPassword;
  const canSubmit =
    form.companyName.trim() && form.adminName.trim() && form.email.trim() &&
    form.password.length >= 6 && form.confirmPassword && !mismatch;

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (form.password !== form.confirmPassword) {
      return setError('Passwords do not match');
    }

    setLoading(true);
    try {
      const payload = { ...form };
      delete payload.confirmPassword;
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
    <AuthLayout variant="split" visualSide="right">
      <div className="mx-auto max-w-sm">
        <h1 className="text-2xl font-bold text-white">
          Manage employees easily — starting from now!
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Get started free for 14 days. Your Company Admin account is created automatically.
        </p>

        {error && (
          <div className="mt-5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
            {error}
          </div>
        )}

        <form onSubmit={onSubmit} className="mt-7 space-y-4" noValidate>
          <div>
            <label htmlFor="companyName" className="mb-1.5 block text-sm font-medium text-slate-300">
              Company Name <span className="text-rose-400">*</span>
            </label>
            <input
              id="companyName"
              name="companyName"
              className="auth-input"
              placeholder="e.g. Unpixel Technologies"
              value={form.companyName}
              onChange={onChange}
              required
            />
          </div>

          <div>
            <label htmlFor="adminName" className="mb-1.5 block text-sm font-medium text-slate-300">
              Your Name <span className="text-rose-400">*</span>
            </label>
            <input
              id="adminName"
              name="adminName"
              className="auth-input"
              placeholder="Input your full name"
              value={form.adminName}
              onChange={onChange}
              required
            />
          </div>

          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-slate-300">
              Work Email <span className="text-rose-400">*</span>
            </label>
            <input
              id="email"
              name="email"
              type="email"
              className="auth-input"
              placeholder="example@company.com"
              value={form.email}
              onChange={onChange}
              required
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-slate-300">
              Password <span className="text-rose-400">*</span>
            </label>
            <PasswordField
              id="password"
              name="password"
              value={form.password}
              onChange={onChange}
              placeholder="Min. 6 characters"
              autoComplete="new-password"
              minLength={6}
              maxLength={128}
            />
          </div>

          <div>
            <label htmlFor="confirmPassword" className="mb-1.5 block text-sm font-medium text-slate-300">
              Confirmation Password <span className="text-rose-400">*</span>
            </label>
            <PasswordField
              id="confirmPassword"
              name="confirmPassword"
              value={form.confirmPassword}
              onChange={onChange}
              placeholder="Re-type your password"
              autoComplete="new-password"
              required={false}
            />
            {mismatch && (
              <p className="mt-2 text-xs text-rose-400">Passwords do not match yet.</p>
            )}
          </div>

          <button type="submit" disabled={loading || !canSubmit} className="auth-primary mt-2">
            {loading ? 'Creating your workspace…' : 'Create Account'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-400">
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-emerald-400 hover:underline">
            Login Here
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
};

export default RegisterCompanyPage;
