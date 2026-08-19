
import { Link } from 'react-router-dom';
import { 
  Users, Calendar, CreditCard, UserPlus, 
  BarChart3, Monitor, GraduationCap, Briefcase, MessageSquare, ArrowRight 
} from 'lucide-react';

const modules = [
  { name: 'Core HR', icon: <Users className="w-6 h-6" />, color: 'bg-blue-500' },
  { name: 'Attendance', icon: <Calendar className="w-6 h-6" />, color: 'bg-emerald-500' },
  { name: 'Payroll', icon: <CreditCard className="w-6 h-6" />, color: 'bg-purple-500' },
  { name: 'Recruitment', icon: <UserPlus className="w-6 h-6" />, color: 'bg-orange-500' },
  { name: 'Performance', icon: <BarChart3 className="w-6 h-6" />, color: 'bg-rose-500' },
  { name: 'Assets', icon: <Monitor className="w-6 h-6" />, color: 'bg-indigo-500' },
  { name: 'Learning', icon: <GraduationCap className="w-6 h-6" />, color: 'bg-amber-500' },
  { name: 'Projects', icon: <Briefcase className="w-6 h-6" />, color: 'bg-cyan-500' },
  { name: 'Communication', icon: <MessageSquare className="w-6 h-6" />, color: 'bg-teal-500' },
];

const LandingPage = () => {
  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-slate-50 text-slate-900">
      
      {/* --- BACKGROUND ELEMENTS --- */}
      <div className="absolute top-0 left-1/4 -z-10 h-[400px] w-[400px] rounded-full bg-emerald-200/50 blur-[100px] opacity-70 animate-pulse"></div>
      <div className="absolute bottom-0 right-1/4 -z-10 h-[400px] w-[400px] rounded-full bg-blue-200/50 blur-[100px] opacity-70"></div>

      {/* --- HERO SECTION --- */}
      <section className="relative z-10 px-6 py-28 text-center">
        <div className="mx-auto mb-6 flex w-fit items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50/50 px-4 py-1 text-sm font-medium text-emerald-700 backdrop-blur-md">
          <span className="flex h-2 w-2 rounded-full bg-emerald-500"></span>
          New: AI-Powered Recruitment integrated
        </div>

        <h1 className="mx-auto max-w-4xl text-5xl font-black tracking-tight sm:text-7xl">
          One platform for your <br />
          <span className="bg-gradient-to-r from-emerald-600 to-teal-500 bg-clip-text text-transparent">
            entire workforce
          </span>
        </h1>
        
        <p className="mx-auto mt-8 max-w-2xl text-lg leading-relaxed text-slate-600">
          Crewly HRMS is a modern, multi-tenant SaaS solution designed to streamline 
          Core HR, Payroll, and Performance management in one beautiful workspace.
        </p>

        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <Link 
            to="/register" 
            className="group flex items-center gap-2 rounded-full bg-slate-900 px-8 py-4 font-semibold text-white transition-all hover:bg-emerald-600 hover:shadow-[0_0_20px_rgba(16,185,129,0.4)]"
          >
            Start Free Trial
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Link>
          <Link 
            to="/login" 
            className="rounded-full border border-slate-200 bg-white/40 px-8 py-4 font-semibold backdrop-blur-md transition-all hover:bg-white/60 hover:border-slate-300"
          >
            Watch Demo
          </Link>
        </div>
        
        <p className="mt-6 text-sm font-medium text-slate-400">
          14-day free trial · No credit card required
        </p>
      </section>

      {/* --- MODULES GRID (GLASSMORPHISM) --- */}
      <section className="relative z-10 mx-auto max-w-6xl px-6 pb-32">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {modules.map((m, idx) => (
            <div 
              key={idx} 
              className="group relative overflow-hidden rounded-2xl border border-white/40 bg-white/30 p-6 backdrop-blur-xl transition-all duration-300 hover:-translate-y-2 hover:bg-white/50 hover:shadow-xl hover:shadow-slate-200/50"
            >
              {/* Subtle background glow on hover */}
              <div className={`absolute -right-4 -top-4 h-24 w-24 rounded-full opacity-10 transition-all group-hover:scale-150 ${m.color}`}></div>
              
              <div className={`mb-4 flex h-12 w-12 items-center justify-center rounded-xl text-white shadow-lg ${m.color}`}>
                {m.icon}
              </div>
              
              <h3 className="text-xl font-bold text-slate-800">{m.name}</h3>
              <p className="mt-2 text-sm text-slate-500 leading-relaxed">
                Streamline your {m.name.toLowerCase()} workflows with our automated enterprise tools.
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

export default LandingPage;