import { Outlet, Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { selectUser } from '../redux/slices/authSlice';
import { logout } from '../redux/slices/authSlice';

const SuperAdminSidebar = ({ isOpen, onClose }) => {
  const user = useSelector(selectUser);
  const navigate = useNavigate();
  const dispatch = useDispatch();

  const menuItems = [
    { label: 'Dashboard', path: '/super-admin/dashboard', icon: '📊' },
    { label: 'Companies', path: '/super-admin/companies', icon: '🏢' },
    { label: 'Plans & Billing', path: '/super-admin/plans', icon: '💳' },
    { label: 'Analytics', path: '/super-admin/analytics', icon: '📈' },
    { label: 'Settings', path: '/super-admin/settings', icon: '⚙️' },
    { label: 'Support Tickets', path: '/super-admin/support', icon: '🎫' },
  ];

  const handleLogout = () => {
    dispatch(logout());
    navigate('/super-admin/login');
  };

  return (
    <aside className={`fixed left-0 top-0 h-full w-64 bg-gray-900 transform transition-transform duration-300 z-40 ${isOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}>
      <div className="flex flex-col h-full">
        <div className="p-6 border-b border-gray-700">
          <Link to="/super-admin/dashboard" className="flex items-center gap-2">
            <div className="w-10 h-10 bg-yellow-500 rounded-lg flex items-center justify-center text-white font-bold text-xl">
              ⚡
            </div>
            <span className="text-xl font-bold text-white">Crewly Admin</span>
          </Link>
        </div>

        <nav className="flex-1 p-4 overflow-y-auto" role="navigation" aria-label="Super admin navigation">
          <ul className="space-y-1">
            {menuItems.map((item) => (
              <li key={item.path}>
                <Link
                  to={item.path}
                  onClick={onClose}
                  className="flex items-center gap-3 px-3 py-2.5 text-gray-300 rounded-lg hover:bg-gray-800 hover:text-white transition-colors group"
                >
                  <span className="text-lg">{item.icon}</span>
                  <span className="font-medium">{item.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="p-4 border-t border-gray-700">
          <div className="flex items-center gap-3 px-3 py-2 mb-3">
            <div className="w-8 h-8 bg-yellow-500 rounded-full flex items-center justify-center text-white font-medium">
              {user?.name?.[0] || 'S'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{user?.name || 'Super Admin'}</p>
              <p className="text-xs text-gray-400">Super Administrator</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2 text-gray-300 rounded-lg hover:bg-red-900/30 hover:text-red-400 transition-colors"
          >
            <span className="text-lg">🚪</span>
            <span className="font-medium">Logout</span>
          </button>
        </div>
      </div>
    </aside>
  );
};

const SuperAdminHeader = ({ onMenuClick }) => {
  return (
    <header className="fixed top-0 left-0 right-0 h-16 bg-gray-800 border-b border-gray-700 z-30 lg:left-64">
      <div className="flex items-center justify-between h-full px-4 lg:px-6">
        <div className="flex items-center gap-4">
          <button
            onClick={onMenuClick}
            className="lg:hidden p-2 rounded-lg hover:bg-gray-700"
            aria-label="Toggle menu"
          >
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h1 className="text-lg font-semibold text-white">Super Admin Panel</h1>
        </div>
      </div>
    </header>
  );
};

export const SuperAdminLayout = () => {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-gray-50">
      <SuperAdminSidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <SuperAdminHeader onMenuClick={() => setSidebarOpen(true)} />
      <main className="pt-16 lg:pl-64 min-h-screen">
        <div className="p-4 lg:p-6">
          <Outlet />
        </div>
      </main>
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
    </div>
  );
};